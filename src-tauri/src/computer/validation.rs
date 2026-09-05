//! Argument validation shared by the CLI and the control dispatcher, ported
//! from Legacy's `computer-provider-action-validation.ts` and
//! `computer-use-key-spec.ts`. Rejecting bad arguments here means the helper
//! only ever sees well-formed requests, and an agent gets `invalid_argument`
//! with a hint instead of a vague accessibility error.

use serde_json::Value;

use super::{ActionMethod, ComputerError};

/// Paste payloads travel through the system clipboard; 16 MiB is the limit
/// Legacy enforced so a runaway payload cannot stall the pasteboard.
pub const PASTE_TEXT_MAX_BYTES: usize = 16 * 1024 * 1024;
pub const PASTE_TEXT_TOO_LARGE: &str = "Clipboard text is too large to copy safely.";

const HOTKEY_MODIFIERS: &[&str] = &[
    "alt",
    "cmd",
    "cmdorctrl",
    "command",
    "commandorcontrol",
    "control",
    "ctrl",
    "meta",
    "option",
    "shift",
    "super",
    "win",
];

pub const HOTKEY_HINT: &str =
    "Hotkey requires a modifier and one key, e.g. CmdOrCtrl+A. Use press-key for a single key.";
pub const PRESS_KEY_HINT: &str =
    "Press-key accepts one key only, e.g. Return, Escape, Tab, or +. Use hotkey for modifier combinations.";
pub const CLICK_MODIFIERS_HINT: &str =
    "Click modifiers accept modifier keys only, e.g. CmdOrCtrl or CmdOrCtrl+Shift.";

fn normalize_hotkey_part(part: &str) -> String {
    part.to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '_' && *c != '-')
        .collect()
}

pub fn hotkey_validation_message(key: &str) -> Option<&'static str> {
    let parts: Vec<&str> = key.split('+').map(str::trim).collect();
    if parts.len() < 2 || parts.iter().any(|part| part.is_empty()) {
        return Some(HOTKEY_HINT);
    }
    let key_parts = parts
        .iter()
        .filter(|part| !HOTKEY_MODIFIERS.contains(&normalize_hotkey_part(part).as_str()))
        .count();
    (key_parts != 1).then_some(HOTKEY_HINT)
}

pub fn press_key_validation_message(key: &str) -> Option<&'static str> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Some(PRESS_KEY_HINT);
    }
    (trimmed != "+" && trimmed.contains('+')).then_some(PRESS_KEY_HINT)
}

pub fn click_modifiers_validation_message(modifiers: &str) -> Option<&'static str> {
    let parts: Vec<&str> = modifiers.split('+').map(str::trim).collect();
    let bad = parts.is_empty()
        || parts.len() > 4
        || parts
            .iter()
            .any(|part| part.is_empty() || !HOTKEY_MODIFIERS.contains(&part.to_lowercase().as_str()));
    bad.then_some(CLICK_MODIFIERS_HINT)
}

