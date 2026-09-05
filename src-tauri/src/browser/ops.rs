//! The typed browser operations the CLI, control protocol and UI share.
//! Each takes the resolved target page, the command's parameters as they
//! arrived over the wire, and returns the JSON the caller prints, always
//! carrying `browserPageId` so an agent can pin later commands to the page.

use std::path::PathBuf;

use serde_json::{json, Map, Value};

use super::bridge::{check_text_argument, guard_exec_args, parse_shell_args, Ctx, ExecOptions, EXEC_TIMEOUT};
use super::pages::{new_page_id, BrowserPage, PageInfo};
use super::{BrowserError, BrowserResult, BrowserRuntime, Target};

const TYPE_CHUNK_BYTES: usize = 4 * 1024;

fn opt(params: &Value, name: &str) -> Option<String> {
    match params.get(name)? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn opt_nonempty(params: &Value, name: &str) -> Option<String> {
    opt(params, name).filter(|s| !s.trim().is_empty())
}

fn req(params: &Value, name: &str) -> BrowserResult<String> {
    opt_nonempty(params, name).ok_or_else(|| BrowserError::new("invalid_arguments", format!("Missing --{name}.")))
}

fn flag(params: &Value, name: &str) -> bool {
    match params.get(name) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => matches!(s.as_str(), "true" | "on" | "1" | "yes"),
        _ => false,
    }
}

fn element(params: &Value) -> BrowserResult<String> {
    let value = req(params, "element")?;
    check_text_argument("--element", &value)?;
    Ok(value)
}

fn with_page_id(target: &Target, value: Value) -> Value {
    let mut map = match value {
        Value::Object(map) => map,
        Value::Null => Map::new(),
        other => {
            let mut map = Map::new();
            map.insert("result".into(), other);
            map
        }
    };
    map.insert("browserPageId".into(), Value::String(target.page.id.clone()));
    Value::Object(map)
}

fn page_info(rt: &BrowserRuntime, target: &Target) -> Value {
    match rt.pages.info(&target.page.id) {
        Some(info) => serde_json::to_value(info).unwrap_or(Value::Null),
        None => json!({"browserPageId": target.page.id}),
    }
}

