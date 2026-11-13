//! The user layer only. Layering (managed, repository and user) is resolved by
//! `store::configuration`; do not invent a second resolver here.
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, LazyLock, Mutex};
use std::time::Duration;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{value::RawValue, Value};

use super::Settings;

static FILES: LazyLock<Mutex<HashMap<PathBuf, FileState>>> = LazyLock::new(Default::default);

#[derive(Default)]
struct FileState {
    good: Settings,
    // Preserve fields this version does not understand when a control saves.
    source: Option<Value>,
    error: Option<String>,
}

/// Safe to send to windows. Never serialize Settings itself into an event:
/// it also contains the Linear credential.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    path: String,
    exists: bool,
    error: Option<String>,
    preferences: BTreeMap<String, Value>,
}

static PREFERENCE_DEFAULTS: LazyLock<Value> = LazyLock::new(||
    serde_json::from_str(include_str!("../../../../src/lib/userPreferenceDefaults.json")).expect("bundled preference defaults")
);

static TEMPLATE: LazyLock<Value> = LazyLock::new(|| {
    let mut value = serde_json::to_value(Settings::default()).expect("settings defaults");
    for key in ["linearApiKey", "linearViewer", "machineName"] {
        value[key] = Value::Null;
    }
    value["preferences"] = PREFERENCE_DEFAULTS.clone();
    value
});

// These object keys are user-defined, rather than settings field names.
static DYNAMIC_MAPS: LazyLock<BTreeMap<&str, Value>> = LazyLock::new(|| BTreeMap::from([
    ("mergedCleanup.projects", Value::Bool(false)),
    ("orchestrator.projects", serde_json::json!({"requireApproval": false, "pieceLimit": 0, "workerMode": "", "reviewDiffLines": 0, "triesPerPiece": 0, "effortCeiling": "", "budgetDollars": 0.5, "budgetPoints": 0.5, "windowCeiling": 0.5})),
    ("preferences.shortcuts", serde_json::json!([""])),
]));

/// Retain duplicate members so an ambiguous field cannot silently become a
/// new permission choice while valid fields elsewhere in the file are loaded.
struct Members<'a>(BTreeMap<String, Vec<&'a RawValue>>);
impl<'de> Deserialize<'de> for Members<'de> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = Members<'de>;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result { formatter.write_str("an object") }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> std::result::Result<Self::Value, A::Error> {
                let mut members = BTreeMap::<String, Vec<&RawValue>>::new();
                while let Some((key, value)) = map.next_entry()? { members.entry(key).or_default().push(value); }
                Ok(Members(members))
            }
        }
        deserializer.deserialize_map(Visitor)
    }
}

fn invalid(source: &str, raw: &RawValue, key: &str, why: &str, file_lines: bool) -> anyhow::Error {
    let key = if key.is_empty() { "settings" } else { key };
    if file_lines {
        let line = source[..raw.get().as_ptr() as usize - source.as_ptr() as usize].bytes().filter(|byte| *byte == b'\n').count() + 1;
        anyhow::anyhow!("{key}, line {line}: {why}")
    } else {
        anyhow::anyhow!("Cannot save settings: {key}: {why}")
    }
}

