//! Drives Chrome on the cloud desktop over its loopback DevTools port.
//! One browser session at a time per workspace: the desktop has one screen.

use super::{changed, describe, text_result, Caller, HELD_WAIT};
use crate::remote::cloud_desktop::{shared_pool, AgentLease};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::Message;

const CALL_TIMEOUT: Duration = Duration::from_secs(20);
const READ_LIMIT: usize = 8000;

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

/// A DevTools connection to the browser target, with one attached page.
struct Cdp {
    send: mpsc::UnboundedSender<Message>,
    pending: Pending,
    next: AtomicU64,
}

impl Cdp {
    async fn connect(endpoint: &str) -> Result<Self, String> {
        let (socket, _) = tokio_tungstenite::connect_async(endpoint).await.map_err(|_| "Could not reach Chrome on the cloud desktop.".to_string())?;
        let (mut write, mut read) = socket.split();
        let (send, mut outgoing) = mpsc::unbounded_channel::<Message>();
        let pending: Pending = Arc::default();
        tokio::spawn(async move {
            while let Some(message) = outgoing.recv().await {
                if write.send(message).await.is_err() {
                    break;
                }
            }
        });
        let answers = pending.clone();
        tokio::spawn(async move {
            while let Some(Ok(message)) = read.next().await {
                let Message::Text(text) = message else { continue };
                let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
                let Some(id) = value["id"].as_u64() else { continue };
                if let Some(answer) = answers.lock().unwrap().remove(&id) {
                    let _ = answer.send(match value.get("error") {
                        Some(error) => Err(error["message"].as_str().unwrap_or("Chrome refused the call").to_string()),
                        None => Ok(value["result"].clone()),
                    });
                }
            }
            // Chrome went away: every waiting call fails now, not at its timeout.
            answers.lock().unwrap().clear();
        });
        Ok(Self { send, pending, next: AtomicU64::new(1) })
    }

    async fn call(&self, method: &str, params: Value, session: Option<&str>) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (answer, wait) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, answer);
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = json!(session);
        }
        self.send.send(Message::Text(message.to_string().into())).map_err(|_| "Chrome closed the connection.".to_string())?;
        match tokio::time::timeout(CALL_TIMEOUT, wait).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Chrome closed the connection.".into()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("Chrome did not answer {method} in time."))
            }
        }
    }
}

struct Browser {
    key: String,
    agent: String,
    tab_title: Option<String>,
    cdp: Cdp,
    page: String,
    actions: u64,
    action: Option<String>,
    _lease: AgentLease,
}

struct Engine {
    browser: tokio::sync::Mutex<Option<Browser>>,
    /// A snapshot of who drives, for `desktop.agent`.
    driving: Mutex<Option<Value>>,
    /// The tab whose session is open, readable without waiting on one.
    owner: Mutex<Option<String>>,
    held: watch::Sender<bool>,
}

static ENGINE: LazyLock<Engine> = LazyLock::new(|| Engine {
    browser: tokio::sync::Mutex::new(None),
    driving: Mutex::new(None),
    owner: Mutex::new(None),
    held: watch::channel(false).0,
});

fn runtime() -> Option<tokio::runtime::Handle> {
    RUNTIME.get().cloned()
}

static RUNTIME: std::sync::OnceLock<tokio::runtime::Handle> = std::sync::OnceLock::new();

/// The runtime's Tokio runtime, from the relay host that serves the desktop.
pub(crate) fn install(handle: tokio::runtime::Handle) {
    let _ = RUNTIME.set(handle);
}

pub(super) fn state() -> Value {
    json!({ "browser": super::offer(), "driving": ENGINE.driving.lock().unwrap().clone() })
}

pub(super) fn set_held(held: bool) {
    if ENGINE.held.send_replace(held) != held {
        if let Some(driving) = ENGINE.driving.lock().unwrap().as_mut() {
            driving["held"] = json!(held);
        }
        changed();
    }
}

fn publish(browser: Option<&Browser>) {
    *ENGINE.owner.lock().unwrap() = browser.map(|browser| browser.key.clone());
    *ENGINE.driving.lock().unwrap() = browser.map(|browser| json!({
        "agent": browser.agent,
        "tabTitle": browser.tab_title,
        "action": browser.action,
        "actions": browser.actions,
        "held": *ENGINE.held.borrow(),
    }));
    changed();
}

