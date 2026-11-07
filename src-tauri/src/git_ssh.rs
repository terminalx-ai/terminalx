//! Contain app-owned SSH without changing Git's configured transport grammar.
use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::Path;
use std::process::Command;

use anyhow::Result;

fn config(cwd: &Path, key: &str) -> Option<String> {
    super::run(cwd, &["config", "--get", key]).ok().map(|mut value| {
        // Remove Git's record terminator, not whitespace belonging to the value.
        if value.ends_with('\n') { value.pop(); }
        value
    })
}

fn quote(value: &OsStr) -> OsString {
    let mut quoted = vec![b'\''];
    for &byte in value.as_bytes() {
        if byte == b'\'' { quoted.extend_from_slice(b"'\\''"); }
        else { quoted.push(byte); }
    }
    quoted.push(b'\'');
    OsString::from_vec(quoted)
}

/// Match Git's split_cmdline rules for the first word, including validating the
/// rest of the command. This is only basename detection, never shell execution.
fn command_word(command: &OsStr) -> Option<OsString> {
    let mut bytes = command.as_bytes().iter().copied();
    let mut word = Vec::new();
    let mut quoted = None;
    let mut first = true;
    while let Some(byte) = bytes.next() {
        match (quoted, byte) {
            (None, b' ' | b'\t' | b'\r' | b'\n' | 11 | 12) => first = false,
            (None, b'\'' | b'"') => quoted = Some(byte),
            (Some(end), byte) if end == byte => quoted = None,
            (quote, b'\\') if quote != Some(b'\'') => {
                let byte = bytes.next()?;
                if first { word.push(byte); }
            }
            (_, byte) => { if first { word.push(byte); } }
        }
    }
    quoted.is_none().then(|| OsString::from_vec(word))
}

enum Variant { OpenSsh, Other, Detect }

fn variant(explicit: Option<&OsStr>, executable: Option<&OsStr>) -> Variant {
    match explicit.map(OsStr::as_bytes) {
        Some(b"simple" | b"plink" | b"putty" | b"tortoiseplink") => return Variant::Other,
        None | Some(b"auto") => {}
        // Git documents *every* unrecognized explicit value as OpenSSH.
        Some(_) => return Variant::OpenSsh,
    }
    let basename = executable.and_then(|value| Path::new(value).file_name())
        .map(|value| value.as_bytes().to_ascii_lowercase());
    match basename.as_deref() {
        Some(b"ssh" | b"ssh.exe") => Variant::OpenSsh,
        Some(b"plink" | b"plink.exe" | b"tortoiseplink" | b"tortoiseplink.exe") => Variant::Other,
        _ => Variant::Detect,
    }
}

