//! Effective OpenSSH checks shared by app-owned Git and identity probes.
use anyhow::{bail, Context, Result};

pub(crate) const OPTIONS: &[&str] = &["-S", "none", "-o", "ProxyCommand=none", "-o", "ForkAfterAuthentication=no", "-o", "PermitLocalCommand=no"];

/// Non-interactive, read-only SSH options for GitHub identity probes.
/// Uses `StrictHostKeyChecking=yes` and `UpdateHostKeys=no` so an identity
/// probe never connects to an unknown host key or mutates `~/.ssh/known_hosts`.
///
/// NOTE: Do NOT include [`OPTIONS`] (`ProxyCommand=none`, `ForkAfterAuthentication=no`,
/// `PermitLocalCommand=no`) here because `IDENTITY_PROBE_OPTIONS` is passed to
/// `ssh -G` before [`direct_identity_probe_configuration`]; overriding those
/// directives on `-G` would mask an unsafe `ProxyJump`/`ProxyCommand` in the
/// user's SSH config. Callers must append [`OPTIONS`] only to the actual
/// connection after `-G` inspection succeeds.
pub(crate) const IDENTITY_PROBE_OPTIONS: &[&str] = &[
    "-T",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=5",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "UpdateHostKeys=no",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "ControlPersist=no",
];

/// Validate an SSH host or alias before passing it to `ssh`.
pub(crate) fn validate_hostname(hostname: &str) -> Result<()> {
    if hostname.is_empty()
        || hostname.starts_with('-')
        || hostname.starts_with('.')
        || hostname.ends_with('.')
        || hostname.contains("..")
        || hostname.len() > 253
        || !hostname.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-'))
        || url::Url::parse(&format!("https://{hostname}")).is_err()
    {
        bail!("Invalid SSH hostname.");
    }
    Ok(())
}

pub(crate) fn direct_configuration(bytes: &[u8]) -> Result<()> {
    let text = std::str::from_utf8(bytes).context("SSH did not report readable effective configuration")?;
    let values: Vec<_> = text.lines().filter_map(|line| line.split_once(char::is_whitespace))
        .map(|(key, value)| (key.to_ascii_lowercase(), value.trim())).collect();
    for required in ["hostname", "user", "port"] {
        anyhow::ensure!(values.iter().any(|(key, value)| key == required && !value.is_empty()),
            "Cannot verify the configured SSH transport: missing {required} in ssh -G output");
    }
    for (key, value) in values {
        match key.as_str() {
            "proxyjump" | "proxycommand" if !value.eq_ignore_ascii_case("none") =>
                bail!("App connections cannot safely contain this SSH {key} route. Use your terminal or agent, or configure a direct SSH connection; the app has not changed the route or started a transfer."),
            "forkafterauthentication" | "permitlocalcommand" if value != "no" =>
                bail!("App connections cannot safely contain SSH {key}. Use your terminal or agent, or disable that option for the app's SSH command."),
            _ => {}
        }
    }
    Ok(())
}