/// Validate the parameters of one action before it reaches a provider.
pub fn validate_action_params(method: ActionMethod, params: &Value) -> Result<(), ComputerError> {
    require_non_empty_string(params, "app")?;
    validate_window_target(params)?;
    match method {
        ActionMethod::Click => {
            validate_element_or_coordinates("Click", params)?;
            validate_positive_integer(params, "clickCount")?;
            validate_mouse_button(params)?;
            if let Some(modifiers) = params.get("modifiers").filter(|v| !v.is_null()) {
                let modifiers = modifiers
                    .as_str()
                    .filter(|m| !m.is_empty())
                    .ok_or_else(|| ComputerError::invalid("Missing modifiers"))?;
                if let Some(message) = click_modifiers_validation_message(modifiers) {
                    return Err(ComputerError::invalid(message));
                }
            }
        }
        ActionMethod::PerformSecondaryAction => {
            require_non_negative_integer(params, "elementIndex")?;
            require_non_empty_string(params, "action")?;
        }
        ActionMethod::Scroll => {
            validate_element_or_coordinates("Scroll", params)?;
            let direction = require_non_empty_string(params, "direction")?;
            if !matches!(direction.as_str(), "up" | "down" | "left" | "right") {
                return Err(ComputerError::invalid(
                    "Unsupported direction; expected up, down, left, or right",
                ));
            }
            validate_positive_number(params, "pages")?;
        }
        ActionMethod::Drag => validate_drag_target(params)?,
        ActionMethod::TypeText => {
            require_non_empty_string(params, "text")?;
        }
        ActionMethod::PasteText => {
            let text = require_non_empty_string(params, "text")?;
            if text.len() > PASTE_TEXT_MAX_BYTES {
                return Err(ComputerError::invalid(PASTE_TEXT_TOO_LARGE));
            }
        }
        ActionMethod::PressKey => {
            let key = require_non_empty_string(params, "key")?;
            if let Some(message) = press_key_validation_message(&key) {
                return Err(ComputerError::invalid(message));
            }
        }
        ActionMethod::Hotkey => {
            let key = require_non_empty_string(params, "key")?;
            if let Some(message) = hotkey_validation_message(&key) {
                return Err(ComputerError::invalid(message));
            }
        }
        ActionMethod::SetValue => {
            require_non_negative_integer(params, "elementIndex")?;
            require_string_allowing_empty(params, "value")?;
        }
    }
    Ok(())
}

fn present(params: &Value, key: &str) -> bool {
    params.get(key).is_some_and(|v| !v.is_null())
}

pub fn validate_window_target(params: &Value) -> Result<(), ComputerError> {
    if present(params, "windowId") && present(params, "windowIndex") {
        return Err(ComputerError::invalid(
            "Window targeting accepts either windowId or windowIndex, not both",
        ));
    }
    if present(params, "windowId") {
        require_non_negative_integer(params, "windowId")?;
    }
    if present(params, "windowIndex") {
        require_non_negative_integer(params, "windowIndex")?;
    }
    Ok(())
}

fn validate_element_or_coordinates(action: &str, params: &Value) -> Result<(), ComputerError> {
    let has_element = present(params, "elementIndex");
    let has_x = present(params, "x");
    let has_y = present(params, "y");
    if !has_element && !(has_x && has_y) {
        return Err(ComputerError::invalid(format!(
            "{action} requires elementIndex or both x and y"
        )));
    }
    if has_x != has_y {
        return Err(ComputerError::invalid(format!(
            "{action} coordinates require both x and y"
        )));
    }
    if has_element && (has_x || has_y) {
        return Err(ComputerError::invalid(format!(
            "{action} accepts either elementIndex or coordinate fields, not both"
        )));
    }
    if has_element {
        require_non_negative_integer(params, "elementIndex")?;
    }
    require_finite_number(params, "x")?;
    require_finite_number(params, "y")?;
    Ok(())
}

fn validate_drag_target(params: &Value) -> Result<(), ComputerError> {
    let from_element = present(params, "fromElementIndex");
    let to_element = present(params, "toElementIndex");
    let coordinates = ["fromX", "fromY", "toX", "toY"];
    let has_element_pair = from_element && to_element;
    let has_partial_element_pair = from_element || to_element;
    let has_coordinate_pair = coordinates.iter().all(|key| present(params, key));
    let has_partial_coordinate_pair = coordinates.iter().any(|key| present(params, key));
    if has_element_pair && has_coordinate_pair {
        return Err(ComputerError::invalid(
            "Drag accepts either element indexes or coordinate fields, not both",
        ));
    }
    if has_partial_element_pair && !has_element_pair {
        return Err(ComputerError::invalid(
            "Drag element targeting requires both fromElementIndex and toElementIndex",
        ));
    }
    if has_partial_coordinate_pair && !has_coordinate_pair {
        return Err(ComputerError::invalid(
            "Drag coordinates require fromX, fromY, toX, and toY",
        ));
    }
    if !has_element_pair && !has_coordinate_pair {
        return Err(ComputerError::invalid(
            "Drag requires fromElementIndex and toElementIndex, or all coordinate fields",
        ));
    }
    if has_element_pair {
        require_non_negative_integer(params, "fromElementIndex")?;
        require_non_negative_integer(params, "toElementIndex")?;
    }
    if has_coordinate_pair {
        for key in coordinates {
            require_finite_number(params, key)?;
        }
    }
    Ok(())
}

