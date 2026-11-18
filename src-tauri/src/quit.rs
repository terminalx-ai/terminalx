//! Asking before the app goes while something must not be cut short.
//!
//! The web view says when such work is under way (a worktree clean-up) and
//! when it is over. While it is, closing the main window or quitting asks
//! first. Agreeing quits; anything else leaves the app as it was.
//!
//! Only a quit this process is asked about can be held back: the Quit menu
//! item and Cmd+Q, the tray's Quit, and the main window's close button.
//! Quitting from the Dock, logging out or shutting down ends the process
//! without asking it. A restart for an update is not held back either.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use crate::store::settings::{self, QuitBehavior};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

/// The app menu's own Quit item, see [`own_quit_item`].
pub const MENU_ID: &str = "app-quit";
pub const STOP_ALL_MENU_ID: &str = "app-stop-all-and-quit";
const KEEP_WORK: &str = "Quit and Keep Running";
const STOP_WORK: &str = "Quit and Stop All";
const CANCEL: &str = "Cancel";
static EXIT_READY: AtomicBool = AtomicBool::new(false);
static EXPLICIT_STOP: AtomicBool = AtomicBool::new(false);

const QUIT: &str = "Quit Anyway";
const STAY: &str = "Keep Running";
const PROMPT_DELIVERY_TIMEOUT: Duration = Duration::from_secs(2);
const PROMPT_REPLY_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Serialize)]
struct Question {
    title: String,
    body: String,
    action: &'static str,
    cancel: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    alternative: Option<&'static str>,
    destructive: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PromptReply {
    Opened,
    Heartbeat,
    Action,
    Alternative,
    Cancel,
}

struct PendingPrompt {
    id: String,
    opened: bool,
    replies: mpsc::Sender<PromptReply>,
}

#[derive(Default)]
struct PromptChannel {
    pending: Mutex<Option<PendingPrompt>>,
}

static PROMPT: PromptChannel = PromptChannel { pending: Mutex::new(None) };

impl PromptChannel {
    fn reply(&self, window: &str, id: &str, reply: PromptReply) -> bool {
        if window != "main" {
            return false;
        }
        let mut pending = self.pending.lock().unwrap();
        let Some(prompt) = pending.as_mut().filter(|prompt| prompt.id == id) else {
            return false;
        };
        match reply {
            PromptReply::Opened if !prompt.opened => {
                prompt.opened = true;
                prompt.replies.send(reply).is_ok()
            }
            PromptReply::Opened => false,
            _ if !prompt.opened => false,
            PromptReply::Heartbeat => prompt.replies.send(reply).is_ok(),
            _ => pending.take().unwrap().replies.send(reply).is_ok(),
        }
    }

    fn receive(
        &self,
        replies: &mpsc::Receiver<PromptReply>,
        timeout: Duration,
    ) -> Option<PromptReply> {
        match replies.recv_timeout(timeout) {
            Ok(reply) => Some(reply),
            Err(mpsc::RecvTimeoutError::Disconnected) => None,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // The wait and the IPC handler agree on who won at the deadline.
                let mut pending = self.pending.lock().unwrap();
                match replies.try_recv() {
                    Ok(reply) => Some(reply),
                    Err(_) => {
                        pending.take();
                        None
                    }
                }
            }
        }
    }

    // The quit guard permits one call at a time. A responsive card renews
    // the wait while the person decides. Once they choose, the wait expires
    // unless their answer reaches Rust.
    fn ask(
        &self,
        delivery_timeout: Duration,
        reply_timeout: Duration,
        deliver: impl FnOnce(&str) -> bool,
        focus: impl FnOnce(),
        withdraw: impl FnOnce(&str),
    ) -> Option<PromptReply> {
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, replies) = mpsc::channel();
        *self.pending.lock().unwrap() = Some(PendingPrompt {
            id: id.clone(),
            opened: false,
            replies: sender,
        });
        if deliver(&id) && self.receive(&replies, delivery_timeout) == Some(PromptReply::Opened) {
            focus();
            while let Some(reply) = self.receive(&replies, reply_timeout) {
                if reply != PromptReply::Heartbeat {
                    return Some(reply);
                }
            }
        }
        self.clear();
        withdraw(&id);
        None
    }

    fn clear(&self) {
        self.pending.lock().unwrap().take();
    }

    fn is_open(&self) -> bool {
        self.pending.lock().unwrap().as_ref().is_some_and(|prompt| prompt.opened)
    }
}

/// Only the main web view can claim a quit card and answer for its ID.
#[tauri::command]
pub fn reply_to_quit_prompt(window: WebviewWindow, id: String, reply: PromptReply) -> bool {
    PROMPT.reply(window.label(), &id, reply)
}

