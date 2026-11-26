//! SSH files owned by TerminalX. All paths are explicit so tests never use
//! the person's ~/.ssh. Only public keys leave this module; private material
//! is produced/read by ssh-keygen through files, never stdout or argv.
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

pub(crate) const PRIVATE_SSHD: &str = "/opt/terminalx/openssh/usr/sbin/sshd";

/// OpenSSH portable versions use a patch suffix, such as OpenSSH_9.6p1.
/// Reject versions we cannot identify and bound the accepted version report.
pub(crate) fn supported_openssh_version(report: &[u8]) -> bool {
    if report.len() > 4096 {
        return false;
    }
    let Ok(report) = std::str::from_utf8(report) else {
        return false;
    };
    let Some(version) = report.lines().find_map(|line| {
        line.strip_prefix("OpenSSH_")?
            .split(|c: char| c == ',' || c.is_ascii_whitespace())
            .next()
    }) else {
        return false;
    };
    let (release, patch) = match version.split_once('p') {
        Some((release, patch)) => (release, patch.parse::<u32>().ok()),
        None => (version, Some(0)),
    };
    let Some((major, minor)) = release.split_once('.') else {
        return false;
    };
    let (Ok(major), Ok(minor), Some(patch)) = (major.parse::<u32>(), minor.parse::<u32>(), patch)
    else {
        return false;
    };
    (major, minor, patch) >= (9, 6, 1)
}

/// The caller supplies proof from the isolated daemon's configuration check.
/// Keep the bootstrap header unchanged whenever readiness or that proof is held.
pub(crate) fn ssh_capability_suffix(
    organization_ready: bool,
    version_report: &[u8],
    configuration_checked: bool,
) -> &'static str {
    if organization_ready && configuration_checked && supported_openssh_version(version_report) {
        ",workspace-ssh-v1,workspace-ssh-v2"
    } else {
        ""
    }
}

pub fn parse_public_key(text: &str) -> Option<String> {
    let mut fields = text.split_ascii_whitespace();
    if fields.next()? != "ssh-ed25519" {
        return None;
    }
    let encoded = fields.next()?;
    if fields.next().is_some() {
        return None;
    }
    let blob = STANDARD.decode(encoded).ok()?;
    if blob.len() != 51
        || &blob[..4] != [0, 0, 0, 11]
        || &blob[4..15] != b"ssh-ed25519"
        || &blob[15..19] != [0, 0, 0, 32]
        || STANDARD.encode(&blob) != encoded
    {
        return None;
    }
    Some(format!("ssh-ed25519 {encoded}"))
}

pub fn private_directory(path: &Path) -> Result<()> {
    if path.exists() {
        let meta = fs::symlink_metadata(path)?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            bail!("SSH directory must be a real directory");
        }
    } else {
        fs::create_dir_all(path)?;
        #[cfg(unix)]
        fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
    }
    Ok(())
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Ok(meta) = fs::symlink_metadata(path) {
        if !meta.is_file() || meta.file_type().is_symlink() {
            bail!("SSH file must be a regular file");
        }
    }
    let mut temp =
        tempfile::NamedTempFile::new_in(path.parent().context("SSH file has no parent")?)?;
    #[cfg(unix)]
    fs::set_permissions(
        temp.path(),
        std::os::unix::fs::PermissionsExt::from_mode(0o600),
    )?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(path)
        .map_err(|_| anyhow::anyhow!("could not replace SSH file"))?;
    Ok(())
}