/// Run `f` with the target's tab current. A tab that has gone missing drops
/// the page from the store so the next `tab list` is honest.
fn on_page<R>(rt: &BrowserRuntime, target: &Target, f: impl FnOnce(&mut Ctx<'_>) -> BrowserResult<R>) -> BrowserResult<R> {
    let result = rt.bridge.with_session(&target.session, |ctx| {
        ctx.ensure_tab(&target.page.tab_id)?;
        f(ctx)
    });
    if let Err(e) = &result {
        if e.code == "browser_tab_not_found" {
            let _ = rt.pages.remove(&target.page.id);
            rt.announce_pages();
        }
    }
    result
}

fn output_path(rt: &BrowserRuntime, kind: &str, page: &BrowserPage, ext: &str) -> BrowserResult<PathBuf> {
    let dir = crate::store::ensure_dir(rt.root.join(kind)).map_err(|e| BrowserError::new("browser_error", format!("{e:#}")))?;
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S%.3f");
    Ok(dir.join(format!("{}-{stamp}.{ext}", page.id)))
}

fn remember_location(rt: &BrowserRuntime, target: &Target, value: &Value) {
    let url = value.get("url").and_then(Value::as_str);
    let title = value.get("title").and_then(Value::as_str);
    if (url.is_some() || title.is_some()) && rt.pages.update_location(&target.page.id, url, title).unwrap_or(false) {
        rt.announce_pages();
    }
}

fn refresh_title(rt: &BrowserRuntime, target: &Target, ctx: &mut Ctx<'_>, mut value: Value) -> Value {
    if let Ok(title) = ctx.run(&["get", "title"], ExecOptions::default()) {
        if let Some(t) = title.get("title").cloned() {
            if let Value::Object(map) = &mut value {
                map.insert("title".into(), t);
            }
        }
    }
    remember_location(rt, target, &value);
    value
}

// ----------------------------------------------------------------- navigation

pub fn goto(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let url = normalize_url(&req(params, "url")?);
    let value = on_page(rt, target, |ctx| ctx.run(&["open", &url], ExecOptions::default()))?;
    remember_location(rt, target, &value);
    Ok(with_page_id(target, value))
}

pub fn history(rt: &BrowserRuntime, target: &Target, verb: &str) -> BrowserResult<Value> {
    let value = on_page(rt, target, |ctx| {
        let value = ctx.run(&[verb], ExecOptions::default())?;
        Ok(refresh_title(rt, target, ctx, value))
    })?;
    Ok(with_page_id(target, value))
}

pub fn snapshot(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let mut args: Vec<String> = vec!["snapshot".into()];
    if flag(params, "interactive") {
        args.push("-i".into());
    }
    if flag(params, "compact") {
        args.push("-c".into());
    }
    if let Some(depth) = opt_nonempty(params, "depth") {
        args.extend(["-d".into(), depth]);
    }
    if let Some(selector) = opt_nonempty(params, "selector") {
        args.extend(["-s".into(), selector]);
    }
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let (value, title) = on_page(rt, target, |ctx| {
        let value = ctx.run(&argv, ExecOptions::default())?;
        // The snapshot names its origin but not the document title, and the
        // store's copy can lag a navigation; one cheap read keeps it honest.
        let title = ctx.run(&["get", "title"], ExecOptions::default()).ok().and_then(|t| t.get("title").and_then(Value::as_str).map(String::from));
        Ok((value, title))
    })?;
    let url = value.get("origin").and_then(Value::as_str).map(String::from);
    let refs: Vec<Value> = value
        .get("refs")
        .and_then(Value::as_object)
        .map(|refs| {
            let mut entries: Vec<(&String, &Value)> = refs.iter().collect();
            entries.sort_by_key(|(name, _)| name.trim_start_matches('e').parse::<u64>().unwrap_or(u64::MAX));
            entries
                .into_iter()
                .map(|(name, info)| json!({"ref": format!("@{name}"), "role": info.get("role").cloned().unwrap_or(Value::Null), "name": info.get("name").cloned().unwrap_or(Value::Null)}))
                .collect()
        })
        .unwrap_or_default();
    if (url.is_some() || title.is_some()) && rt.pages.update_location(&target.page.id, url.as_deref(), title.as_deref()).unwrap_or(false) {
        rt.announce_pages();
    }
    let page = rt.pages.get(&target.page.id).unwrap_or_else(|| target.page.clone());
    Ok(json!({
        "browserPageId": target.page.id,
        "url": url.unwrap_or(page.url),
        "title": title.unwrap_or(page.title),
        "snapshot": value.get("snapshot").cloned().unwrap_or(Value::String(String::new())),
        "refs": refs,
    }))
}

pub fn screenshot(rt: &BrowserRuntime, target: &Target, params: &Value, full: bool) -> BrowserResult<Value> {
    let format = opt_nonempty(params, "format").unwrap_or_else(|| "png".into());
    if !matches!(format.as_str(), "png" | "jpeg") {
        return Err(BrowserError::new("invalid_arguments", "--format must be png or jpeg."));
    }
    let path = match opt_nonempty(params, "path") {
        Some(p) => PathBuf::from(p),
        None => output_path(rt, "screenshots", &target.page, &format)?,
    };
    let path_text = path.to_string_lossy().into_owned();
    let mut args: Vec<&str> = vec!["screenshot"];
    if full || flag(params, "full") {
        args.push("--full");
    }
    if flag(params, "annotate") {
        args.push("--annotate");
    }
    args.extend(["--screenshot-format", &format, &path_text]);
    let value = on_page(rt, target, |ctx| ctx.run(&args, ExecOptions::default()))?;
    let saved = value.get("path").and_then(Value::as_str).map(String::from).unwrap_or(path_text);
    let bytes = std::fs::metadata(&saved).map(|m| m.len()).unwrap_or(0);
    let mut out = with_page_id(target, value);
    if let Value::Object(map) = &mut out {
        map.insert("path".into(), Value::String(saved));
        map.insert("format".into(), Value::String(format));
        map.insert("bytes".into(), Value::from(bytes));
        map.insert("full".into(), Value::Bool(full || flag(params, "full")));
    }
    Ok(out)
}

pub fn pdf(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let path = match opt_nonempty(params, "path") {
        Some(p) => PathBuf::from(p),
        None => output_path(rt, "pdf", &target.page, "pdf")?,
    };
    let path_text = path.to_string_lossy().into_owned();
    let value = on_page(rt, target, |ctx| ctx.run(&["pdf", &path_text], ExecOptions::default()))?;
    let mut out = with_page_id(target, value);
    if let Value::Object(map) = &mut out {
        map.entry("path").or_insert(Value::String(path_text.clone()));
        map.insert("bytes".into(), Value::from(std::fs::metadata(&path_text).map(|m| m.len()).unwrap_or(0)));
    }
    Ok(out)
}

/// Expressions always travel over stdin: no argv limit, no shell quoting,
/// and page text an agent was tricked into evaluating still only runs where
/// the agent explicitly asked for `eval`.
pub fn eval(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let expression = req(params, "expression")?;
    let value = on_page(rt, target, |ctx| ctx.run(&["eval", "--stdin"], ExecOptions { timeout: EXEC_TIMEOUT, stdin: Some(expression) }))?;
    Ok(with_page_id(target, value))
}

pub fn scroll(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let direction = opt_nonempty(params, "direction").unwrap_or_else(|| "down".into());
    if !matches!(direction.as_str(), "up" | "down" | "left" | "right") {
        return Err(BrowserError::new("invalid_arguments", "--direction must be up, down, left or right."));
    }
    let amount = opt_nonempty(params, "amount").unwrap_or_else(|| "300".into());
    amount.parse::<u64>().map_err(|_| BrowserError::new("invalid_arguments", "--amount must be a whole number of pixels."))?;
    let mut args: Vec<&str> = vec!["scroll", &direction, &amount];
    let selector = opt_nonempty(params, "selector");
    if let Some(sel) = &selector {
        args.extend(["--selector", sel]);
    }
    let value = on_page(rt, target, |ctx| ctx.run(&args, ExecOptions::default()))?;
    Ok(with_page_id(target, value))
}

pub fn wait(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let mut args: Vec<String> = vec!["wait".into()];
    let mut modes = 0;
    if let Some(selector) = opt_nonempty(params, "selector") {
        args.push(selector);
        modes += 1;
    }
    if let Some(ms) = opt_nonempty(params, "ms") {
        args.push(ms);
        modes += 1;
    }
    for (flag_name, cli) in [("text", "--text"), ("url", "--url"), ("load", "--load"), ("fn", "--fn"), ("download", "--download")] {
        if let Some(v) = opt_nonempty(params, flag_name) {
            args.extend([cli.into(), v]);
            modes += 1;
        }
    }
    if modes == 0 {
        return Err(BrowserError::new("invalid_arguments", "wait needs one of --selector, --text, --url, --load, --fn, --download or --ms."));
    }
    if let Some(state) = opt_nonempty(params, "state") {
        args.extend(["--state".into(), state]);
    }
    let timeout_ms = opt_nonempty(params, "timeout").map(|t| t.parse::<u64>()).transpose().map_err(|_| BrowserError::new("invalid_arguments", "--timeout must be milliseconds."))?;
    if let Some(t) = timeout_ms {
        args.extend(["--timeout".into(), t.to_string()]);
    }
    let exec_timeout = timeout_ms.map(|t| std::time::Duration::from_millis(t) + std::time::Duration::from_secs(5)).unwrap_or(EXEC_TIMEOUT).max(EXEC_TIMEOUT);
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let value = on_page(rt, target, |ctx| ctx.run(&argv, ExecOptions { timeout: exec_timeout, stdin: None }))?;
    Ok(with_page_id(target, value))
}

// ------------------------------------------------------------------ interact

/// `click`, `dblclick`, `hover`, `focus`, `check`, `uncheck`,
/// `scrollintoview`, `highlight`: one verb, one element.
pub fn element_verb(rt: &BrowserRuntime, target: &Target, verb: &str, params: &Value) -> BrowserResult<Value> {
    let el = element(params)?;
    let value = on_page(rt, target, |ctx| ctx.run(&[verb, &el], ExecOptions::default()))?;
    Ok(with_page_id(target, value))
}

pub fn fill(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let el = element(params)?;
    let value = opt(params, "value").unwrap_or_default();
    let result = on_page(rt, target, |ctx| {
        if value.len() <= super::bridge::TEXT_ARGUMENT_MAX_BYTES {
            return ctx.run(&["fill", &el, &value], ExecOptions::default());
        }
        // Too large for argv: focus the control and set its value the way a
        // framework expects (native setter + input/change events), streamed
        // over stdin.
        ctx.run(&["focus", &el], ExecOptions::default())?;
        let script = focused_value_set_expression(&value);
        ctx.run(&["eval", "--stdin"], ExecOptions { timeout: EXEC_TIMEOUT, stdin: Some(script) })?;
        Ok(json!({"filled": el, "bytes": value.len()}))
    })?;
    Ok(with_page_id(target, result))
}

/// `type --input <text>` types at the current focus; `--element` types into
/// a control. Text is chunked so no single argv entry is oversized.
pub fn type_text(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let text = opt(params, "input").or_else(|| opt(params, "text")).ok_or_else(|| BrowserError::new("invalid_arguments", "Missing --input."))?;
    let el = opt_nonempty(params, "element");
    let count = on_page(rt, target, |ctx| {
        let mut chunks = 0;
        for chunk in chunk_text(&text, TYPE_CHUNK_BYTES) {
            match &el {
                Some(el) if chunks == 0 => ctx.run(&["type", el, chunk], ExecOptions::default())?,
                _ => ctx.run(&["keyboard", "type", chunk], ExecOptions::default())?,
            };
            chunks += 1;
        }
        Ok(chunks)
    })?;
    Ok(with_page_id(target, json!({"typed": text.chars().count(), "chunks": count})))
}

pub fn insert_text(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let text = req(params, "text")?;
    let count = on_page(rt, target, |ctx| {
        let mut chunks = 0;
        for chunk in chunk_text(&text, TYPE_CHUNK_BYTES) {
            ctx.run(&["keyboard", "inserttext", chunk], ExecOptions::default())?;
            chunks += 1;
        }
        Ok(chunks)
    })?;
    Ok(with_page_id(target, json!({"inserted": text.chars().count(), "chunks": count})))
}

pub fn select(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let el = element(params)?;
    let values: Vec<String> = match params.get("value") {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).map(String::from).collect(),
        _ => vec![req(params, "value")?],
    };
    let mut args: Vec<&str> = vec!["select", &el];
    args.extend(values.iter().map(String::as_str));
    let value = on_page(rt, target, |ctx| ctx.run(&args, ExecOptions::default()))?;
    Ok(with_page_id(target, value))
}