/// Stricter effective-configuration check for read-only SSH identity probes:
/// in addition to direct-route containment, refuse any configuration that
/// weakens host-key verification or would mutate `~/.ssh/known_hosts`.
pub(crate) fn direct_identity_probe_configuration(bytes: &[u8]) -> Result<()> {
    direct_configuration(bytes)?;
    let text = std::str::from_utf8(bytes).context("SSH did not report readable effective configuration")?;
    let mut strict_yes = false;
    for line in text.lines() {
        let Some((key, value)) = line.split_once(char::is_whitespace) else { continue };
        let key = key.to_ascii_lowercase();
        let value = value.trim();
        match key.as_str() {
            "stricthostkeychecking" => {
                // OpenSSH `ssh -G` prints `true` (modern) or `yes` (older) for `StrictHostKeyChecking=yes`.
                if !(value.eq_ignore_ascii_case("yes") || value.eq_ignore_ascii_case("true")) {
                    bail!("SSH identity probe requires StrictHostKeyChecking=yes");
                }
                strict_yes = true;
            }
            "updatehostkeys" if !(value.eq_ignore_ascii_case("no") || value.eq_ignore_ascii_case("false")) => {
                // OpenSSH `ssh -G` prints `false` (modern) or `no` (older) for `UpdateHostKeys=no`.
                bail!("SSH identity probe requires UpdateHostKeys=no");
            }
            _ => {}
        }
    }
    anyhow::ensure!(strict_yes, "SSH identity probe missing StrictHostKeyChecking=yes in ssh -G output");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_hostname_rejects_flags_and_malformed_hosts() {
        assert!(validate_hostname("github.com").is_ok());
        assert!(validate_hostname("github-work").is_ok());
        assert!(validate_hostname("ghe.corp.example").is_ok());
        for bad in ["", "-oProxyCommand=id", "--help", "host name", "user@github.com", "github.com:22", "github.com/path", "host\nfoo", ".github.com", "..github.com", "a..github.com", "github.com."] {
            assert!(validate_hostname(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn identity_probe_options_enforce_read_only_strict_host_key_checking() {
        assert!(IDENTITY_PROBE_OPTIONS.contains(&"StrictHostKeyChecking=yes"));
        assert!(IDENTITY_PROBE_OPTIONS.contains(&"UpdateHostKeys=no"));
        assert!(!IDENTITY_PROBE_OPTIONS.iter().any(|opt| opt.contains("accept-new")));
        // Must not mask ProxyJump/ProxyCommand during `ssh -G` inspection.
        assert!(!IDENTITY_PROBE_OPTIONS.iter().any(|opt| opt.contains("ProxyCommand")));
    }

    #[test]
    fn direct_identity_probe_configuration_refuses_known_hosts_mutation() {
        let ok_yes_no = b"hostname github.com\nuser git\nport 22\nstricthostkeychecking yes\nupdatehostkeys no\nproxycommand none\nproxyjump none\nforkafterauthentication no\npermitlocalcommand no\n";
        assert!(direct_identity_probe_configuration(ok_yes_no).is_ok());
        // Modern OpenSSH `ssh -G` normalizes yes/no to true/false.
        let ok_true_false = b"hostname github.com\nuser git\nport 22\nstricthostkeychecking true\nupdatehostkeys false\nproxycommand none\nproxyjump none\nforkafterauthentication no\npermitlocalcommand no\n";
        assert!(direct_identity_probe_configuration(ok_true_false).is_ok());
        let accept_new = b"hostname github.com\nuser git\nport 22\nstricthostkeychecking accept-new\nupdatehostkeys false\n";
        assert!(direct_identity_probe_configuration(accept_new).is_err());
        let no_check = b"hostname github.com\nuser git\nport 22\nstricthostkeychecking no\nupdatehostkeys no\n";
        assert!(direct_identity_probe_configuration(no_check).is_err());
        let false_check = b"hostname github.com\nuser git\nport 22\nstricthostkeychecking false\nupdatehostkeys false\n";
        assert!(direct_identity_probe_configuration(false_check).is_err());
        let ask_check = b"hostname github.com\nuser git\nport 22\nstricthostkeychecking ask\nupdatehostkeys false\n";
        assert!(direct_identity_probe_configuration(ask_check).is_err());
        let update_keys = b"hostname github.com\nuser git\nport 22\nstricthostkeychecking true\nupdatehostkeys true\n";
        assert!(direct_identity_probe_configuration(update_keys).is_err());
        let update_keys_yes = b"hostname github.com\nuser git\nport 22\nstricthostkeychecking yes\nupdatehostkeys yes\n";
        assert!(direct_identity_probe_configuration(update_keys_yes).is_err());
        let update_keys_ask = b"hostname github.com\nuser git\nport 22\nstricthostkeychecking true\nupdatehostkeys ask\n";
        assert!(direct_identity_probe_configuration(update_keys_ask).is_err());
        let missing_strict = b"hostname github.com\nuser git\nport 22\nupdatehostkeys false\n";
        assert!(direct_identity_probe_configuration(missing_strict).is_err());
    }
}