/// Existing private keys are never overwritten, including when a concurrent
/// setup created the same key. Encrypted keys need the user's agent/tooling.
pub fn public_key(path: &Path, generate: bool) -> Result<String> {
    if !path.exists() {
        if !generate {
            bail!("SSH private key path does not exist");
        }
        let parent = path.parent().context("SSH key has no parent")?;
        private_directory(parent)?;
        let temporary = tempfile::tempdir_in(parent)?;
        let generated = temporary.path().join("key");
        let status = std::process::Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-C", "terminalx", "-f"])
            .arg(&generated)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()?;
        if !status.success() {
            bail!("SSH key generation failed");
        }
        // Hard-link is a no-clobber publish. Private bytes never enter Rust.
        fs::hard_link(&generated, path).context("SSH key already exists or cannot be saved")?;
    }
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        bail!("SSH private key must be a regular file");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o077 != 0 {
            bail!("SSH private key must be accessible only to its owner");
        }
    }
    let answer = std::process::Command::new("ssh-keygen")
        .args(["-y", "-f"])
        .arg(path)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()?;
    if !answer.status.success() {
        bail!("Could not read the SSH public key; use an unlocked Ed25519 key");
    }
    let text = String::from_utf8(answer.stdout)?;
    // ssh-keygen may append the comment from an existing key; it is never
    // sent to the API or used as authorized_keys options.
    let canonical = text
        .split_ascii_whitespace()
        .take(2)
        .collect::<Vec<_>>()
        .join(" ");
    parse_public_key(&canonical).context("SSH requires an Ed25519 public key")
}

pub fn config_quote(value: &str) -> Result<String> {
    if value
        .chars()
        .any(|c| c.is_control() || c == '%' || c == '$')
    {
        bail!("Unsupported character in SSH path");
    }
    Ok(format!(
        "\"{}\"",
        value.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
}

fn workspace_alias_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=63).contains(&bytes.len())
        && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
}

pub fn scope(user: &str, org: &str, workspace: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{user}\0{org}\0{workspace}"))
    )
}

/// One account/org/workspace Include. The caller must obtain explicit opt-in
/// before invoking. Unrelated SSH config bytes are retained verbatim.
pub fn install(
    ssh_dir: &Path,
    scope: &str,
    org: &str,
    workspace: &str,
    user: &str,
    identity: &Path,
    executable: &Path,
    host_key: &str,
) -> Result<String> {
    if !identifier(scope)
        || !identifier(org)
        || !identifier(user)
        || !workspace_alias_id(workspace)
        || user.starts_with('-')
    {
        bail!("Invalid SSH scope");
    }
    let host_key = parse_public_key(host_key).context("Invalid SSH host public key")?;
    private_directory(ssh_dir)?;
    let owned = ssh_dir.join("terminalx");
    private_directory(&owned)?;
    let _lock = file_lock(ssh_dir)?;
    let alias = format!("{workspace}.terminalx");
    let known = owned.join(format!("{scope}.known_hosts"));
    let include = owned.join(format!("{scope}.conf"));
    let executable = executable.to_string_lossy();
    config_quote(&executable)?;
    let shell = format!("'{}'", executable.replace('\'', "'\"'\"'"));
    let text = format!("# TerminalX workspace SSH\nHost {alias}\n  HostName {alias}\n  User {user}\n  IdentityFile {}\n  IdentitiesOnly yes\n  IdentityAgent none\n  UserKnownHostsFile {}\n  GlobalKnownHostsFile none\n  StrictHostKeyChecking yes\n  HostKeyAlgorithms ssh-ed25519\n  UpdateHostKeys no\n  ProxyCommand exec {shell} terminalx ssh-proxy --organization {org} --workspace {workspace} --scope {scope}\n", config_quote(&identity.to_string_lossy())?, config_quote(&known.to_string_lossy())?);
    let config = ssh_dir.join("config");
    let original = read_config(&config)?;
    let rest = remove_include(&original, scope, &include)?;
    // Include precedes the person's Host/Match blocks so it is global. Each
    // product file ends with Host * to restore context for following content.
    atomic_write(&known, format!("{alias} {host_key}\n").as_bytes())?;
    atomic_write(&include, format!("{text}Host *\n").as_bytes())?;
    let marker = format!(
        "# BEGIN TerminalX {scope}\nInclude {}\n# END TerminalX {scope}\n",
        config_quote(&include.to_string_lossy())?
    );
    let next = format!("{marker}{rest}");
    if original != next {
        atomic_write(&config, next.as_bytes())?;
    }
    Ok(format!("ssh {alias}"))
}

