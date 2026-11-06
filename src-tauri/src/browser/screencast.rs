//! Live preview of a page for the browser pane: `Page.startScreencast`
//! frames streamed as Tauri events, with navigation events keeping the
//! page's url and title current while the stream runs.
//!
//! The preview is also driven: the reader's clicks, scrolls and keys reach
//! the page as `Input.*` commands over the same DevTools connection, so the
//! reader and the agent work in the one page. The view also sets the page's
//! viewport to its own size, so the page lays out for the space it is shown
//! in and the frames come at that size, crisp, as a page in the app would. Events that arrive while a
//! command waits for its reply are kept and handled after it: a frame left
//! unacknowledged would stop the stream.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};

use super::cdp::{find_marked_page, PageConnection};
use super::{BrowserError, BrowserResult, BrowserRuntime, FRAME_EVENT, SCREENCAST_STATE_EVENT};

/// Chromium sends a frame only when the page repaints, so the budget is
/// really a ceiling on frame size rather than a rate.
/// The page is laid out at the view's size and device pixel ratio, so a frame
/// is as large as the view in device pixels, up to this.
const MAX_WIDTH: u32 = 2048;
const MAX_HEIGHT: u32 = 2048;
const JPEG_QUALITY: u32 = 60;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FramePayload {
    pub page_id: String,
    /// Base64 JPEG.
    pub data: String,
    pub width: u64,
    pub height: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatePayload {
    pub page_id: String,
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// The DevTools commands a browser view may send to its page: the reader's
/// input, and the viewport the view shows it at.
pub const VIEW_METHODS: [&str; 4] = ["Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText", "Emulation.setDeviceMetricsOverride"];

type InputBatch = Vec<(String, Value)>;

#[derive(Default)]
pub struct Screencasts {
    /// Each live page's stream, by the generation that started it: a stream
    /// still winding down after a stop must not clear the entries of the one
    /// started after it, nor announce that the page's stream ended.
    stops: Mutex<HashMap<String, (u64, watch::Sender<bool>)>>,
    /// The reader's input for each live page, handed to its stream.
    inputs: Mutex<HashMap<String, (u64, mpsc::UnboundedSender<InputBatch>)>>,
    generations: AtomicU64,
    /// Frames delivered per page, for diagnostics and the live test.
    frames: Mutex<HashMap<String, u64>>,
}

impl Screencasts {
    pub fn is_live(&self, page_id: &str) -> bool {
        self.stops.lock().unwrap_or_else(|e| e.into_inner()).contains_key(page_id)
    }

    pub fn frame_count(&self, page_id: &str) -> u64 {
        self.frames.lock().unwrap_or_else(|e| e.into_inner()).get(page_id).copied().unwrap_or(0)
    }

    /// Send a view's input to a live page, in order. Only `VIEW_METHODS`
    /// pass; the page must be streaming (the reader is looking at it).
    pub fn input(&self, page_id: &str, events: Vec<(String, Value)>) -> BrowserResult<()> {
        if let Some((method, _)) = events.iter().find(|(method, _)| !VIEW_METHODS.contains(&method.as_str())) {
            return Err(BrowserError::new("browser_input_refused", format!("{method} is not a browser view command.")));
        }
        let sender = self.inputs.lock().unwrap_or_else(|e| e.into_inner()).get(page_id).map(|(_, sender)| sender.clone());
        let sender = sender.ok_or_else(|| BrowserError::new("browser_preview_not_live", "The page's preview is not live."))?;
        sender.send(events).map_err(|_| BrowserError::new("browser_preview_not_live", "The page's preview has ended."))
    }

    fn count_frame(&self, page_id: &str) {
        *self.frames.lock().unwrap_or_else(|e| e.into_inner()).entry(page_id.to_string()).or_insert(0) += 1;
    }

    /// Start streaming a page. Target discovery happens up front so a page
    /// that cannot be found fails the call rather than a background task.
    pub fn start(&self, rt: Arc<BrowserRuntime>, page_id: &str) -> BrowserResult<()> {
        if self.is_live(page_id) {
            return Ok(());
        }
        let page = rt.pages.get(page_id).ok_or_else(|| BrowserError::new("browser_tab_not_found", format!("No browser page {page_id}.")))?;
        let target = rt.target(page)?;
        let port = super::cdp::cdp_port(&rt, &target)?;
        super::cdp::mark_page(&rt, &target)?;
        let (stop_tx, mut stop_rx) = watch::channel(false);
        let (input_tx, mut input_rx) = mpsc::unbounded_channel();
        let generation = self.generations.fetch_add(1, Ordering::Relaxed) + 1;
        self.stops.lock().unwrap_or_else(|e| e.into_inner()).insert(page_id.to_string(), (generation, stop_tx));
        self.inputs.lock().unwrap_or_else(|e| e.into_inner()).insert(page_id.to_string(), (generation, input_tx));
        let page_id = page_id.to_string();
        let owner = rt.clone();
        tauri::async_runtime::spawn(async move {
            let outcome = stream(&owner, &page_id, port, &mut stop_rx, &mut input_rx).await;
            if !owner.screencasts.retire(&page_id, generation) {
                // A newer stream has the page now; its state is the page's.
                return;
            }
            let payload = match outcome {
                Ok(()) => StatePayload { page_id: page_id.clone(), state: "ended", message: None },
                Err(message) => StatePayload { page_id: page_id.clone(), state: "error", message: Some(message) },
            };
            owner.emit(SCREENCAST_STATE_EVENT, payload);
        });
        Ok(())
    }

    pub fn stop(&self, page_id: &str) {
        if let Some((_, stop)) = self.stops.lock().unwrap_or_else(|e| e.into_inner()).remove(page_id) {
            let _ = stop.send(true);
        }
    }

    /// A stream's own clean-up: clears what it holds, unless a newer stream
    /// holds the page. Says whether the page is still this stream's to report on.
    fn retire(&self, page_id: &str, generation: u64) -> bool {
        let mut stops = self.stops.lock().unwrap_or_else(|e| e.into_inner());
        let mut inputs = self.inputs.lock().unwrap_or_else(|e| e.into_inner());
        if stops.get(page_id).is_some_and(|(owner, _)| *owner != generation) {
            if inputs.get(page_id).is_some_and(|(owner, _)| *owner == generation) {
                inputs.remove(page_id);
            }
            return false;
        }
        stops.remove(page_id);
        if inputs.get(page_id).is_some_and(|(owner, _)| *owner == generation) {
            inputs.remove(page_id);
        }
        true
    }

    pub fn stop_all(&self) {
        let stops: Vec<watch::Sender<bool>> = self.stops.lock().unwrap_or_else(|e| e.into_inner()).drain().map(|(_, (_, s))| s).collect();
        for stop in stops {
            let _ = stop.send(true);
        }
    }
}

async fn stream(rt: &Arc<BrowserRuntime>, page_id: &str, port: u16, stop: &mut watch::Receiver<bool>, inputs: &mut mpsc::UnboundedReceiver<InputBatch>) -> Result<(), String> {
    let found = find_marked_page(port, page_id).await?;
    let mut connection = PageConnection::connect(&found.ws_url).await?;
    // Events seen while one of our own commands waited for its reply.
    let mut backlog: VecDeque<(String, Value)> = VecDeque::new();
    call_keeping(&mut connection, "Page.enable", json!({}), &mut backlog).await?;
    // The Chromium window is usually behind the app: let the page act focused
    // (caret, :focus, key events) while the reader types into the preview.
    let _ = call_keeping(&mut connection, "Emulation.setFocusEmulationEnabled", json!({"enabled": true}), &mut backlog).await;
    call_keeping(
        &mut connection,
        "Page.startScreencast",
        json!({"format": "jpeg", "quality": JPEG_QUALITY, "maxWidth": MAX_WIDTH, "maxHeight": MAX_HEIGHT, "everyNthFrame": 1}),
        &mut backlog,
    )
    .await?;
    rt.emit(SCREENCAST_STATE_EVENT, StatePayload { page_id: page_id.to_string(), state: "live", message: None });
    loop {
        if let Some((method, params)) = backlog.pop_front() {
            handle_event(rt, page_id, &mut connection, &method, params, &mut backlog).await;
            continue;
        }
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    let _ = connection.call("Page.stopScreencast", json!({}), |_, _| {}).await;
                    return Ok(());
                }
            }
            Some(batch) = inputs.recv() => {
                for (method, params) in batch {
                    // A refused event (a key the page rejects) must not end the preview.
                    let _ = call_keeping(&mut connection, &method, params, &mut backlog).await;
                }
            }
            event = connection.next_event() => {
                let Some((method, params)) = event else { return Ok(()) };
                handle_event(rt, page_id, &mut connection, &method, params, &mut backlog).await;
            }
        }
    }
}