pub fn clear(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let el = element(params)?;
    let value = on_page(rt, target, |ctx| ctx.run(&["fill", &el, ""], ExecOptions::default()))?;
    Ok(with_page_id(target, json!({"cleared": el, "result": value})))
}

pub fn select_all(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let el = element(params)?;
    let value = on_page(rt, target, |ctx| {
        ctx.run(&["focus", &el], ExecOptions::default())?;
        ctx.run(&["press", "ControlOrMeta+a"], ExecOptions::default())
    })?;
    Ok(with_page_id(target, json!({"selectedAll": el, "result": value})))
}

pub fn keypress(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let key = req(params, "key")?;
    let value = on_page(rt, target, |ctx| ctx.run(&["press", &key], ExecOptions::default()))?;
    Ok(with_page_id(target, value))
}

pub fn drag(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let from = req(params, "from")?;
    let to = req(params, "to")?;
    let value = on_page(rt, target, |ctx| ctx.run(&["drag", &from, &to], ExecOptions::default()))?;
    Ok(with_page_id(target, value))
}

pub fn upload(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let el = element(params)?;
    let files: Vec<String> = match params.get("files") {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).map(String::from).collect(),
        _ => req(params, "files")?.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
    };
    if files.is_empty() {
        return Err(BrowserError::new("invalid_arguments", "--files needs at least one path."));
    }
    for file in &files {
        if !std::path::Path::new(file).is_file() {
            return Err(BrowserError::new("invalid_arguments", format!("{file} is not a readable file.")));
        }
    }
    let mut args: Vec<&str> = vec!["upload", &el];
    args.extend(files.iter().map(String::as_str));
    let value = on_page(rt, target, |ctx| ctx.run(&args, ExecOptions::default()))?;
    Ok(with_page_id(target, value))
}