/// The switch went off: end the session now.
pub(super) fn withdraw() {
    let Some(handle) = runtime() else { return };
    handle.spawn(async {
        ENGINE.browser.lock().await.take();
        ENGINE.held.send_replace(false);
        publish(None);
    });
}

pub(super) fn call(caller: Caller<'_>, tool: &str, arguments: &Value, approve: &dyn Fn(Value) -> bool) -> Value {
    let Some(handle) = runtime() else {
        return text_result("The cloud desktop is not running in this runtime.", true);
    };
    // Shown on the card before anything starts, in a tab that asks first.
    let opening = tool == "open";
    if opening {
        let other = ENGINE.owner.lock().unwrap().as_ref().map(|owner| *owner != caller.key);
        if other == Some(true) {
            return text_result("Another tab's agent is using the cloud browser. Try again when it closes its session.", true);
        }
        if other.is_none() && caller.asks && !approve(json!({
            "url": arguments["url"], "plan": arguments["plan"], "agent": caller.agent,
        })) {
            return text_result("The person denied the browser session. Do not open it again unless they ask.", true);
        }
    }
    let tool = tool.to_string();
    let arguments = arguments.clone();
    let (key, agent, tab_title) = (caller.key, caller.agent.to_string(), caller.tab_title);
    // Run on the runtime's own threads; this hook thread only waits.
    let (answer, wait) = std::sync::mpsc::channel();
    handle.spawn(async move {
        let _ = answer.send(run(key, agent, tab_title, &tool, &arguments).await);
    });
    wait.recv().unwrap_or_else(|_| text_result("The cloud browser stopped.", true))
}

async fn wait_for_control() -> Result<(), String> {
    let mut held = ENGINE.held.subscribe();
    let released = tokio::time::timeout(HELD_WAIT, held.wait_for(|held| !*held)).await.is_ok_and(|waited| waited.is_ok());
    if released {
        return Ok(());
    }
    Err("A person has had control of the cloud desktop for 30 minutes. Stop and ask them before trying again.".into())
}

async fn run(key: String, agent: String, tab_title: Option<String>, tool: &str, arguments: &Value) -> Value {
    let mut slot = ENGINE.browser.lock().await;
    if tool == "open" && slot.is_none() {
        match start(&key, &agent, tab_title).await {
            Ok(browser) => *slot = Some(browser),
            Err(error) => return text_result(error, true),
        }
    }
    let Some(browser) = slot.as_mut().filter(|browser| browser.key == key) else {
        return text_result("No browser session is open for this tab. Call open first.", true);
    };
    if tool == "close" {
        let _ = browser.cdp.call("Page.navigate", json!({ "url": "about:blank" }), Some(&browser.page)).await;
        slot.take();
        ENGINE.held.send_replace(false);
        publish(None);
        return text_result("Closed the browser session.", false);
    }
    browser.actions += 1;
    browser.action = Some(describe(tool, arguments));
    publish(Some(browser));
    drop(slot);
    // A person who took control is not raced: the agent waits, unlocked,
    // so the session can still be closed meanwhile.
    if let Err(error) = wait_for_control().await {
        return text_result(error, true);
    }
    let slot = ENGINE.browser.lock().await;
    let Some(browser) = slot.as_ref().filter(|browser| browser.key == key) else {
        return text_result("The browser session ended.", true);
    };
    match act(browser, tool, arguments).await {
        Ok(result) => result,
        Err(error) => text_result(error, true),
    }
}

