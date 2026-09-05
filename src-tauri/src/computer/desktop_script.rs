//! AT-SPI / UI Automation providers. Scripts are stateless; this provider owns
//! the last observed identities used to resolve subsequent element actions.
mod bridge;
mod snapshot;

use super::{ActionMethod, ComputerError, ComputerProvider, REQUIRED_PROTOCOL_VERSION};
use serde_json::{json, Value};
use std::path::PathBuf;

pub use bridge::{script_path, Platform};

pub struct DesktopScriptProvider {
    platform: Platform,
    script: PathBuf,
    capabilities: Option<Value>,
    snapshots: snapshot::SnapshotStore,
}

impl DesktopScriptProvider {
    pub fn new(platform: Platform, script: PathBuf) -> Self {
        Self {
            platform,
            script,
            capabilities: None,
            snapshots: Default::default(),
        }
    }

    fn call_bridge(&self, request: &Value) -> Result<Value, ComputerError> {
        bridge::call(self.platform, &self.script, request)
    }

    fn ensure_capability(&mut self, group: &str, key: &str) -> Result<(), ComputerError> {
        let capabilities = self.capabilities()?;
        if capabilities["supports"][group][key] != true {
            return Err(ComputerError::new(
                "unsupported_capability",
                format!(
                    "{} does not support {group}.{key}",
                    capabilities["provider"]
                        .as_str()
                        .unwrap_or("desktop provider")
                ),
            ));
        }
        Ok(())
    }

    fn remember_and_render(
        &mut self,
        query: &str,
        response: &Value,
        params: &Value,
    ) -> Result<Value, ComputerError> {
        let snapshot = &response["snapshot"];
        if !snapshot.is_object() {
            return Err(ComputerError::accessibility(
                "desktop provider returned no snapshot",
            ));
        }
        let result = snapshot::render(snapshot, params["noScreenshot"] == true)?;
        self.snapshots.remember(query, snapshot, params);
        Ok(result)
    }
}

fn app(params: &Value) -> Result<&str, ComputerError> {
    params["app"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| ComputerError::invalid("app is required"))
}

fn snapshot_request(tool: &str, params: &Value) -> Value {
    let mut request = json!({"tool": tool});
    for field in [
        "app",
        "windowId",
        "windowIndex",
        "noScreenshot",
        "restoreWindow",
    ] {
        if let Some(value) = params.get(field) {
            request[field] = value.clone();
        }
    }
    request
}

impl ComputerProvider for DesktopScriptProvider {
    fn capabilities(&mut self) -> Result<Value, ComputerError> {
        if let Some(capabilities) = &self.capabilities {
            return Ok(capabilities.clone());
        }
        let response = self.call_bridge(&json!({"tool": "handshake"}))?;
        let capabilities = &response["capabilities"];
        if !capabilities.is_object() {
            return Err(ComputerError::accessibility(
                "desktop provider returned no capabilities",
            ));
        }
        if capabilities["protocolVersion"].as_u64() != Some(REQUIRED_PROTOCOL_VERSION) {
            return Err(ComputerError::new(
                "provider_incompatible",
                "desktop provider protocol version does not match this app",
            ));
        }
        self.capabilities = Some(capabilities.clone());
        Ok(capabilities.clone())
    }

    fn list_apps(&mut self) -> Result<Value, ComputerError> {
        self.ensure_capability("apps", "list")?;
        let response = self.call_bridge(&json!({"tool": "list_apps"}))?;
        let apps = response["apps"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|app| {
                let mut app = snapshot::normalize_app(app)?;
                app["isRunning"] = json!(true);
                app["lastUsedAt"] = Value::Null;
                app["useCount"] = Value::Null;
                Ok(app)
            })
            .collect::<Result<Vec<_>, ComputerError>>()?;
        Ok(json!({"apps": apps}))
    }