pub fn download(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let selector = opt_nonempty(params, "selector").or_else(|| opt_nonempty(params, "element")).ok_or_else(|| BrowserError::new("invalid_arguments", "Missing --selector."))?;
    let path = match opt_nonempty(params, "path") {
        Some(p) => PathBuf::from(p),
        None => target.session.download_dir.join(format!("{}-{}", target.page.id, chrono::Utc::now().format("%Y%m%d-%H%M%S"))),
    };
    let path_text = path.to_string_lossy().into_owned();
    let value = on_page(rt, target, |ctx| ctx.run(&["download", &selector, &path_text], ExecOptions::default()))?;
    Ok(with_page_id(target, value))
}

pub fn get(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let what = req(params, "what")?;
    let mut args: Vec<String> = vec!["get".into(), what.clone()];
    match what.as_str() {
        "title" | "url" | "cdp-url" => {}
        "attr" => {
            args.push(element(params)?);
            args.push(req(params, "name")?);
        }
        "text" | "html" | "value" | "count" | "box" | "styles" => args.push(element(params)?),
        other => return Err(BrowserError::new("invalid_arguments", format!("Unknown --what {other}."))),
    }
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let value = on_page(rt, target, |ctx| ctx.run(&argv, ExecOptions::default()))?;
    remember_location(rt, target, &value);
    Ok(with_page_id(target, value))
}

pub fn is(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let what = req(params, "what")?;
    if !matches!(what.as_str(), "visible" | "enabled" | "checked") {
        return Err(BrowserError::new("invalid_arguments", "--what must be visible, enabled or checked."));
    }
    let el = element(params)?;
    let value = on_page(rt, target, |ctx| ctx.run(&["is", &what, &el], ExecOptions::default()))?;
    Ok(with_page_id(target, value))
}

pub fn mouse(rt: &BrowserRuntime, target: &Target, action: &str, params: &Value) -> BrowserResult<Value> {
    let mut args: Vec<String> = vec!["mouse".into(), action.into()];
    match action {
        "move" => {
            args.push(req(params, "x")?);
            args.push(req(params, "y")?);
        }
        "down" | "up" => {
            if let Some(button) = opt_nonempty(params, "button") {
                args.push(button);
            }
        }
        "wheel" => {
            args.push(req(params, "dy")?);
            if let Some(dx) = opt_nonempty(params, "dx") {
                args.push(dx);
            }
        }
        other => return Err(BrowserError::new("invalid_arguments", format!("Unknown mouse action {other}."))),
    }
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let value = on_page(rt, target, |ctx| ctx.run(&argv, ExecOptions::default()))?;
    Ok(with_page_id(target, value))
}

pub fn find(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let locator = req(params, "locator")?;
    let value = req(params, "value")?;
    let action = req(params, "action")?;
    let mut args: Vec<&str> = vec!["find", &locator, &value, &action];
    let text = opt_nonempty(params, "text");
    if let Some(t) = &text {
        args.push(t);
    }
    let result = on_page(rt, target, |ctx| ctx.run(&args, ExecOptions::default()))?;
    Ok(with_page_id(target, result))
}

// ----------------------------------------------------------------------- tabs

pub fn tab_list(rt: &BrowserRuntime, workspace: Option<&str>) -> BrowserResult<Value> {
    for session in rt.bridge.launched_sessions() {
        rt.reconcile_session(&session, None)?;
    }
    let tabs: Vec<PageInfo> = rt.pages.infos(workspace);
    Ok(json!({"workspace": workspace, "tabs": tabs}))
}

pub fn tab_show(rt: &BrowserRuntime, target: &Target) -> BrowserResult<Value> {
    let _ = rt.reconcile_session(&target.session, target.page.workspace_path.as_deref());
    let info = rt.pages.info(&target.page.id).ok_or_else(|| BrowserError::new("browser_tab_not_found", format!("Browser page {} is no longer open.", target.page.id)))?;
    Ok(json!({"tab": info}))
}

pub fn tab_switch(rt: &BrowserRuntime, target: &Target, focus: bool) -> BrowserResult<Value> {
    on_page(rt, target, |ctx| {
        ctx.forget_active_tab();
        ctx.ensure_tab(&target.page.tab_id)
    })?;
    rt.pages.set_active(&target.page.id)?;
    rt.announce_pages();
    if focus {
        focus_window(rt, target);
    }
    let info = page_info(rt, target);
    Ok(json!({"switched": info.get("index").cloned().unwrap_or(Value::Null), "browserPageId": target.page.id, "tab": info}))
}