/// `call`, keeping the events that arrive before its reply.
async fn call_keeping(connection: &mut PageConnection, method: &str, params: Value, backlog: &mut VecDeque<(String, Value)>) -> Result<Value, String> {
    let mut seen = Vec::new();
    let result = connection.call(method, params, |name, params| seen.push((name.to_string(), params.clone()))).await;
    backlog.extend(seen);
    result
}

async fn handle_event(rt: &Arc<BrowserRuntime>, page_id: &str, connection: &mut PageConnection, method: &str, params: Value, backlog: &mut VecDeque<(String, Value)>) {
    match method {
        "Page.screencastFrame" => {
            if let Some(session) = params.get("sessionId").cloned() {
                let metadata = params.get("metadata").cloned().unwrap_or(Value::Null);
                rt.screencasts.count_frame(page_id);
                rt.emit(FRAME_EVENT, FramePayload {
                    page_id: page_id.to_string(),
                    data: params.get("data").and_then(Value::as_str).unwrap_or("").to_string(),
                    width: metadata.get("deviceWidth").and_then(Value::as_u64).unwrap_or(0),
                    height: metadata.get("deviceHeight").and_then(Value::as_u64).unwrap_or(0),
                });
                let _ = call_keeping(connection, "Page.screencastFrameAck", json!({"sessionId": session}), backlog).await;
            }
        }
        "Page.frameNavigated" => {
            let frame = params.get("frame").cloned().unwrap_or(Value::Null);
            if frame.get("parentId").is_none() {
                let url = frame.get("url").and_then(Value::as_str).map(String::from);
                let title = call_keeping(connection, "Runtime.evaluate", json!({"expression": "document.title", "returnByValue": true}), backlog)
                    .await
                    .ok()
                    .and_then(|r| r.get("result").and_then(|r| r.get("value")).and_then(Value::as_str).map(String::from));
                if rt.pages.update_location(page_id, url.as_deref(), title.as_deref()).unwrap_or(false) {
                    rt.announce_pages();
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hold(casts: &Screencasts, page: &str) -> u64 {
        let generation = casts.generations.fetch_add(1, Ordering::Relaxed) + 1;
        let (stop, _) = watch::channel(false);
        let (input, _) = mpsc::unbounded_channel();
        casts.stops.lock().unwrap().insert(page.into(), (generation, stop));
        casts.inputs.lock().unwrap().insert(page.into(), (generation, input));
        generation
    }

    #[test]
    fn a_stream_winding_down_leaves_the_one_started_after_it_alone() {
        let casts = Screencasts::default();
        let old = hold(&casts, "bp-1");
        casts.stop("bp-1");
        let new = hold(&casts, "bp-1");
        // The old stream finishes after the new one started: nothing of the new one is cleared, and it does not report.
        assert!(!casts.retire("bp-1", old));
        assert!(casts.is_live("bp-1"));
        assert_eq!(casts.inputs.lock().unwrap().get("bp-1").map(|(g, _)| *g), Some(new));
        // The new stream, stopped in turn, clears its own and reports.
        casts.stop("bp-1");
        assert!(casts.retire("bp-1", new));
        assert!(!casts.is_live("bp-1"));
        assert!(casts.inputs.lock().unwrap().get("bp-1").is_none());
    }
}