/// A navigation or destruction invalidates the old card and wakes the quit worker.
pub fn main_view_lost() {
    PROMPT.clear();
}

impl Question {
    fn ask(self, app: &AppHandle) -> PromptReply {
        self.ask_with(|| self.ask_in_app(app), || self.ask_native(app))
    }

    fn ask_with(
        &self,
        in_app: impl FnOnce() -> Option<PromptReply>,
        native: impl FnOnce() -> MessageDialogResult,
    ) -> PromptReply {
        in_app().unwrap_or_else(|| self.native_reply(native()))
    }

    fn ask_native(&self, app: &AppHandle) -> MessageDialogResult {
        let dialog = app.dialog().message(&self.body).title(&self.title);
        let dialog = if self.destructive { dialog.kind(MessageDialogKind::Warning) } else { dialog };
        let buttons = if let Some(alternative) = self.alternative {
            MessageDialogButtons::YesNoCancelCustom(self.action.into(), alternative.into(), self.cancel.into())
        } else {
            MessageDialogButtons::OkCancelCustom(self.action.into(), self.cancel.into())
        };
        dialog.buttons(buttons).blocking_show_with_result()
    }

    fn ask_in_app(&self, app: &AppHandle) -> Option<PromptReply> {
        let window = app.get_webview_window("main")?;
        if !window.is_visible().ok()? || window.is_minimized().ok()? {
            return None;
        }
        let target = tauri::EventTarget::webview_window("main");
        PROMPT.ask(
            PROMPT_DELIVERY_TIMEOUT,
            PROMPT_REPLY_TIMEOUT,
            |id| match app.emit_to(target.clone(), "quit-prompt", (id, Some(self))) {
                Ok(()) => true,
                Err(error) => {
                    log::warn!("Could not deliver the in-app quit prompt: {error}");
                    false
                }
            },
            || { let _ = window.set_focus(); },
            |id| {
                let _ = app.emit_to(target.clone(), "quit-prompt", (id, None::<&Question>));
            },
        )
    }

    fn native_reply(&self, pressed: MessageDialogResult) -> PromptReply {
        match pressed {
            MessageDialogResult::Custom(label) if label == self.action => PromptReply::Action,
            MessageDialogResult::Custom(label) if self.alternative == Some(label.as_str()) => PromptReply::Alternative,
            _ => PromptReply::Cancel,
        }
    }
}

fn guarded_question(title: String, body: String) -> Question {
    Question { title, body, action: QUIT, cancel: STAY, alternative: None, destructive: true }
}

fn runtime_question() -> Question {
    Question {
        title: "Keep work running?".into(),
        body: "Agents and terminal commands can keep working after TerminalX quits. Choose what quitting should do. You can change this in Settings.".into(),
        action: KEEP_WORK,
        alternative: Some(STOP_WORK),
        cancel: CANCEL,
        destructive: false,
    }
}

/// What quitting now would cut short.
#[derive(Default)]
pub struct QuitGuard {
    /// In words for the person. `None`: nothing is under way.
    warning: Mutex<Option<String>>,
    /// The question is on screen.
    asking: AtomicBool,
    /// They said to quit anyway.
    agreed: AtomicBool,
}

static GUARD: QuitGuard = QuitGuard { warning: Mutex::new(None), asking: AtomicBool::new(false), agreed: AtomicBool::new(false) };

impl QuitGuard {
    /// Say what is under way, or with `None` that it is over.
    pub fn set(&self, warning: Option<String>) {
        *self.warning.lock().unwrap() = warning.filter(|warning| !warning.trim().is_empty());
        // An answer was about the work that was under way then.
        self.agreed.store(false, Ordering::SeqCst);
    }

    /// What to ask before quitting now. `None` when nothing is under way, or
    /// they already said to quit.
    fn pending(&self) -> Option<String> {
        if self.agreed.load(Ordering::SeqCst) {
            return None;
        }
        self.warning.lock().unwrap().clone()
    }
}

/// The web view names the work that quitting would cut short, or clears it.
#[tauri::command]
pub fn set_quit_warning(warning: Option<String>) {
    GUARD.set(warning);
}