    fn list_windows(&mut self, params: Value) -> Result<Value, ComputerError> {
        self.ensure_capability("windows", "list")?;
        let response = self.call_bridge(&json!({"tool": "list_windows", "app": app(&params)?}))?;
        let windows = response["windows"].as_array().into_iter().flatten().map(|window| {
            Ok(json!({"index": window["index"], "app": snapshot::normalize_app(&window["app"])?,
                "id": window["id"], "title": window["title"], "x": window["x"], "y": window["y"],
                "width": window["width"], "height": window["height"], "isMinimized": window["isMinimized"],
                "isOffscreen": window["isOffscreen"], "screenIndex": window["screenIndex"], "platform": window["platform"]}))
        }).collect::<Result<Vec<_>, ComputerError>>()?;
        Ok(json!({"app": snapshot::normalize_app(&response["app"])?, "windows": windows}))
    }

    fn snapshot(&mut self, params: Value) -> Result<Value, ComputerError> {
        let query = app(&params)?;
        let response = self.call_bridge(&snapshot_request("get_app_state", &params))?;
        self.remember_and_render(query, &response, &params)
    }

    fn action(&mut self, method: ActionMethod, params: Value) -> Result<Value, ComputerError> {
        super::validation::validate_action_params(method, &params)?;
        let query = app(&params)?;
        let current = self.snapshots.current(query, &params);
        let mut request = snapshot_request(bridge_tool(method), &params);
        // Resolve before even launching a handshake: cache misses must never
        // allow an index to be interpreted against an unrelated fresh tree.
        for (param, field) in [
            ("elementIndex", "element"),
            ("fromElementIndex", "fromElement"),
            ("toElementIndex", "toElement"),
        ] {
            if let Some(element) = snapshot::element(current.as_ref(), params.get(param))? {
                request[field] = element;
            }
        }
        self.ensure_capability("actions", method.capability_key())?;
        if !params["windowId"].is_number() && !params["windowIndex"].is_number() {
            if let Some(current) = &current {
                if current["windowId"].is_number() {
                    request["windowId"] = current["windowId"].clone();
                } else if current["windowIndex"].is_number() {
                    request["windowIndex"] = current["windowIndex"].clone();
                }
            }
        }
        for (param, field) in [
            ("x", "x"),
            ("y", "y"),
            ("fromX", "from_x"),
            ("fromY", "from_y"),
            ("toX", "to_x"),
            ("toY", "to_y"),
            ("clickCount", "click_count"),
            ("mouseButton", "mouse_button"),
            ("modifiers", "modifiers"),
            ("action", "action"),
            ("direction", "direction"),
            ("pages", "pages"),
            ("text", "text"),
            ("key", "key"),
            ("value", "value"),
        ] {
            if let Some(value) = params.get(param) {
                request[field] = value.clone();
            }
        }
        let response = self.call_bridge(&request)?;
        let action = action_metadata(
            method,
            &params,
            &response,
            &request["element"],
            current.as_ref(),
        );
        let mut cache_params = params.clone();
        if action["verification"]["state"] == "unverified"
            && action["verification"]["reason"] == "window_changed"
        {
            self.snapshots
                .forget_window_target(query, &params, current.as_ref());
            cache_params.as_object_mut().unwrap().remove("windowId");
            cache_params.as_object_mut().unwrap().remove("windowIndex");
        }
        let mut result = self.remember_and_render(query, &response, &cache_params)?;
        result["action"] = action;
        super::normalize_action_result(&mut result);
        Ok(result)
    }

    fn shutdown(&mut self) {
        self.snapshots.clear();
        self.capabilities = None;
    }
}

fn bridge_tool(method: ActionMethod) -> &'static str {
    match method {
        ActionMethod::PerformSecondaryAction => "perform_secondary_action",
        ActionMethod::TypeText => "type_text",
        ActionMethod::PressKey => "press_key",
        ActionMethod::PasteText => "paste_text",
        ActionMethod::SetValue => "set_value",
        other => other.wire(),
    }
}

