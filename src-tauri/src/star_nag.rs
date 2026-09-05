//! Local, event-driven reminder. Only this owner writes durable reminder state.
//! Runtime activity is fed directly by SessionManager, never by replaying logs.
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::events::{AgentEvent, Payload, TurnStatus};
use crate::github::StarStatus;
use crate::store::{self, index::TabStatus};

const INITIAL_THRESHOLD: u64 = 35;
const COOLDOWN_MS: i64 = 3 * 24 * 60 * 60 * 1000;
const QUIET_MS: i64 = 1200;
pub const EVENT: &str = "star_nag_changed";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Saved {
    launches: u64,
    baseline: u64,
    next_threshold: u64,
    cooldown_until: i64,
    app_version: String,
    completed: bool,
    completion_version: Option<String>,
}

impl Default for Saved {
    fn default() -> Self {
        Self { launches: 0, baseline: 0, next_threshold: INITIAL_THRESHOLD, cooldown_until: 0, app_version: String::new(), completed: false, completion_version: None }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Direct,
    Browser,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    revision: u64,
    visible: bool,
    mode: Option<Mode>,
    busy: bool,
    error: Option<String>,
}

struct Core {
    path: PathBuf,
    saved: Saved,
    // Seeded with restored tabs. A tab's first successful spawn counts once;
    // tab switches, retries of a running process and restored tabs do not.
    seen: HashSet<String>,
    active: HashSet<String>,
    meaningful: HashSet<String>,
    pending_usage: bool,
    pending_completion: bool,
    prepared: Option<Mode>,
    checking: bool,
    action: bool,
    generation: u64,
    input_epoch: u64,
    quiet_since: i64,
    ready: bool,
    view: View,
}

impl Core {
    fn load(path: PathBuf, version: &str, seen: HashSet<String>, now: i64) -> Result<Self> {
        let mut saved: Saved = store::read_json(&path)?.unwrap_or_default();
        if saved.app_version != version {
            saved.app_version = version.into();
            saved.baseline = saved.launches;
            saved.next_threshold = INITIAL_THRESHOLD;
        }
        store::write_json(&path, &saved)?;
        Ok(Self::new(path, saved, seen, now))
    }

    fn new(path: PathBuf, saved: Saved, seen: HashSet<String>, now: i64) -> Self {
        Self {
            path,
            saved,
            seen,
            active: HashSet::new(),
            meaningful: HashSet::new(),
            pending_usage: false,
            pending_completion: false,
            prepared: None,
            checking: false,
            action: false,
            generation: 0,
            input_epoch: 0,
            quiet_since: now,
            ready: false,
            view: View::default(),
        }
    }

    fn save(&mut self, next: Saved) -> Result<()> {
        store::write_json(&self.path, &next)?;
        self.saved = next;
        Ok(())
    }

    fn suppressed(&self, now: i64) -> bool {
        self.saved.completed || now < self.saved.cooldown_until
    }

    fn launched(&mut self, key: String, now: i64) -> Result<()> {
        if self.saved.completed || self.seen.contains(&key) {
            return Ok(());
        }
        let mut next = self.saved.clone();
        next.launches = next.launches.saturating_add(1);
        self.save(next)?;
        self.seen.insert(key);
        // Only usage changes create threshold eligibility, never startup or a timer.
        self.pending_usage |= !self.suppressed(now) && self.saved.launches.saturating_sub(self.saved.baseline) >= self.saved.next_threshold;
        Ok(())
    }