/// RawValue borrows the original input, so diagnostics use the actual value's
/// line even for repeated keys in different objects or escaped JSON key names.
fn validate(source: &str, raw: &RawValue, expected: &Value, key: &str, file_lines: bool) -> Result<()> {
    let value: Value = serde_json::from_str(raw.get())?;
    let error = |why: &str| invalid(source, raw, key, why, file_lines);
    let choices: &[&str] = match key {
        "statusBar.percent" => &["used", "remaining"],
        "statusBar.usageMode" => &["detailed", "compact"],
        "preferences.linkBrowser" => &["terminalx", "system", "ask"],
        "preferences.branchSessions" => &["tabs", "sidebar"],
        "preferences.updateChannel" => &["stable", "beta"],
        "preferences.fontScale" => &["sm", "md", "lg"],
        "preferences.transcriptLayout" => &["wide", "chat"],
        "preferences.sidebarLayout" => &["simple", "list", "status"],
        "preferences.organizationDisplay" => &["all", "one"],
        "preferences.theme" => &["den", "slate", "moss", "ember"],
        "preferences.mode" => &["system", "light", "dark"],
        "orchestrator.workerMode" => &super::WORKER_MODES,
        _ => &[],
    };
    if !choices.is_empty() && !value.as_str().is_some_and(|text| choices.contains(&text)) {
        return Err(error("unknown option"));
    }
    let numbers: &[u32] = match key {
        "agents.idleStopMinutes" => &super::IDLE_STOP_MINUTES,
        "conversations.archiveIdleDays" => &super::ARCHIVE_IDLE_DAYS,
        "mergedCleanup.graceMinutes" => &super::GRACE_MINUTES,
        "statusBar.usageRefreshMinutes" => &super::USAGE_REFRESH_MINUTES,
        _ => &[],
    };
    if !numbers.is_empty() && !value.as_u64().is_some_and(|n| numbers.iter().any(|v| u64::from(*v) == n)) {
        return Err(error("choose one of the supported intervals"));
    }
    if key == "orchestrator.pieceLimit" && !value.as_u64().is_some_and(|n| (1..=u64::from(super::MAX_PIECE_LIMIT)).contains(&n)) {
        return Err(error("expected a number of pieces from 1 to 50"));
    }
    if key == "orchestrator.reviewDiffLines" && !value.as_u64().is_some_and(|n| (1..=u64::from(super::MAX_REVIEW_DIFF_LINES)).contains(&n)) {
        return Err(error("expected a number of changed lines from 1 to 100000"));
    }
    // PRO-280: a run's limits. The budget and the window level take fractions; the counts do not.
    if key.starts_with("orchestrator.") && !value.is_object() {
        let field = key.rsplit('.').next().unwrap_or_default();
        let whole = |valid: fn(u32) -> bool| value.as_u64().and_then(|n| u32::try_from(n).ok()).is_some_and(valid);
        // PRO-335: a budget or the window level may also be "none", No limit.
        let cap = |valid: fn(f64) -> bool| super::read_cap(&value, valid).is_some();
        let checked = match field {
            "workersPerRun" | "workersAtOnce" => Some((whole(super::valid_workers), "expected a number of workers from 1 to 50")),
            "stallMinutes" => Some((whole(super::valid_stall_minutes), "expected minutes from 1 to 240")),
            "triesPerPiece" => Some((whole(super::valid_tries), "expected a number of tries from 1 to 6")),
            "effortCeiling" => Some((value.as_str().is_some_and(super::valid_ceiling), "expected one of low, medium, high, xhigh or max")),
            "budgetDollars" => Some((cap(super::valid_dollars), "expected dollars above 0, at most 10000, or \"none\" for no limit")),
            "budgetPoints" | "windowCeiling" => Some((cap(super::valid_percent), "expected a percentage above 0, at most 100, or \"none\" for no limit")),
            _ => None,
        };
        if let Some((ok, why)) = checked {
            return if ok { Ok(()) } else { Err(error(why)) };
        }
    }
    if key == "floating.retentionDays" && !value.as_u64().is_some_and(|n| n <= u64::from(super::MAX_RETENTION_DAYS)) {
        return Err(error("expected days from 0 to 3650"));
    }
    match expected {
        Value::Object(properties) => {
            let Members(members): Members = serde_json::from_str(raw.get()).map_err(|_| error("expected an object"))?;
            for (name, members) in members {
                let path = if key.is_empty() { name.clone() } else { format!("{key}.{name}") };
                let Some(kind) = DYNAMIC_MAPS.get(key).or_else(|| properties.get(&name)) else {
                    // Future fields and editor metadata (including $schema)
                    // are inert to this build, and survive subsequent writes.
                    continue;
                };
                if members.len() > 1 { return Err(invalid(source, members[1], &path, "duplicate setting", file_lines)); }
                validate(source, members[0], kind, &path, file_lines)?;
            }
        }
        Value::Array(_) => {
            if !value.as_array().is_some_and(|items| items.iter().all(Value::is_string)) {
                return Err(error("expected a list of strings"));
            }
        }
        Value::Bool(_) if !value.is_boolean() => return Err(error("expected true or false")),
        Value::String(_) if !value.is_string() && !(key == "floating.shortcut" && value.is_null()) => return Err(error("expected a string")),
        Value::Number(_) if !value.as_u64().is_some_and(|n| n <= u64::from(u32::MAX)) => return Err(error("expected a non-negative integer")),
        Value::Null if !value.is_null() && !value.is_string() => return Err(error("expected a string or null")),
        _ => {}
    }
    Ok(())
}

fn parse(source: &str) -> Result<Settings> { parse_input(source, true) }

fn parse_input(source: &str, file_lines: bool) -> Result<Settings> {
    let raw: &RawValue = serde_json::from_str(source).map_err(|error| anyhow::anyhow!("settings, line {}: invalid JSON", error.line()))?;
    validate(source, raw, &TEMPLATE, "", file_lines)?;
    let mut settings: Settings = serde_json::from_str(source).map_err(|error| {
        let message = error.to_string();
        let key = message.strip_prefix("duplicate field `").and_then(|tail| tail.split_once('`')).map(|(key, _)| key).unwrap_or("settings");
        if file_lines { anyhow::anyhow!("{key}, line {}: invalid or duplicate setting", error.line()) }
        else { anyhow::anyhow!("Cannot save settings: {key}: invalid or duplicate setting") }
    })?;
    // Unknown preferences are preserved in the source, not sent to webviews.
    settings.preferences.retain(|key, _| PREFERENCE_DEFAULTS.get(key).is_some());
    Ok(settings)
}