/// Prepare only the non-recursive verification fetch for this repository.
/// Keep the returned directory alive until the admitted Git group is drained.
/// Known variants need no probe. For an unknown basename, Git itself supplies
/// the -G probe, host, port and protocol arguments, and selects ssh or simple.
pub(super) fn contain(cwd: &Path, command: &mut Command) -> Result<Option<tempfile::TempDir>> {
    let explicit = std::env::var_os("GIT_SSH_VARIANT")
        .or_else(|| config(cwd, "ssh.variant").map(OsString::from));
    let configured = std::env::var_os("GIT_SSH_COMMAND")
        .or_else(|| config(cwd, "core.sshCommand").map(OsString::from));
    let (mut effective, executable) = if let Some(configured) = configured {
        let executable = command_word(&configured);
        (configured, executable)
    } else {
        let executable = std::env::var_os("GIT_SSH").unwrap_or_else(|| "ssh".into());
        (quote(&executable), Some(executable))
    };
    match variant(explicit.as_deref(), executable.as_deref()) {
        Variant::Other => Ok(None), // Leave Git's original selection and arguments alone.
        Variant::OpenSsh => {
            // The final -S overrides an earlier -S/ControlPath without changing
            // configured keys, ports or proxies. -o settings alone are first-wins.
            effective.push(" -S none");
            command.env("GIT_SSH_COMMAND", effective);
            Ok(None)
        }
        Variant::Detect => {
            let directory = tempfile::tempdir()?;
            let script = directory.path().join("transport");
            let state = quote(directory.path().as_os_str());
            // Git appends "$@" to a shell command. Preserve that exact command,
            // including its own arguments, rather than interpreting it here.
            let argv0 = quote(&effective);
            effective.push(" \"$@\"");
            let invocation = quote(&effective);
            let mut source = b"#!/bin/sh\nstate=".to_vec();
            source.extend_from_slice(state.as_bytes());
            source.extend_from_slice(b"/\"$PPID\"\nrun() { /bin/sh -c ");
            source.extend_from_slice(invocation.as_bytes());
            source.push(b' ');
            source.extend_from_slice(argv0.as_bytes());
            source.extend_from_slice(b" \"$@\"; }\n\
if [ \"$1\" = -G ]; then\n\
  : > \"$state\" || exit 1\n\
  run \"$@\"\n\
  result=$?\n\
  selected=simple\n\
  if [ \"$result\" = 0 ]; then selected=ssh; fi\n\
  printf '%s\\n' \"$selected\" > \"$state\" || exit 1\n\
  exit \"$result\"\n\
fi\n\
selected=\n\
if [ -f \"$state\" ]; then IFS= read -r selected < \"$state\"; fi\n\
case \"$selected\" in\n\
  ssh) set -- -S none \"$@\" ;;\n\
  simple) ;;\n\
  *) exit 1 ;;\n\
esac\n\
exec /bin/sh -c ");
            source.extend_from_slice(invocation.as_bytes());
            source.push(b' ');
            source.extend_from_slice(argv0.as_bytes());
            source.extend_from_slice(b" \"$@\"\n");
            std::fs::write(&script, source)?;
            // exec keeps PPID equal to the invoking Git process in both the
            // probe and transfer. Nothing is reused by a later request or
            // privacy generation. The verification fetch never enters submodules.
            let mut proxy = OsString::from("exec /bin/sh ");
            proxy.push(quote(script.as_os_str()));
            command.env("GIT_SSH_COMMAND", proxy).env("GIT_SSH_VARIANT", "auto");
            // No executable runs here. Git, its probe, wrapper and transfer all
            // run inside the original ticket's single admitted process group.
            Ok(Some(directory))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn privacy_fetch_preserves_git_ssh_variant_rules() {
        for command in ["'/key directory/SSH.exe' -i key", "\"/key directory/ssh\" -p 2222", "/key\\ directory/ssh -o 'ProxyCommand=proxy'"] {
            let word = command_word(OsStr::new(command)).unwrap();
            assert!(matches!(variant(None, Some(&word)), Variant::OpenSsh));
        }
        for command in ["/wrapper -i 'unclosed", "/wrapper trailing\\"] {
            assert!(command_word(OsStr::new(command)).is_none());
        }
        for name in ["plink", "PLINK.exe", "tortoiseplink", "TortoisePlink.EXE"] {
            assert!(matches!(variant(None, Some(OsStr::new(name))), Variant::Other));
        }
        // Git does not recognize the putty basename; its explicit variant does.
        assert!(matches!(variant(None, Some(OsStr::new("putty"))), Variant::Detect));
        for explicit in ["simple", "putty", "plink", "tortoiseplink"] {
            assert!(matches!(variant(Some(OsStr::new(explicit)), Some(OsStr::new("ssh"))), Variant::Other));
        }
        for explicit in ["ssh", "unrecognized", "", "AUTO"] {
            assert!(matches!(variant(Some(OsStr::new(explicit)), Some(OsStr::new("plink"))), Variant::OpenSsh));
        }
        assert!(matches!(variant(Some(OsStr::new("auto")), Some(OsStr::new("wrapper"))), Variant::Detect));
    }
}
