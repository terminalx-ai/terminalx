//! A small Chrome DevTools Protocol client for the two things agent-browser
//! does not expose: the live screencast the pane shows, and deleting one
//! cookie. Chromium accepts several DevTools clients at once, so this rides
//! alongside agent-browser's own connection.
//!
//! Finding the page: `/json/list` names every page target, but nothing in
//! it says which agent-browser tab is which. So the app stamps the page
//! (`window.__terminalxBrowserPage = "<page id>"`) through agent-browser,
//! then evaluates that marker on each candidate until one answers.

use std::sync::OnceLock;
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

fn cdp_agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| ureq::AgentBuilder::new().timeout(HTTP_TIMEOUT).build())
}

fn cdp_runtime() -> Result<&'static tokio::runtime::Runtime, String> {
    static RUNTIME: OnceLock<Result<tokio::runtime::Runtime, String>> = OnceLock::new();
    match RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .thread_name("browser-cdp")
            .enable_all()
            .build()
            .map_err(|e| e.to_string())
    }) {
        Ok(rt) => Ok(rt),
        Err(e) => Err(e.clone()),
    }
}

fn block_on_cdp<F, T>(future: F) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>> + Send + 'static,
    T: Send + 'static,
{
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread {
            return tokio::task::block_in_place(|| handle.block_on(future));
        }
    }
    cdp_runtime()?.block_on(future)
}

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
    let response = cdp_agent()
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

/// The page target carrying `page_id`'s marker, along with the already-open
/// DevTools connection used to confirm it.
pub async fn find_marked_page(port: u16, page_id: &str) -> Result<(PageTarget, PageConnection), String> {
    let targets = tokio::task::spawn_blocking(move || list_page_targets(port))
        .await
        .map_err(|e| format!("DevTools listing failed: {e}"))?
        .map_err(|e| e.message)?;
    let probe = format!("window.{MARKER_KEY}");
    let expected = page_id.to_string();
    let mut probes = tokio::task::JoinSet::new();
    for target in targets {
        let probe = probe.clone();
        let expected = expected.clone();
        probes.spawn(async move {
            let mut connection = PageConnection::connect(&target.ws_url).await.ok()?;
            let found = connection.evaluate(&probe).await.ok()?;
            (found.as_str() == Some(expected.as_str())).then_some((target, connection))
        });
    }
    while let Some(joined) = probes.join_next().await {
        if let Ok(Some(matched)) = joined {
            probes.abort_all();
            return Ok(matched);
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
    block_on_cdp(async move {
        let (_found, mut connection) = find_marked_page(port, &page_id).await?;
        connection.call(&method, params, |_, _| {}).await
    })
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

    #[test]
    fn cdp_agent_is_shared_across_calls() {
        assert!(std::ptr::eq(cdp_agent(), cdp_agent()));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn find_marked_page_probes_targets_concurrently_and_reuses_open_connection() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // Slow target that accepts WS and stalls forever on evaluate.
        let slow_ws = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let slow_addr = slow_ws.local_addr().unwrap();
        let slow_task = tokio::spawn(async move {
            if let Ok((stream, _)) = slow_ws.accept().await {
                if let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await {
                    let _ = ws.next().await;
                    tokio::time::sleep(Duration::from_secs(30)).await;
                }
            }
        });

        // Fast matching target: answers marker evaluation AND a follow-up command on the SAME socket.
        let fast_ws = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fast_addr = fast_ws.local_addr().unwrap();
        let fast_accepts = Arc::new(AtomicUsize::new(0));
        let fast_accepts_clone = fast_accepts.clone();
        let fast_task = tokio::spawn(async move {
            let (stream, _) = fast_ws.accept().await.unwrap();
            fast_accepts_clone.fetch_add(1, Ordering::SeqCst);
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            while let Some(Ok(Message::Text(text))) = ws.next().await {
                let req: Value = serde_json::from_str(&text).unwrap();
                let id = req["id"].as_u64().unwrap();
                let reply = match req["method"].as_str() {
                    Some("Runtime.evaluate") => json!({"id": id, "result": {"result": {"value": "page-42"}}}),
                    Some("Page.ping") => json!({"id": id, "result": {"ok": true}}),
                    _ => json!({"id": id, "result": {}}),
                };
                ws.send(Message::Text(reply.to_string().into())).await.unwrap();
            }
        });

        // Mock /json/list HTTP server listing the slow target FIRST, then the matching target.
        let http = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let http_port = http.local_addr().unwrap().port();
        let body = json!([
            {"id": "slow", "type": "page", "url": "https://slow", "title": "Slow", "webSocketDebuggerUrl": format!("ws://{slow_addr}/devtools/page/slow")},
            {"id": "fast", "type": "page", "url": "https://fast", "title": "Fast", "webSocketDebuggerUrl": format!("ws://{fast_addr}/devtools/page/fast")},
        ])
        .to_string();
        let http_task = tokio::spawn(async move {
            let (mut stream, _) = http.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf).await;
            let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            stream.write_all(resp.as_bytes()).await.unwrap();
        });

        let started = std::time::Instant::now();
        let (target, mut conn) = find_marked_page(http_port, "page-42").await.unwrap();
        assert!(started.elapsed() < Duration::from_secs(3), "concurrent probe must not wait on stalled target");
        assert_eq!(target.id, "fast");
        let pong = conn.call("Page.ping", json!({}), |_, _| {}).await.unwrap();
        assert_eq!(pong["ok"], true);
        assert_eq!(fast_accepts.load(Ordering::SeqCst), 1, "reused the already-open WebSocket connection");

        drop(conn);
        slow_task.abort();
        let _ = fast_task.await;
        let _ = http_task.await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn block_on_cdp_uses_existing_tokio_runtime_handle() {
        let value = block_on_cdp(async { Ok::<_, String>(42) }).unwrap();
        assert_eq!(value, 42);
    }
}