fn validate_mouse_button(params: &Value) -> Result<(), ComputerError> {
    match params.get("mouseButton") {
        None | Some(Value::Null) => Ok(()),
        Some(Value::String(button)) if matches!(button.as_str(), "left" | "right" | "middle") => Ok(()),
        _ => Err(ComputerError::invalid(
            "Unsupported mouseButton; expected left, right, or middle",
        )),
    }
}

fn require_string_allowing_empty(params: &Value, key: &str) -> Result<String, ComputerError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| ComputerError::invalid(format!("Missing {key}")))
}

fn require_non_empty_string(params: &Value, key: &str) -> Result<String, ComputerError> {
    let value = require_string_allowing_empty(params, key)?;
    if value.is_empty() {
        return Err(ComputerError::invalid(format!("Missing {key}")));
    }
    Ok(value)
}

fn require_non_negative_integer(params: &Value, key: &str) -> Result<u64, ComputerError> {
    params
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| ComputerError::invalid(format!("{key} must be a non-negative integer")))
}

fn require_finite_number(params: &Value, key: &str) -> Result<Option<f64>, ComputerError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_f64()
            .filter(|n| n.is_finite())
            .map(Some)
            .ok_or_else(|| ComputerError::invalid(format!("{key} must be a finite number"))),
    }
}

fn validate_positive_integer(params: &Value, key: &str) -> Result<(), ComputerError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(()),
        Some(value) if value.as_u64().is_some_and(|n| n > 0) => Ok(()),
        _ => Err(ComputerError::invalid(format!("{key} must be a positive integer"))),
    }
}

