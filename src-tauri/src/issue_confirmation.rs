//! Issue writes wait here for an explicit human decision. Pending requests never
//! focus a window. Keep expiry, backoff and the computer-use guard in native code.
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tauri::Emitter;
use crate::cloud_control::{self, Answer, Confirming, QUESTION_TTL};
use crate::issue_control::Question;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    id: String,
    question: Question,
    expires_at: u64,
}
struct Pending {
    request: Request,
    deadline: Instant,
    answer: Option<tokio::sync::oneshot::Sender<bool>>,
}
fn pending() -> &'static Mutex<Option<Pending>> {
    static PENDING: OnceLock<Mutex<Option<Pending>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(None))
}

#[tauri::command]
pub fn issue_confirmation_pending(window: tauri::WebviewWindow) -> Option<Request> {
    if window.label() != "main" { return None; }
    pending().lock().unwrap().as_ref().filter(|p| Instant::now() < p.deadline && p.answer.is_some()).map(|p| p.request.clone())
}

#[tauri::command]
pub fn issue_confirmation_reply(window: tauri::WebviewWindow, id: String, approved: bool) -> bool {
    if window.label() != "main" { return false; }
    let mut slot = pending().lock().unwrap();
    let Some(p) = slot.as_mut().filter(|p| p.request.id == id && Instant::now() < p.deadline) else { return false; };
    p.answer.take().is_some_and(|answer| answer.send(approved).is_ok())
}

pub async fn ask(app: tauri::AppHandle, question: Question) -> Answer {
    if let Err(answer) = cloud_control::question_begin(Instant::now()) { return answer; }
    let _guard = Confirming::begin();
    let (send, receive) = tokio::sync::oneshot::channel();
    let deadline = Instant::now() + QUESTION_TTL;
    let expires_at = (std::time::SystemTime::now() + QUESTION_TTL).duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    *pending().lock().unwrap() = Some(Pending {
        request: Request { id: uuid::Uuid::now_v7().to_string(), question, expires_at },
        deadline,
        answer: Some(send),
    });
    let _ = app.emit_to("main", "issue-confirmation-changed", ());
    let decision = tokio::time::timeout(QUESTION_TTL, receive).await;
    // Remove the request before releasing the shared question gate. Late replies
    // and replies to a previous request can never approve a subsequent write.
    *pending().lock().unwrap() = None;
    let _ = app.emit_to("main", "issue-confirmation-changed", ());
    match decision {
        Ok(Ok(agreed)) => cloud_control::question_answered(agreed, Instant::now()),
        Ok(Err(_)) => cloud_control::question_answered(false, Instant::now()),
        Err(_) => {
            let answer = cloud_control::question_expired(Instant::now());
            cloud_control::question_closed();
            answer
        }
    }
}