/// Open a page in the workspace's browser. The first page of a profile
/// reuses the tab Chromium opens at launch; later ones are new tabs.
pub fn tab_create(rt: &BrowserRuntime, workspace: &str, url: Option<&str>, profile_id: &str) -> BrowserResult<Value> {
    let url = url.map(normalize_url).unwrap_or_else(|| "about:blank".into());
    let session = rt.session_for(profile_id)?;
    let listing = rt.reconcile_session(&session, Some(workspace))?;
    let known = rt.pages.in_profile(profile_id);
    let launch_tab = listing
        .iter()
        .find(|t| listing.len() == 1 && is_blank(&t.url) && !known.iter().any(|p| p.tab_id == t.tab_id && p.workspace_path.as_deref() != Some(workspace)))
        .cloned();
    let (tab_id, opened) = rt.bridge.with_session(&session, |ctx| {
        match &launch_tab {
            Some(tab) => {
                ctx.ensure_tab(&tab.tab_id)?;
                let opened = ctx.run(&["open", &url], ExecOptions::default())?;
                Ok::<_, BrowserError>((tab.tab_id.clone(), opened))
            }
            None => {
                let created = ctx.run(&["tab", "new", &url], ExecOptions::default())?;
                ctx.forget_active_tab();
                let tab_id = created.get("tabId").and_then(Value::as_str).map(String::from).ok_or_else(|| BrowserError::new("browser_error", "agent-browser did not report a tab id for the new tab."))?;
                ctx.lane.active_tab = Some(tab_id.clone());
                Ok((tab_id, created))
            }
        }
    })?;
    // The launch tab may already be in the store (adopted by reconcile).
    let existing = rt.pages.in_profile(profile_id).into_iter().find(|p| p.tab_id == tab_id);
    let page = match existing {
        Some(mut page) => {
            let _ = rt.pages.remove(&page.id);
            page.workspace_path = Some(workspace.to_string());
            page.url = opened.get("url").and_then(Value::as_str).unwrap_or(&url).to_string();
            page.title = opened.get("title").and_then(Value::as_str).unwrap_or("").to_string();
            page
        }
        None => BrowserPage {
            id: new_page_id(),
            profile_id: profile_id.to_string(),
            tab_id: tab_id.clone(),
            url: opened.get("url").and_then(Value::as_str).unwrap_or(&url).to_string(),
            title: opened.get("title").and_then(Value::as_str).unwrap_or("").to_string(),
            workspace_path: Some(workspace.to_string()),
            created: crate::store::index::now(),
        },
    };
    rt.pages.insert(page.clone())?;
    let _ = rt.reconcile_session(&session, Some(workspace));
    // `open` waited for the load, so its title beats the listing's
    // mid-load placeholder.
    if !page.title.is_empty() {
        let _ = rt.pages.update_location(&page.id, Some(&page.url), Some(&page.title));
    }
    rt.announce_pages();
    let info = rt.pages.info(&page.id).map(|i| serde_json::to_value(i).unwrap_or(Value::Null)).unwrap_or(Value::Null);
    Ok(json!({"browserPageId": page.id, "tab": info, "url": page.url, "title": page.title, "profileId": profile_id}))
}

/// Close the tab behind a page. The last page of a profile takes its
/// browser with it, so no empty window is left behind.
pub fn tab_close(rt: &BrowserRuntime, target: &Target) -> BrowserResult<Value> {
    rt.screencasts.stop(&target.page.id);
    let remaining = rt.pages.in_profile(&target.page.profile_id).into_iter().filter(|p| p.id != target.page.id).count();
    let closed_browser = rt.bridge.with_session(&target.session, |ctx| {
        if remaining == 0 {
            ctx.close()?;
            return Ok::<_, BrowserError>(true);
        }
        let outcome = ctx.run(&["tab", "close", &target.page.tab_id], ExecOptions::default());
        ctx.forget_active_tab();
        match outcome {
            Ok(_) => Ok(false),
            Err(e) if e.code == "browser_tab_not_found" || e.message.to_ascii_lowercase().contains("not found") => Ok(false),
            Err(e) => Err(e),
        }
    })?;
    rt.pages.remove(&target.page.id)?;
    rt.announce_pages();
    Ok(json!({"closed": target.page.id, "browserPageId": target.page.id, "closedBrowser": closed_browser}))
}

/// Bring the browser window for a page to the front. macOS only for now;
/// elsewhere the tab is still made current inside its window.
pub fn focus_window(rt: &BrowserRuntime, target: &Target) {
    let _ = on_page(rt, target, |ctx| {
        ctx.forget_active_tab();
        ctx.ensure_tab(&target.page.tab_id)
    });
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let Some(daemon) = super::bridge::daemon_pid(&rt.bridge.env, &target.session.name) else { return };
        let Ok(children) = Command::new("pgrep").args(["-P", &daemon.to_string()]).output() else { return };
        for pid in String::from_utf8_lossy(&children.stdout).split_whitespace() {
            let script = format!("tell application \"System Events\" to set frontmost of (first process whose unix id is {pid}) to true");
            let _ = Command::new("osascript").args(["-e", &script]).output();
        }
    }
}

// --------------------------------------------------------------------- exec

pub fn exec(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let command = req(params, "command")?;
    let args = parse_shell_args(&command);
    guard_exec_args(&args)?;
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let touches_tabs = argv.first() == Some(&"tab");
    let value = on_page(rt, target, |ctx| {
        let value = ctx.run(&argv, ExecOptions::default())?;
        if touches_tabs {
            ctx.forget_active_tab();
        }
        Ok(value)
    })?;
    if touches_tabs {
        let _ = rt.reconcile_session(&target.session, target.page.workspace_path.as_deref());
    }
    Ok(with_page_id(target, value))
}

// ------------------------------------------------------------------- cookies

pub fn cookie_get(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let value = on_page(rt, target, |ctx| ctx.run(&["cookies", "get"], ExecOptions::default()))?;
    let filter = opt_nonempty(params, "url").and_then(|u| url::Url::parse(&u).ok()).and_then(|u| u.host_str().map(|h| h.to_string()));
    let cookies: Vec<Value> = value
        .get("cookies")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|c| match &filter {
            Some(host) => c.get("domain").and_then(Value::as_str).map(|d| host.ends_with(d.trim_start_matches('.'))).unwrap_or(true),
            None => true,
        })
        .collect();
    Ok(json!({"browserPageId": target.page.id, "cookies": cookies}))
}

pub fn cookie_set(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let name = req(params, "name")?;
    let value = opt(params, "value").ok_or_else(|| BrowserError::new("invalid_arguments", "Missing --value (or pipe it on stdin with --value-stdin)."))?;
    check_text_argument("--value", &value)?;
    let mut args: Vec<String> = vec!["cookies".into(), "set".into(), name, value];
    for (key, cli) in [("url", "--url"), ("domain", "--domain"), ("path", "--path"), ("sameSite", "--sameSite"), ("expires", "--expires")] {
        if let Some(v) = opt_nonempty(params, key) {
            args.extend([cli.into(), v]);
        }
    }
    if flag(params, "secure") {
        args.push("--secure".into());
    }
    if flag(params, "httpOnly") {
        args.push("--httpOnly".into());
    }
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let result = on_page(rt, target, |ctx| ctx.run(&argv, ExecOptions::default()))?;
    Ok(with_page_id(target, result))
}

