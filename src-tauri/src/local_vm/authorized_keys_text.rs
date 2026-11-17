//! The authorized_keys transformation, shared verbatim by the desktop helper
//! engine (`macos_bootstrap_helper`) and the guest account child
//! (`native/vm-bootstrap`, which includes this file by path). Standard library
//! only, so both crates compile exactly the same rules and run these tests.

/// The largest authorized_keys file either side reads or writes.
pub const KEYS_LIMIT: u64 = 64 * 1024;

/// The one restricted key line, without its newline, that `append` adds for
/// this bootstrap: what the first strict SSH connection later looks for.
pub fn line(public_key: &str, bootstrap_id: &str) -> String {
    format!("restrict {public_key} terminalx-bootstrap:{bootstrap_id}")
}

/// Appends one restricted key line marked with this bootstrap id. Existing
/// lines are never rewritten. Refuses non-text input, an existing bootstrap
/// marker, a duplicate key, or a result over the bound.
pub fn append(
    before: &[u8],
    public_key: &str,
    bootstrap_id: &str,
) -> Result<Vec<u8>, &'static str> {
    if before.len() as u64 > KEYS_LIMIT || before.contains(&0) {
        return Err("Unsupported original authorized_keys");
    }
    let text = std::str::from_utf8(before).map_err(|_| "Unsupported original authorized_keys")?;
    let blob = public_key.split_once(' ').ok_or("Public key missing")?.1;
    if text.contains("terminalx-bootstrap:") || text.split_whitespace().any(|part| part == blob) {
        return Err("Existing bootstrap key/marker cannot be adopted or duplicated");
    }
    let mut after = before.to_vec();
    if !after.is_empty() && after.last() != Some(&b'\n') {
        after.push(b'\n');
    }
    after.extend(line(public_key, bootstrap_id).as_bytes());
    after.push(b'\n');
    if after.len() as u64 > KEYS_LIMIT {
        return Err("Authorized keys would exceed bound");
    }
    Ok(after)
}

#[cfg(test)]
mod tests {
    use super::*;
    const KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH";

    #[test]
    fn appends_one_marked_restricted_line_and_keeps_existing_lines() {
        assert_eq!(
            append(b"", KEY, "boot").unwrap(),
            format!("restrict {KEY} terminalx-bootstrap:boot\n").into_bytes()
        );
        assert_eq!(
            append(b"ssh-rsa AAAA other", KEY, "boot").unwrap(),
            format!("ssh-rsa AAAA other\nrestrict {KEY} terminalx-bootstrap:boot\n").into_bytes()
        );
    }

    #[test]
    fn refuses_markers_duplicates_binary_and_oversize() {
        let blob = KEY.split_once(' ').unwrap().1;
        for before in [
            b"x terminalx-bootstrap:old\n".to_vec(),
            format!("ssh-ed25519 {blob}\n").into_bytes(),
            b"a\0b".to_vec(),
            vec![0xff, 0xfe],
            vec![b'a'; KEYS_LIMIT as usize + 1],
            vec![b'a'; KEYS_LIMIT as usize - 10],
        ] {
            assert!(append(&before, KEY, "boot").is_err(), "{}", before.len());
        }
        assert!(append(b"", "no-space", "boot").is_err());
    }
}