fn validate_positive_number(params: &Value, key: &str) -> Result<(), ComputerError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(()),
        Some(value) if value.as_f64().is_some_and(|n| n.is_finite() && n > 0.0) => Ok(()),
        _ => Err(ComputerError::invalid(format!("{key} must be a positive number"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn check(method: ActionMethod, params: Value) -> Result<(), ComputerError> {
        validate_action_params(method, &params)
    }

    #[test]
    fn key_specs_match_the_legacy_rules() {
        assert_eq!(hotkey_validation_message("CmdOrCtrl+A"), None);
        assert_eq!(hotkey_validation_message("Cmd Or Ctrl+Shift+P"), None);
        assert_eq!(hotkey_validation_message("A"), Some(HOTKEY_HINT));
        assert_eq!(hotkey_validation_message("Cmd+Shift"), Some(HOTKEY_HINT));
        assert_eq!(hotkey_validation_message("Cmd++"), Some(HOTKEY_HINT));
        assert_eq!(press_key_validation_message("Return"), None);
        assert_eq!(press_key_validation_message("+"), None);
        assert_eq!(press_key_validation_message("Cmd+A"), Some(PRESS_KEY_HINT));
        assert_eq!(press_key_validation_message("  "), Some(PRESS_KEY_HINT));
        assert_eq!(click_modifiers_validation_message("CmdOrCtrl+Shift"), None);
        assert_eq!(click_modifiers_validation_message("CmdOrCtrl+A"), Some(CLICK_MODIFIERS_HINT));
        assert_eq!(click_modifiers_validation_message(""), Some(CLICK_MODIFIERS_HINT));
    }

    #[test]
    fn click_needs_an_element_or_a_coordinate_pair_but_not_both() {
        assert!(check(ActionMethod::Click, json!({"app": "a", "elementIndex": 3})).is_ok());
        assert!(check(ActionMethod::Click, json!({"app": "a", "x": 1.5, "y": 2})).is_ok());
        let missing = check(ActionMethod::Click, json!({"app": "a"})).unwrap_err();
        assert_eq!(missing.code, "invalid_argument");
        assert!(missing.message.contains("requires elementIndex"));
        assert!(check(ActionMethod::Click, json!({"app": "a", "x": 1})).is_err());
        assert!(check(ActionMethod::Click, json!({"app": "a", "elementIndex": 1, "x": 1, "y": 1})).is_err());
        assert!(check(ActionMethod::Click, json!({"app": "a", "elementIndex": -1})).is_err());
        assert!(check(ActionMethod::Click, json!({"app": "a", "elementIndex": 1, "clickCount": 0})).is_err());
        assert!(check(ActionMethod::Click, json!({"app": "a", "elementIndex": 1, "mouseButton": "back"})).is_err());
        assert!(check(ActionMethod::Click, json!({"app": "a", "elementIndex": 1, "modifiers": "Shift+Q"})).is_err());
        assert!(check(ActionMethod::Click, json!({"app": "a", "elementIndex": 1, "modifiers": "Shift", "mouseButton": "right", "clickCount": 2})).is_ok());
        assert!(check(ActionMethod::Click, json!({"elementIndex": 1})).is_err(), "app is required");
    }

    #[test]
    fn window_targets_are_exclusive_and_non_negative() {
        assert!(check(ActionMethod::TypeText, json!({"app": "a", "text": "hi", "windowId": 5})).is_ok());
        assert!(check(ActionMethod::TypeText, json!({"app": "a", "text": "hi", "windowId": 5, "windowIndex": 0})).is_err());
        assert!(check(ActionMethod::TypeText, json!({"app": "a", "text": "hi", "windowIndex": -1})).is_err());
    }

    #[test]
    fn drag_requires_a_complete_element_or_coordinate_set() {
        assert!(check(ActionMethod::Drag, json!({"app": "a", "fromElementIndex": 1, "toElementIndex": 2})).is_ok());
        assert!(check(ActionMethod::Drag, json!({"app": "a", "fromX": 1, "fromY": 1, "toX": 2, "toY": 2})).is_ok());
        assert!(check(ActionMethod::Drag, json!({"app": "a", "fromElementIndex": 1})).is_err());
        assert!(check(ActionMethod::Drag, json!({"app": "a", "fromX": 1, "toX": 2})).is_err());
        assert!(check(ActionMethod::Drag, json!({"app": "a"})).is_err());
        assert!(check(ActionMethod::Drag, json!({"app": "a", "fromElementIndex": 1, "toElementIndex": 2, "fromX": 1, "fromY": 1, "toX": 2, "toY": 2})).is_err());
    }

    #[test]
    fn scroll_keys_text_and_values_follow_their_rules() {
        assert!(check(ActionMethod::Scroll, json!({"app": "a", "elementIndex": 1, "direction": "down", "pages": 0.5})).is_ok());
        assert!(check(ActionMethod::Scroll, json!({"app": "a", "elementIndex": 1, "direction": "sideways"})).is_err());
        assert!(check(ActionMethod::Scroll, json!({"app": "a", "elementIndex": 1, "direction": "up", "pages": 0})).is_err());
        assert!(check(ActionMethod::PressKey, json!({"app": "a", "key": "Return"})).is_ok());
        assert!(check(ActionMethod::PressKey, json!({"app": "a", "key": "Cmd+A"})).is_err());
        assert!(check(ActionMethod::Hotkey, json!({"app": "a", "key": "CmdOrCtrl+A"})).is_ok());
        assert!(check(ActionMethod::Hotkey, json!({"app": "a", "key": "A"})).is_err());
        assert!(check(ActionMethod::TypeText, json!({"app": "a", "text": ""})).is_err());
        assert!(check(ActionMethod::SetValue, json!({"app": "a", "elementIndex": 4, "value": ""})).is_ok());
        assert!(check(ActionMethod::SetValue, json!({"app": "a", "value": "x"})).is_err());
        assert!(check(ActionMethod::PerformSecondaryAction, json!({"app": "a", "elementIndex": 4, "action": "AXPress"})).is_ok());
        assert!(check(ActionMethod::PerformSecondaryAction, json!({"app": "a", "elementIndex": 4})).is_err());
        let big = "x".repeat(PASTE_TEXT_MAX_BYTES + 1);
        let error = check(ActionMethod::PasteText, json!({"app": "a", "text": big})).unwrap_err();
        assert_eq!(error.message, PASTE_TEXT_TOO_LARGE);
        assert!(check(ActionMethod::PasteText, json!({"app": "a", "text": "ok"})).is_ok());
    }
}