fn action_metadata(
    method: ActionMethod,
    params: &Value,
    response: &Value,
    target: &Value,
    current: Option<&Value>,
) -> Value {
    let path = match method {
        ActionMethod::PasteText => "clipboard",
        ActionMethod::SetValue | ActionMethod::PerformSecondaryAction => "accessibility",
        _ => "synthetic",
    };
    let action_name = match method {
        ActionMethod::PasteText => Some("paste"),
        ActionMethod::Click | ActionMethod::Scroll | ActionMethod::Drag => None,
        _ => Some(method.wire()),
    };
    let mut action = response
        .get("action")
        .filter(|action| action.is_object())
        .cloned()
        .unwrap_or_else(
            || json!({"path": path, "actionName": action_name, "fallbackReason": null}),
        );
    for (field, snapshot_field) in [
        ("targetWindowId", "windowId"),
        ("targetWindowIndex", "windowIndex"),
    ] {
        if action[field].is_null() {
            action[field] = response["snapshot"]
                .get(snapshot_field)
                .filter(|v| !v.is_null())
                .or_else(|| current.and_then(|s| s.get(snapshot_field)))
                .cloned()
                .unwrap_or(Value::Null);
        }
    }
    if !action["verification"].is_null() {
        return action;
    }
    let reason = match method {
        ActionMethod::TypeText | ActionMethod::PressKey | ActionMethod::Hotkey => {
            Some("synthetic_input")
        }
        ActionMethod::PasteText => Some("clipboard_paste"),
        _ => None,
    };
    if let Some(reason) = reason {
        action["verification"] = json!({"state": "unverified", "reason": reason});
    }
    if method == ActionMethod::SetValue {
        let elements = response["snapshot"]["elements"].as_array();
        let actual = elements
            .and_then(|elements| {
                elements
                    .iter()
                    .find(|element| same_identity(element, target))
                    .or_else(|| {
                        elements
                            .iter()
                            .find(|e| e["index"] == params["elementIndex"])
                    })
            })
            .and_then(|element| element["value"].as_str());
        let expected = params["value"].as_str();
        action["verification"] = if actual.is_some() && actual == expected {
            json!({"state": "verified", "property": "value", "expected": expected, "actualPreview": actual})
        } else {
            json!({"state": "unverified", "reason": if actual.is_some() { "value_mismatch" } else { "provider_unavailable" }, "expected": expected, "actualPreview": actual})
        };
    }
    action
}

