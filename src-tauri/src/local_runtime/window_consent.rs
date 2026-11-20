//! A runtime that cannot verify this window, and the fresh launch that
//! repairs it (PRO-486).
//!
//! Making a pairing code, Allow and Let back need the window to prove it is
//! the window (`serve_cli::consent`, PRO-369). The runtime trusts one key
//! only: the public key in `TERMINALX_LOCAL_WINDOW_CONSENT_KEY` of its own
//! environment, which only the window that launched it can have set. Nothing
//! pins a key over IPC, since any process of the user can send IPC. A
//! handover execs the newer runtime in the same environment, so a runtime
//! first launched without this window's key keeps none through every update.
//! That happens to one launched by a build before the key existed, one
//! launched while its Keychain write failed, one launched by a build with
//! another bundle identifier (another key), and one whose key was removed
//! from Keychain by hand afterwards. Every guarded command then fails.
//!
//! The repair keeps that property: the window launches a fresh runtime
//! itself, which pins the key it holds (creating it if absent). As an update
//! does by itself (#730), it stops the runtime only when nothing it runs
//! would be cut short (`runtime.stopAllIfIdle`), then attaches the fresh one
//! and sends the command once more. A handover would not do: it keeps the
//! environment. When the runtime has work under way, nothing is stopped: the
//! command fails with [`RestartRequired`], which names the work, and the
//! window offers Restart runtime, which stops it with its work
//! ([`local_runtime_restart_for_window`]). A Keychain the window cannot read
//! is not repaired this way: its message stays as it is.

use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use serde_json::Value;

use super::client::Refused;
use super::desktop::Desktop;
use crate::serve_cli::consent::{self, Refusal, WindowKeyMissing};

/// What a guarded command that cannot be repaired by itself fails with:
/// `runtime_restart_required:<epoch>: <message>`, which a window shows with
/// Restart runtime beside it.
pub(crate) const RESTART_REQUIRED: &str = "runtime_restart_required";

/// Whether `error`, from a guarded command this window sent, says the
/// attached runtime cannot verify this window: this window has no consent key
/// to sign with, the runtime has none pinned (`pairing_unavailable`), or it
/// has another pinned (the window's proof does not verify).
pub(crate) fn unverifiable(error: &anyhow::Error) -> bool {
    if error.downcast_ref::<WindowKeyMissing>().is_some() {
        return true;
    }
    error.downcast_ref::<Refused>().is_some_and(|refused| {
        refused.code == "pairing_unavailable"
            || (refused.code == "person_required" && refused.message.contains(Refusal::NotWindow.says()))
    })
}

/// The runtime `epoch` cannot verify this window, and restarting it would
/// stop `work`, so it was left running.
#[derive(Debug)]
pub struct RestartRequired {
    pub epoch: String,
    /// What would stop, by name.
    pub work: Vec<String>,
}

impl std::fmt::Display for RestartRequired {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            out,
            "{RESTART_REQUIRED}:{}: The TerminalX runtime that is running was not started by this window, so it cannot confirm that you asked. Restart runtime starts a new one that can. ",
            self.epoch
        )?;
        if self.work.is_empty() {
            out.write_str("Restarting stops its agents and terminals")?;
        } else {
            write!(out, "Restarting stops what it runs: {}", self.work.join("; "))?;
        }
        out.write_str(". Each agent picks up its conversation again when its tab next starts.")
    }
}

impl std::error::Error for RestartRequired {}

/// Stop the runtime `stale` that cannot verify this window and attach a
/// fresh one the window launches; see [`relaunch_with`].
pub(crate) type Relaunch = Box<dyn Fn(&Desktop) -> Result<Arc<Desktop>> + Send + Sync>;

static RELAUNCH: OnceLock<Relaunch> = OnceLock::new();

/// Repair every guarded command this process sends with `relaunch`. Only the
/// window's process installs one.
pub(crate) fn install(relaunch: Relaunch) {
    if RELAUNCH.set(relaunch).is_err() {
        log::warn!("the window consent relaunch was installed twice");
    }
}

pub(crate) fn installed() -> Option<&'static Relaunch> {
    RELAUNCH.get()
}

/// A relaunch, as [`guarded`] is given it.
pub(crate) type Relaunching<'a, R> = &'a dyn Fn(&R) -> Result<Arc<R>>;

