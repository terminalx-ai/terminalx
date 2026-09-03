//! Resource accounting for the processes Raccoon started.
//!
//! Sampling is deliberately explicit: this module owns no thread or timer.
//! The frontend invokes one sample when a focused window needs an honest badge
//! and every two seconds while the popover is open. On this development Mac,
//! twenty full `ps` snapshots took 1.21 seconds (about 60 ms each); paying that
//! only while the reader is looking was simpler and smaller than adding a
//! resident system-inspection dependency. `LC_ALL=C` is load-bearing because
//! the parser expects a decimal point in `%CPU`.

use std::collections::{HashMap, HashSet};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use serde::Serialize;

use crate::pty::{PaneInfo, Terminals};
use crate::store::{index, projects};

pub const CHANGED_EVENT: &str = "status_resources_changed";
const PS: &str = "/bin/ps";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceOverview {
    pub agent_count: usize,
    pub orphan_count: usize,
    pub rss_bytes: Option<u64>,
    pub pressure: Option<f32>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum KillRule {
    None,
    Idle,
    Confirm,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcSample {
    pub pane_id: String,
    pub tab_id: Option<String>,
    pub tab_title: String,
    pub session_id: Option<String>,
    pub session_title: Option<String>,
    pub project_path: Option<String>,
    pub project_name: Option<String>,
    pub cwd: String,
    pub kind: String,
    pub harness: Option<String>,
    pub orphaned: bool,
    pub pid: Option<u32>,
    pub cpu_percent: Option<f32>,
    pub rss_bytes: Option<u64>,
    pub child_count: Option<usize>,
    pub kill_rule: KillRule,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSample {
    pub main_pid: u32,
    pub main_cpu_percent: Option<f32>,
    pub main_rss_bytes: Option<u64>,
    pub webview_cpu_percent: Option<f32>,
    pub webview_rss_bytes: Option<u64>,
    pub webview_process_count: usize,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostSample {
    pub total_bytes: Option<u64>,
    pub available_bytes: Option<u64>,
    pub cores: usize,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSnapshot {
    pub processes: Vec<ProcSample>,
    pub app: AppSample,
    pub host: HostSample,
    pub total_cpu_percent: Option<f32>,
    pub total_rss_bytes: Option<u64>,
    pub sampled_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KillResult {
    pub killed: bool,
    pub confirmation: Option<String>,
}

#[derive(Debug, Clone)]
struct Process {
    pid: u32,
    ppid: u32,
    cpu_percent: f32,
    rss_bytes: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct Aggregate {
    cpu_percent: f32,
    rss_bytes: u64,
    child_count: usize,
    process_count: usize,
}

#[derive(Default)]
struct ProcessTable {
    by_pid: HashMap<u32, Process>,
    children: HashMap<u32, Vec<u32>>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(i64::MAX as u128) as i64
}

fn parse_ps(input: &str) -> ProcessTable {
    let mut by_pid = HashMap::new();
    for line in input.lines() {
        let mut fields = line.split_whitespace();
        let (Some(pid), Some(ppid), Some(cpu), Some(rss)) = (fields.next(), fields.next(), fields.next(), fields.next()) else { continue };
        let (Ok(pid), Ok(ppid), Ok(cpu_percent), Ok(rss_kib)) = (pid.parse(), ppid.parse(), cpu.parse(), rss.parse::<u64>()) else { continue };
        by_pid.insert(pid, Process { pid, ppid, cpu_percent, rss_bytes: rss_kib.saturating_mul(1024) });
    }
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for process in by_pid.values() {
        children.entry(process.ppid).or_default().push(process.pid);
    }
    ProcessTable { by_pid, children }
}

fn aggregate(root: u32, table: &ProcessTable, claimed: &mut HashSet<u32>) -> Option<Aggregate> {
    if !table.by_pid.contains_key(&root) {
        return None;
    }
    let mut out = Aggregate::default();
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if let Some(children) = table.children.get(&pid) {
            stack.extend(children.iter().copied());
        }
        let Some(process) = table.by_pid.get(&pid) else { continue };
        if !claimed.insert(pid) {
            continue;
        }
        out.cpu_percent += process.cpu_percent;
        out.rss_bytes = out.rss_bytes.saturating_add(process.rss_bytes);
        out.process_count += 1;
        if pid != root {
            out.child_count += 1;
        }
    }
    (out.process_count > 0).then_some(out)
}

fn attribute_roots(roots: &[(String, u32)], table: &ProcessTable, claimed: &mut HashSet<u32>) -> HashMap<String, Option<Aggregate>> {
    roots.iter().map(|(key, pid)| (key.clone(), aggregate(*pid, table, claimed))).collect()
}

fn ps_table() -> Result<ProcessTable> {
    let output = Command::new(PS)
        .args(["-eo", "pid=,ppid=,pcpu=,rss="])
        .env("LC_ALL", "C")
        .output()
        .context("sample processes")?;
    if !output.status.success() {
        bail!("ps exited {}", output.status);
    }
    Ok(parse_ps(&String::from_utf8_lossy(&output.stdout)))
}

fn sysctl_u64(name: &str) -> Option<u64> {
    let output = Command::new("/usr/sbin/sysctl").args(["-n", name]).output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().parse().ok()).flatten()
}

fn host_total() -> Option<u64> {
    static TOTAL: OnceLock<Option<u64>> = OnceLock::new();
    *TOTAL.get_or_init(|| sysctl_u64("hw.memsize"))
}

fn parse_vm_available(input: &str) -> Option<u64> {
    let page_size = input.lines().next()?.split("page size of ").nth(1)?.split_whitespace().next()?.parse::<u64>().ok()?;
    let wanted = ["Pages free", "Pages inactive", "Pages speculative"];
    let pages = input.lines().filter_map(|line| {
        let (key, value) = line.split_once(':')?;
        wanted.contains(&key.trim()).then(|| value.trim().trim_end_matches('.').parse::<u64>().ok()).flatten()
    }).sum::<u64>();
    Some(pages.saturating_mul(page_size))
}

fn host_sample() -> HostSample {
    let available_bytes = Command::new("/usr/bin/vm_stat")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| parse_vm_available(&String::from_utf8_lossy(&output.stdout)));
    HostSample {
        total_bytes: host_total(),
        available_bytes,
        cores: std::thread::available_parallelism().map(usize::from).unwrap_or(1),
    }
}

fn bound_pane(pane: &PaneInfo, sessions: &[index::SessionEntry], project_names: &HashMap<String, String>, aggregate: Option<Aggregate>) -> ProcSample {
    if let Some(tab_id) = pane.id.strip_prefix("tab:") {
        if let Some((session, tab)) = sessions.iter().find_map(|session| session.tab(tab_id).map(|tab| (session, tab))) {
            return ProcSample {
                pane_id: pane.id.clone(),
                tab_id: Some(tab_id.to_string()),
                tab_title: tab.title.clone().unwrap_or_else(|| if tab.harness == "claude" { "Claude".into() } else { "Codex".into() }),
                session_id: Some(session.id.clone()),
                session_title: Some(session.title.clone()),
                project_path: Some(session.project_path.clone()),
                project_name: project_names.get(&session.project_path).cloned().or_else(|| Some(projects::project_name(&session.project_path))),
                cwd: pane.cwd.clone(),
                kind: "agent".into(),
                harness: Some(tab.harness.clone()),
                orphaned: false,
                pid: pane.pid,
                cpu_percent: aggregate.map(|sample| sample.cpu_percent),
                rss_bytes: aggregate.map(|sample| sample.rss_bytes),
                child_count: aggregate.map(|sample| sample.child_count),
                kill_rule: KillRule::None,
            };
        }
        return ProcSample {
            pane_id: pane.id.clone(),
            tab_id: Some(tab_id.to_string()),
            tab_title: "Orphaned agent".into(),
            session_id: None,
            session_title: None,
            project_path: None,
            project_name: None,
            cwd: pane.cwd.clone(),
            kind: "agent".into(),
            harness: None,
            orphaned: true,
            pid: pane.pid,
            cpu_percent: aggregate.map(|sample| sample.cpu_percent),
            rss_bytes: aggregate.map(|sample| sample.rss_bytes),
            child_count: aggregate.map(|sample| sample.child_count),
            kill_rule: KillRule::Confirm,
        };
    }

    let session = sessions
        .iter()
        .find(|session| pane.id.starts_with(&format!("{}:", session.id)))
        .or_else(|| sessions.iter().find(|session| session.cwd == pane.cwd));
    let child_count = aggregate.map(|sample| sample.child_count);
    ProcSample {
        pane_id: pane.id.clone(),
        tab_id: None,
        tab_title: "Terminal shell".into(),
        session_id: session.map(|session| session.id.clone()),
        session_title: session.map(|session| session.title.clone()),
        project_path: session.map(|session| session.project_path.clone()),
        project_name: session.map(|session| {
            project_names.get(&session.project_path).cloned().unwrap_or_else(|| projects::project_name(&session.project_path))
        }),
        cwd: pane.cwd.clone(),
        kind: "shell".into(),
        harness: None,
        orphaned: session.is_none(),
        pid: pane.pid,
        cpu_percent: aggregate.map(|sample| sample.cpu_percent),
        rss_bytes: aggregate.map(|sample| sample.rss_bytes),
        child_count,
        kill_rule: if child_count == Some(0) { KillRule::Idle } else { KillRule::Confirm },
    }
}

fn pressure(host: &HostSample) -> Option<f32> {
    let (Some(total), Some(available)) = (host.total_bytes, host.available_bytes) else { return None };
    (total > 0).then(|| (1.0 - available.min(total) as f32 / total as f32).clamp(0.0, 1.0))
}

fn add_options(values: impl Iterator<Item = Option<f32>>) -> Option<f32> {
    let mut measured = false;
    let total = values.flatten().inspect(|_| measured = true).sum();
    measured.then_some(total)
}

fn add_bytes(values: impl Iterator<Item = Option<u64>>) -> Option<u64> {
    let mut measured = false;
    let total = values.flatten().inspect(|_| measured = true).fold(0_u64, u64::saturating_add);
    measured.then_some(total)
}

#[derive(Default)]
pub struct ResourceStore {
    last_rss: Mutex<Option<u64>>,
    last_pressure: Mutex<Option<f32>>,
}

impl ResourceStore {
    pub fn overview(&self, terminals: &Terminals) -> ResourceOverview {
        let panes = terminals.panes();
        ResourceOverview {
            agent_count: panes.iter().filter(|pane| pane.running && pane.id.starts_with("tab:")).count(),
            orphan_count: orphan_count(&panes),
            rss_bytes: *self.last_rss.lock().unwrap(),
            pressure: *self.last_pressure.lock().unwrap(),
        }
    }

    pub fn sample(&self, terminals: &Terminals) -> Result<ResourceSnapshot> {
        let mut panes: Vec<_> = terminals.panes().into_iter().filter(|pane| pane.running).collect();
        panes.sort_by(|a, b| a.id.cmp(&b.id));
        let mut table = ps_table()?;
        let app_pid = std::process::id();
        let dead_direct_children: Vec<_> = table
            .by_pid
            .values()
            .filter(|process| process.ppid == app_pid && !crate::harness::host::is_alive(process.pid))
            .map(|process| process.pid)
            .collect();
        for pid in dead_direct_children {
            table.by_pid.remove(&pid);
        }
        table.children.clear();
        for process in table.by_pid.values() {
            table.children.entry(process.ppid).or_default().push(process.pid);
        }

        let roots: Vec<_> = panes.iter().filter_map(|pane| pane.pid.map(|pid| (pane.id.clone(), pid))).collect();
        let mut claimed = HashSet::new();
        let attributed = attribute_roots(&roots, &table, &mut claimed);
        let sessions = index::load().unwrap_or_default();
        let project_names: HashMap<_, _> = projects::list()
            .map(|(projects, _)| projects.into_iter().map(|project| (project.path, project.name)).collect())
            .unwrap_or_default();
        let processes: Vec<_> = panes
            .iter()
            .map(|pane| bound_pane(pane, &sessions, &project_names, attributed.get(&pane.id).copied().flatten()))
            .collect();

        let main = table.by_pid.get(&app_pid).filter(|_| claimed.insert(app_pid));
        let mut webview = Aggregate::default();
        if let Some(children) = table.children.get(&app_pid) {
            for child in children {
                if let Some(sample) = aggregate(*child, &table, &mut claimed) {
                    webview.cpu_percent += sample.cpu_percent;
                    webview.rss_bytes = webview.rss_bytes.saturating_add(sample.rss_bytes);
                    webview.process_count += sample.process_count;
                }
            }
        }
        let app = AppSample {
            main_pid: app_pid,
            main_cpu_percent: main.map(|process| process.cpu_percent),
            main_rss_bytes: main.map(|process| process.rss_bytes),
            webview_cpu_percent: (webview.process_count > 0).then_some(webview.cpu_percent),
            webview_rss_bytes: (webview.process_count > 0).then_some(webview.rss_bytes),
            webview_process_count: webview.process_count,
        };
        let host = host_sample();
        let total_cpu_percent = add_options(
            processes
                .iter()
                .map(|process| process.cpu_percent)
                .chain([app.main_cpu_percent, app.webview_cpu_percent]),
        );
        let total_rss_bytes = add_bytes(
            processes
                .iter()
                .map(|process| process.rss_bytes)
                .chain([app.main_rss_bytes, app.webview_rss_bytes]),
        );
        let snapshot = ResourceSnapshot { processes, app, host, total_cpu_percent, total_rss_bytes, sampled_at: now_ms() };
        *self.last_rss.lock().unwrap() = snapshot.total_rss_bytes;
        *self.last_pressure.lock().unwrap() = pressure(&snapshot.host);
        Ok(snapshot)
    }

    pub fn kill(&self, terminals: &Terminals, pane_id: &str, confirmed: bool) -> Result<KillResult> {
        let snapshot = self.sample(terminals)?;
        let process = snapshot.processes.iter().find(|process| process.pane_id == pane_id).context("that process is no longer running")?;
        if process.kill_rule == KillRule::None {
            bail!("An agent bound to a tab cannot be stopped here; close its tab instead.");
        }
        if process.kill_rule == KillRule::Confirm && !confirmed {
            let subject = process.session_title.as_deref().unwrap_or(&process.tab_title);
            return Ok(KillResult {
                killed: false,
                confirmation: Some(format!("Kill {subject}? Its running command, unfinished work, and terminal output will be lost.")),
            });
        }
        terminals.kill_and_wait(pane_id, std::time::Duration::from_secs(3));
        Ok(KillResult { killed: true, confirmation: None })
    }
}

fn orphan_count(panes: &[PaneInfo]) -> usize {
    let tabs: HashSet<_> = index::load()
        .unwrap_or_default()
        .into_iter()
        .flat_map(|session| session.tabs.into_iter().map(|tab| tab.id))
        .collect();
    panes
        .iter()
        .filter(|pane| pane.running && pane.id.strip_prefix("tab:").is_some_and(|tab| !tabs.contains(tab)))
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("fixtures/ps_macos.txt");

    #[test]
    fn parses_lc_all_c_ps_fixture() {
        let table = parse_ps(FIXTURE);
        assert_eq!(table.by_pid[&410].ppid, 400);
        assert_eq!(table.by_pid[&410].cpu_percent, 12.5);
        assert_eq!(table.by_pid[&410].rss_bytes, 4096 * 1024);
    }

    #[test]
    fn overlapping_subtrees_claim_every_pid_once() {
        let table = parse_ps(FIXTURE);
        let mut claimed = HashSet::new();
        let samples = attribute_roots(&[("parent".into(), 400), ("child".into(), 410)], &table, &mut claimed);
        assert_eq!(samples["parent"].unwrap().process_count, 3);
        assert_eq!(samples["child"], None);
        assert_eq!(claimed, HashSet::from([400, 410, 411]));
    }

    #[test]
    fn vm_stat_available_memory_uses_page_size() {
        let fixture = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nPages inactive: 20.\nPages speculative: 3.\n";
        assert_eq!(parse_vm_available(fixture), Some(33 * 16_384));
    }

    #[test]
    fn process_sampling_has_no_background_loop() {
        let source = include_str!("resources.rs");
        let command = ["Command::new", "(PS)"].concat();
        let sleep = ["thread::", "sleep"].concat();
        let spawn = ["thread::", "spawn"].concat();
        assert_eq!(source.matches(&command).count(), 1);
        assert!(!source.contains(&sleep));
        assert!(!source.contains(&spawn));
    }

    #[test]
    fn bound_agents_never_have_a_kill_rule() {
        let pane = PaneInfo { id: "tab:t1".into(), pid: Some(400), running: true, cwd: "/work".into() };
        let tab = index::TabEntry {
            id: "t1".into(), harness: "claude".into(), title: None, model: String::new(), effort: None,
            permission_mode: "auto".into(), provider_session_id: None, status: index::TabStatus::Idle,
            created: String::new(), modified: String::new(), context_used: None, context_max: None,
            fork_from: None, unknown: Default::default(),
        };
        let session = index::SessionEntry {
            id: "s1".into(), project_path: "/work".into(), cwd: "/work".into(), worktree_name: None,
            branch: None, base_ref: None, worktree_removed: false, issue: None, automation: None,
            title: "Safe session".into(),
            created: String::new(), modified: String::new(), archived: false, pinned: false, tabs: vec![tab],
            active_tab: Some("t1".into()), unknown: Default::default(),
        };
        let process = bound_pane(&pane, &[session], &HashMap::new(), Some(Aggregate::default()));
        assert_eq!(process.kill_rule, KillRule::None);
    }

    #[test]
    fn an_agent_pane_without_its_tab_requires_confirmation() {
        let pane = PaneInfo { id: "tab:gone".into(), pid: Some(400), running: true, cwd: "/work".into() };
        let process = bound_pane(&pane, &[], &HashMap::new(), Some(Aggregate::default()));
        assert!(process.orphaned);
        assert_eq!(process.kill_rule, KillRule::Confirm);
    }

    #[test]
    fn only_a_childless_shell_skips_confirmation() {
        let pane = PaneInfo { id: "shell:1".into(), pid: Some(400), running: true, cwd: "/work".into() };
        let idle = bound_pane(&pane, &[], &HashMap::new(), Some(Aggregate::default()));
        let busy = bound_pane(&pane, &[], &HashMap::new(), Some(Aggregate { child_count: 1, process_count: 2, ..Aggregate::default() }));
        assert_eq!(idle.kill_rule, KillRule::Idle);
        assert_eq!(busy.kill_rule, KillRule::Confirm);
    }
}
