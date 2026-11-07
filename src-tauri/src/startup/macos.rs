//! Read only owned process trees through libproc, without spawning ps/sample
//! into the very launch failure we are observing. No command lines are read.
//! A small, single-threaded image with unchanged CPU and RSS is a *signature*,
//! not proof that dyld, security policy, or resource pressure caused a stall.
use std::collections::HashSet;
use super::{Category, Evidence, Launch, Phase, Snapshot};

const SMALL_IMAGE: u64 = 128 * 1024;
const MAX_PROCESSES: usize = 2048;

pub(super) struct Child {
    pane: String,
    pid: u32,
    birth: String,
    rss: u64,
    cpu: u64,
    threads: i32,
}

pub(super) struct Census {
    children: Vec<Child>,
    complete: bool,
}

fn bsd(pid: u32) -> Option<libc::proc_bsdinfo> {
    // SAFETY: proc_pidinfo writes at most the size supplied into this exact
    // SDK-defined POD type. A short/error reply is never read.
    unsafe {
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        (libc::proc_pidinfo(pid as i32, libc::PROC_PIDTBSDINFO, 0, info.as_mut_ptr().cast(), size) == size).then(|| info.assume_init())
    }
}

pub(super) fn identity(pid: u32) -> Option<String> {
    bsd(pid).map(|info| format!("{}:{}:{}", pid, info.pbi_start_tvsec, info.pbi_start_tvusec))
}

fn task(pid: u32) -> Option<libc::proc_taskinfo> {
    // SAFETY: as above, using the SDK's task-info type and exact length.
    unsafe {
        let mut info = std::mem::MaybeUninit::<libc::proc_taskinfo>::zeroed();
        let size = std::mem::size_of::<libc::proc_taskinfo>() as i32;
        (libc::proc_pidinfo(pid as i32, libc::PROC_PIDTASKINFO, 0, info.as_mut_ptr().cast(), size) == size).then(|| info.assume_init())
    }
}

pub(super) fn children(terminals: &crate::pty::Terminals, state: &Snapshot) -> Census {
    let mut census = Census { children: Vec::new(), complete: true };
    let mut seen = HashSet::new();
    let mut roots = Vec::new();
    for pane in terminals.panes().into_iter().filter(|pane| pane.running) {
        if pane.pid.and_then(identity).is_some_and(|birth| state.launches.iter().any(|launch|
            launch.evidence == Evidence::Readiness && launch.pane == pane.id && launch.pid == pane.pid && launch.pid_birth.as_deref() == Some(birth.as_str()))) {
            roots.push(pane);
        } else { census.complete = false; }
    }
    for launch in state.launches.iter().filter(|launch| launch.recorder.is_some() && launch.phase != Phase::Exited) {
        if launch.pid.and_then(identity).is_some_and(|birth| Some(birth) == launch.pid_birth) {
            roots.push(crate::pty::PaneInfo { id: launch.pane.clone(), pid: launch.pid, running: true, cwd: String::new() });
        } else { census.complete = false; }
    }
    for pane in roots {
        let Some(root) = pane.pid else { continue };
        let mut pending = vec![(root, None)];
        while let Some((pid, parent)) = pending.pop() {
            if seen.len() >= MAX_PROCESSES { census.complete = false; return census; }
            if !seen.insert(pid) { continue; }
            let Some(info) = bsd(pid) else { census.complete = false; continue };
            // Parentage is rechecked after listing; PID reuse never transfers
            // a stranger into this owned tree. Zombies are no startup evidence.
            if parent.is_some_and(|parent| info.pbi_ppid != parent) || info.pbi_status == libc::SZOMB { continue; }
            if let Some(task) = task(pid) {
                census.children.push(Child { pane: pane.id.clone(), pid,
                    birth: format!("{}:{}:{}", pid, info.pbi_start_tvsec, info.pbi_start_tvusec),
                    rss: task.pti_resident_size, cpu: task.pti_total_user.saturating_add(task.pti_total_system), threads: task.pti_threadnum });
            } else { census.complete = false; }
            let mut pids = [0i32; 256];
            // SAFETY: the fixed buffer and its length match; no strings or
            // environment values are requested. Unlike proc_listpids, this
            // wrapper returns a PID count, not the number of bytes written.
            let count = unsafe { libc::proc_listchildpids(pid as i32, pids.as_mut_ptr().cast(), std::mem::size_of_val(&pids) as i32) };
            if count < 0 || count as usize >= pids.len() { census.complete = false; }
            for child in pids.into_iter().take((count.max(0) as usize).min(256)).filter(|child| *child > 0) {
                pending.push((child as u32, Some(pid)));
            }
        }
    }
    census
}

