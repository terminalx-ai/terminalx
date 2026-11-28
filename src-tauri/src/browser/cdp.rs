//! A small Chrome DevTools Protocol client for the two things agent-browser
//! does not expose: the live screencast the pane shows, and deleting one
//! cookie. Chromium accepts several DevTools clients at once, so this rides
//! alongside agent-browser's own connection.
//!
//! Finding the page: each page is bound directly to its immutable CDP
//! `targetId` (captured on creation or resolved uniquely from `/json/list`
//! without trusting any page-writable main-world global).

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

use super::bridge::ExecOptions;
use super::{BrowserError, BrowserResult, BrowserRuntime, Target};

const HTTP_TIMEOUT: Duration = Duration::from_secs(5);
const CALL_TIMEOUT: Duration = Duration::from_secs(15);

fn target_bindings() -> &'static Mutex<HashMap<String, String>> {
    static BINDINGS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    BINDINGS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn bind_target_id(page_id: &str, target_id: &str) {
    let mut map = target_bindings().lock().unwrap_or_else(|e| e.into_inner());
    if map.len() >= 1024 && !map.contains_key(page_id) {
        map.clear();
    }
    map.insert(page_id.to_string(), target_id.to_string());
}

pub fn unbind_target_id(page_id: &str) {
    target_bindings().lock().unwrap_or_else(|e| e.into_inner()).remove(page_id);
}

pub fn cached_target_id(page_id: &str) -> Option<String> {
    target_bindings().lock().unwrap_or_else(|e| e.into_inner()).get(page_id).cloned()
}

/// Snapshot currently open page `targetId`s on `port` (used around tab creation
/// to bind the newly created tab's immutable CDP `targetId` without touching JS).
pub fn snapshot_target_ids(port: u16) -> Option<HashSet<String>> {
    list_page_targets(port).ok().map(|list| list.into_iter().map(|t| t.id).collect())
}

/// Identify a newly created page target by diffing `/json/list` snapshots.
pub fn diff_new_target_id(before: &HashSet<String>, after: &[PageTarget]) -> Option<String> {
    let mut added = after.iter().filter(|t| !before.contains(&t.id));
    let first = added.next()?;
    if added.next().is_some() {
        return None;
    }
    Some(first.id.clone())
}

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

/// Resolve and persist the immutable CDP `targetId` for `target`.
///
/// Never relies on a static page-writable main-world global like
/// `window.__terminalxBrowserPage`:
/// 1. Uses the already-bound immutable `cdp_target_id` if still present in `/json/list`.
/// 2. If only one unbound page target exists (or one unbound target matches the
///    tab's URL/title uniquely), binds its immutable `targetId` with zero JS.
/// 3. As a one-time fallback for ambiguous pre-existing tabs, binds via an
///    unpredictable per-probe CSPRNG key+nonce pair that is deleted immediately
///    on read and fails closed if more than one target matches, then permanently
///    caches the immutable `targetId`.
pub fn resolve_target_id(rt: &BrowserRuntime, target: &Target) -> BrowserResult<(u16, String)> {
    let port = cdp_port(rt, target)?;
    let targets = list_page_targets(port)?;
    if let Some(existing) = target
        .page
        .cdp_target_id
        .clone()
        .or_else(|| cached_target_id(&target.page.id))
    {
        if targets.iter().any(|t| t.id == existing) {
            bind_target_id(&target.page.id, &existing);
            return Ok((port, existing));
        }
    }

    // Exclude immutable targetIds already owned by sibling pages in this profile.
    let claimed: HashSet<String> = rt
        .pages
        .in_profile(&target.page.profile_id)
        .into_iter()
        .filter(|p| p.id != target.page.id)
        .filter_map(|p| p.cdp_target_id.or_else(|| cached_target_id(&p.id)))
        .collect();
    let candidates: Vec<PageTarget> = targets
        .into_iter()
        .filter(|t| !claimed.contains(&t.id))
        .collect();

    if let Some(unique) = pick_unambiguous_target(&candidates, &target.page.url, &target.page.title) {
        remember_target_id(rt, &target.page.id, &unique.id);
        return Ok((port, unique.id.clone()));
    }

    if candidates.is_empty() {
        return Err(BrowserError::new(
            "browser_error",
            format!("No DevTools page target is open for {}.", target.page.id),
        ));
    }

    // One-time unpredictable CSPRNG probe for ambiguous pre-existing tabs:
    // both property name and value carry 128 bits of entropy and are deleted
    // immediately on read; any duplicate match fails closed.
    let (probe_key, probe_nonce) = random_probe_pair();
    let set_expr = format!(
        "(() => {{ Object.defineProperty(window, {key}, {{ value: {val}, configurable: true, enumerable: false }}); return true; }})()",
        key = serde_json::to_string(&probe_key).unwrap_or_default(),
        val = serde_json::to_string(&probe_nonce).unwrap_or_default(),
    );
    rt.bridge.with_session(&target.session, |ctx| {
        ctx.ensure_tab(&target.page.tab_id)?;
        ctx.run(&["eval", "--stdin"], ExecOptions { timeout: Duration::from_secs(20), stdin: Some(set_expr) })
    })?;

    let matched = block_on_cdp(async move {
        find_unique_ephemeral_probe(candidates, probe_key, probe_nonce).await
    })
    .map_err(|e| BrowserError::new("browser_error", e))?;
    remember_target_id(rt, &target.page.id, &matched.id);
    Ok((port, matched.id))
}

