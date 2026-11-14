//! Effective OpenSSH checks shared by app-owned Git and identity probes.
use anyhow::{bail, Context, Result};

pub(crate) const OPTIONS: &[&str] = &["-S", "none", "-o", "ProxyCommand=none", "-o", "ForkAfterAuthentication=no", "-o", "PermitLocalCommand=no"];

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