async fn start(key: &str, agent: &str, tab_title: Option<String>) -> Result<Browser, String> {
    let pool = shared_pool().ok_or("The cloud desktop is not set up in this runtime.")?;
    let lease = pool.agent().await.map_err(|error| format!("The cloud desktop could not start: {error}."))?;
    let cdp = Cdp::connect(&lease.devtools).await?;
    let targets = cdp.call("Target.getTargets", json!({}), None).await?;
    let page = targets["targetInfos"].as_array().and_then(|targets| targets.iter().find(|target| target["type"] == "page")).and_then(|target| target["targetId"].as_str()).map(str::to_string);
    let target = match page {
        Some(target) => target,
        None => cdp.call("Target.createTarget", json!({ "url": "about:blank" }), None).await?["targetId"].as_str().ok_or("Chrome opened no page.")?.to_string(),
    };
    let attached = cdp.call("Target.attachToTarget", json!({ "targetId": target, "flatten": true }), None).await?;
    let page = attached["sessionId"].as_str().ok_or("Chrome did not attach to its page.")?.to_string();
    cdp.call("Page.enable", json!({}), Some(&page)).await?;
    Ok(Browser { key: key.into(), agent: agent.into(), tab_title, cdp, page, actions: 0, action: None, _lease: lease })
}

fn http_url(url: Option<&str>) -> Result<String, String> {
    let url = url.map(str::trim).filter(|url| !url.is_empty()).ok_or("Give a URL.")?;
    // "localhost:3000" parses with "localhost" as its scheme: no "://", no scheme.
    let full = if url.contains("://") { url.to_string() } else { format!("http://{url}") };
    let parsed = url::Url::parse(&full).map_err(|_| format!("Not a URL: {url}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only http and https pages can be opened.".into());
    }
    Ok(parsed.to_string())
}

/// The page's title and address, after an action.
async fn where_now(browser: &Browser) -> String {
    let page = browser.cdp.call("Runtime.evaluate", json!({ "expression": "JSON.stringify([document.title, location.href])", "returnByValue": true }), Some(&browser.page)).await;
    let pair: Vec<String> = page.ok().and_then(|page| page["result"]["value"].as_str().and_then(|text| serde_json::from_str(text).ok())).unwrap_or_default();
    match pair.as_slice() {
        [title, url] if !title.is_empty() => format!("Now on “{title}” at {url}."),
        [_, url] => format!("Now at {url}."),
        _ => "Done.".into(),
    }
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(400)).await;
}

/// The element's centre: by visible text first, as a person would.
const FIND: &str = r#"(function(text, selector) {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  let el = null;
  if (selector) el = document.querySelector(selector);
  if (!el && text) {
    const want = text.trim().toLowerCase();
    const candidates = [...document.querySelectorAll('button, a, [role=button], input[type=submit], input[type=button], label, summary, [onclick]')].filter(visible);
    el = candidates.find((c) => (c.innerText || c.value || '').trim().toLowerCase() === want)
      || candidates.find((c) => (c.innerText || c.value || '').trim().toLowerCase().includes(want));
    if (el && el.tagName === 'LABEL' && el.control) el = el.control;
  }
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return JSON.stringify([r.left + r.width / 2, r.top + r.height / 2]);
})"#;

async fn click_at(browser: &Browser, x: f64, y: f64) -> Result<(), String> {
    for kind in ["mouseMoved", "mousePressed", "mouseReleased"] {
        browser.cdp.call("Input.dispatchMouseEvent", json!({ "type": kind, "x": x, "y": y, "button": "left", "clickCount": 1 }), Some(&browser.page)).await?;
    }
    Ok(())
}

async fn locate(browser: &Browser, text: Option<&str>, selector: Option<&str>) -> Result<(f64, f64), String> {
    let expression = format!("{FIND}({}, {})", json!(text), json!(selector));
    let found = browser.cdp.call("Runtime.evaluate", json!({ "expression": expression, "returnByValue": true }), Some(&browser.page)).await?;
    let point: Option<(f64, f64)> = found["result"]["value"].as_str().and_then(|text| serde_json::from_str(text).ok());
    point.ok_or_else(|| format!("Found nothing to click for {}.", text.or(selector).unwrap_or("that")))
}

fn key_code(key: &str) -> Option<(&'static str, &'static str, u32)> {
    Some(match key {
        "Enter" => ("Enter", "Enter", 13),
        "Tab" => ("Tab", "Tab", 9),
        "Escape" => ("Escape", "Escape", 27),
        "Backspace" => ("Backspace", "Backspace", 8),
        "ArrowUp" => ("ArrowUp", "ArrowUp", 38),
        "ArrowDown" => ("ArrowDown", "ArrowDown", 40),
        "ArrowLeft" => ("ArrowLeft", "ArrowLeft", 37),
        "ArrowRight" => ("ArrowRight", "ArrowRight", 39),
        _ => return None,
    })
}