fn remember_target_id(rt: &BrowserRuntime, page_id: &str, target_id: &str) {
    bind_target_id(page_id, target_id);
    let _ = rt.pages.set_cdp_target_id(page_id, Some(target_id));
}

fn random_probe_pair() -> (String, String) {
    use base64::{engine::general_purpose, Engine};
    use rand_core::{OsRng, RngCore};
    let mut k = [0u8; 16];
    let mut v = [0u8; 16];
    OsRng.fill_bytes(&mut k);
    OsRng.fill_bytes(&mut v);
    (
        format!("__tx_probe_{}", general_purpose::URL_SAFE_NO_PAD.encode(k)),
        general_purpose::URL_SAFE_NO_PAD.encode(v),
    )
}

fn pick_unambiguous_target<'a>(candidates: &'a [PageTarget], url: &str, title: &str) -> Option<&'a PageTarget> {
    if candidates.len() == 1 {
        return Some(&candidates[0]);
    }
    if !url.is_empty() {
        let by_url: Vec<&PageTarget> = candidates.iter().filter(|t| t.url == url).collect();
        if by_url.len() == 1 {
            return Some(by_url[0]);
        }
        if !title.is_empty() {
            let by_both: Vec<&PageTarget> = by_url.into_iter().filter(|t| t.title == title).collect();
            if by_both.len() == 1 {
                return Some(by_both[0]);
            }
        }
    }
    None
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

/// Connect directly to the page with immutable CDP `target_id`.
/// Never inspects any page-writable JS global.
pub async fn connect_target_id(port: u16, target_id: &str) -> Result<(PageTarget, PageConnection), String> {
    let targets = tokio::task::spawn_blocking(move || list_page_targets(port))
        .await
        .map_err(|e| format!("DevTools listing failed: {e}"))?
        .map_err(|e| e.message)?;
    let target = targets
        .into_iter()
        .find(|t| t.id == target_id)
        .ok_or_else(|| format!("DevTools page target {target_id} is no longer open."))?;
    let connection = PageConnection::connect(&target.ws_url).await?;
    Ok((target, connection))
}

async fn find_unique_ephemeral_probe(
    targets: Vec<PageTarget>,
    probe_key: String,
    probe_nonce: String,
) -> Result<PageTarget, String> {
    let read_and_delete = format!(
        "(() => {{ const k = {key}; const v = window[k]; if (typeof v === 'string') {{ try {{ delete window[k]; }} catch {{}} }} return v ?? null; }})()",
        key = serde_json::to_string(&probe_key).unwrap_or_default(),
    );
    let mut probes = tokio::task::JoinSet::new();
    for target in targets {
        let expr = read_and_delete.clone();
        let expected = probe_nonce.clone();
        probes.spawn(async move {
            let mut connection = PageConnection::connect(&target.ws_url).await.ok()?;
            let found = tokio::time::timeout(Duration::from_secs(3), connection.evaluate(&expr))
                .await
                .ok()?
                .ok()?;
            (found.as_str() == Some(expected.as_str())).then_some(target)
        });
    }
    let mut matches = Vec::new();
    while let Some(joined) = probes.join_next().await {
        if let Ok(Some(matched)) = joined {
            matches.push(matched);
            if matches.len() > 1 {
                probes.abort_all();
                return Err("Refusing ambiguous DevTools target match.".into());
            }
        }
    }
    match matches.len() {
        1 => Ok(matches.into_iter().next().unwrap()),
        0 => Err("No DevTools page target matched the probe; it may have navigated. Retry.".into()),
        _ => Err("Refusing ambiguous DevTools target match.".into()),
    }
}

