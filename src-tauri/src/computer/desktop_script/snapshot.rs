use std::collections::{HashSet, VecDeque};
use std::time::{Duration, Instant};

use super::super::ComputerError;
use serde_json::{json, Value};

const TTL: Duration = Duration::from_secs(120);
const CAPACITY: usize = 32;

struct Entry {
    snapshot: Value,
    keys: HashSet<String>,
    created: Instant,
}

#[derive(Default)]
pub struct SnapshotStore {
    entries: VecDeque<Entry>,
}

fn namespace(params: &Value) -> String {
    if let Some(session) = params["session"].as_str() {
        return format!("session:{session}");
    }
    if let Some(worktree) = params["worktree"].as_str() {
        return format!("worktree:{worktree}");
    }
    "default".into()
}

fn key(params: &Value, app: &str, target: &str, value: &Value) -> String {
    // Structured keys prevent selectors containing delimiters from colliding.
    // Window indexes are per app, never global across unrelated apps.
    json!([namespace(params), app.to_lowercase(), target, value]).to_string()
}

fn aliases(query: &str, snapshot: &Value) -> HashSet<String> {
    let mut names = HashSet::from([query.to_owned()]);
    for field in ["name", "bundleId", "bundleIdentifier"] {
        if let Some(name) = snapshot["app"][field].as_str().filter(|s| !s.is_empty()) {
            names.insert(name.into());
        }
    }
    if let Some(pid) = snapshot["app"]["pid"].as_u64().filter(|pid| *pid > 0) {
        names.insert(format!("pid:{pid}"));
        names.insert(pid.to_string());
    }
    names
}

impl SnapshotStore {
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    fn prune(&mut self, now: Instant) {
        while self
            .entries
            .front()
            .is_some_and(|entry| now.duration_since(entry.created) > TTL)
            || self.entries.len() > CAPACITY
        {
            self.entries.pop_front();
        }
    }

    pub fn remember(&mut self, query: &str, snapshot: &Value, params: &Value) {
        self.remember_at(query, snapshot, params, Instant::now());
    }

    fn remember_at(&mut self, query: &str, snapshot: &Value, params: &Value, now: Instant) {
        let mut keys = HashSet::new();
        for alias in aliases(query, snapshot) {
            keys.insert(key(params, &alias, "app", &Value::Null));
            for target in ["windowId", "windowIndex"] {
                let value = if target == "windowIndex" && params[target].is_number() {
                    &params[target]
                } else {
                    &snapshot[target]
                };
                if value.is_number() {
                    keys.insert(key(params, &alias, target, value));
                }
            }
        }
        // Retire reused aliases from older entries. They must never reappear
        // when the newest snapshot expires or its window target is evicted.
        for entry in &mut self.entries {
            entry.keys.retain(|key| !keys.contains(key));
        }
        self.entries.retain(|entry| !entry.keys.is_empty());
        let mut cached = snapshot.clone();
        cached
            .as_object_mut()
            .unwrap()
            .remove("screenshotPngBase64");
        self.entries.push_back(Entry {
            snapshot: cached,
            keys,
            created: now,
        });
        self.prune(now);
    }

    pub fn current(&mut self, app: &str, params: &Value) -> Option<Value> {
        self.current_at(app, params, Instant::now())
    }

    fn current_at(&mut self, app: &str, params: &Value, now: Instant) -> Option<Value> {
        self.prune(now);
        let (target, value) = if params["windowId"].is_number() {
            ("windowId", &params["windowId"])
        } else if params["windowIndex"].is_number() {
            ("windowIndex", &params["windowIndex"])
        } else {
            ("app", &Value::Null)
        };
        let key = key(params, app, target, value);
        self.entries
            .iter()
            .rev()
            .find(|entry| entry.keys.contains(&key))
            .map(|entry| entry.snapshot.clone())
    }

    pub fn forget_window_target(&mut self, query: &str, params: &Value, current: Option<&Value>) {
        let names = aliases(query, current.unwrap_or(&Value::Null));
        let mut stale = HashSet::new();
        for app in names {
            for target in ["windowId", "windowIndex"] {
                // Forget both representations of the stale window, including
                // cached implicit targets, so no alias can revive its indexes.
                for value in [&params[target], &current.unwrap_or(&Value::Null)[target]] {
                    if value.is_number() {
                        stale.insert(key(params, &app, target, value));
                    }
                }
            }
            stale.insert(key(params, &app, "app", &Value::Null));
        }
        for entry in &mut self.entries {
            entry.keys.retain(|key| !stale.contains(key));
        }
        self.entries.retain(|entry| !entry.keys.is_empty());
    }
}

pub fn element(
    snapshot: Option<&Value>,
    index: Option<&Value>,
) -> Result<Option<Value>, ComputerError> {
    let Some(index) = index.filter(|index| !index.is_null()) else {
        return Ok(None);
    };
    snapshot.and_then(|snapshot| snapshot["elements"].as_array())
        .and_then(|elements| elements.iter().find(|element| &element["index"] == index))
        .cloned().map(Some).ok_or_else(|| ComputerError::new("element_not_found",
            format!("element {index} is not in the current cached snapshot; run get-app-state again and use a fresh element index")))
}