pub fn remove(ssh_dir: &Path, scope: &str) -> Result<()> {
    if !identifier(scope) {
        bail!("Invalid SSH scope");
    }
    if !ssh_dir.exists() {
        return Ok(());
    }
    private_directory(ssh_dir)?;
    let _lock = file_lock(ssh_dir)?;
    let config = ssh_dir.join("config");
    let original = read_config(&config)?;
    let owned = ssh_dir.join("terminalx");
    let next = remove_include(&original, scope, &owned.join(format!("{scope}.conf")))?;
    if original != next {
        atomic_write(&config, next.as_bytes())?;
    }
    if owned.exists() {
        private_directory(&owned)?;
    }
    for suffix in ["conf", "known_hosts"] {
        let file = owned.join(format!("{scope}.{suffix}"));
        if let Ok(meta) = fs::symlink_metadata(&file) {
            if !meta.is_file() || meta.file_type().is_symlink() {
                bail!("SSH managed file was replaced");
            }
            fs::remove_file(file)?;
        }
    }
    // Private keys, including generated keys, are deliberately preserved.
    Ok(())
}

fn read_config(path: &Path) -> Result<String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() => {
            bail!("SSH config must be a regular file")
        }
        Ok(_) => Ok(fs::read_to_string(path)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.into()),
    }
}

fn remove_include(text: &str, scope: &str, include: &Path) -> Result<String> {
    let begin = format!("# BEGIN TerminalX {scope}\n");
    let end = format!("# END TerminalX {scope}\n");
    let Some(start) = text.find(&begin) else {
        return Ok(text.to_string());
    };
    if start != 0 && text.as_bytes()[start - 1] != b'\n' {
        bail!("SSH Include marker was modified");
    }
    let tail = &text[start + begin.len()..];
    let stop = tail.find(&end).context("SSH Include marker was modified")?;
    let body = &tail[..stop];
    if body != format!("Include {}\n", config_quote(&include.to_string_lossy())?) {
        bail!("SSH Include was edited; remove it manually");
    }
    Ok(format!("{}{}", &text[..start], &tail[stop + end.len()..]))
}

fn file_lock(dir: &Path) -> Result<std::fs::File> {
    let path = dir.join(".terminalx.lock");
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            bail!("SSH config is being updated; try again");
        }
    }
    Ok(file)
}

