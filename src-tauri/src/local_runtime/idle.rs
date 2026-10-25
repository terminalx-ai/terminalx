//! Conservative last check at the end of an idle grace, not a polling sampler.
//! A child or an unreadable process table is work we cannot safely discard.
use std::collections::HashSet;
use anyhow::{Context, Result};

fn childless(output: &str, roots: &[u32]) -> Result<bool> {
    let mut seen = HashSet::new();
    let mut parents = HashSet::new();
    for line in output.lines().filter(|line| !line.trim().is_empty()) {
        let mut fields = line.split_whitespace();
        let pid: u32 = fields.next().context("missing pid")?.parse()?;
        let parent: u32 = fields.next().context("missing parent")?.parse()?;
        if fields.next().is_some() { anyhow::bail!("unexpected process table field"); }
        seen.insert(pid);
        parents.insert(parent);
    }
    Ok(roots.iter().all(|pid| seen.contains(pid) && !parents.contains(pid)))
}

pub(crate) fn safe(roots: &[u32]) -> Result<bool> {
    if roots.is_empty() { return Ok(true); }
    let output = std::process::Command::new("/bin/ps").args(["-eo", "pid=,ppid="]).env("LC_ALL", "C").output()?;
    if !output.status.success() { anyhow::bail!("cannot classify idle runtime processes"); }
    childless(std::str::from_utf8(&output.stdout)?, roots)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_roots_children_and_malformed_tables_are_not_idle() {
        assert!(childless("1 0\n20 1\n", &[20]).unwrap());
        assert!(!childless("1 0\n20 1\n21 20\n", &[20]).unwrap());
        assert!(!childless("1 0\n", &[20]).unwrap());
        assert!(childless("20 unknown\n", &[20]).is_err());
        assert!(childless("20 1 extra\n", &[20]).is_err());
    }
}