/// Whether a quit, or a close of the main window, is held back for now. When
/// it is, the person is asked, once however often they try, and agreeing
/// quits.
pub fn held(app: &AppHandle) -> bool {
    if EXIT_READY.load(Ordering::SeqCst) { return false; }
    if GUARD.asking.load(Ordering::SeqCst) {
        // A tray or menu retry can bring back a card the person hid or minimized.
        if PROMPT.is_open() {
            if let Some(window) = app.get_webview_window("main") {
                if window.is_minimized().unwrap_or(false) {
                    let _ = window.unminimize();
                }
                if !window.is_visible().unwrap_or(false) {
                    let _ = window.show();
                }
                let _ = window.set_focus();
            }
        }
        return true;
    }
    let runtime = app.try_state::<crate::AppState>().and_then(|state| state.runtime());
    let warning = GUARD.pending();
    if runtime.is_none() && warning.is_none() && !requires_stop(EXPLICIT_STOP.load(Ordering::SeqCst), settings::load().quit_behavior) { return false; }
    if GUARD.asking.swap(true, Ordering::SeqCst) { return true; }
    let stop_all = EXPLICIT_STOP.swap(false, Ordering::SeqCst);
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(warning) = warning {
            let question = guarded_question(format!("Quit {}?", app.package_info().name), warning);
            if question.ask(&app) != PromptReply::Action {
                GUARD.asking.store(false, Ordering::SeqCst);
                return;
            }
        }
        let result = (|| -> anyhow::Result<bool> {
            if let Some(runtime) = runtime {
                let saved = settings::load().quit_behavior;
                let policy = if stop_all { QuitBehavior::StopAll } else if let Some(saved) = saved { saved } else {
                    let Some(chosen) = choice(runtime_question().ask(&app)) else { return Ok(false) };
                    // Read again after the dialog, preserving changes made while it was open.
                    let mut settings = settings::load();
                    settings.quit_behavior = Some(chosen);
                    settings::save(&settings)?;
                    chosen
                };
                if policy == QuitBehavior::StopAll {
                    // Never reconnect to, or start again, the runtime being stopped.
                    let state = app.state::<crate::AppState>();
                    state.runtime_supervisor.halt();
                    // Authenticated, pinned to the owner generation. An unavailable
                    // owner must not be presented as a successful stop-all.
                    if let Err(error) = runtime.stop_all() {
                        state.runtime_supervisor.resume(state.runtime().as_deref());
                        return Err(error);
                    }
                }
            } else if requires_stop(stop_all, settings::load().quit_behavior) {
                anyhow::bail!("The background runtime is unavailable, so stopping agents and terminals could not be confirmed. Try Stop All again once TerminalX has reconnected.");
            }
            Ok(true)
        })();
        match result {
            Ok(true) => {
                EXIT_READY.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            Ok(false) => {}
            Err(error) => {
                app.dialog().message(format!("TerminalX did not quit: {error:#}"))
                    .title("Could not finish quitting")
                    .kind(MessageDialogKind::Error).blocking_show();
            }
        }
        GUARD.asking.store(false, Ordering::SeqCst);
    });
    true
}

/// Explicit stop-all never changes the saved normal-quit preference. The
/// cleanup guard still runs before any stop request reaches the runtime.
pub fn stop_all_and_quit(app: &AppHandle) {
    if GUARD.asking.load(Ordering::SeqCst) { return; }
    EXPLICIT_STOP.store(true, Ordering::SeqCst);
    app.exit(0);
}

fn choice(reply: PromptReply) -> Option<QuitBehavior> {
    match reply {
        PromptReply::Action => Some(QuitBehavior::KeepRunning),
        PromptReply::Alternative => Some(QuitBehavior::StopAll),
        PromptReply::Opened | PromptReply::Heartbeat | PromptReply::Cancel => None,
    }
}

fn requires_stop(explicit: bool, saved: Option<QuitBehavior>) -> bool {
    explicit || saved == Some(QuitBehavior::StopAll)
}