pub(super) fn observe(state: &mut Snapshot, census: Census, permissions: &[String], at: i64) {
    if !census.complete && !state.census_incomplete { state.observation_lost_at = Some(at); }
    state.census_incomplete = !census.complete;
    let children = census.children;
    for launch in &mut state.launches {
        if !matches!(launch.phase, Phase::Spawning | Phase::AwaitingReady | Phase::PermissionPrompt | Phase::Running) { continue; }
        if launch.evidence == Evidence::SmallUnchangingImage && !children.iter().any(|child| child.birth == launch.generation) {
            // The process vanished or became unreadable. Neither is an exit
            // status. Keep unknown distinct, and require a fresh health probe.
            launch.phase = Phase::Unobserved;
            state.observation_lost_at = Some(at);
        }
    }
    for child in children {
        let permission = permissions.contains(&child.pane);
        let small = child.rss > 0 && child.rss <= SMALL_IMAGE && child.threads == 1;
        if !small {
            // A large/active application image disproves pre-main startup
            // suspicion even when a compile has never printed a byte.
            for launch in state.launches.iter_mut().filter(|launch| launch.pane == child.pane && launch.pid == Some(child.pid)
                && (launch.evidence != Evidence::SmallUnchangingImage || launch.generation == child.birth)) {
                if matches!(launch.phase, Phase::AwaitingReady | Phase::PermissionPrompt | Phase::Running | Phase::Unobserved) {
                    if permission { launch.phase = Phase::PermissionPrompt; launch.last_progress_at = at; }
                    else if launch.phase != Phase::Running { launch.phase = Phase::Running; launch.last_progress_at = at; }
                }
            }
            continue;
        }
        for launch in state.launches.iter_mut().filter(|launch| launch.evidence == Evidence::Readiness && launch.pane == child.pane && launch.pid == Some(child.pid) && launch.phase == Phase::AwaitingReady) {
            if launch.cpu_time.is_some_and(|cpu| cpu != child.cpu) || launch.resident_bytes.is_some_and(|rss| rss != child.rss) { launch.last_progress_at = at; }
            launch.cpu_time = Some(child.cpu);
            launch.resident_bytes = Some(child.rss);
        }
        if let Some(launch) = state.launches.iter_mut().find(|launch| launch.evidence == Evidence::SmallUnchangingImage && launch.generation == child.birth) {
            if launch.cpu_time != Some(child.cpu) || launch.resident_bytes != Some(child.rss) || permission || launch.phase == Phase::PermissionPrompt {
                launch.last_progress_at = at;
            }
            launch.phase = if permission { Phase::PermissionPrompt } else { Phase::AwaitingReady };
            launch.cpu_time = Some(child.cpu);
            launch.resident_bytes = Some(child.rss);
        } else {
            state.launches.push(Launch { id: uuid::Uuid::new_v4().to_string(), pane: child.pane, generation: child.birth, pid: Some(child.pid),
                category: Category::OwnedChild, evidence: Evidence::SmallUnchangingImage,
                phase: if permission { Phase::PermissionPrompt } else { Phase::AwaitingReady }, started_at: at, last_progress_at: at,
                exit_code: None, cpu_time: Some(child.cpu), resident_bytes: Some(child.rss), pid_birth: None, recorder: None, pipeline_id: None, recorder_owner: None, recorder_exit: None });
        }
    }
}

