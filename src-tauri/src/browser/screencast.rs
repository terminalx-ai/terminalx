//! Live preview of a page for the browser pane: `Page.startScreencast`
//! frames streamed as Tauri events, with navigation events keeping the
//! page's url and title current while the stream runs.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::watch;

use super::cdp::{find_marked_page, PageConnection};
use super::{BrowserError, BrowserResult, BrowserRuntime, FRAME_EVENT, SCREENCAST_STATE_EVENT};

/// Chromium sends a frame only when the page repaints, so the budget is
/// really a ceiling on frame size rather than a rate.
const MAX_WIDTH: u32 = 1440;
const MAX_HEIGHT: u32 = 1000;
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

#[derive(Default)]
pub struct Screencasts {
    stops: Mutex<HashMap<String, watch::Sender<bool>>>,
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
        self.stops.lock().unwrap_or_else(|e| e.into_inner()).insert(page_id.to_string(), stop_tx);
        let page_id = page_id.to_string();
        let owner = rt.clone();
        tauri::async_runtime::spawn(async move {
            let outcome = stream(&owner, &page_id, port, &mut stop_rx).await;
            owner.screencasts.stops.lock().unwrap_or_else(|e| e.into_inner()).remove(&page_id);
            let payload = match outcome {
                Ok(()) => StatePayload { page_id: page_id.clone(), state: "ended", message: None },
                Err(message) => StatePayload { page_id: page_id.clone(), state: "error", message: Some(message) },
            };
            owner.emit(SCREENCAST_STATE_EVENT, payload);
        });
        Ok(())
    }

    pub fn stop(&self, page_id: &str) {
        if let Some(stop) = self.stops.lock().unwrap_or_else(|e| e.into_inner()).remove(page_id) {
            let _ = stop.send(true);
        }
    }

    pub fn stop_all(&self) {
        let stops: Vec<watch::Sender<bool>> = self.stops.lock().unwrap_or_else(|e| e.into_inner()).drain().map(|(_, s)| s).collect();
        for stop in stops {
            let _ = stop.send(true);
        }
    }
}

async fn stream(rt: &Arc<BrowserRuntime>, page_id: &str, port: u16, stop: &mut watch::Receiver<bool>) -> Result<(), String> {
    let found = find_marked_page(port, page_id).await?;
    let mut connection = PageConnection::connect(&found.ws_url).await?;
    connection.call("Page.enable", json!({}), |_, _| {}).await?;
    connection
        .call(
            "Page.startScreencast",
            json!({"format": "jpeg", "quality": JPEG_QUALITY, "maxWidth": MAX_WIDTH, "maxHeight": MAX_HEIGHT, "everyNthFrame": 1}),
            |_, _| {},
        )
        .await?;
    rt.emit(SCREENCAST_STATE_EVENT, StatePayload { page_id: page_id.to_string(), state: "live", message: None });
    loop {
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    let _ = connection.call("Page.stopScreencast", json!({}), |_, _| {}).await;
                    return Ok(());
                }
            }
            event = connection.next_event() => {
                let Some((method, params)) = event else { return Ok(()) };
                match method.as_str() {
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
                            let _ = connection.call("Page.screencastFrameAck", json!({"sessionId": session}), |_, _| {}).await;
                        }
                    }
                    "Page.frameNavigated" => {
                        let frame = params.get("frame").cloned().unwrap_or(Value::Null);
                        if frame.get("parentId").is_none() {
                            let url = frame.get("url").and_then(Value::as_str).map(String::from);
                            let title = connection.evaluate("document.title").await.ok().and_then(|v| v.as_str().map(String::from));
                            if rt.pages.update_location(page_id, url.as_deref(), title.as_deref()).unwrap_or(false) {
                                rt.announce_pages();
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}