/// agent-browser only clears all cookies; one cookie goes through CDP.
pub fn cookie_delete(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let name = req(params, "name")?;
    if flag(params, "all") {
        let value = on_page(rt, target, |ctx| ctx.run(&["cookies", "clear"], ExecOptions::default()))?;
        return Ok(with_page_id(target, value));
    }
    let mut cdp_params = json!({"name": name});
    if let Some(domain) = opt_nonempty(params, "domain") {
        cdp_params["domain"] = Value::String(domain);
    }
    if let Some(u) = opt_nonempty(params, "url") {
        cdp_params["url"] = Value::String(u);
    } else if cdp_params.get("domain").is_none() {
        cdp_params["url"] = Value::String(rt.pages.get(&target.page.id).map(|p| p.url).unwrap_or_else(|| target.page.url.clone()));
    }
    let result = super::cdp::call_on_page(rt, target, "Network.deleteCookies", cdp_params)?;
    Ok(json!({"browserPageId": target.page.id, "deleted": name, "result": result}))
}

// ------------------------------------------------------- capture and network

pub fn console(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let mut args: Vec<&str> = vec!["console"];
    if flag(params, "clear") {
        args.push("--clear");
    }
    let value = on_page(rt, target, |ctx| ctx.run(&args, ExecOptions::default()))?;
    let messages = tail(value.get("messages").and_then(Value::as_array).cloned().unwrap_or_default(), opt_nonempty(params, "limit"));
    Ok(json!({"browserPageId": target.page.id, "messages": messages}))
}

pub fn network(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let mut args: Vec<String> = vec!["network".into(), "requests".into()];
    for (key, cli) in [("filter", "--filter"), ("type", "--type"), ("method", "--method"), ("status", "--status")] {
        if let Some(v) = opt_nonempty(params, key) {
            args.extend([cli.into(), v]);
        }
    }
    if flag(params, "clear") {
        args.push("--clear".into());
    }
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let value = on_page(rt, target, |ctx| ctx.run(&argv, ExecOptions::default()))?;
    let requests = tail(value.get("requests").and_then(Value::as_array).cloned().unwrap_or_default(), opt_nonempty(params, "limit"));
    Ok(json!({"browserPageId": target.page.id, "requests": requests}))
}

pub fn capture_start(rt: &BrowserRuntime, target: &Target) -> BrowserResult<Value> {
    let value = on_page(rt, target, |ctx| {
        let v = ctx.run(&["network", "har", "start"], ExecOptions::default())?;
        ctx.lane.capture_active = true;
        Ok(v)
    })?;
    Ok(with_page_id(target, value))
}

pub fn capture_stop(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let path = match opt_nonempty(params, "path") {
        Some(p) => PathBuf::from(p),
        None => output_path(rt, "captures", &target.page, "har")?,
    };
    let path_text = path.to_string_lossy().into_owned();
    let value = on_page(rt, target, |ctx| {
        let v = ctx.run(&["network", "har", "stop", &path_text], ExecOptions::default())?;
        ctx.lane.capture_active = false;
        Ok(v)
    })?;
    let mut out = with_page_id(target, value);
    if let Value::Object(map) = &mut out {
        map.entry("path").or_insert(Value::String(path_text));
    }
    Ok(out)
}

pub fn intercept_enable(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let patterns: Vec<String> = match params.get("patterns") {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).map(String::from).collect(),
        _ => opt_nonempty(params, "patterns").unwrap_or_else(|| "**/*".into()).split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
    };
    let body = opt_nonempty(params, "body");
    let abort = flag(params, "abort") || body.is_none();
    let applied = on_page(rt, target, |ctx| {
        for pattern in &patterns {
            let mut args: Vec<&str> = vec!["network", "route", pattern];
            if abort {
                args.push("--abort");
            } else if let Some(b) = &body {
                args.extend(["--body", b]);
            }
            ctx.run(&args, ExecOptions::default())?;
            if !ctx.lane.intercept_patterns.contains(pattern) {
                ctx.lane.intercept_patterns.push(pattern.clone());
            }
        }
        Ok(ctx.lane.intercept_patterns.clone())
    })?;
    Ok(json!({"browserPageId": target.page.id, "enabled": true, "patterns": applied, "mode": if abort { "abort" } else { "body" }}))
}

pub fn intercept_disable(rt: &BrowserRuntime, target: &Target) -> BrowserResult<Value> {
    on_page(rt, target, |ctx| {
        ctx.run(&["network", "unroute"], ExecOptions::default())?;
        ctx.lane.intercept_patterns.clear();
        Ok(())
    })?;
    Ok(json!({"browserPageId": target.page.id, "enabled": false}))
}

pub fn intercept_list(rt: &BrowserRuntime, target: &Target) -> BrowserResult<Value> {
    let patterns = rt.bridge.with_session(&target.session, |ctx| ctx.lane.intercept_patterns.clone());
    Ok(json!({"browserPageId": target.page.id, "patterns": patterns}))
}

// ------------------------------------------------------------- environment

pub fn viewport(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let width = req(params, "width")?;
    let height = req(params, "height")?;
    for (name, v) in [("--width", &width), ("--height", &height)] {
        v.parse::<u32>().map_err(|_| BrowserError::new("invalid_arguments", format!("{name} must be a whole number of pixels.")))?;
    }
    let mut args: Vec<&str> = vec!["set", "viewport", &width, &height];
    let scale = opt_nonempty(params, "scale");
    if let Some(s) = &scale {
        args.push(s);
    }
    let value = on_page(rt, target, |ctx| ctx.run(&args, ExecOptions::default()))?;
    Ok(with_page_id(target, value))
}

