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
        if launch.phase == Phase::Running { launch.startup_proven = true; }
        if !matches!(launch.phase, Phase::Spawning | Phase::AwaitingReady | Phase::PermissionPrompt | Phase::Running) { continue; }
        if launch.evidence == Evidence::SmallUnchangingImage && !children.iter().any(|child| child.birth == launch.generation) {
            // Disappearance never proves an exit. Only an unproven startup or
            // an incident's affected launch invalidates health evidence; normal
            // healthy child churn must not perpetually postpone recovery.
            launch.phase = Phase::Unobserved;
            if !launch.startup_proven || state.incidents.iter().any(|incident|
                incident.recovered_at.is_none() && incident.launches.contains(&launch.id)) {
                state.observation_lost_at = Some(at);
            }
        }
    }
    for child in children {
        let permission = permissions.contains(&child.pane);
        let small = child.rss > 0 && child.rss <= SMALL_IMAGE && child.threads == 1;
        if !small {
            // A large/active application image disproves pre-main startup
            // suspicion even when a compile has never printed a byte.
            for launch in state.launches.iter_mut().filter(|launch| launch.pane == child.pane && launch.pid == Some(child.pid)
                && (match launch.evidence {
                    Evidence::SmallUnchangingImage => launch.generation == child.birth,
                    Evidence::Readiness => launch.pid_birth.as_deref() == Some(child.birth.as_str()),
                })) {
                if matches!(launch.phase, Phase::AwaitingReady | Phase::PermissionPrompt | Phase::Running | Phase::Unobserved) {
                    launch.startup_proven = true;
                    if permission {
                        if launch.phase != Phase::PermissionPrompt { launch.last_progress_at = at; }
                        launch.phase = Phase::PermissionPrompt;
                    }
                    else if launch.phase != Phase::Running { launch.phase = Phase::Running; launch.last_progress_at = at; }
                }
            }
        }
        for launch in state.launches.iter_mut().filter(|launch| launch.evidence == Evidence::Readiness && launch.pane == child.pane && launch.pid == Some(child.pid) && launch.pid_birth.as_deref() == Some(child.birth.as_str()) && launch.phase == Phase::AwaitingReady) {
            if launch.cpu_time.is_some_and(|cpu| cpu != child.cpu) || launch.resident_bytes.is_some_and(|rss| rss != child.rss) { launch.last_progress_at = at; }
            launch.cpu_time = Some(child.cpu);
            launch.resident_bytes = Some(child.rss);
        }
        // Readiness or a grown image disproves a pre-main stall for this
        // exact process birth. A pane's prompt alone cannot prove that every
        // descendant has started; it only holds those children in human wait.
        // A later smaller RSS or quiet period cannot undo that evidence.
        let proven = !small || state.launches.iter().any(|launch| launch.pane == child.pane && launch.pid == Some(child.pid)
            && match launch.evidence {
                Evidence::Readiness => launch.pid_birth.as_deref() == Some(child.birth.as_str())
                    && (launch.startup_proven || matches!(launch.phase, Phase::Running | Phase::PermissionPrompt)),
                Evidence::SmallUnchangingImage => launch.generation == child.birth && (launch.startup_proven || launch.phase == Phase::Running),
            });
        let phase = if permission { Phase::PermissionPrompt } else if proven { Phase::Running } else { Phase::AwaitingReady };
        if let Some(launch) = state.launches.iter_mut().find(|launch| launch.evidence == Evidence::SmallUnchangingImage && launch.generation == child.birth) {
            if launch.cpu_time != Some(child.cpu) || launch.resident_bytes != Some(child.rss)
                || phase != launch.phase {
                launch.last_progress_at = at;
            }
            launch.startup_proven |= proven;
            launch.phase = phase;
            launch.cpu_time = Some(child.cpu);
            launch.resident_bytes = Some(child.rss);
        } else {
            state.launches.push(Launch { startup_proven: proven, id: uuid::Uuid::new_v4().to_string(), pane: child.pane, generation: child.birth, pid: Some(child.pid),
                category: Category::OwnedChild, evidence: Evidence::SmallUnchangingImage,
                phase, started_at: at, last_progress_at: at,
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
    fn healthy_child_disappearance_preserves_recovery_boundary_after_restart() {
        let mut state = Snapshot::default();
        observe(&mut state, vec![child(96 * 1024, 10)], &[], 0);
        state.tick(120_000);
        let mut healthy = child(40 * 1024 * 1024, 20);
        healthy.pid = 2;
        healthy.birth = "2:3:4".into();
        observe(&mut state, vec![child(96 * 1024, 10), healthy], &[], 130_000);
        let mut state: Snapshot = serde_json::from_value(serde_json::to_value(&state).unwrap()).unwrap();
        observe(&mut state, vec![child(96 * 1024, 10)], &[], 140_000);
        assert_eq!(state.observation_lost_at, None, "unrelated healthy churn is not lost startup evidence");
        let healthy = state.launches.iter().find(|launch| launch.pid == Some(2)).unwrap();
        assert_eq!(healthy.phase, Phase::Unobserved);
        assert_eq!(healthy.exit_code, None, "disappearance cannot invent success");
        observe(&mut state, vec![], &[], 150_000);
        assert_eq!(state.observation_lost_at, Some(150_000), "losing an affected child still requires fresh health");
    }

    #[test]
    fn incomplete_census_still_invalidates_health_for_proven_children() {
        let mut state = Snapshot::default();
        observe(&mut state, vec![child(40 * 1024 * 1024, 10)], &[], 0);
        super::observe(&mut state, Census { children: vec![], complete: false }, &[], 1_000);
        assert_eq!(state.observation_lost_at, Some(1_000));
        assert!(state.census_incomplete);
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
    fn observing_the_same_permission_card_does_not_invent_child_progress() {
        for rss in [96 * 1024, 40 * 1024 * 1024] {
            let mut state = Snapshot::default();
            observe(&mut state, vec![child(96 * 1024, 10)], &[], 0);
            observe(&mut state, vec![child(rss, 10)], &["tab:a".into()], 1_000);
            observe(&mut state, vec![child(rss, 10)], &["tab:a".into()], 100_000);
            assert_eq!(state.launches[0].phase, Phase::PermissionPrompt);
            assert_eq!(state.launches[0].last_progress_at, 1_000);
        }
    }

    #[test]
    fn proven_startup_stays_healthy_when_an_image_later_becomes_small_and_silent() {
        let mut state = Snapshot::default();
        observe(&mut state, vec![child(96 * 1024, 10)], &[], 0);
        observe(&mut state, vec![child(40 * 1024 * 1024, 11)], &[], 1_000);
        assert_eq!(state.launches[0].phase, Phase::Running);
        observe(&mut state, vec![child(96 * 1024, 11)], &[], 2_000);
        observe(&mut state, vec![child(96 * 1024, 11)], &[], 200_000);
        state.tick(200_000);
        assert_eq!(state.launches[0].phase, Phase::Running);
        assert!(state.active().is_none(), "a proven startup cannot become a pre-main stall");
    }

    #[test]
    fn startup_proof_survives_permission_wait_and_serialized_restart() {
        for initially_small in [false, true] {
            for grows_during_prompt in [false, true] {
                let mut state = Snapshot::default();
                if initially_small { observe(&mut state, vec![child(96 * 1024, 10)], &[], 0); }
                let permissions = if grows_during_prompt { vec!["tab:a".into()] } else { vec![] };
                observe(&mut state, vec![child(40 * 1024 * 1024, 11)], &permissions, 1_000);
                observe(&mut state, vec![child(96 * 1024, 11)], &["tab:a".into()], 2_000);
                assert_eq!(state.launches[0].phase, Phase::PermissionPrompt);
                assert!(state.launches[0].startup_proven);
                let mut state: Snapshot = serde_json::from_value(serde_json::to_value(&state).unwrap()).unwrap();
                observe(&mut state, vec![child(96 * 1024, 11)], &["tab:a".into()], 200_000);
                assert_eq!(state.launches[0].last_progress_at, 2_000);
                observe(&mut state, vec![child(96 * 1024, 11)], &[], 201_000);
                observe(&mut state, vec![child(96 * 1024, 11)], &[], 400_000);
                state.tick(400_000);
                assert_eq!(state.launches[0].phase, Phase::Running);
                assert!(state.active().is_none(), "dismissing a prompt cannot undo proven startup");
                let mut reused = child(96 * 1024, 11);
                reused.birth = "1:2:4".into();
                observe(&mut state, vec![reused], &[], 401_000);
                state.tick(521_000);
                assert!(state.active().is_some(), "proof cannot transfer to a reused PID");
            }
        }
    }

    #[test]
    fn readiness_disproves_a_small_image_stall_only_for_the_same_process_birth() {
        for birth in ["1:2:3", "1:2:4"] {
            let mut state = Snapshot::default();
            observe(&mut state, vec![child(96 * 1024, 10)], &[], 0);
            let mut ready = super::super::tests::launch("tab:a", Phase::Running);
            ready.pid = Some(1);
            ready.pid_birth = Some(birth.into());
            ready.last_progress_at = 1_000;
            state.launches.push(ready);
            observe(&mut state, vec![child(96 * 1024, 10)], &[], 2_000);
            observe(&mut state, vec![child(96 * 1024, 10)], &[], 200_000);
            state.tick(200_000);
            assert_eq!(state.active().is_none(), birth == "1:2:3",
                "readiness must belong to the exact process birth");
        }
    }

    #[test]
    fn a_pane_permission_wait_does_not_prove_every_small_descendant_started() {
        let mut state = Snapshot::default();
        observe(&mut state, vec![child(96 * 1024, 10)], &[], 0);
        observe(&mut state, vec![child(96 * 1024, 10)], &["tab:a".into()], 1_000);
        observe(&mut state, vec![child(96 * 1024, 10)], &[], 2_000);
        assert_eq!(state.launches[0].phase, Phase::AwaitingReady);
        state.tick(122_000);
        assert!(state.active().is_some());
    }

    #[test]
    fn incomplete_census_cannot_recover_with_a_previously_healthy_probe() {
        use super::super::{probe, tests::recorder_exit};
        let directory = tempfile::tempdir().unwrap();
        // A child that is really alive (this test process): losing sight of it is not its closing.
        let me = std::process::id();
        let birth = identity(me).unwrap();
        let child = |rss, cpu| Child { pane: "tab:a".into(), pid: me, birth: birth.clone(), rss, cpu, threads: 1 };
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
        assert!(state.active().is_some(), "a complete later census cannot reuse stale probe evidence while the lost child lives");
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