/// Recover each known field independently. One invalid leaf must not discard
/// credentials, permission choices, or valid siblings on a cold start. Missing
/// keys still inherit defaults; only an invalid field uses its previous value.
fn recover(source: &str, raw: &RawValue, expected: &Value, previous: Option<&Value>, key: &str) -> Value {
    if let (Value::Object(properties), Ok(Members(members))) = (expected, serde_json::from_str::<Members>(raw.get())) {
        let mut values = serde_json::Map::new();
        for (name, members) in members {
            let path = if key.is_empty() { name.clone() } else { format!("{key}.{name}") };
            let map_value = DYNAMIC_MAPS.get(key);
            if let Some(kind) = map_value.or_else(|| properties.get(&name)) {
                let previous = previous.and_then(|value| value.get(&name));
                if map_value.is_some() && previous.is_none()
                    && (members.len() > 1 || validate(source, members[0], kind, &path, true).is_err()) { continue; }
                let value = if members.len() > 1 { previous.unwrap_or(kind).clone() }
                    else { recover(source, members[0], kind, previous, &path) };
                values.insert(name, value);
            }
        }
        return Value::Object(values);
    }
    if validate(source, raw, expected, key, true).is_ok() {
        serde_json::from_str(raw.get()).expect("validated JSON value")
    } else {
        previous.unwrap_or(expected).clone()
    }
}