pub fn geolocation(rt: &BrowserRuntime, target: &Target, params: &Value) -> BrowserResult<Value> {
    let lat = req(params, "latitude")?;
    let lng = req(params, "longitude")?;
    for (name, v) in [("--latitude", &lat), ("--longitude", &lng)] {
        v.parse::<f64>().map_err(|_| BrowserError::new("invalid_arguments", format!("{name} must be a number.")))?;
    }
    let value = on_page(rt, target, |ctx| ctx.run(&["set", "geo", &lat, &lng], ExecOptions::default()))?;
    Ok(with_page_id(target, value))
}

pub fn set(rt: &BrowserRuntime, target: &Target, what: &str, params: &Value) -> BrowserResult<Value> {
    let mut args: Vec<String> = vec!["set".into(), what.into()];
    match what {
        "device" => args.push(req(params, "name")?),
        "offline" => {
            let state = opt_nonempty(params, "state").unwrap_or_else(|| "on".into());
            if !matches!(state.as_str(), "on" | "off") {
                return Err(BrowserError::new("invalid_arguments", "--state must be on or off."));
            }
            args.push(state);
        }
        "headers" => {
            let headers = req(params, "headers")?;
            serde_json::from_str::<Map<String, Value>>(&headers).map_err(|e| BrowserError::new("invalid_arguments", format!("--headers must be a JSON object: {e}")))?;
            args.push(headers);
        }
        "credentials" => {
            args.push(req(params, "user")?);
            args.push(opt(params, "pass").ok_or_else(|| BrowserError::new("invalid_arguments", "Missing --pass (or pipe it on stdin with --pass-stdin)."))?);
        }
        "media" => {
            if let Some(scheme) = opt_nonempty(params, "colorScheme") {
                if !matches!(scheme.as_str(), "dark" | "light") {
                    return Err(BrowserError::new("invalid_arguments", "--color-scheme must be dark or light."));
                }
                args.push(scheme);
            }
            if let Some(motion) = opt_nonempty(params, "reducedMotion") {
                if motion == "reduce" {
                    args.push("reduced-motion".into());
                } else if motion != "no-preference" {
                    return Err(BrowserError::new("invalid_arguments", "--reduced-motion must be reduce or no-preference."));
                }
            }
        }
        other => return Err(BrowserError::new("invalid_arguments", format!("Unknown setting {other}."))),
    }
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let value = on_page(rt, target, |ctx| ctx.run(&argv, ExecOptions::default()))?;
    Ok(with_page_id(target, value))
}

pub fn clipboard(rt: &BrowserRuntime, target: &Target, op: &str, params: &Value) -> BrowserResult<Value> {
    let mut args: Vec<String> = vec!["clipboard".into(), op.into()];
    if op == "write" {
        let text = req(params, "text")?;
        check_text_argument("--text", &text)?;
        args.push(text);
    }
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let value = on_page(rt, target, |ctx| ctx.run(&argv, ExecOptions::default()))?;
    Ok(with_page_id(target, value))
}

pub fn dialog(rt: &BrowserRuntime, target: &Target, op: &str, params: &Value) -> BrowserResult<Value> {
    let mut args: Vec<String> = vec!["dialog".into(), op.into()];
    if op == "accept" {
        if let Some(text) = opt_nonempty(params, "text") {
            args.push(text);
        }
    }
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let value = on_page(rt, target, |ctx| ctx.run(&argv, ExecOptions::default()))?;
    Ok(with_page_id(target, value))
}

pub fn storage(rt: &BrowserRuntime, target: &Target, kind: &str, op: &str, params: &Value) -> BrowserResult<Value> {
    let mut args: Vec<String> = vec!["storage".into(), kind.into(), op.into()];
    match op {
        "get" => {
            if let Some(key) = opt_nonempty(params, "key") {
                args.push(key);
            }
        }
        "set" => {
            args.push(req(params, "key")?);
            let value = opt(params, "value").ok_or_else(|| BrowserError::new("invalid_arguments", "Missing --value."))?;
            check_text_argument("--value", &value)?;
            args.push(value);
        }
        "clear" => {}
        other => return Err(BrowserError::new("invalid_arguments", format!("Unknown storage operation {other}."))),
    }
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let value = on_page(rt, target, |ctx| ctx.run(&argv, ExecOptions::default()))?;
    Ok(with_page_id(target, value))
}

// ----------------------------------------------------------------- profiles

pub fn profile_list(rt: &BrowserRuntime) -> BrowserResult<Value> {
    let profiles: Vec<Value> = rt
        .profiles
        .list()
        .into_iter()
        .map(|p| {
            let pages = rt.pages.in_profile(&p.id).len();
            json!({"id": p.id, "label": p.label, "created": p.created, "default": p.id == super::profiles::DEFAULT_PROFILE_ID, "openPages": pages, "dataDir": rt.profiles.data_dir(&p.id)})
        })
        .collect();
    Ok(json!({"profiles": profiles}))
}

pub fn profile_create(rt: &BrowserRuntime, params: &Value) -> BrowserResult<Value> {
    let label = req(params, "label")?;
    let profile = rt.profiles.create(&label, opt_nonempty(params, "id").as_deref())?;
    Ok(json!({"profile": profile, "dataDir": rt.profiles.data_dir(&profile.id)}))
}

