//! A per-invocation SSH adapter, including recursive submodule transports.
//! Resolve configuration in the invoking Git child's directory, not once in
//! the superproject. The parent keeps one admission/process group until every
//! probe, transport and pipe is drained. This entry never starts app services.
use super::{command_word, quote};
use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

const ENTRY: &str = "--terminalx-git-ssh";

#[derive(Serialize, Deserialize)]
struct Settings {
    git: Vec<u8>,
    config_args: Vec<Vec<u8>>,
    // Git strips repository-local config environment before executing SSH.
    // Preserve the original command-line config, not the parent's local config.
    environment: Vec<(String, Option<Vec<u8>>)>,
}

fn environment(command: &Command, key: &str) -> Option<OsString> {
    command.get_envs().find(|(name, _)| *name == key)
        .map(|(_, value)| value.map(OsStr::to_os_string))
        .unwrap_or_else(|| std::env::var_os(key))
}

pub(crate) fn prepare(command: &mut Command) -> Result<tempfile::TempDir> {
    let mut keys = vec!["GIT_SSH_COMMAND".to_string(), "GIT_SSH".into(), "GIT_SSH_VARIANT".into(), "GIT_PROTOCOL".into(), "GIT_CONFIG_PARAMETERS".into(), "GIT_CONFIG_COUNT".into()];
    if let Some(count) = environment(command, "GIT_CONFIG_COUNT") {
        let count: usize = count.to_str().context("invalid Git config count")?.parse()?;
        anyhow::ensure!(count < 100_000, "too many Git config entries");
        for i in 0..count { keys.extend([format!("GIT_CONFIG_KEY_{i}"), format!("GIT_CONFIG_VALUE_{i}")]); }
    }
    let mut config_args = Vec::new();
    let mut args = command.get_args();
    while let Some(arg) = args.next() {
        let bytes = arg.as_bytes();
        if bytes == b"-c" || bytes == b"--config-env" {
            config_args.push(bytes.to_vec());
            config_args.push(args.next().context("missing Git config argument")?.as_bytes().to_vec());
        } else if bytes.starts_with(b"-c") || bytes.starts_with(b"--config-env=") {
            config_args.push(bytes.to_vec());
        } else { break; }
    }
    let settings = Settings { git: command.get_program().as_bytes().to_vec(), config_args,
        environment: keys.into_iter().map(|key| { let value = environment(command, &key).map(|v| v.into_vec()); (key, value) }).collect() };
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("transport.json");
    std::fs::write(&path, serde_json::to_vec(&settings)?)?;
    let mut proxy = OsString::from("exec ");
    proxy.push(quote(std::env::current_exe()?.as_os_str()));
    #[cfg(test)]
    proxy.push(" --exact git::ssh::transfer::tests::privacy_transport_child -- ");
    proxy.push(" "); proxy.push(ENTRY); proxy.push(" "); proxy.push(quote(path.as_os_str()));
    // libtest's startup text must not enter Git's protocol. The child restores
    // stdout before exec; production binaries enter directly in main().
    #[cfg(test)]
    proxy.push(" 3>&1 1>/dev/null");
    command.env("GIT_SSH_COMMAND", proxy).env("GIT_SSH_VARIANT", "ssh");
    Ok(directory)
}

impl Settings {
    fn env(&self, key: &str) -> Option<OsString> {
        self.environment.iter().find(|(name, _)| name == key).and_then(|(_, value)| value.clone()).map(OsString::from_vec)
    }

    fn config(&self, key: &str) -> Result<Option<OsString>> {
        let mut command = Command::new(OsString::from_vec(self.git.clone()));
        for (key, value) in &self.environment {
            if let Some(value) = value { command.env(key, OsString::from_vec(value.clone())); }
            else { command.env_remove(key); }
        }
        command.args(self.config_args.iter().cloned().map(OsString::from_vec));
        let out = command.args(["config", "--get", key]).env("GIT_NO_LAZY_FETCH", "1")
            .stdin(Stdio::null()).stderr(Stdio::piped()).output()?;
        if out.status.code() == Some(1) { return Ok(None); }
        anyhow::ensure!(out.status.success(), "read Git transport config: {}", String::from_utf8_lossy(&out.stderr));
        let mut value = out.stdout;
        if value.last() == Some(&b'\n') { value.pop(); }
        Ok(Some(OsString::from_vec(value)))
    }
}

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Variant { Ssh, Simple, Putty, Tortoise, Detect }

pub(super) fn variant(explicit: Option<&OsStr>, word: Option<&OsStr>) -> Variant {
    match explicit.map(OsStr::as_bytes) {
        Some(b"simple") => return Variant::Simple,
        Some(b"putty" | b"plink") => return Variant::Putty,
        Some(b"tortoiseplink") => return Variant::Tortoise,
        None | Some(b"auto") => {}
        Some(_) => return Variant::Ssh,
    }
    match word.and_then(|w| std::path::Path::new(w).file_name()).map(|w| w.as_bytes().to_ascii_lowercase()).as_deref() {
        Some(b"ssh" | b"ssh.exe") => Variant::Ssh,
        Some(b"plink" | b"plink.exe") => Variant::Putty,
        Some(b"tortoiseplink" | b"tortoiseplink.exe") => Variant::Tortoise,
        _ => Variant::Detect,
    }
}