/// Run one DevTools command against the page, from a synchronous caller,
/// pinned to its immutable CDP `targetId`.
pub fn call_on_page(rt: &BrowserRuntime, target: &Target, method: &str, params: Value) -> BrowserResult<Value> {
    let (port, target_id) = resolve_target_id(rt, target)?;
    let method = method.to_string();
    block_on_cdp(async move {
        let (_found, mut connection) = connect_target_id(port, &target_id).await?;
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
    async fn connect_target_id_connects_directly_to_immutable_target_without_js_eval() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // Malicious spoof target that would reply with any JS marker if evaluated.
        let spoof_ws = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let spoof_addr = spoof_ws.local_addr().unwrap();
        let spoof_hits = Arc::new(AtomicUsize::new(0));
        let spoof_hits_clone = spoof_hits.clone();
        let spoof_task = tokio::spawn(async move {
            if let Ok((stream, _)) = spoof_ws.accept().await {
                spoof_hits_clone.fetch_add(1, Ordering::SeqCst);
                let _ = tokio_tungstenite::accept_async(stream).await;
            }
        });

        // Legitimate target identified strictly by immutable CDP targetId.
        let real_ws = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let real_addr = real_ws.local_addr().unwrap();
        let real_evals = Arc::new(AtomicUsize::new(0));
        let real_evals_clone = real_evals.clone();
        let real_task = tokio::spawn(async move {
            let (stream, _) = real_ws.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            while let Some(Ok(Message::Text(text))) = ws.next().await {
                let req: Value = serde_json::from_str(&text).unwrap();
                let id = req["id"].as_u64().unwrap();
                if req["method"].as_str() == Some("Runtime.evaluate") {
                    real_evals_clone.fetch_add(1, Ordering::SeqCst);
                }
                let reply = match req["method"].as_str() {
                    Some("Page.ping") => json!({"id": id, "result": {"ok": true}}),
                    _ => json!({"id": id, "result": {}}),
                };
                ws.send(Message::Text(reply.to_string().into())).await.unwrap();
            }
        });

        let http = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let http_port = http.local_addr().unwrap().port();
        let body = json!([
            {"id": "spoof-target", "type": "page", "url": "https://evil.example", "title": "Evil", "webSocketDebuggerUrl": format!("ws://{spoof_addr}/devtools/page/spoof-target")},
            {"id": "real-target", "type": "page", "url": "https://good.example", "title": "Good", "webSocketDebuggerUrl": format!("ws://{real_addr}/devtools/page/real-target")},
        ])
        .to_string();
        let http_task = tokio::spawn(async move {
            let (mut stream, _) = http.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf).await;
            let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            stream.write_all(resp.as_bytes()).await.unwrap();
        });

        let (target, mut conn) = connect_target_id(http_port, "real-target").await.unwrap();
        assert_eq!(target.id, "real-target");
        let pong = conn.call("Page.ping", json!({}), |_, _| {}).await.unwrap();
        assert_eq!(pong["ok"], true);
        assert_eq!(spoof_hits.load(Ordering::SeqCst), 0, "spoof target must never be contacted");
        assert_eq!(real_evals.load(Ordering::SeqCst), 0, "must not evaluate main-world JS");

        drop(conn);
        spoof_task.abort();
        let _ = real_task.await;
        let _ = http_task.await;
    }

    #[test]
    fn diff_new_target_id_identifies_newly_created_page_target() {
        let before: HashSet<String> = ["t1".into(), "t2".into()].into_iter().collect();
        let after = vec![
            PageTarget { id: "t1".into(), kind: "page".into(), url: String::new(), title: String::new(), ws_url: "ws://1".into() },
            PageTarget { id: "t2".into(), kind: "page".into(), url: String::new(), title: String::new(), ws_url: "ws://2".into() },
            PageTarget { id: "t3".into(), kind: "page".into(), url: String::new(), title: String::new(), ws_url: "ws://3".into() },
        ];
        assert_eq!(diff_new_target_id(&before, &after).as_deref(), Some("t3"));
        assert_eq!(diff_new_target_id(&before, &after[..2]), None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn block_on_cdp_uses_existing_tokio_runtime_handle() {
        let value = block_on_cdp(async { Ok::<_, String>(42) }).unwrap();
        assert_eq!(value, 42);
    }
}