pub(super) fn version() -> serde_json::Value {
    fn read(name: &std::ffi::CStr) -> Option<String> {
        let mut bytes = [0u8; 128];
        let mut len = bytes.len();
        // SAFETY: fixed valid output buffer; no new value is supplied.
        if unsafe { libc::sysctlbyname(name.as_ptr(), bytes.as_mut_ptr().cast(), &mut len, std::ptr::null_mut(), 0) } != 0 { return None; }
        let text = std::str::from_utf8(bytes.get(..len)?.strip_suffix(&[0]).unwrap_or(&bytes[..len])).ok()?;
        // Version/build grammar only; never an arbitrary sysctl string.
        text.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'.').then(|| text.to_string())
    }
    serde_json::json!({ "version": read(c"kern.osproductversion"), "build": read(c"kern.osversion") })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn child(rss: u64, cpu: u64) -> Child { Child { pane: "tab:a".into(), pid: 1, birth: "1:2:3".into(), rss, cpu, threads: 1 } }
    fn observe(state: &mut Snapshot, children: Vec<Child>, permissions: &[String], at: i64) {
        super::observe(state, Census { children, complete: true }, permissions, at);
    }
    #[test]
    fn unchanged_small_images_correlate_but_progress_and_large_compiles_do_not() {
        let mut state = Snapshot::default();
        observe(&mut state, vec![child(96 * 1024, 10)], &[], 0);
        observe(&mut state, vec![child(96 * 1024, 11)], &[], 119_000);
        state.tick(120_000);
        assert!(state.active().is_none());
        observe(&mut state, vec![child(96 * 1024, 11)], &[], 240_000);
        state.tick(240_000);
        assert_eq!(state.incidents.len(), 1);
        observe(&mut state, vec![child(40 * 1024 * 1024, 11)], &[], 250_000);
        assert_eq!(state.launches[0].phase, Phase::Running);
    }
    #[test]
    fn kernel_reads_our_own_identity_and_versions() {
        assert_eq!(bsd(std::process::id()).unwrap().pbi_pid, std::process::id());
        assert!(task(std::process::id()).unwrap().pti_resident_size > SMALL_IMAGE);
        assert!(version()["build"].as_str().is_some());
    }

    #[test]
    fn kernel_census_includes_a_real_child_of_a_recorded_owner() {
        use std::process::{Command, Stdio};
        // The pipe keeps this owned child alive without a timing assumption.
        let mut child = Command::new("/bin/sh").args(["-c", "read release"])
            .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let pid = child.id();
        let mut owner = super::super::tests::launch("validation", Phase::Running);
        owner.pid = Some(std::process::id());
        owner.pid_birth = identity(std::process::id());
        owner.recorder = Some(uuid::Uuid::new_v4().to_string());
        let state = Snapshot { launches: vec![owner], ..Snapshot::default() };
        let observed = children(&crate::pty::Terminals::new(), &state);
        let found = observed.children.iter().any(|observed| observed.pid == pid && Some(observed.birth.clone()) == identity(pid));
        drop(child.stdin.take());
        child.wait().unwrap();
        assert!(found, "owned-child enumeration dropped a real child PID");
    }

    #[test]
    fn an_application_image_does_not_override_a_human_permission_wait() {
        let mut state = Snapshot::default();
        observe(&mut state, vec![child(96 * 1024, 10)], &[], 0);
        observe(&mut state, vec![child(40 * 1024 * 1024, 11)], &["tab:a".into()], 1_000);
        state.tick(1_000_000);
        assert_eq!(state.launches[0].phase, Phase::PermissionPrompt);
        assert!(state.active().is_none());
    }

    #[test]
    fn incomplete_census_cannot_recover_with_a_previously_healthy_probe() {
        use super::super::{probe, tests::recorder_exit};
        let directory = tempfile::tempdir().unwrap();
        let mut state = Snapshot::default();
        observe(&mut state, vec![child(96 * 1024, 10)], &[], 0);
        state.tick(120_000);
        let incident_id = state.active().unwrap().id.clone();
        let child_id = state.launches[0].id.clone();
        let healthy = probe::Captured { exit_code: Some(0), signal: None, spawn_failed: false,
            stdout: String::new(), stderr: String::new(), stdout_truncated: false, stderr_truncated: false };
        state.incidents[0].probe = Some(probe::Probe { id: uuid::Uuid::new_v4().to_string(), started_at: 130_000,
            observation_timed_out: false, shell: Some(healthy.clone()), owner: None, owner_exit: Some(recorder_exit(0, 140_001)),
            result: Some(probe::ProbeResult { finished_at: 140_000, shell: healthy.clone(), native: probe::Captured { stdout: "terminalx-startup-ready\n".into(), ..healthy } }) });
        probe::refresh(directory.path(), &mut state, 150_000).unwrap();
        assert!(state.active().is_some(), "healthy probe cannot release a still observed stall");
        super::observe(&mut state, Census { children: vec![], complete: false }, &[], 160_000);
        // Restart persistence includes both incompleteness and the recovery
        // evidence boundary; a changed in-memory enum alone is insufficient.
        let mut state: Snapshot = serde_json::from_str(&serde_json::to_string(&state).unwrap()).unwrap();
        probe::refresh(directory.path(), &mut state, 165_000).unwrap();
        assert_eq!(state.active().unwrap().id, incident_id);
        assert_eq!(state.launches[0].last_progress_at, 0, "losing sight is not progress");
        assert_eq!(state.observation_lost_at, Some(160_000));
        observe(&mut state, vec![], &[], 170_000);
        probe::refresh(directory.path(), &mut state, 170_000).unwrap();
        assert!(state.active().is_some(), "a complete later census cannot reuse stale probe evidence");
        observe(&mut state, vec![child(96 * 1024, 10)], &[], 180_000);
        state.tick(180_000);
        assert_eq!(state.incidents.len(), 1);
        assert_eq!(state.launches[0].id, child_id);
        observe(&mut state, vec![], &[], 190_000);
        let health = state.incidents[0].probe.as_mut().unwrap();
        health.started_at = 200_000;
        health.result.as_mut().unwrap().finished_at = 210_000;
        health.owner_exit = Some(recorder_exit(0, 210_001));
        super::observe(&mut state, Census { children: vec![], complete: false }, &[], 195_000);
        probe::refresh(directory.path(), &mut state, 215_000).unwrap();
        assert!(state.active().is_some(), "even fresh health cannot clear an incomplete census");
        observe(&mut state, vec![], &[], 220_000);
        probe::refresh(directory.path(), &mut state, 220_000).unwrap();
        assert!(state.active().is_none(), "complete observation plus new health can recover");
    }
}