pub fn normalize_app(app: &Value) -> Result<Value, ComputerError> {
    if !app.is_object() {
        return Err(ComputerError::accessibility(
            "desktop provider returned no app",
        ));
    }
    Ok(
        json!({"name": app["name"], "bundleId": app.get("bundleId").filter(|v| !v.is_null()).unwrap_or(&app["bundleIdentifier"]), "pid": app["pid"]}),
    )
}

fn sanitize(text: &str) -> String {
    text.replace(['\n', '\r'], " ")
}
fn number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite() && *n > 0.0)
}

pub fn render(snapshot: &Value, no_screenshot: bool) -> Result<Value, ComputerError> {
    let app = normalize_app(&snapshot["app"])?;
    let app_ref = app["bundleId"]
        .as_str()
        .or_else(|| app["name"].as_str())
        .unwrap_or_default();
    let name = app["name"].as_str().unwrap_or_default();
    let title = snapshot["windowTitle"].as_str().unwrap_or(name);
    let mut lines = vec![
        format!("App={app_ref} (pid {})", app["pid"]),
        format!("Window: \"{}\", App: {}.", sanitize(title), sanitize(name)),
        String::new(),
    ];
    if let Some(tree) = snapshot["treeLines"].as_array() {
        lines.extend(tree.iter().filter_map(Value::as_str).map(str::to_owned));
    }
    if let Some(selected) = snapshot["selectedText"].as_str().filter(|s| !s.is_empty()) {
        lines.extend([
            String::new(),
            format!("Selected text: [{}]", sanitize(selected)),
        ]);
    } else if let Some(focused) = snapshot["focusedSummary"]
        .as_str()
        .filter(|s| !s.is_empty())
    {
        lines.extend([
            String::new(),
            format!("The focused UI element is {}.", sanitize(focused)),
        ]);
    }
    let bounds = &snapshot["windowBounds"];
    let elements = snapshot["elements"].as_array();
    let focused = elements
        .and_then(|items| {
            items
                .iter()
                .find(|e| e["index"] == snapshot["focusedElementId"])
        })
        .map(|e| e["index"].clone())
        .unwrap_or(Value::Null);
    let window_ref = if snapshot["windowId"].is_number() {
        snapshot["windowId"].to_string()
    } else if snapshot["windowIndex"].is_number() {
        format!("window-index:{}", snapshot["windowIndex"])
    } else {
        "window".into()
    };
    let id = snapshot["snapshotId"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{app_ref}:{}:{window_ref}", app["pid"]));
    let screenshot = if no_screenshot {
        Value::Null
    } else {
        snapshot["screenshotPngBase64"].as_str().filter(|s| !s.is_empty()).map(|data| json!({
            "data": data, "format": "png",
            "width": number(&snapshot["screenshotWidth"]).unwrap_or_else(|| number(&bounds["width"]).unwrap_or(1.0)).round().max(1.0),
            "height": number(&snapshot["screenshotHeight"]).unwrap_or_else(|| number(&bounds["height"]).unwrap_or(1.0)).round().max(1.0),
            "scale": number(&snapshot["screenshotScale"]).unwrap_or(1.0)
        })).unwrap_or(Value::Null)
    };
    let status = if !screenshot.is_null() {
        json!({"state": "captured", "metadata": {"engine": "unknown", "windowId": snapshot["windowId"]}})
    } else if no_screenshot {
        json!({"state": "skipped", "reason": "no_screenshot_flag"})
    } else {
        json!({"state": "failed", "code": "screenshot_failed", "message": snapshot["screenshotError"]["message"].as_str().unwrap_or("desktop provider returned no image; check desktop capture support or pass --no-screenshot to inspect accessibility state only.")})
    };
    Ok(json!({
        "snapshot": {
            "id": id, "app": app, "window": {
                "title": title, "id": snapshot["windowId"], "index": snapshot["windowIndex"],
                "x": bounds["x"].as_f64().map(f64::round), "y": bounds["y"].as_f64().map(f64::round),
                "width": bounds["width"].as_f64().unwrap_or(0.0).round().max(0.0),
                "height": bounds["height"].as_f64().unwrap_or(0.0).round().max(0.0),
                "isMinimized": null, "isOffscreen": null, "screenIndex": null
            },
            "coordinateSpace": snapshot["coordinateSpace"].as_str().unwrap_or("window"),
            "treeText": lines.join("\n"), "elementCount": elements.map_or(0, Vec::len), "focusedElementId": focused,
            "truncation": {"truncated": snapshot["truncation"]["truncated"] == true,
                "maxDepthReached": snapshot["truncation"]["maxDepthReached"] == true,
                "maxDepth": snapshot["truncation"]["maxDepth"], "maxNodes": snapshot["truncation"]["maxNodes"]}
        },
        "screenshot": screenshot, "screenshotStatus": status
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state(name: &str, pid: u64, window: u64) -> Value {
        json!({"app": {"name": name, "pid": pid}, "windowId": window, "windowIndex": 0,
            "screenshotPngBase64": "large", "elements": [{"index": 7, "runtimeId": [pid, 2]}]})
    }

    #[test]
    fn aliases_are_case_insensitive_and_window_indexes_stay_with_the_app_and_session() {
        let mut store = SnapshotStore::default();
        store.remember(
            "editor",
            &state("Text Editor", 11, 100),
            &json!({"session": "a"}),
        );
        store.remember("other", &state("Other", 22, 200), &json!({"session": "a"}));
        for alias in ["EDITOR", "Text Editor", "pid:11", "11"] {
            let cached = store
                .current(alias, &json!({"session": "a", "windowIndex": 0}))
                .unwrap();
            assert_eq!(cached["app"]["pid"], 11);
            assert!(cached.get("screenshotPngBase64").is_none());
        }
        assert!(store.current("editor", &json!({"session": "b"})).is_none());
        assert!(store.current("editor", &json!({})).is_none());
        assert!(store
            .current("editor", &json!({"session": "a", "windowId": 200}))
            .is_none());
    }

    #[test]
    fn ttl_capacity_and_reused_aliases_do_not_revive_old_elements() {
        let mut store = SnapshotStore::default();
        let now = Instant::now();
        store.remember_at("editor", &state("Text Editor", 11, 100), &json!({}), now);
        let later = now + Duration::from_secs(60);
        let mut fresh = state("Text Editor", 11, 100);
        fresh["elements"] = json!([{ "index": 99 }]);
        store.remember_at("editor", &fresh, &json!({}), later);
        let cached = store
            .current_at("editor", &json!({}), now + TTL + Duration::from_secs(1))
            .unwrap();
        assert_eq!(
            element(Some(&cached), Some(&json!(7))).unwrap_err().code,
            "element_not_found"
        );
        assert!(store
            .current_at("editor", &json!({}), later + TTL + Duration::from_secs(1))
            .is_none());
        for i in 1..=33 {
            store.remember_at(
                &format!("app{i}"),
                &state(&format!("App{i}"), i, i),
                &json!({}),
                now,
            );
        }
        assert_eq!(store.entries.len(), CAPACITY);
        assert!(store.current_at("app1", &json!({}), now).is_none());
        assert!(store.current_at("app33", &json!({}), now).is_some());
    }

    #[test]
    fn window_changed_forgets_all_stale_aliases_without_affecting_other_windows() {
        let mut store = SnapshotStore::default();
        let current = state("Editor", 11, 100);
        store.remember("editor", &current, &json!({"windowId": 100}));
        let mut other = current.clone();
        other["windowId"] = json!(200);
        other["windowIndex"] = json!(1);
        store.remember("editor", &other, &json!({"windowId": 200}));
        store.forget_window_target("editor", &json!({"windowId": 100}), Some(&current));
        for alias in ["editor", "pid:11"] {
            assert!(store.current(alias, &json!({"windowId": 100})).is_none());
            assert!(store.current(alias, &json!({"windowIndex": 0})).is_none());
            assert_eq!(
                store.current(alias, &json!({"windowId": 200})).unwrap()["windowId"],
                200
            );
        }
    }

    #[test]
    fn renders_sparse_tree_scaled_screenshot_and_explicit_capture_failures() {
        let mut snapshot = state("Editor", 11, 100);
        snapshot["windowBounds"] = json!({"x": 3, "y": 4, "width": 2000, "height": 1000});
        snapshot["screenshotWidth"] = json!(1000);
        snapshot["screenshotHeight"] = json!(500);
        snapshot["screenshotScale"] = json!(0.5);
        snapshot["treeLines"] = json!(["7 entry Text", "  99 button Save"]);
        snapshot["focusedElementId"] = json!(99);
        let result = render(&snapshot, false).unwrap();
        assert!(result["snapshot"]["treeText"]
            .as_str()
            .unwrap()
            .ends_with("7 entry Text\n  99 button Save"));
        assert_eq!(result["snapshot"]["elementCount"], 1);
        assert!(result["snapshot"]["focusedElementId"].is_null());
        assert_eq!(result["screenshot"]["scale"], 0.5);
        assert_eq!(result["screenshot"]["width"].as_f64(), Some(1000.0));
        assert!(result["snapshot"].get("elements").is_none());
        let skipped = render(&snapshot, true).unwrap();
        assert!(skipped["screenshot"].is_null());
        assert_eq!(skipped["screenshotStatus"]["state"], "skipped");
        snapshot["screenshotPngBase64"] = Value::Null;
        snapshot["screenshotError"] = json!({"message": "Wayland screenshots are unsupported"});
        assert_eq!(
            render(&snapshot, false).unwrap()["screenshotStatus"]["message"],
            "Wayland screenshots are unsupported"
        );
    }
}