async fn act(browser: &Browser, tool: &str, arguments: &Value) -> Result<Value, String> {
    let page = Some(browser.page.as_str());
    match tool {
        "open" | "navigate" => {
            let url = http_url(arguments["url"].as_str())?;
            let _ = browser.cdp.call("Page.bringToFront", json!({}), page).await;
            let navigated = browser.cdp.call("Page.navigate", json!({ "url": url }), page).await?;
            if let Some(error) = navigated["errorText"].as_str().filter(|error| !error.is_empty()) {
                return Err(format!("Could not open {url}: {error}."));
            }
            settle().await;
        }
        "click" => {
            let (x, y) = match (arguments["x"].as_f64(), arguments["y"].as_f64()) {
                (Some(x), Some(y)) => (x, y),
                _ => locate(browser, arguments["text"].as_str(), arguments["selector"].as_str()).await?,
            };
            click_at(browser, x, y).await?;
            settle().await;
        }
        "type" => {
            if let Some(selector) = arguments["selector"].as_str() {
                let (x, y) = locate(browser, None, Some(selector)).await?;
                click_at(browser, x, y).await?;
            }
            let text = arguments["text"].as_str().ok_or("Give the text to type.")?;
            browser.cdp.call("Input.insertText", json!({ "text": text }), page).await?;
        }
        "press" => {
            let (key, code, number) = key_code(arguments["key"].as_str().unwrap_or_default()).ok_or("That key is not supported. Use Enter, Tab, Escape, Backspace or an arrow key.")?;
            for kind in ["keyDown", "keyUp"] {
                let mut event = json!({ "type": kind, "key": key, "code": code, "windowsVirtualKeyCode": number });
                if key == "Enter" && kind == "keyDown" {
                    event["text"] = json!("\r");
                }
                browser.cdp.call("Input.dispatchKeyEvent", event, page).await?;
            }
            settle().await;
        }
        "read" => {
            let read = browser.cdp.call("Runtime.evaluate", json!({ "expression": "JSON.stringify([document.title, location.href, document.body ? document.body.innerText : ''])", "returnByValue": true }), page).await?;
            let [title, url, text]: [String; 3] = read["result"]["value"].as_str().and_then(|text| serde_json::from_str(text).ok()).ok_or("Could not read the page.")?;
            let text: String = text.chars().take(READ_LIMIT).collect();
            return Ok(text_result(format!("Title: {title}\nURL: {url}\n\n{text}"), false));
        }
        "screenshot" => {
            let shot = browser.cdp.call("Page.captureScreenshot", json!({ "format": "png" }), page).await?;
            let data = shot["data"].as_str().ok_or("Chrome took no screenshot.")?;
            return Ok(json!({ "content": [{ "type": "image", "data": data, "mimeType": "image/png" }], "isError": false }));
        }
        _ => return Err(format!("Unknown tool: {tool}")),
    }
    Ok(text_result(where_now(browser).await, false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_only_web_pages() {
        assert_eq!(http_url(Some("localhost:3000")).unwrap(), "http://localhost:3000/");
        assert_eq!(http_url(Some("https://example.test/a")).unwrap(), "https://example.test/a");
        for refused in ["file:///etc/passwd", "javascript:alert(1)", "javascript://alert(1)", "data:text/html,x", "chrome://settings", ""] {
            assert!(http_url(Some(refused)).is_err(), "{refused}");
        }
    }

    #[test]
    fn presses_only_the_named_keys() {
        assert_eq!(key_code("Enter"), Some(("Enter", "Enter", 13)));
        assert_eq!(key_code("F12"), None);
    }

    #[test]
    fn taking_control_marks_the_driver_as_waiting() {
        *ENGINE.driving.lock().unwrap() = Some(json!({ "agent": "Claude Code", "held": false }));
        let seen = super::super::subscribe();
        set_held(true);
        assert!(seen.has_changed().unwrap());
        assert_eq!(state()["driving"]["held"], true);
        set_held(false);
        assert_eq!(state()["driving"]["held"], false);
        *ENGINE.driving.lock().unwrap() = None;
    }
}