/// Copy binary SSH bytes to an already authorized connection. EOF from the
/// caller closes only its write half so the server can finish its response.
#[allow(dead_code)]
pub(crate) fn bridge(
    mut input: impl std::io::Read + Send + 'static,
    output: &mut dyn Write,
    mut connection: std::net::TcpStream,
) -> std::io::Result<()> {
    use std::net::Shutdown;

    let mut writer = connection.try_clone()?;
    std::thread::Builder::new()
        .name("ssh-proxy-input".into())
        .spawn(move || {
            let copied = std::io::copy(&mut input, &mut writer);
            let _ = writer.shutdown(if copied.is_ok() {
                Shutdown::Write
            } else {
                Shutdown::Both
            });
        })?;
    let result = std::io::copy(&mut connection, output).and_then(|_| output.flush());
    let _ = connection.shutdown(Shutdown::Both);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn key() -> String {
        let mut blob = vec![0, 0, 0, 11];
        blob.extend(b"ssh-ed25519");
        blob.extend([0, 0, 0, 32]);
        blob.extend([9; 32]);
        format!("ssh-ed25519 {}", STANDARD.encode(blob))
    }
    #[test]
    fn workspace_ssh_advertisement_requires_readiness_and_a_usable_supported_daemon() {
        let minimum = b"OpenSSH_9.6p1 Ubuntu-3ubuntu13, OpenSSL 3.0.13";
        assert_eq!(
            ssh_capability_suffix(true, minimum, true),
            ",workspace-ssh-v1,workspace-ssh-v2"
        );
        assert_eq!(ssh_capability_suffix(false, minimum, true), "");
        assert_eq!(ssh_capability_suffix(true, minimum, false), "");
        for held in [
            b"".as_slice(),
            b"OpenSSH_9.5p9",
            b"OpenSSH_9.6",
            b"OpenSSH_9.6p0",
            b"Dropbear_2025.88",
            b"OpenSSH_10.0pbad",
        ] {
            assert_eq!(ssh_capability_suffix(true, held, true), "");
        }
        assert!(supported_openssh_version(b"OpenSSH_10.0p1"));
        assert!(!supported_openssh_version(&[b' '; 4097]));
    }

    #[test]
    fn phase2_workspace_ssh_proxy_preserves_binary_bytes_and_half_close() {
        use std::io::Read;
        use std::net::{Ipv4Addr, TcpListener, TcpStream};
        use std::time::Duration;

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        assert!(address.ip().is_loopback());
        let server = std::thread::spawn(move || {
            let (mut connection, _) = listener.accept().unwrap();
            connection
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = Vec::new();
            connection.read_to_end(&mut bytes).unwrap();
            assert_eq!(bytes, b"SSH-2.0-client\r\n\x00\xff");
            connection.write_all(b"SSH-2.0-server\r\n\xff\x00").unwrap();
        });
        let connection = TcpStream::connect(address).unwrap();
        connection
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = Vec::new();
        bridge(&b"SSH-2.0-client\r\n\x00\xff"[..], &mut bytes, connection).unwrap();
        assert_eq!(bytes, b"SSH-2.0-server\r\n\xff\x00");
        server.join().unwrap();
    }

    #[test]
    fn scoped_include_is_idempotent_quoted_and_removable_without_touching_keys() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("ssh directory");
        fs::create_dir(&dir).unwrap();
        let original = "Host personal\n  IdentityFile ~/.ssh/personal\nMatch all\n";
        fs::write(dir.join("config"), original).unwrap();
        let private = dir.join("existing key");
        fs::write(&private, b"untouched sentinel").unwrap();
        let apply = || {
            install(
                &dir,
                "scope",
                "org",
                "workspace",
                "worker",
                &private,
                Path::new("/App With Space/app"),
                &key(),
            )
            .unwrap()
        };
        assert_eq!(apply(), "ssh workspace.terminalx");
        let once = fs::read(dir.join("config")).unwrap();
        apply();
        assert_eq!(fs::read(dir.join("config")).unwrap(), once);
        let config = fs::read_to_string(dir.join("terminalx/scope.conf")).unwrap();
        assert!(config.contains("StrictHostKeyChecking yes"));
        assert!(config.contains("IdentityFile \""));
        assert!(config.ends_with("Host *\n"));
        remove(&dir, "scope").unwrap();
        remove(&dir, "scope").unwrap();
        assert_eq!(fs::read_to_string(dir.join("config")).unwrap(), original);
        assert_eq!(fs::read(private).unwrap(), b"untouched sentinel");
    }
    #[test]
    fn rejects_options_injection_and_expansions() {
        assert!(parse_public_key(&format!("command=evil {}", key())).is_none());
        assert!(parse_public_key("ssh-ed25519 aaaa").is_none());
        for path in ["path\nHost evil", "path%h", "${HOME}/key"] {
            assert!(config_quote(path).is_err());
        }
    }
    #[test]
    fn alias_is_one_dns_label_and_cannot_be_interpreted_as_a_command_option() {
        assert!(workspace_alias_id("wk-450"));
        for alias in ["-p", "--", "release.corp", "team_workspace", "wk-"] {
            assert!(!workspace_alias_id(alias), "{alias}");
        }
        assert!(!workspace_alias_id(&"a".repeat(64)));
    }

    #[test]
    fn preserves_an_include_retargeted_by_the_user() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("config");
        let original =
            "# BEGIN TerminalX scope\nInclude \"personal.conf\"\n# END TerminalX scope\n";
        fs::write(&config, original).unwrap();
        assert!(remove(temp.path(), "scope").is_err());
        assert_eq!(fs::read_to_string(config).unwrap(), original);
    }

    #[cfg(unix)]
    #[test]
    fn never_replaces_a_symlinked_personal_config() {
        let temp = tempfile::tempdir().unwrap();
        let other = temp.path().join("personal");
        fs::write(&other, "keep").unwrap();
        std::os::unix::fs::symlink(&other, temp.path().join("config")).unwrap();
        assert!(install(
            temp.path(),
            "scope",
            "org",
            "workspace",
            "worker",
            Path::new("/key"),
            Path::new("/app"),
            &key()
        )
        .is_err());
        assert_eq!(fs::read_to_string(other).unwrap(), "keep");
    }
}