    fn observe(&mut self, event: &AgentEvent, now: i64) -> Result<()> {
        if self.saved.completed || event.subagent.is_some() {
            return Ok(());
        }
        let key = format!("{}/{}", event.session_id, event.tab_id);
        match &event.payload {
            Payload::UserMessage { text, queued: false, .. } => {
                if !text.trim().is_empty() {
                    self.meaningful.insert(key);
                }
            }
            Payload::TurnCompleted { status, .. } => {
                let meaningful = self.meaningful.remove(&key);
                if meaningful && *status == TurnStatus::Ok && self.saved.completion_version.as_deref() != Some(&self.saved.app_version) {
                    if self.suppressed(now) || self.view.visible {
                        self.consume_completion()?;
                    } else {
                        self.pending_completion = true;
                        self.quiet_since = now;
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn consume_completion(&mut self) -> Result<()> {
        let mut next = self.saved.clone();
        next.completion_version = Some(next.app_version.clone());
        self.save(next)?;
        self.pending_completion = false;
        Ok(())
    }

    fn eligible(&self, now: i64) -> bool {
        self.ready
            && !self.view.visible
            && !self.action
            && !self.suppressed(now)
            && (self.pending_usage || (self.pending_completion && self.active.is_empty() && now - self.quiet_since >= QUIET_MS))
    }

    fn begin_check(&mut self, now: i64) -> Option<u64> {
        if self.checking || self.prepared.is_some() || !self.eligible(now) {
            return None;
        }
        self.checking = true;
        Some(self.generation)
    }

    fn checked(&mut self, generation: u64, status: StarStatus, now: i64) -> Result<()> {
        self.checking = false;
        if status == StarStatus::Starred {
            return self.complete();
        }
        if generation != self.generation || self.suppressed(now) {
            return Ok(());
        }
        self.prepared = Some(if status == StarStatus::NotStarred { Mode::Direct } else { Mode::Browser });
        self.show_prepared(now)
    }

    fn show_prepared(&mut self, now: i64) -> Result<()> {
        if !self.eligible(now) {
            return Ok(());
        }
        let Some(mode) = self.prepared else {
            return Ok(());
        };
        if self.pending_completion {
            self.consume_completion()?;
        }
        self.prepared = None;
        self.pending_usage = false;
        self.view.visible = true;
        self.view.mode = Some(mode);
        self.view.error = None;
        Ok(())
    }

    fn clear(&mut self) {
        self.generation += 1;
        self.pending_usage = false;
        self.pending_completion = false;
        self.prepared = None;
        self.view.visible = false;
        self.view.error = None;
    }

    fn defer(&mut self, now: i64) -> Result<()> {
        let mut next = self.saved.clone();
        next.cooldown_until = now.saturating_add(COOLDOWN_MS);
        next.baseline = next.launches;
        next.next_threshold = next.next_threshold.saturating_mul(2);
        self.save(next)?;
        self.clear();
        Ok(())
    }

    fn complete(&mut self) -> Result<()> {
        let mut next = self.saved.clone();
        next.completed = true;
        self.save(next)?;
        self.clear();
        Ok(())
    }

    fn begin_action(&mut self) -> Option<(u64, Mode)> {
        if !self.view.visible || self.action || self.checking {
            return None;
        }
        let mode = self.view.mode?;
        self.action = true;
        self.view.busy = true;
        self.view.error = None;
        Some((self.generation, mode))
    }

    fn acted(&mut self, generation: u64, mode: Mode, success: bool, now: i64) -> Result<()> {
        self.action = false;
        self.view.busy = false;
        if success && mode == Mode::Direct {
            return self.complete();
        }
        if generation != self.generation {
            return Ok(());
        }
        if success {
            return self.defer(now);
        }
        self.view.mode = Some(Mode::Browser);
        self.view.error =
            Some(if mode == Mode::Direct { "Couldn’t star from the app. You can open GitHub instead." } else { "Couldn’t open your browser. Please try again." }.into());
        Ok(())
    }
}

pub struct StarNag {
    core: Mutex<Core>,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl StarNag {
    pub fn load(version: &str) -> Self {
        let load = || -> Result<Core> {
            let seen = store::index::load()?.into_iter().flat_map(|s| s.tabs.into_iter().map(move |t| format!("{}/{}", s.id, t.id))).collect();
            Core::load(store::root()?.join("star-reminder.json"), version, seen, now())
        };
        let core = load().unwrap_or_else(|e| {
            // A reminder must never prevent startup or overwrite corrupt state.
            log::warn!("star reminder disabled: {e:#}");
            Core::new(PathBuf::new(), Saved { completed: true, ..Saved::default() }, HashSet::new(), now())
        });
        Self { core: Mutex::new(core) }
    }

    fn emit(core: &mut Core, app: &AppHandle) -> View {
        core.view.revision += 1;
        let _ = app.emit(EVENT, &core.view);
        core.view.clone()
    }

    pub fn launched(self: &Arc<Self>, app: &AppHandle, key: String) {
        if let Err(e) = self.core.lock().unwrap().launched(key, now()) {
            log::warn!("star reminder usage: {e:#}");
        }
        self.drive(app);
    }

    pub fn observe(self: &Arc<Self>, app: &AppHandle, event: &AgentEvent) {
        // No work for token deltas or transcript output.
        if !matches!(event.payload, Payload::UserMessage { .. } | Payload::TurnCompleted { .. }) {
            return;
        }
        if let Err(e) = self.core.lock().unwrap().observe(event, now()) {
            log::warn!("star reminder completion: {e:#}");
        }
        self.schedule(app);
    }

    pub fn status(self: &Arc<Self>, app: &AppHandle, key: String, status: TabStatus) {
        {
            let mut core = self.core.lock().unwrap();
            if matches!(status, TabStatus::InProgress | TabStatus::Waiting) {
                core.active.insert(key.clone());
            } else {
                core.active.remove(&key);
            }
            if status == TabStatus::Idle {
                core.meaningful.remove(&key);
            }
        }
        self.drive(app);
    }

    pub fn interrupted(&self, key: &str) {
        self.core.lock().unwrap().meaningful.remove(key);
    }

    // A one-shot debounce of local input/completion; this never polls GitHub.
    fn schedule(self: &Arc<Self>, app: &AppHandle) {
        let epoch = {
            let mut core = self.core.lock().unwrap();
            core.input_epoch += 1;
            core.input_epoch
        };
        let owner = self.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(QUIET_MS as u64)).await;
            if owner.core.lock().unwrap().input_epoch == epoch {
                owner.drive(&app);
            }
        });
    }

    fn drive(self: &Arc<Self>, app: &AppHandle) {
        let ticket = {
            let mut core = self.core.lock().unwrap();
            let was_visible = core.view.visible;
            if let Err(e) = core.show_prepared(now()) {
                log::warn!("star reminder display: {e:#}");
            }
            // Emit only on an actual change, except command snapshots.
            if core.view.visible != was_visible {
                Self::emit(&mut core, app);
            }
            core.begin_check(now())
        };
        let Some(ticket) = ticket else {
            return;
        };
        let owner = self.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let status = crate::github::star_status().await;
            let mut core = owner.core.lock().unwrap();
            if let Err(e) = core.checked(ticket, status, now()) {
                log::warn!("star reminder lookup: {e:#}");
            }
            Self::emit(&mut core, &app);
        });
    }
}

#[tauri::command]
pub fn star_nag_ready(app: AppHandle) -> View {
    let owner = app.state::<crate::AppState>().star_nag.clone();
    let view = {
        let mut core = owner.core.lock().unwrap();
        core.ready = true;
        core.quiet_since = now();
        StarNag::emit(&mut core, &app)
    };
    owner.schedule(&app);
    view
}

#[tauri::command]
pub fn star_nag_input(app: AppHandle) {
    let owner = app.state::<crate::AppState>().star_nag.clone();
    owner.core.lock().unwrap().quiet_since = now();
    owner.schedule(&app);
}

#[tauri::command]
pub fn star_nag_dismiss(app: AppHandle) -> Result<View, String> {
    let state = app.state::<crate::AppState>();
    let mut core = state.star_nag.core.lock().unwrap();
    if core.view.visible || core.checking || core.prepared.is_some() {
        core.defer(now()).map_err(|e| e.to_string())?;
    }
    Ok(StarNag::emit(&mut core, &app))
}

#[tauri::command]
pub async fn star_nag_act(app: AppHandle) -> Result<View, String> {
    let owner = app.state::<crate::AppState>().star_nag.clone();
    let (ticket, mode) = {
        let mut core = owner.core.lock().unwrap();
        let Some(attempt) = core.begin_action() else {
            return Ok(core.view.clone());
        };
        StarNag::emit(&mut core, &app);
        attempt
    };
    let success = match mode {
        Mode::Direct => crate::github::star_repository().await,
        Mode::Browser => {
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || app.opener().open_url(crate::github::REPO_URL, None::<&str>).is_ok()).await.unwrap_or(false)
        }
    };
    let mut core = owner.core.lock().unwrap();
    if let Err(e) = core.acted(ticket, mode, success, now()) {
        core.view.error = Some("Couldn’t save the reminder preference. Please try again.".into());
        log::warn!("star reminder action: {e:#}");
    }
    Ok(StarNag::emit(&mut core, &app))
}

#[cfg(test)]
mod tests;