/// Send guarded `command` with `params` to `runtime` through `send`. When it
/// fails because the runtime cannot verify this window, `relaunch` replaces
/// the runtime with one the window launched, and the command is sent to that
/// one, once. Any other command, or failure, is as `send` answered it.
pub(crate) fn guarded<R>(
    runtime: &R,
    command: &str,
    params: Value,
    send: impl Fn(&R, Value) -> Result<Value>,
    relaunch: Option<Relaunching<'_, R>>,
) -> Result<Value> {
    let sent = send(runtime, params.clone());
    let error = match sent {
        Err(error) if consent::guards(command) && unverifiable(&error) => error,
        sent => return sent,
    };
    let Some(relaunch) = relaunch else { return Err(error) };
    log::warn!("the local runtime cannot verify this window ({error:#}); starting a fresh runtime with the window's consent key");
    let fresh = relaunch(runtime)?;
    match send(&fresh, params) {
        Err(error) if error.downcast_ref::<WindowKeyMissing>().is_some() => Err(anyhow!(
            "TerminalX restarted its runtime but could not save the window consent key in Keychain. Unlock your login Keychain, allow TerminalX access if prompted, then try again."
        )),
        Err(error) if unverifiable(&error) => Err(anyhow!("TerminalX restarted its runtime, but it still cannot verify this window: {error:#}")),
        answered => answered,
    }
}

/// How a relaunch goes, apart from the app: `retire` stops runtime `epoch`
/// (only if nothing it runs would be cut short, unless forced) and waits
/// until it has gone; `work` names what it runs; `attach` waits for the fresh
/// runtime the window launches in its place. A runtime left running because
/// of its work is [`RestartRequired`], with nothing stopped.
pub(crate) fn relaunch_with<R>(
    epoch: &str,
    retire: impl FnOnce() -> Result<()>,
    work: impl FnOnce() -> Vec<String>,
    attach: impl FnOnce() -> Result<Arc<R>>,
) -> Result<Arc<R>> {
    match retire() {
        Ok(()) => attach(),
        // Another runtime took its place meanwhile: that one is attached.
        Err(error) if super::launch::refused(&error, "runtime_restarted") => attach(),
        Err(error) if super::launch::left_running(&error) => {
            log::info!("the local runtime that cannot verify this window was left running: {error:#}");
            Err(RestartRequired { epoch: epoch.to_owned(), work: work() }.into())
        }
        Err(error) => Err(error.context("TerminalX could not restart its runtime so it can verify this window")),
    }
}

/// How long the fresh runtime may take to attach: its binary may be new to
/// this Mac's security checks, as after a handover.
const ATTACH_WITHIN: Duration = Duration::from_secs(60);

/// The app's relaunch, for every guarded command the window sends.
#[cfg(target_os = "macos")]
pub(crate) fn install_for(app: &tauri::AppHandle) {
    let app = app.clone();
    install(Box::new(move |stale| relaunch(&app, stale, false)));
}

/// Replace `stale` with a runtime this window launches, which pins its
/// consent key. `forced`: stop it with whatever it runs, as Restart runtime
/// does; otherwise only if nothing would be cut short.
fn relaunch(app: &tauri::AppHandle, stale: &Desktop, forced: bool) -> Result<Arc<Desktop>> {
    use tauri::{Emitter, Manager};
    let _one = super::ui::RESTART.blocking_lock();
    let state = app.state::<crate::AppState>();
    let epoch = stale.epoch().to_owned();
    if let Some(current) = state.runtime().filter(|runtime| runtime.epoch() != epoch && runtime.attachment().is_ok()) {
        return Ok(current);
    }
    let home = crate::store::root()?;
    let stopping = || stale.stopping();
    relaunch_with(
        &epoch,
        || {
            if forced {
                super::launch::retire(&home, || stale.stop_all(), super::launch::Fallback::Forced)
            } else {
                super::launch::retire(&home, || super::replace::stop_if_idle(stale), super::launch::Fallback::Agreed(&stopping))
            }
        },
        || super::replace::work(stale).unwrap_or_default(),
        || {
            log::info!("stopped the local runtime that could not verify this window; attaching a fresh one");
            *state.runtime_error.lock().unwrap() = "TerminalX is restarting its runtime so it can verify this window.".into();
            state.runtime_health.clear();
            // Nothing more is sent to the runtime that stopped. The
            // supervisor's next attempt, made now, launches a fresh runtime
            // with the window's consent key (`launch::launch`).
            stale.disconnect();
            state.runtime_supervisor.retry_now();
            let _ = app.emit("local_runtime_state", ());
            let deadline = Instant::now() + ATTACH_WITHIN;
            let fresh = loop {
                if let Some(fresh) = state.runtime().filter(|runtime| runtime.epoch() != epoch && runtime.attachment().is_ok()) {
                    break fresh;
                }
                if Instant::now() >= deadline {
                    anyhow::bail!("TerminalX restarted its runtime, but the new one has not attached yet. Try again in a moment.");
                }
                std::thread::sleep(Duration::from_millis(100));
            };
            // The host key the window holds, before the command needs it.
            state.pairing.reconcile_machine(&fresh);
            Ok(fresh)
        },
    )
}