fn same_identity(left: &Value, right: &Value) -> bool {
    if !left["runtimeId"].is_null() && !right["runtimeId"].is_null() {
        return left["runtimeId"] == right["runtimeId"];
    }
    left["automationId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .is_some_and(|id| Some(id) == right["automationId"].as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_verification_follows_provider_identity_then_index() {
        let params = json!({"elementIndex": 3, "value": "new"});
        let target = json!({"index": 3, "runtimeId": [1, 7], "automationId": "entry"});
        let mut response = json!({"snapshot": {"elements": [
            {"index": 3, "runtimeId": [1, 8], "value": "wrong"},
            {"index": 99, "runtimeId": [1, 7], "value": "new"}
        ]}});
        let action = action_metadata(ActionMethod::SetValue, &params, &response, &target, None);
        assert_eq!(action["verification"]["state"], "verified");
        assert_eq!(action["verification"]["property"], "value");
        response["snapshot"]["elements"][1]["value"] = json!("mismatch");
        assert_eq!(
            action_metadata(ActionMethod::SetValue, &params, &response, &target, None)
                ["verification"]["reason"],
            "value_mismatch"
        );
        response["snapshot"]["elements"] = json!([]);
        assert_eq!(
            action_metadata(ActionMethod::SetValue, &params, &response, &target, None)
                ["verification"]["reason"],
            "provider_unavailable"
        );
        response["snapshot"]["elements"] = json!([{ "index": 3, "value": "new" }]);
        assert_eq!(
            action_metadata(ActionMethod::SetValue, &params, &response, &target, None)
                ["verification"]["state"],
            "verified"
        );
        response["snapshot"]["elements"] =
            json!([{ "index": 12, "automationId": "entry", "value": "new" }]);
        assert_eq!(
            action_metadata(ActionMethod::SetValue, &params, &response, &target, None)
                ["verification"]["state"],
            "verified"
        );
    }

    #[test]
    fn synthetic_and_clipboard_delivery_are_unverified_and_explicit_verification_survives() {
        for (method, path, reason) in [
            (ActionMethod::PasteText, "clipboard", "clipboard_paste"),
            (ActionMethod::TypeText, "synthetic", "synthetic_input"),
            (ActionMethod::PressKey, "synthetic", "synthetic_input"),
            (ActionMethod::Hotkey, "synthetic", "synthetic_input"),
        ] {
            let action = action_metadata(method, &json!({}), &json!({}), &Value::Null, None);
            assert_eq!(action["path"], path);
            assert_eq!(action["verification"]["reason"], reason);
        }
        let response = json!({"action": {"path": "accessibility", "verification": {"state": "unverified", "reason": "window_changed"}}});
        assert_eq!(
            action_metadata(
                ActionMethod::SetValue,
                &json!({}),
                &response,
                &Value::Null,
                None
            )["verification"],
            response["action"]["verification"]
        );
    }

    #[test]
    fn absent_cached_element_fails_before_launching_any_script() {
        let mut provider =
            DesktopScriptProvider::new(Platform::Linux, PathBuf::from("does-not-exist.py"));
        let failure = provider
            .action(
                ActionMethod::Click,
                json!({"app": "Editor", "elementIndex": 7}),
            )
            .unwrap_err();
        assert_eq!(failure.code, "element_not_found");
    }

    #[cfg(unix)]
    #[test]
    fn fake_provider_exercises_handshake_cache_window_pinning_and_action_translation() {
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("fake.py");
        std::fs::write(&script, r#"
import json, pathlib, sys
op = json.loads(pathlib.Path(sys.argv[1]).read_text())
log = pathlib.Path(__file__).with_suffix('.log')
with log.open('a') as f: f.write(json.dumps(op) + '\n')
snapshot = {'app': {'name': 'Editor', 'pid': 123}, 'windowIndex': 2, 'treeLines': ['7 entry Text'], 'elements': [{'index': 7, 'runtimeId': [1, 2], 'value': op.get('value', '')}]}
if op['tool'] == 'handshake':
    reply = {'capabilities': {'protocolVersion': 1, 'provider': 'fake', 'supports': {'actions': {'setValue': True, 'click': False}}}}
elif op['tool'] == 'set_value':
    assert op['element']['runtimeId'] == [1, 2]
    assert op['windowIndex'] == 2
    assert 'elementIndex' not in op
    reply = {'snapshot': snapshot}
else: reply = {'snapshot': snapshot}
print(json.dumps({'ok': True, **reply}))
"#).unwrap();
        let mut provider = DesktopScriptProvider::new(Platform::Linux, script.clone());
        provider
            .snapshot(json!({"app": "Editor", "windowIndex": 2, "noScreenshot": true}))
            .unwrap();
        let result = provider
            .action(
                ActionMethod::SetValue,
                json!({"app": "pid:123", "elementIndex": 7, "value": "hi", "noScreenshot": true}),
            )
            .unwrap();
        assert_eq!(result["action"]["verification"]["state"], "verified");
        assert_eq!(
            provider
                .action(
                    ActionMethod::Click,
                    json!({"app": "Editor", "elementIndex": 7})
                )
                .unwrap_err()
                .code,
            "unsupported_capability"
        );
        provider.capabilities().unwrap();
        let calls: Vec<Value> = std::fs::read_to_string(script.with_extension("log"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            calls
                .iter()
                .filter(|call| call["tool"] == "handshake")
                .count(),
            1
        );
        assert_eq!(calls.len(), 3);
        provider.shutdown();
        assert_eq!(
            provider
                .action(
                    ActionMethod::SetValue,
                    json!({"app": "Editor", "elementIndex": 7, "value": "hi"})
                )
                .unwrap_err()
                .code,
            "element_not_found"
        );
    }
}