/// Put a Quit item this app answers in place of the system's, which on macOS
/// ends the process without asking it anything. The menu is left as it is
/// when it is not laid out as expected, and quitting then works as before.
#[cfg(target_os = "macos")]
pub fn own_quit_item<R: tauri::Runtime>(app: &AppHandle<R>, menu: &tauri::menu::Menu<R>) -> tauri::Result<()> {
    use tauri::menu::{MenuItemBuilder, MenuItemKind};
    let Some(MenuItemKind::Submenu(application)) = menu.items()?.into_iter().next() else { return Ok(()) };
    let Some(MenuItemKind::Predefined(system)) = application.items()?.into_iter().last() else { return Ok(()) };
    if !system.text()?.contains("Quit") {
        return Ok(());
    }
    let own = MenuItemBuilder::with_id(MENU_ID, format!("Quit {}", app.package_info().name)).accelerator("CmdOrCtrl+Q").build(app)?;
    application.remove(&system)?;
    let stop_all = MenuItemBuilder::with_id(STOP_ALL_MENU_ID, "Stop all and quit").build(app)?;
    application.append(&stop_all)?;
    application.append(&own)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_card_claims_and_answers_for_its_own_id() {
        let channel = PromptChannel::default();
        let question = runtime_question();
        let answer = question.ask_with(
            || channel.ask(
                Duration::ZERO,
                Duration::ZERO,
                |id| {
                    assert!(!channel.reply("chat-1", id, PromptReply::Opened));
                    assert!(!channel.reply("main", id, PromptReply::Action));
                    assert!(channel.reply("main", id, PromptReply::Opened));
                    assert!(!channel.reply("main", id, PromptReply::Opened));
                    assert!(!channel.reply("main", "a different ID", PromptReply::Cancel));
                    assert!(channel.reply("main", id, PromptReply::Heartbeat));
                    assert!(channel.reply("main", id, PromptReply::Alternative));
                    assert!(!channel.reply("main", id, PromptReply::Action));
                    true
                },
                || {},
                |_| panic!("an answered card must not be withdrawn"),
            ),
            || panic!("an answered card must not open a native alert"),
        );
        assert_eq!(choice(answer), Some(QuitBehavior::StopAll));
        assert!(!channel.is_open());
    }

    #[test]
    fn a_missing_claim_or_lost_answer_withdraws_the_card_before_native_fallback() {
        use std::cell::Cell;

        let channel = PromptChannel::default();
        let question = runtime_question();
        for claimed in [false, true] {
            let withdrawn = Cell::new(false);
            let native_shown = Cell::new(false);
            let answer = question.ask_with(
                || channel.ask(
                    Duration::ZERO,
                    Duration::ZERO,
                    |id| {
                        if claimed {
                            assert!(channel.reply("main", id, PromptReply::Opened));
                            assert!(channel.reply("main", id, PromptReply::Heartbeat));
                        }
                        true
                    },
                    || assert!(claimed),
                    |id| {
                        assert!(!channel.reply("main", id, PromptReply::Opened));
                        assert!(!channel.reply("main", id, PromptReply::Action));
                        withdrawn.set(true);
                    },
                ),
                || {
                    assert!(withdrawn.get());
                    assert!(!native_shown.replace(true));
                    MessageDialogResult::Cancel
                },
            );
            assert!(native_shown.get());
            assert_eq!(answer, PromptReply::Cancel);
            assert!(!channel.is_open());
        }
    }

    #[test]
    fn a_quit_is_asked_about_only_while_something_is_under_way() {
        let guard = QuitGuard::default();
        assert_eq!(guard.pending(), None);
        guard.set(Some("A worktree clean-up is still running.".into()));
        assert_eq!(guard.pending().as_deref(), Some("A worktree clean-up is still running."));
        // Once they agreed, the quit that follows is not asked about again.
        guard.agreed.store(true, Ordering::SeqCst);
        assert_eq!(guard.pending(), None);
        // That answer does not cover the next piece of work.
        guard.set(Some("Another one is running.".into()));
        assert!(guard.pending().is_some());
        guard.set(None);
        assert_eq!(guard.pending(), None);
        guard.set(Some("  ".into()));
        assert_eq!(guard.pending(), None, "nothing to say is nothing under way");
    }

    #[test]
    fn an_unavailable_owner_cannot_satisfy_an_explicit_or_saved_stop() {
        for saved in [None, Some(QuitBehavior::KeepRunning), Some(QuitBehavior::StopAll)] {
            assert!(requires_stop(true, saved));
        }
        assert!(requires_stop(false, Some(QuitBehavior::StopAll)));
        assert!(!requires_stop(false, Some(QuitBehavior::KeepRunning)));
        assert!(!requires_stop(false, None));
    }

    #[test]
    fn dismissing_the_first_choice_never_stops_or_saves_a_preference() {
        let question = runtime_question();
        assert_eq!(choice(question.native_reply(MessageDialogResult::Custom(KEEP_WORK.into()))), Some(QuitBehavior::KeepRunning));
        assert_eq!(choice(question.native_reply(MessageDialogResult::Custom(STOP_WORK.into()))), Some(QuitBehavior::StopAll));
        for result in [MessageDialogResult::Cancel, MessageDialogResult::No, MessageDialogResult::Yes,
            MessageDialogResult::Ok, MessageDialogResult::Custom(CANCEL.into()), MessageDialogResult::Custom("unknown".into())] {
            assert_eq!(choice(question.native_reply(result)), None);
        }
    }

    #[test]
    fn only_the_explicit_button_quits() {
        let question = guarded_question("Quit TerminalX?".into(), "A worktree clean-up is still running.".into());
        assert_eq!(question.native_reply(MessageDialogResult::Custom(QUIT.into())), PromptReply::Action);
        // Escape and the close box come back as the other button.
        for other in [MessageDialogResult::Custom(STAY.into()), MessageDialogResult::Cancel, MessageDialogResult::No, MessageDialogResult::Ok, MessageDialogResult::Yes] {
            assert_eq!(question.native_reply(other), PromptReply::Cancel);
        }
    }
}