/// Restart runtime, beside a [`RestartRequired`]: stop runtime `epoch` with
/// what it runs and attach a fresh one this window launches, which can verify
/// it. Each agent stopped picks up its conversation again when its tab next
/// starts. A runtime another window or a switch already replaced is left
/// alone.
#[tauri::command]
pub async fn local_runtime_restart_for_window(app: tauri::AppHandle, epoch: String) -> Result<(), String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(stale) = app.state::<crate::AppState>().runtime().filter(|runtime| runtime.epoch() == epoch) else { return Ok(()) };
        relaunch(&app, &stale, true).map(drop).map_err(|error| format!("{error:#}"))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    fn refused(code: &str, message: &str) -> anyhow::Error {
        Refused { code: code.into(), message: message.into() }.into()
    }

    fn not_window() -> anyhow::Error {
        refused("person_required", &format!("Only a person may do this, and {}.", Refusal::NotWindow.says()))
    }

    #[test]
    fn says_which_failures_a_fresh_launch_repairs() {
        // The window holds no key: the Keychain item is absent.
        assert!(unverifiable(&anyhow::Error::new(WindowKeyMissing).context("make a pairing code")));
        // The runtime pinned none: launched before the key, or without it.
        assert!(unverifiable(&refused("pairing_unavailable", Refusal::UnsupportedDesktop.says())));
        // The runtime pinned another key: another build's, or one removed.
        assert!(unverifiable(&not_window()));
        // A Keychain the window cannot read keeps its own message.
        assert!(!unverifiable(&anyhow!("TerminalX couldn’t access the window consent key in Keychain. Unlock your login Keychain, allow TerminalX access if prompted, then try again.")));
        // An agent, or a terminal the runtime runs, is no window to repair.
        assert!(!unverifiable(&refused("person_required", &format!("Only a person may do this, and {}.", Refusal::Descendant.says()))));
        assert!(!unverifiable(&refused("not_enabled", "Machines is off")));
    }

    struct Runtime(&'static str);

    #[test]
    fn a_runtime_that_cannot_verify_the_window_is_relaunched_and_asked_once_more() {
        let sent = RefCell::new(Vec::new());
        let send = |runtime: &Runtime, params: Value| {
            sent.borrow_mut().push((runtime.0, params.clone()));
            match runtime.0 {
                "adopted" => Err(anyhow::Error::new(WindowKeyMissing)),
                _ => Ok(serde_json::json!({ "code": "fresh" })),
            }
        };
        let relaunched = Cell::new(0);
        let relaunch = |stale: &Runtime| {
            assert_eq!(stale.0, "adopted");
            relaunched.set(relaunched.get() + 1);
            Ok(Arc::new(Runtime("fresh")))
        };
        let params = serde_json::json!({ "grantRequestId": "g" });
        let answer = guarded(&Runtime("adopted"), crate::machine_wire::CREATE_CODE, params.clone(), send, Some(&relaunch)).unwrap();
        assert_eq!(answer["code"], "fresh");
        assert_eq!(relaunched.get(), 1);
        assert_eq!(*sent.borrow(), [("adopted", params.clone()), ("fresh", params)], "the same request, to the fresh runtime");
    }

    #[test]
    fn every_guarded_command_is_repaired_and_no_other() {
        for command in consent::GUARDED {
            let relaunched = Cell::new(false);
            let relaunch = |_: &Runtime| {
                relaunched.set(true);
                Ok(Arc::new(Runtime("fresh")))
            };
            let send = |runtime: &Runtime, _| if runtime.0 == "fresh" { Ok(Value::Null) } else { Err(refused("pairing_unavailable", "")) };
            guarded(&Runtime("adopted"), command, serde_json::json!({}), send, Some(&relaunch)).unwrap();
            assert!(relaunched.get(), "{command}");
        }
        let relaunch = |_: &Runtime| -> Result<Arc<Runtime>> { panic!("an unguarded command never restarts the runtime") };
        let send = |_: &Runtime, _| Err(refused("pairing_unavailable", ""));
        assert!(guarded(&Runtime("adopted"), crate::machine_wire::REVOKE, serde_json::json!({}), send, Some(&relaunch)).is_err());
    }

    #[test]
    fn a_denied_keychain_or_another_refusal_restarts_nothing() {
        let relaunch = |_: &Runtime| -> Result<Arc<Runtime>> { panic!("nothing to repair") };
        let denied = |_: &Runtime, _| Err(anyhow!("TerminalX couldn’t access the window consent key in Keychain. Unlock your login Keychain, allow TerminalX access if prompted, then try again."));
        let error = guarded(&Runtime("adopted"), crate::machine_wire::CREATE_CODE, serde_json::json!({}), denied, Some(&relaunch)).unwrap_err();
        assert_eq!(error.to_string(), "TerminalX couldn’t access the window consent key in Keychain. Unlock your login Keychain, allow TerminalX access if prompted, then try again.");
        let agent = |_: &Runtime, _| Err(refused("person_required", Refusal::Descendant.says()));
        assert!(guarded(&Runtime("adopted"), crate::machine_wire::APPROVE, serde_json::json!({}), agent, Some(&relaunch)).is_err());
    }

    #[test]
    fn without_a_relaunch_the_failure_is_as_it_was() {
        let send = |_: &Runtime, _| Err(anyhow::Error::new(WindowKeyMissing));
        let error = guarded(&Runtime("adopted"), crate::machine_wire::CREATE_CODE, serde_json::json!({}), send, None).unwrap_err();
        assert!(error.downcast_ref::<WindowKeyMissing>().is_some());
    }

    #[test]
    fn a_relaunch_that_still_cannot_verify_says_so_and_is_not_repeated() {
        let relaunched = Cell::new(0);
        let relaunch = |_: &Runtime| {
            relaunched.set(relaunched.get() + 1);
            Ok(Arc::new(Runtime("fresh")))
        };
        // The fresh launch could not save the key: its Keychain write failed.
        let send = |_: &Runtime, _| Err(anyhow::Error::new(WindowKeyMissing));
        let error = guarded(&Runtime("adopted"), crate::machine_wire::CREATE_CODE, serde_json::json!({}), send, Some(&relaunch)).unwrap_err();
        assert!(error.to_string().contains("could not save the window consent key in Keychain"), "{error:#}");
        assert_eq!(relaunched.get(), 1);
        let send = |_: &Runtime, _| Err(not_window());
        let error = guarded(&Runtime("adopted"), crate::machine_wire::LET_BACK, serde_json::json!({}), send, Some(&relaunch)).unwrap_err();
        assert!(error.to_string().contains("still cannot verify this window"), "{error:#}");
        assert_eq!(relaunched.get(), 2);
    }

    #[test]
    fn a_busy_runtime_is_left_running_and_the_error_names_its_work() {
        let attached = Cell::new(false);
        let busy = || -> Result<()> {
            let refusal = anyhow::Error::from(Refused { code: "runtime_busy".into(), message: "It is running work.".into() });
            Err(refusal.context(super::super::launch::LeftRunning("The TerminalX runtime has work under way; nothing was stopped.")))
        };
        let error = relaunch_with::<Runtime>("epoch-1", busy, || vec!["Claude in api".into(), "a terminal in web".into()], || {
            attached.set(true);
            Ok(Arc::new(Runtime("fresh")))
        })
        .err()
        .unwrap();
        assert!(!attached.get(), "nothing was stopped, so nothing new is attached");
        let required = error.downcast_ref::<RestartRequired>().expect("restart required");
        assert_eq!(required.epoch, "epoch-1");
        let text = error.to_string();
        assert!(text.starts_with("runtime_restart_required:epoch-1: "), "{text}");
        assert!(text.contains("Restart runtime"), "names the control: {text}");
        assert!(text.contains("Claude in api; a terminal in web"), "{text}");
        assert!(text.contains("picks up its conversation again"), "says what happens to sessions: {text}");
    }

    #[test]
    fn an_idle_runtime_is_stopped_then_the_fresh_one_attached() {
        let order = RefCell::new(Vec::new());
        let fresh = relaunch_with(
            "epoch-1",
            || {
                order.borrow_mut().push("retire");
                Ok(())
            },
            || panic!("an idle runtime's work is not read"),
            || {
                order.borrow_mut().push("attach");
                Ok(Arc::new(Runtime("fresh")))
            },
        )
        .unwrap();
        assert_eq!(fresh.0, "fresh");
        assert_eq!(*order.borrow(), ["retire", "attach"]);
        // Replaced by another window meanwhile: that runtime is attached.
        let replaced = || -> Result<()> {
            let refusal = anyhow::Error::from(Refused { code: "runtime_restarted".into(), message: "Another runtime was attached meanwhile.".into() });
            Err(refusal.context(super::super::launch::LeftRunning("replaced")))
        };
        assert_eq!(relaunch_with("epoch-1", replaced, Vec::new, || Ok(Arc::new(Runtime("other")))).unwrap().0, "other");
        // A failure that may have stopped something is no restart prompt.
        let failed = relaunch_with::<Runtime>("epoch-1", || anyhow::bail!("did not exit"), Vec::new, || panic!("not attached")).err().unwrap();
        assert!(failed.downcast_ref::<RestartRequired>().is_none());
    }
}
