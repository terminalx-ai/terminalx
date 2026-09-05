//! A small Chrome DevTools Protocol client for the two things agent-browser
//! does not expose: the live screencast the pane shows, and deleting one
//! cookie. Chromium accepts several DevTools clients at once, so this rides
//! alongside agent-browser's own connection.
//!
//! Finding the page: `/json/list` names every page target, but nothing in
//! it says which agent-browser tab is which. So the app stamps the page
//! (`window.__terminalxBrowserPage = "<page id>"`) through agent-browser,
//! then evaluates that marker on each candidate until one answers.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

use super::bridge::ExecOptions;
use super::{BrowserError, BrowserResult, BrowserRuntime, Target};

pub const MARKER_KEY: &str = "__terminalxBrowserPage";
const HTTP_TIMEOUT: Duration = Duration::from_secs(5);
const CALL_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct PageTarget {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(rename = "webSocketDebuggerUrl", default)]
    pub ws_url: String,
}

/// The DevTools port of the browser behind a page, from agent-browser.
pub fn cdp_port(rt: &BrowserRuntime, target: &Target) -> BrowserResult<u16> {
    let value = rt.bridge.with_session(&target.session, |ctx| ctx.run(&["get", "cdp-url"], ExecOptions::default()))?;
    let url = value.get("cdpUrl").and_then(Value::as_str).ok_or_else(|| BrowserError::new("browser_error", "agent-browser did not report a DevTools URL."))?;
    parse_port(url).ok_or_else(|| BrowserError::new("browser_error", format!("Unreadable DevTools URL {url}.")))
}

pub fn parse_port(ws_url: &str) -> Option<u16> {
    url::Url::parse(ws_url).ok()?.port()
}

/// Stamp the page so it can be told apart from its siblings.
pub fn mark_page(rt: &BrowserRuntime, target: &Target) -> BrowserResult<()> {
    let expression = format!("window.{MARKER_KEY} = {}; true", serde_json::to_string(&target.page.id).unwrap_or_default());
    rt.bridge.with_session(&target.session, |ctx| {
        ctx.ensure_tab(&target.page.tab_id)?;
        ctx.run(&["eval", "--stdin"], ExecOptions { timeout: Duration::from_secs(20), stdin: Some(expression) })
    })?;
    Ok(())
}

pub fn list_page_targets(port: u16) -> BrowserResult<Vec<PageTarget>> {
    let agent = ureq::AgentBuilder::new().timeout(HTTP_TIMEOUT).build();
    let response = agent
        .get(&format!("http://127.0.0.1:{port}/json/list"))
        .call()
        .map_err(|e| BrowserError::new("browser_error", format!("DevTools listing failed: {e}")))?;
    let targets: Vec<PageTarget> = response.into_json().map_err(|e| BrowserError::new("browser_error", format!("DevTools listing unreadable: {e}")))?;
    Ok(targets.into_iter().filter(|t| t.kind == "page" && !t.ws_url.is_empty()).collect())
}

/// One DevTools connection to a page target.
pub struct PageConnection {
    socket: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    next_id: u64,
}

impl PageConnection {
    pub async fn connect(ws_url: &str) -> Result<Self, String> {
        let (socket, _) = tokio::time::timeout(CALL_TIMEOUT, tokio_tungstenite::connect_async(ws_url))
            .await
            .map_err(|_| "DevTools connect timed out".to_string())?
            .map_err(|e| format!("DevTools connect failed: {e}"))?;
        Ok(Self { socket, next_id: 0 })
    }