fn transport(effective: &OsStr, shell: bool) -> Command {
    if !shell { return Command::new(effective); }
    let mut invocation = effective.to_os_string(); invocation.push(" \"$@\"");
    let mut command = Command::new("/bin/sh");
    command.arg("-c").arg(invocation).arg(effective);
    command
}

fn direct_configuration(bytes: &[u8]) -> Result<()> {
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
                bail!("App Git transfers cannot safely contain this SSH {key} route. Run Git in your terminal or agent, or configure a direct SSH connection; the app has not changed the route or started a transfer."),
            "forkafterauthentication" | "permitlocalcommand" if value != "no" =>
                bail!("App Git transfers cannot safely contain SSH {key}. Run Git in your terminal or agent, or disable that option for the app's SSH command."),
            _ => {}
        }
    }
    Ok(())
}

fn execute(settings: Settings, args: Vec<OsString>) -> Result<()> {
    anyhow::ensure!(args.len() >= 2, "missing Git SSH destination");
    let configured = match settings.env("GIT_SSH_COMMAND") { Some(v) => Some(v), None => settings.config("core.sshCommand")? };
    let shell = configured.is_some();
    let effective = configured.unwrap_or_else(|| settings.env("GIT_SSH").unwrap_or_else(|| "ssh".into()));
    let word = if shell { command_word(&effective) } else { Some(effective.clone()) };
    let explicit = match settings.env("GIT_SSH_VARIANT") { Some(v) => Some(v), None => settings.config("ssh.variant")? };
    let mut selected = variant(explicit.as_deref(), word.as_deref());
    if selected == Variant::Detect {
        // Same capability probe/arguments as Git, in the parent's admitted
        // group. A blocked probe is cancelled by that parent, not re-admitted.
        let status = transport(&effective, shell).arg("-G").args(&args[..args.len() - 1])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status()?;
        selected = if status.success() { Variant::Ssh } else { Variant::Simple };
    }
    let mut command = transport(&effective, shell);
    if selected == Variant::Ssh {
        // Probe the actual command too (Match command can select routing).
        // This runs inside the parent's original admitted/cancellable group.
        // A nested proxy can detach or reuse a master outside that group: do
        // not silently reroute it to a direct connection or kill its master.
        let configuration = transport(&effective, shell).arg("-G").args(&args)
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).output()?;
        anyhow::ensure!(configuration.status.success(), "Cannot verify configured SSH transport: {}", String::from_utf8_lossy(&configuration.stderr));
        direct_configuration(&configuration.stdout)?;
        // Last -S wins even when configured arguments supplied -S or -o
        // ControlPath earlier. No socket means neither reuse nor persistence;
        // direct keys/ports remain effective. Pin the verified absence of a
        // proxy/fork/local command before config is read again at execution.
        command.args(["-S", "none", "-o", "ProxyCommand=none", "-o", "ForkAfterAuthentication=no", "-o", "PermitLocalCommand=no"]).args(&args);
    } else {
        // The outer Git uses ssh grammar solely for this adapter. Reconstruct
        // the selected transport's grammar, including simple's refusals.
        let mut converted = Vec::new();
        let mut i = 0;
        let mut port = None;
        while i < args.len() - 2 {
            match args[i].as_bytes() {
                b"-o" if args.get(i + 1).is_some_and(|v| v == "SendEnv=GIT_PROTOCOL") => i += 2,
                b"-4" | b"-6" => {
                    anyhow::ensure!(selected != Variant::Simple, "ssh variant 'simple' does not support address-family options");
                    converted.push(args[i].clone()); i += 1;
                }
                b"-p" => {
                    anyhow::ensure!(selected != Variant::Simple, "ssh variant 'simple' does not support setting port");
                    port = Some(args.get(i + 1).context("missing SSH port")?.clone()); i += 2;
                }
                _ => bail!("unsupported Git SSH option"),
            }
        }
        if selected == Variant::Tortoise { converted.push("-batch".into()); }
        if let Some(port) = port { converted.extend(["-P".into(), port]); }
        command.args(converted).args(&args[args.len() - 2..]);
        if let Some(value) = settings.env("GIT_PROTOCOL") { command.env("GIT_PROTOCOL", value); }
        else { command.env_remove("GIT_PROTOCOL"); }
    }
    Err(command.exec().into())
}

pub(crate) fn run_cli() -> Option<i32> {
    let args: Vec<_> = std::env::args_os().collect();
    #[cfg(not(test))]
    let start = (args.get(1).is_some_and(|a| a == ENTRY)).then_some(1)?;
    #[cfg(test)]
    let start = args.iter().position(|a| a == ENTRY)?;
    let result = (|| {
        let path = args.get(start + 1).context("missing Git transport settings")?;
        let settings = serde_json::from_slice(&std::fs::read(path)?)?;
        execute(settings, args[start + 2..].to_vec())
    })();
    if let Err(error) = result { eprintln!("Git SSH transport: {error:#}"); }
    Some(1)
}

#[cfg(test)]
mod tests {
    #[test]
    fn privacy_transport_child() {
        if !std::env::args_os().any(|a| a == super::ENTRY) { return; }
        assert!(unsafe { libc::dup2(3, 1) } >= 0);
        unsafe { libc::close(3); }
        std::process::exit(super::run_cli().unwrap());
    }
}
