//! Contain app-owned SSH without changing Git's configured transport grammar.
use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::{OsStrExt, OsStringExt};

#[path = "git_transfer_ssh.rs"]
mod transfer;
pub(crate) use transfer::prepare;
pub(crate) use transfer::run_cli;

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

#[cfg(test)]
mod tests {
    use super::*;
    use transfer::{variant, Variant};

    #[test]
    fn privacy_fetch_preserves_git_ssh_variant_rules() {
        for command in ["'/key directory/SSH.exe' -i key", "\"/key directory/ssh\" -p 2222", "/key\\ directory/ssh -o 'ProxyCommand=proxy'"] {
            let word = command_word(OsStr::new(command)).unwrap();
            assert!(matches!(variant(None, Some(&word)), Variant::Ssh));
        }
        for command in ["/wrapper -i 'unclosed", "/wrapper trailing\\"] {
            assert!(command_word(OsStr::new(command)).is_none());
        }
        for name in ["plink", "PLINK.exe", "tortoiseplink", "TortoisePlink.EXE"] {
            assert!(matches!(variant(None, Some(OsStr::new(name))), Variant::Simple | Variant::Putty | Variant::Tortoise));
        }
        // Git does not recognize the putty basename; its explicit variant does.
        assert!(matches!(variant(None, Some(OsStr::new("putty"))), Variant::Detect));
        for explicit in ["simple", "putty", "plink", "tortoiseplink"] {
            assert!(matches!(variant(Some(OsStr::new(explicit)), Some(OsStr::new("ssh"))), Variant::Simple | Variant::Putty | Variant::Tortoise));
        }
        for explicit in ["ssh", "unrecognized", "", "AUTO"] {
            assert!(matches!(variant(Some(OsStr::new(explicit)), Some(OsStr::new("plink"))), Variant::Ssh));
        }
        assert!(matches!(variant(Some(OsStr::new("auto")), Some(OsStr::new("wrapper"))), Variant::Detect));
    }
}