    /// Send a command and wait for its reply, handing intervening events to
    /// `on_event`.
    pub async fn call(&mut self, method: &str, params: Value, mut on_event: impl FnMut(&str, &Value)) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let text = json!({"id": id, "method": method, "params": params}).to_string();
        self.socket.send(Message::Text(text.into())).await.map_err(|e| format!("DevTools send failed: {e}"))?;
        let deadline = tokio::time::Instant::now() + CALL_TIMEOUT;
        loop {
            let message = tokio::time::timeout_at(deadline, self.socket.next()).await.map_err(|_| format!("DevTools {method} timed out"))?;
            let Some(message) = message else { return Err("DevTools connection closed".into()) };
            let message = message.map_err(|e| format!("DevTools read failed: {e}"))?;
            let Some(value) = parse_message(&message) else { continue };
            if value.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(error) = value.get("error") {
                    return Err(format!("DevTools {method}: {}", error.get("message").and_then(Value::as_str).unwrap_or("error")));
                }
                return Ok(value.get("result").cloned().unwrap_or(Value::Null));
            }
            if let Some(event) = value.get("method").and_then(Value::as_str) {
                on_event(event, value.get("params").unwrap_or(&Value::Null));
            }
        }
    }

    /// The next event, or `None` when the page is gone.
    pub async fn next_event(&mut self) -> Option<(String, Value)> {
        loop {
            let message = self.socket.next().await?.ok()?;
            let Some(value) = parse_message(&message) else { continue };
            if let Some(method) = value.get("method").and_then(Value::as_str) {
                return Some((method.to_string(), value.get("params").cloned().unwrap_or(Value::Null)));
            }
        }
    }

    pub async fn evaluate(&mut self, expression: &str) -> Result<Value, String> {
        let result = self.call("Runtime.evaluate", json!({"expression": expression, "returnByValue": true}), |_, _| {}).await?;
        Ok(result.get("result").and_then(|r| r.get("value")).cloned().unwrap_or(Value::Null))
    }
}

fn parse_message(message: &Message) -> Option<Value> {
    match message {
        Message::Text(text) => serde_json::from_str(text).ok(),
        Message::Binary(bytes) => serde_json::from_slice(bytes).ok(),
        _ => None,
    }
}

/// The page target carrying `page_id`'s marker.
pub async fn find_marked_page(port: u16, page_id: &str) -> Result<PageTarget, String> {
    let targets = list_page_targets(port).map_err(|e| e.message)?;
    let probe = format!("window.{MARKER_KEY}");
    for target in targets {
        let Ok(mut connection) = PageConnection::connect(&target.ws_url).await else { continue };
        if let Ok(Value::String(found)) = connection.evaluate(&probe).await {
            if found == page_id {
                return Ok(target);
            }
        }
    }
    Err(format!("No DevTools page carries the marker for {page_id}; it may have navigated. Retry."))
}

/// Run one DevTools command against the page, from a synchronous caller.
pub fn call_on_page(rt: &BrowserRuntime, target: &Target, method: &str, params: Value) -> BrowserResult<Value> {
    let port = cdp_port(rt, target)?;
    mark_page(rt, target)?;
    let page_id = target.page.id.clone();
    let method = method.to_string();
    let handle = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
        runtime.block_on(async move {
            let found = find_marked_page(port, &page_id).await?;
            let mut connection = PageConnection::connect(&found.ws_url).await?;
            connection.call(&method, params, |_, _| {}).await
        })
    });
    handle
        .join()
        .map_err(|_| BrowserError::new("browser_error", "DevTools call panicked"))?
        .map_err(|e| BrowserError::new("browser_error", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_port_out_of_a_devtools_url() {
        assert_eq!(parse_port("ws://127.0.0.1:54743/devtools/browser/7aab"), Some(54743));
        assert_eq!(parse_port("nonsense"), None);
    }

    #[test]
    fn page_targets_deserialize_from_json_list() {
        let raw = r#"[{"id":"A","type":"page","url":"https://x","title":"X","webSocketDebuggerUrl":"ws://127.0.0.1:1/devtools/page/A"},{"id":"B","type":"browser_ui","url":"chrome://x","webSocketDebuggerUrl":"ws://127.0.0.1:1/devtools/page/B"}]"#;
        let targets: Vec<PageTarget> = serde_json::from_str(raw).unwrap();
        assert_eq!(targets.len(), 2);
        assert_eq!(targets[0].ws_url, "ws://127.0.0.1:1/devtools/page/A");
        assert_eq!(targets[1].kind, "browser_ui");
    }
}