/// Delete a profile: its pages close, its browser closes, its data goes.
pub fn profile_delete(rt: &BrowserRuntime, params: &Value) -> BrowserResult<Value> {
    let id = req(params, "profile")?;
    rt.profiles.get(&id)?;
    for page in rt.pages.in_profile(&id) {
        rt.screencasts.stop(&page.id);
    }
    if let Some(session) = rt.bridge.existing_session(&id) {
        let _ = rt.bridge.close_session(&session);
    }
    let removed = rt.pages.remove_profile(&id)?;
    rt.announce_pages();
    let profile = rt.profiles.delete(&id)?;
    Ok(json!({"deleted": profile, "closedPages": removed.into_iter().map(|p| p.id).collect::<Vec<_>>()}))
}

pub fn profile_show(rt: &BrowserRuntime, target: &Target) -> BrowserResult<Value> {
    let profile = rt.profiles.get(&target.page.profile_id)?;
    Ok(json!({"browserPageId": target.page.id, "workspace": target.page.workspace_path, "profileId": profile.id, "profileLabel": profile.label}))
}

/// Open the page's URL in another profile's browser; `keep_source` false
/// closes the original (that is `tab profile set`).
pub fn profile_clone(rt: &BrowserRuntime, target: &Target, profile_id: &str, keep_source: bool) -> BrowserResult<Value> {
    let profile = rt.profiles.get(profile_id)?;
    let workspace = target.page.workspace_path.clone().ok_or_else(|| BrowserError::new("invalid_arguments", "The page is not attached to a workspace."))?;
    let url = rt.pages.get(&target.page.id).map(|p| p.url).unwrap_or_else(|| target.page.url.clone());
    let created = tab_create(rt, &workspace, Some(&url), &profile.id)?;
    if !keep_source {
        tab_close(rt, target)?;
    }
    Ok(json!({
        "sourceBrowserPageId": target.page.id,
        "browserPageId": created.get("browserPageId").cloned().unwrap_or(Value::Null),
        "profileId": profile.id,
        "profileLabel": profile.label,
        "tab": created.get("tab").cloned().unwrap_or(Value::Null),
        "closedSource": !keep_source,
    }))
}

// ------------------------------------------------------------------ helpers

fn tail(items: Vec<Value>, limit: Option<String>) -> Vec<Value> {
    match limit.and_then(|l| l.parse::<usize>().ok()) {
        Some(n) if n < items.len() => items[items.len() - n..].to_vec(),
        _ => items,
    }
}

fn is_blank(url: &str) -> bool {
    url.is_empty() || url == "about:blank" || url.starts_with("chrome://newtab") || url.starts_with("chrome://new-tab-page")
}

/// A bare host becomes https; anything with a scheme is left alone.
pub fn normalize_url(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.contains("://") || trimmed.starts_with("about:") || trimmed.starts_with("data:") || trimmed.starts_with("chrome:") || trimmed.starts_with("file:") {
        trimmed.to_string()
    } else if trimmed.starts_with("localhost") || trimmed.starts_with("127.0.0.1") {
        format!("http://{trimmed}")
    } else {
        format!("https://{trimmed}")
    }
}

/// Split at char boundaries into pieces no larger than `max` bytes.
pub fn chunk_text(text: &str, max: usize) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let mut end = (start + max).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        out.push(&text[start..end]);
        start = end;
    }
    if out.is_empty() {
        out.push("");
    }
    out
}

/// Set the focused control's value the way frameworks observe it: through
/// the prototype's native setter, followed by input and change events.
pub fn focused_value_set_expression(value: &str) -> String {
    let literal = serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into());
    format!(
        "(() => {{ const el = document.activeElement; if (!el) return false; \
         const proto = Object.getPrototypeOf(el); \
         const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set; \
         const next = {literal}; \
         if (el.isContentEditable && !setter) {{ el.textContent = next; }} else if (setter) {{ setter.call(el, next); }} else {{ el.value = next; }} \
         el.dispatchEvent(new Event('input', {{ bubbles: true }})); \
         el.dispatchEvent(new Event('change', {{ bubbles: true }})); \
         return true; }})()"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_get_a_scheme_only_when_they_lack_one() {
        assert_eq!(normalize_url("example.com"), "https://example.com");
        assert_eq!(normalize_url("localhost:3000/x"), "http://localhost:3000/x");
        assert_eq!(normalize_url("http://a.b"), "http://a.b");
        assert_eq!(normalize_url("about:blank"), "about:blank");
        assert_eq!(normalize_url("file:///tmp/x.html"), "file:///tmp/x.html");
    }

    #[test]
    fn text_chunks_respect_char_boundaries() {
        let text = "héllo wörld".repeat(500);
        let chunks = chunk_text(&text, 100);
        assert!(chunks.iter().all(|c| c.len() <= 100));
        assert_eq!(chunks.concat(), text);
        assert_eq!(chunk_text("", 10), vec![""]);
    }

    #[test]
    fn value_setter_expression_embeds_the_value_as_a_json_literal() {
        let expr = focused_value_set_expression("a \"quoted\" line\nnext");
        assert!(expr.contains(r#""a \"quoted\" line\nnext""#));
        assert!(expr.contains("dispatchEvent(new Event('input'"));
    }

    #[test]
    fn tail_keeps_the_newest_entries() {
        let items: Vec<Value> = (0..5).map(Value::from).collect();
        assert_eq!(tail(items.clone(), Some("2".into())), vec![Value::from(3), Value::from(4)]);
        assert_eq!(tail(items.clone(), Some("50".into())), items);
        assert_eq!(tail(items.clone(), None), items);
    }

    #[test]
    fn blank_launch_tabs_are_recognised() {
        assert!(is_blank("about:blank"));
        assert!(is_blank("chrome://newtab/"));
        assert!(!is_blank("https://example.com"));
    }
}