fn refresh(path: &Path, state: &mut FileState) {
    match std::fs::read_to_string(path) {
        Ok(source) => {
            state.source = serde_json::from_str::<Value>(&source).ok().filter(Value::is_object);
            match parse(&source) {
                Ok(good) => { state.good = good; state.error = None; }
                Err(error) => {
                    if state.source.is_some() {
                        let previous = serde_json::to_value(&state.good).expect("settings values");
                        let raw = serde_json::from_str::<&RawValue>(&source).expect("parsed source");
                        let recovered = recover(&source, raw, &TEMPLATE, Some(&previous), "");
                        let good = serde_json::from_value(recovered);
                        debug_assert!(good.is_ok(), "validated recovery must match the Settings type");
                        if let Ok(good) = good { state.good = good; }
                    }
                    state.error = Some(error.to_string());
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => *state = FileState::default(),
        Err(_) => { state.source = None; state.error = Some("settings, line 1: could not read the file".into()); }
    }
}

/// Settings serializes only fields understood by this build. Carry the others
/// forward at every object level, without restoring deleted dynamic map keys.
fn preserve_unknown(next: &mut Value, source: &Value, expected: &Value, key: &str) {
    if DYNAMIC_MAPS.contains_key(key) { return; }
    if let (Some(next), Some(source), Some(properties)) = (next.as_object_mut(), source.as_object(), expected.as_object()) {
        for (name, value) in source {
            if let Some(kind) = properties.get(name) {
                if let Some(child) = next.get_mut(name) {
                    let path = if key.is_empty() { name.clone() } else { format!("{key}.{name}") };
                    preserve_unknown(child, value, kind, &path);
                }
            } else {
                next.insert(name.clone(), value.clone());
            }
        }
    }
}

fn status_at(path: &Path, state: &FileState) -> Status {
    Status { path: path.to_string_lossy().into(), exists: path.exists(), error: state.error.clone(), preferences: state.good.preferences.clone() }
}

pub(super) fn load() -> Settings {
    let Ok(path) = super::file_path() else { return Settings::default() };
    let mut files = FILES.lock().unwrap_or_else(|e| e.into_inner());
    let state = files.entry(path.clone()).or_default();
    refresh(&path, state);
    state.good.clone()
}

fn write(path: &Path, state: &mut FileState, settings: &Settings) -> Result<()> {
    write_without(path, state, settings, &[])
}

/// `absent` top-level keys are left out of the file so they inherit from the
/// layers below the user layer (defaults) rather than pinning today's value.
fn write_without(path: &Path, state: &mut FileState, settings: &Settings, absent: &[&str]) -> Result<()> {
    if let Some(error) = &state.error { bail!("Fix settings.json before saving: {error}"); }
    let mut next = serde_json::to_value(settings)?;
    if let Some(object) = next.as_object_mut() { for key in absent { object.remove(*key); } }
    let good = parse_input(&serde_json::to_string(&next)?, false)?;
    if let Some(source) = &state.source { preserve_unknown(&mut next, source, &TEMPLATE, ""); }
    let bytes = serde_json::to_vec_pretty(&next)?;
    // Tighten before making the temporary copy too, not after exposing a
    // credential in a file whose old permissions may have been too broad.
    #[cfg(unix)]
    if path.exists() {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    crate::store::write_atomic(path, &bytes)?;
    state.good = good;
    state.source = Some(next);
    Ok(())
}

pub(super) fn save(settings: &Settings) -> Result<()> {
    let path = super::file_path()?;
    crate::store::transaction::run(&path.with_extension("lock"), Duration::from_secs(5), || {
        let mut files = FILES.lock().unwrap_or_else(|e| e.into_inner());
        let state = files.entry(path.clone()).or_default();
        refresh(&path, state);
        // Existing native controls save a whole Settings snapshot. They do
        // not edit preferences, and must not undo a window's newer choices.
        let mut next = settings.clone();
        next.preferences = state.good.preferences.clone();
        next.preferences_migrated = state.good.preferences_migrated;
        // Layered keys this snapshot did not change keep what is on disk now:
        // another window may have written or reset them through the layered
        // configuration writer since this snapshot was loaded.
        let mut absent = Vec::new();
        if let Some((prefix, directory)) = &settings.loaded_configuration {
            let on_disk = |key: &str| state.source.as_ref().and_then(|source| source.get(key)).is_some();
            if prefix == &settings.branch_prefix {
                if on_disk("branchPrefix") { next.branch_prefix = state.good.branch_prefix.clone(); } else { absent.push("branchPrefix"); }
            }
            if directory == &settings.worktree_dir {
                if on_disk("worktreeDir") { next.worktree_dir = state.good.worktree_dir.clone(); } else { absent.push("worktreeDir"); }
            }
        }
        write_without(&path, state, &next, &absent)
    })
}

pub fn status() -> Result<Status> {
    let path = super::file_path()?;
    let mut files = FILES.lock().unwrap_or_else(|e| e.into_inner());
    let state = files.entry(path.clone()).or_default();
    refresh(&path, state);
    Ok(status_at(&path, state))
}

#[cfg(any(feature = "desktop", test))]
fn change_preferences(path: &Path, patch: BTreeMap<String, Value>, migrate: bool, create: bool) -> Result<Status> {
    crate::store::transaction::run(&path.with_extension("lock"), Duration::from_secs(5), || {
        change_preferences_locked(path, patch, migrate, create)
    })
}

#[cfg(any(feature = "desktop", test))]
fn change_preferences_locked(path: &Path, patch: BTreeMap<String, Value>, migrate: bool, create: bool) -> Result<Status> {
    let mut files = FILES.lock().unwrap_or_else(|e| e.into_inner());
    let state = files.entry(path.to_owned()).or_default();
    refresh(path, state);
    if let Some(error) = &state.error { bail!("Fix settings.json before saving: {error}"); }
    let mut next = state.good.clone();
    if migrate && next.preferences_migrated { return Ok(status_at(path, state)); }
    // Nothing to migrate on a fresh installation: let General offer Create.
    if migrate && patch.is_empty() && !path.exists() { return Ok(status_at(path, state)); }
    for (key, value) in patch {
        if migrate {
            next.preferences.entry(key).or_insert(value);
        } else {
            next.preferences.insert(key, value);
        }
    }
    next.preferences_migrated |= migrate;
    if create && path.exists() { return Ok(status_at(path, state)); }
    write(path, state, &next)?;
    Ok(status_at(path, state))
}

/// How long a changed settings file must hold still before the change is reported.
const SETTLE: Duration = Duration::from_millis(50);

/// What a changed file settles to: `first` read again after each `wait` until two reads
/// agree, at most ten times. `None` when `wait` says to stop.
fn settled<T: PartialEq>(first: T, mut read: impl FnMut() -> T, mut wait: impl FnMut() -> bool) -> Option<T> {
    let mut current = first;
    for _ in 0..10 {
        if !wait() { return None; }
        let again = read();
        if again == current { break; }
        current = again;
    }
    Some(current)
}

/// One small file polled every 200ms, including when absent. This also sees
/// editor rename-over saves, deletion, and symlink-target edits on every OS.
/// No event payload contains values; consumers ask for their own safe view.
pub struct Watcher {
    stop: mpsc::Sender<()>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Watcher {
    fn at(path: PathBuf, changed: impl Fn() + Send + 'static) -> Result<Self> {
        let (stop, done) = mpsc::channel();
        let mut previous = std::fs::read(&path).map_err(|error| error.kind());
        {
            let mut files = FILES.lock().unwrap_or_else(|e| e.into_inner());
            refresh(&path, files.entry(path.clone()).or_default());
        }
        let thread = std::thread::Builder::new().name("settings-file".into()).spawn(move || {
            while done.recv_timeout(Duration::from_millis(200)) == Err(mpsc::RecvTimeoutError::Timeout) {
                let current = std::fs::read(&path).map_err(|error| error.kind());
                if current == previous { continue; }
                // A save in place truncates before it writes: a read between the two sees an
                // empty or partial file. Report the change once the file holds still.
                let read = || std::fs::read(&path).map_err(|error| error.kind());
                let Some(current) = settled(current, read, || done.recv_timeout(SETTLE) == Err(mpsc::RecvTimeoutError::Timeout)) else { return };
                if current == previous { continue; }
                previous = current;
                {
                    let mut files = FILES.lock().unwrap_or_else(|e| e.into_inner());
                    refresh(&path, files.entry(path.clone()).or_default());
                }
                changed();
            }
        })?;
        Ok(Self { stop, thread: Some(thread) })
    }

    pub fn start(sink: Arc<dyn crate::sink::EventSink>) -> Result<Self> {
        Self::at(super::file_path()?, move || sink.emit("settings_file_changed", &()))
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(thread) = self.thread.take() { let _ = thread.join(); }
    }
}

#[cfg(feature = "desktop")]
pub fn install(app: &tauri::AppHandle) -> Result<()> {
    use tauri::{Emitter, Manager};
    let handle = app.clone();
    let applied = Arc::new(Mutex::new(super::load()));
    crate::sink::EventSink::listen(app, "settings_file_changed", Box::new(move |_| {
        let ui = handle.clone();
        let applied = applied.clone();
        // Native menu/shortcut calls belong on the UI thread. Never block
        // the watcher waiting for it (including while the app is exiting).
        let _ = handle.run_on_main_thread(move || {
            let settings = super::load();
            crate::status::set_menu_checked(&ui, settings.status_bar.visible);
            let _ = ui.emit(crate::status::SETTINGS_EVENT, &settings.status_bar);
            let _ = ui.emit("experimental_settings_changed", &settings.experimental);
            let _ = ui.emit("merged_cleanup_settings", &settings.merged_cleanup);
            let (floating_changed, claims_changed) = {
                let mut before = applied.lock().unwrap_or_else(|e| e.into_inner());
                let floating_changed = settings.floating != before.floating;
                let claims_changed = settings.work_status != before.work_status || settings.machine_name != before.machine_name;
                *before = settings;
                (floating_changed, claims_changed)
            };
            if floating_changed { crate::floating::reload_settings(&ui); }
            if claims_changed { ui.state::<crate::AppState>().work_claims.nudge(); }
        });
    }));
    app.manage(Watcher::start(Arc::new(app.clone()))?);
    Ok(())
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn settings_file_status() -> Result<Status, String> {
    status().map_err(|e| e.to_string())
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn update_user_preferences(patch: BTreeMap<String, Value>, migrate: bool) -> Result<Status, String> {
    (|| change_preferences(&super::file_path()?, patch, migrate, false))().map_err(|e| e.to_string())
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn create_settings_file() -> Result<Status, String> {
    (|| change_preferences(&super::file_path()?, BTreeMap::new(), false, true))().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn patch(value: Value) -> BTreeMap<String, Value> { serde_json::from_value(value).unwrap() }

    #[test]
    fn validates_types_options_and_the_exact_nested_line() {
        for (source, key) in [
            (r#"{"preferences":{"sounds":"secret-value"}}"#, "preferences.sounds"),
            (r#"{"preferences":{"fontScale":"huge"}}"#, "preferences.fontScale"),
            (r#"{"agents":{"idleStopMinutes":1}}"#, "agents.idleStopMinutes"),
            (r#"{"statusBar":{"percent":"all"}}"#, "statusBar.percent"),
            (r#"{"notifications":null}"#, "notifications"),
            (r#"{"diagnostics":{"recoveryIncidents":"yes"}}"#, "diagnostics.recoveryIncidents"),
            (r#"{"preferences":{"shortcuts":{"session.stop":"escape"}}}"#, "preferences.shortcuts.session.stop"),
            (r#"{"floating":{"retentionDays":3651}}"#, "floating.retentionDays"),
        ] {
            let error = parse(source).unwrap_err().to_string();
            assert!(error.contains(key) && error.contains("line 1"), "{error}");
            assert!(!error.contains("secret-value"));
        }
        let source = "{\n  \"preferences\": {\n    \"mode\": \"dark\",\n    \"sounds\": 4\n  }\n}";
        assert_eq!(parse(source).unwrap_err().to_string(), "preferences.sounds, line 4: expected true or false");
        let escaped = "{\n  \"preferences\": {\n    \"sou\\u006eds\": 4\n  }\n}";
        assert!(parse(escaped).unwrap_err().to_string().contains("preferences.sounds, line 3"));
        assert!(parse("{\n").unwrap_err().to_string().contains("line 2: invalid JSON"));
        assert!(parse("[]").is_err());
        assert!(parse("null").is_err());
        assert!(parse("{\"notifications\":true,\n\"notifications\":false}").unwrap_err().to_string().contains("notifications, line 2"));
    }

    #[test]
    fn accepts_current_defaults_optional_strings_and_dynamic_maps() {
        parse(&serde_json::to_string(&Settings::default()).unwrap()).unwrap();
        let settings = parse(r#"{"floating":{"shortcut":null},"linearApiKey":"secret","mergedCleanup":{"projects":{"/repo":true}},"preferences":{"shortcuts":{"session.stop":["mod+."]},"mode":"dark"}}"#).unwrap();
        assert!(settings.floating.shortcut.is_none());
        assert!(settings.merged_cleanup.enabled_for("/repo"));
        assert_eq!(settings.preferences["mode"], "dark");
    }

    #[test]
    fn a_budget_or_the_window_level_at_no_limit_is_saved_and_read_back_through_the_file() {
        use crate::store::settings::Cap;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        // A hand-edited "none", app-wide and for a project, is a valid file (PRO-335).
        std::fs::write(&path, json!({"orchestrator": {"budgetDollars": "none", "projects": {"/repo": {"budgetPoints": "none", "windowCeiling": 70}}}}).to_string()).unwrap();
        let mut state = FileState::default();
        refresh(&path, &mut state);
        assert!(state.error.is_none(), "{:?}", state.error);
        assert_eq!(state.good.orchestrator.budget_dollars, Cap::NoLimit);
        assert_eq!(state.good.orchestrator.for_project("/repo").budget_points, Cap::NoLimit);

        // Saving No limit for the window level, and reading the file again, keeps every "none".
        let mut next = state.good.clone();
        next.orchestrator.window_ceiling = Cap::NoLimit;
        write(&path, &mut state, &next).unwrap();
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!((&saved["orchestrator"]["budgetDollars"], &saved["orchestrator"]["windowCeiling"]), (&json!("none"), &json!("none")));
        assert_eq!(saved["orchestrator"]["projects"]["/repo"], json!({"budgetPoints": "none", "windowCeiling": 70.0}));
        let mut reread = FileState::default();
        refresh(&path, &mut reread);
        assert!(reread.error.is_none(), "{:?}", reread.error);
        assert_eq!(reread.good.orchestrator, next.orchestrator);

        // Any other word, or null, is still refused with the key.
        for bad in [json!("unlimited"), Value::Null, json!(0)] {
            let error = parse(&json!({"orchestrator": {"windowCeiling": bad}}).to_string()).unwrap_err().to_string();
            assert!(error.contains("orchestrator.windowCeiling") && error.contains("\"none\""), "{error}");
        }
        assert!(parse(&json!({"orchestrator": {"projects": {"/repo": {"budgetDollars": "lots"}}}}).to_string()).unwrap_err().to_string().contains("budgetDollars"));
    }

    #[test]
    fn tries_per_piece_and_effort_ceiling_are_checked_in_the_file_app_wide_and_per_project() {
        let settings = parse(&json!({"orchestrator": {"triesPerPiece": 6, "effortCeiling": "max", "projects": {"/repo": {"triesPerPiece": 1, "effortCeiling": "low"}}}}).to_string()).unwrap();
        assert_eq!((settings.orchestrator.tries_per_piece, settings.orchestrator.effort_ceiling.as_str()), (6, "max"));
        let repo = settings.orchestrator.for_project("/repo");
        assert_eq!((repo.tries_per_piece, repo.effort_ceiling.as_str()), (1, "low"));
        for bad in [json!(0), json!(7), json!("3"), Value::Null] {
            let error = parse(&json!({"orchestrator": {"triesPerPiece": bad}}).to_string()).unwrap_err().to_string();
            assert!(error.contains("orchestrator.triesPerPiece") && error.contains("1 to 6"), "{error}");
            assert!(parse(&json!({"orchestrator": {"projects": {"/repo": {"triesPerPiece": bad}}}}).to_string()).unwrap_err().to_string().contains("triesPerPiece"));
        }
        for bad in [json!("none"), json!("High"), json!(2), Value::Null] {
            let error = parse(&json!({"orchestrator": {"effortCeiling": bad}}).to_string()).unwrap_err().to_string();
            assert!(error.contains("orchestrator.effortCeiling") && error.contains("medium"), "{error}");
            assert!(parse(&json!({"orchestrator": {"projects": {"/repo": {"effortCeiling": bad}}}}).to_string()).unwrap_err().to_string().contains("effortCeiling"));
        }
    }

    #[test]
    fn status_grouping_is_a_valid_default_sidebar_layout() {
        let settings = parse(r#"{"preferences":{"sidebarLayout":"status"}}"#).unwrap();
        assert_eq!(settings.preferences["sidebarLayout"], "status");
        assert!(parse(r#"{"preferences":{"sidebarLayout":"unknown"}}"#).is_err());
    }

    #[test]
    fn a_cold_start_keeps_known_values_and_preserves_future_keys_on_save() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let source = json!({
            "$schema": "https://example.test/settings.schema.json", "future": {"enabled": true},
            "linearApiKey": "private-key", "agents": {"readOnlyCommands": false, "future": 42},
            "diagnostics": {"recoveryIncidents": false},
            "mergedCleanup": {"enabled": true, "graceMinutes": 30, "projects": {"/repo": true}},
            "floating": {"shortcut": "alt+space", "alwaysOnTop": false, "retentionDays": 7},
            "preferences": {"sounds": false, "theme": "moss", "future": "preserve-me"}
        });
        std::fs::write(&path, source.to_string()).unwrap();
        let mut state = FileState::default();
        refresh(&path, &mut state);
        assert!(state.error.is_none());
        assert_eq!(state.good.linear_api_key.as_deref(), Some("private-key"));
        assert!(!state.good.agents.read_only_commands);
        assert!(!state.good.diagnostics.recovery_incidents);
        assert!(state.good.merged_cleanup.enabled);
        assert_eq!(state.good.merged_cleanup.grace_minutes, 30);
        assert_eq!(state.good.floating.shortcut.as_deref(), Some("alt+space"));
        assert!(!state.good.floating.always_on_top);
        assert_eq!(state.good.floating.retention_days, 7);
        assert_eq!(state.good.preferences["sounds"], false);
        assert_eq!(state.good.preferences["theme"], "moss");
        assert!(!serde_json::to_string(&status_at(&path, &state)).unwrap().contains("preserve-me"));

        let mut next = state.good.clone();
        next.notifications = false;
        next.linear_api_key = None; // Clearing a known optional field must still work.
        next.merged_cleanup.projects.clear();
        write(&path, &mut state, &next).unwrap();
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved["$schema"], source["$schema"]);
        assert_eq!(saved["future"], source["future"]);
        assert_eq!(saved["agents"]["future"], 42);
        assert_eq!(saved["preferences"]["future"], "preserve-me");
        assert!(saved.get("linearApiKey").is_none());
        assert_eq!(saved["mergedCleanup"]["projects"], json!({}));
        assert_eq!(saved["notifications"], false);
        assert_eq!(saved["diagnostics"]["recoveryIncidents"], false);
    }

    #[test]
    fn a_cold_start_with_one_invalid_value_keeps_credentials_permissions_and_valid_siblings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let source = "{\n\"linearApiKey\":\"private-key\",\n\"agents\":{\"readOnlyCommands\":false,\"idleStopMinutes\":1},\n\"mergedCleanup\":{\"enabled\":true,\"graceMinutes\":30},\n\"floating\":{\"shortcut\":\"alt+space\",\"retentionDays\":7},\n\"preferences\":{\"theme\":\"moss\",\"sounds\":false}\n}";
        std::fs::write(&path, source).unwrap();
        let mut state = FileState::default();
        refresh(&path, &mut state);
        assert!(state.error.as_deref().unwrap().contains("agents.idleStopMinutes, line 3"));
        assert_eq!(state.good.linear_api_key.as_deref(), Some("private-key"));
        assert!(!state.good.agents.read_only_commands);
        assert_eq!(state.good.agents.idle_stop_minutes, Settings::default().agents.idle_stop_minutes);
        assert!(state.good.merged_cleanup.enabled);
        assert_eq!(state.good.merged_cleanup.grace_minutes, 30);
        assert_eq!(state.good.floating.shortcut.as_deref(), Some("alt+space"));
        assert_eq!(state.good.floating.retention_days, 7);
        assert_eq!(state.good.preferences["theme"], "moss");
        assert_eq!(state.good.preferences["sounds"], false);

        // A later invalid preference only retains that preference, while valid edits apply.
        std::fs::write(&path, source.replace("\"sounds\":false", "\"sounds\":\"invalid\"").replace("\"theme\":\"moss\"", "\"theme\":\"slate\"")).unwrap();
        refresh(&path, &mut state);
        assert_eq!(state.good.preferences["sounds"], false);
        assert_eq!(state.good.preferences["theme"], "slate");
        assert!(!state.good.agents.read_only_commands);
    }

    #[test]
    fn a_cold_start_with_an_invalid_preference_keeps_the_rest_and_uses_its_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"linearApiKey":"private-key","agents":{"readOnlyCommands":false},"preferences":{"sounds":"invalid","theme":"moss"}}"#).unwrap();
        let mut state = FileState::default();
        refresh(&path, &mut state);
        assert!(state.error.as_deref().unwrap().contains("preferences.sounds"));
        assert_eq!(state.good.preferences["sounds"], PREFERENCE_DEFAULTS["sounds"]);
        assert_eq!(state.good.preferences["theme"], "moss");
        assert_eq!(state.good.linear_api_key.as_deref(), Some("private-key"));
        assert!(!state.good.agents.read_only_commands);
    }

    #[test]
    fn future_quit_behaviors_keep_the_existing_lenient_policy() {
        let settings = parse(r#"{"quitBehavior":"future-policy","agents":{"readOnlyCommands":false}}"#).unwrap();
        assert_eq!(settings.quit_behavior, Some(super::super::QuitBehavior::KeepRunning));
        assert!(!settings.agents.read_only_commands);
    }

    #[test]
    fn duplicate_fields_on_a_cold_start_use_defaults_without_resetting_valid_siblings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"linearApiKey":"private-key","agents":{"readOnlyCommands":false,"readOnlyCommands":true},"notifications":false,"preferences":{"theme":"moss"}}"#).unwrap();
        let mut state = FileState::default();
        refresh(&path, &mut state);
        assert!(state.error.as_deref().unwrap().contains("agents.readOnlyCommands"));
        assert_eq!(state.good.agents.read_only_commands, Settings::default().agents.read_only_commands);
        assert_eq!(state.good.linear_api_key.as_deref(), Some("private-key"));
        assert!(!state.good.notifications);
        assert_eq!(state.good.preferences["theme"], "moss");
    }

    #[test]
    fn duplicate_fields_and_invalid_map_entries_do_not_replace_other_choices() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let mut state = FileState::default();
        std::fs::write(&path, r#"{"agents":{"readOnlyCommands":false},"preferences":{"theme":"moss"}}"#).unwrap();
        refresh(&path, &mut state);
        std::fs::write(&path, r#"{"agents":{"readOnlyCommands":false,"readOnlyCommands":true},"preferences":{"theme":"slate","shortcuts":{"bad":"invalid","valid":["mod+."]}}}"#).unwrap();
        refresh(&path, &mut state);
        assert!(!state.good.agents.read_only_commands);
        assert_eq!(state.good.preferences["theme"], "slate");
        assert_eq!(state.good.preferences["shortcuts"], json!({"valid":["mod+."]}));
        assert!(state.error.as_deref().unwrap().contains("agents.readOnlyCommands"));
    }

    #[test]
    fn bad_window_or_migration_patches_have_no_fictional_file_line() {
        for migrate in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("settings.json");
            std::fs::write(&path, "{}").unwrap();
            let error = change_preferences(&path, patch(json!({"fontScale":"invalid"})), migrate, false).err().unwrap().to_string();
            assert_eq!(error, "Cannot save settings: preferences.fontScale: unknown option");
            assert_eq!(std::fs::read_to_string(path).unwrap(), "{}");
        }
    }

    #[test]
    fn migration_preserves_choices_and_credentials_and_runs_only_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"linearApiKey":"private-key","notifications":false,"preferences":{"sounds":true}}"#).unwrap();
        let first = change_preferences(&path, patch(json!({"sounds":false,"fontScale":"lg","shortcuts":{"session.stop":["mod+."]}})), true, false).unwrap();
        assert_eq!(first.preferences["sounds"], true, "existing file wins");
        assert_eq!(first.preferences["fontScale"], "lg");
        assert!(!serde_json::to_string(&first).unwrap().contains("private-key"));
        let saved = parse(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(saved.preferences_migrated);
        assert_eq!(saved.linear_api_key.as_deref(), Some("private-key"));
        assert!(!saved.notifications);
        let again = change_preferences(&path, patch(json!({"fontScale":"sm","sounds":false})), true, false).unwrap();
        assert_eq!(again.preferences, first.preferences);
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn no_legacy_choices_leaves_create_available_and_create_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        assert!(!change_preferences(&path, BTreeMap::new(), true, false).unwrap().exists);
        assert!(change_preferences(&path, BTreeMap::new(), false, true).unwrap().exists);
        std::fs::write(&path, r#"{"notifications":false}"#).unwrap();
        change_preferences(&path, BTreeMap::new(), false, true).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), r#"{"notifications":false}"#);
    }

    #[test]
    fn invalid_edits_retain_the_last_good_settings_and_cannot_be_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        change_preferences(&path, patch(json!({"sounds":false})), true, false).unwrap();
        let invalid = r#"{"preferences":{"sounds":"no"}}"#;
        std::fs::write(&path, invalid).unwrap();
        assert!(change_preferences(&path, patch(json!({"sounds":true})), false, false).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), invalid);
        let files = FILES.lock().unwrap();
        let held = files.get(&path).unwrap();
        assert_eq!(held.good.preferences["sounds"], false);
        assert!(held.error.as_deref().unwrap().contains("preferences.sounds"));
    }

    #[test]
    fn two_windows_merge_their_patches_instead_of_overwriting_each_other() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let threads: Vec<_> = [json!({"sounds":false}), json!({"fontScale":"lg"})].into_iter().map(|value| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                change_preferences(&path, patch(value), false, false).unwrap();
            })
        }).collect();
        barrier.wait();
        for thread in threads { thread.join().unwrap(); }
        let saved = parse(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(saved.preferences["sounds"], false);
        assert_eq!(saved.preferences["fontScale"], "lg");
    }

    /// A read between a save's truncation and its write sees an empty file: the change is
    /// what the file holds once two reads agree, not that (CI, ubuntu: two events for one edit).
    #[test]
    fn a_change_is_what_the_file_settles_to() {
        let mut reads = vec![b"{\"a\"".to_vec(), b"{}".to_vec()].into_iter();
        let mut waits = 0;
        // Empty, then partial, then whole, then whole again: it settles on the whole file.
        let whole = settled(Vec::new(), || reads.next().unwrap_or_else(|| b"{}".to_vec()), || { waits += 1; true });
        assert_eq!((whole.as_deref(), waits), (Some(&b"{}"[..]), 3));
        // Already still: one more read confirms it.
        let mut waits = 0;
        assert_eq!(settled(5, || 5, || { waits += 1; true }), Some(5));
        assert_eq!(waits, 1);
        // Never still: it gives up after ten reads with the last.
        let mut n = 0;
        assert_eq!(settled(0, || { n += 1; n }, || true), Some(10));
        // Stopped while waiting: nothing is reported.
        assert_eq!(settled(1, || 1, || false), None);
    }

    #[test]
    fn watches_creation_replacement_invalid_edits_recovery_and_deletion_within_a_second() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let (send, receive) = mpsc::channel();
        let _watcher = Watcher::at(path.clone(), move || { send.send(()).unwrap(); }).unwrap();
        let wait = || receive.recv_timeout(Duration::from_secs(1)).expect("settings did not reload within one second");
        std::fs::write(&path, r#"{"notifications":false}"#).unwrap();
        wait();
        assert!(!FILES.lock().unwrap()[&path].good.notifications);
        let replacement = dir.path().join("editor.tmp");
        std::fs::write(&replacement, r#"{"notifications":true}"#).unwrap();
        std::fs::rename(&replacement, &path).unwrap();
        wait();
        assert!(FILES.lock().unwrap()[&path].good.notifications);
        std::fs::write(&path, r#"{"notifications":"wrong"}"#).unwrap();
        wait();
        assert!(FILES.lock().unwrap()[&path].good.notifications);
        assert!(FILES.lock().unwrap()[&path].error.is_some());
        assert!(receive.recv_timeout(Duration::from_millis(250)).is_err(), "one event per edit");
        std::fs::write(&path, r#"{"notifications":false}"#).unwrap();
        wait();
        assert!(FILES.lock().unwrap()[&path].error.is_none());
        std::fs::remove_file(&path).unwrap();
        wait();
        assert!(FILES.lock().unwrap()[&path].good.notifications);
    }
}
