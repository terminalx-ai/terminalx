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

fn table() -> Result<String> {
    let output = std::process::Command::new("/bin/ps").args(["-eo", "pid=,ppid="]).env("LC_ALL", "C").output()?;
    if !output.status.success() { anyhow::bail!("cannot classify idle runtime processes"); }
    Ok(String::from_utf8(output.stdout)?)
}

pub(crate) fn safe(roots: &[u32]) -> Result<bool> {
    if roots.is_empty() { return Ok(true); }
    childless(&table()?, roots)
}

/// One row of the process table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Process {
    pub pid: u32,
    pub parent: u32,
    pub group: u32,
    /// The program's name: its command's first word, without a directory or
    /// a login shell's leading `-`.
    pub name: String,
}

/// The process table, for telling an agent's work from its helpers (#730).
pub(crate) fn processes() -> Result<Vec<Process>> {
    let output = std::process::Command::new("/bin/ps").args(["-eo", "pid=,ppid=,pgid=,comm="]).env("LC_ALL", "C").output()?;
    if !output.status.success() { anyhow::bail!("cannot read the process table"); }
    parse(std::str::from_utf8(&output.stdout)?)
}

/// `pid ppid pgid comm` lines, as [`processes`] reads them.
pub(crate) fn parse(table: &str) -> Result<Vec<Process>> {
    table.lines().filter(|line| !line.trim().is_empty()).map(|line| {
        let mut fields = line.split_whitespace();
        let mut number = || -> Result<u32> { Ok(fields.next().context("missing process field")?.parse()?) };
        let (pid, parent, group) = (number()?, number()?, number()?);
        let name = fields.next().map(|command| command.rsplit('/').next().unwrap_or(command).trim_start_matches('-').to_string()).unwrap_or_default();
        Ok(Process { pid, parent, group, name })
    }).collect()
}

/// How an agent's tools run a command: in a shell the agent starts.
const SHELLS: &[&str] = &["sh", "bash", "zsh", "dash", "fish", "ksh", "mksh", "tcsh", "csh", "nu"];

pub(crate) fn is_shell(process: &Process) -> bool { SHELLS.contains(&process.name.as_str()) }

/// Whether the agent whose process is `root` has work running beyond its own
/// helpers (#730): a shell it started, which is how its tools run a command,
/// with everything below it; or a process in its group no longer below it, as
/// a server is that a command left running after its shell exited. Its other
/// children are its MCP and language servers, with theirs: they start again
/// with the agent when its conversation resumes, so stopping them cuts
/// nothing short. Some start only when first used, mid-conversation, so the
/// time a process started does not tell them apart.
pub(crate) fn working(table: &[Process], root: u32) -> bool {
    let mut below = HashSet::new();
    let mut next = vec![root];
    while let Some(pid) = next.pop() {
        for child in table.iter().filter(|process| process.parent == pid && process.pid != pid) {
            if below.insert(child.pid) { next.push(child.pid); }
        }
    }
    table.iter().any(|process| process.parent == root && is_shell(process))
        || table.iter().any(|process| process.group == root && process.pid != root && !below.contains(&process.pid))
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

    /// #730 review: an agent's MCP and language servers are its own; a shell
    /// it started, and a server left in its group, are work.
    #[test]
    fn an_agents_helpers_are_told_from_the_work_its_tools_started() {
        // As this Mac showed: Claude Code (200) with npm-launched and native MCP servers.
        let helpers = "1 1 1 launchd\n100 1 100 terminalx-serve\n200 100 200 /Users/me/.local/bin/claude\n\
            201 200 200 npm exec rea-agents@6.4.0 mcp\n202 201 200 node\n203 202 200 sh\n204 200 200 cua\n205 200 200 rust-analyzer\n";
        let table = parse(helpers).unwrap();
        assert_eq!(table[2], Process { pid: 200, parent: 100, group: 200, name: "claude".into() });
        assert_eq!(table[3].name, "npm", "a process title's first word");
        assert!(!working(&table, 200), "helpers, a shell below one included, are not work");
        // A tool's command, in a shell the agent started, running past its turn.
        let tool = parse(&format!("{helpers}300 200 200 /bin/zsh\n301 300 200 node\n")).unwrap();
        assert!(working(&tool, 200));
        assert!(working(&parse(&format!("{helpers}300 200 200 -bash\n")).unwrap(), 200), "a login shell");
        // A server whose shell exited: under launchd, still in the agent's group.
        assert!(working(&parse(&format!("{helpers}400 1 200 node\n")).unwrap(), 200));
        assert!(!working(&parse(&format!("{helpers}400 1 400 node\n")).unwrap(), 200), "one in a group of its own is not the agent's");
        assert!(parse("200 x 200 claude\n").is_err());
    }
}
