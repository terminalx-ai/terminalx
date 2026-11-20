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
//! itself, which pins the key it holds. It first makes sure Keychain gives it
//! that key (creating it if absent): a fresh launch without it would pin
//! none, so a Keychain that refuses stops nothing and keeps its own message.
//! As an update does by itself (#730), it stops the runtime only when nothing
//! it runs would be cut short (`runtime.stopAllIfIdle`) and no computer or
//! phone is connected to it or waiting for Allow, then attaches the fresh one
//! and sends the command once more. A handover would not do: it keeps the
//! environment. Otherwise nothing is stopped: the command fails with
//! [`RestartRequired`], which names what would stop, and Settings → Machines
//! offers Restart runtime for that runtime alone
//! ([`local_runtime_restart_for_window`]). A command sent with no one at the
//! window (an account pairing grant, [`unattended`]) never restarts the
//! runtime: it only offers the restart there.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
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

/// Allow, after the runtime it was asked of was restarted.
pub(crate) const ASK_AGAIN: &str = "TerminalX restarted its runtime so it can verify this window, which ended the other computer's request. Ask again from the other computer, then allow it here.";

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
#[derive(Clone, Debug, PartialEq, Eq)]
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

/// The restarts this window offered, by the runtime each names: Restart
/// runtime stops only a runtime offered here.
static OFFERED: Mutex<Option<HashMap<String, RestartRequired>>> = Mutex::new(None);

fn offer(required: RestartRequired) -> anyhow::Error {
    OFFERED.lock().unwrap().get_or_insert_with(HashMap::new).insert(required.epoch.clone(), required.clone());
    required.into()
}

/// The restart offered for runtime `epoch`, which Settings → Machines shows.
pub(crate) fn offered(epoch: &str) -> Option<RestartRequired> {
    OFFERED.lock().unwrap().as_ref().and_then(|offered| offered.get(epoch).cloned())
}

/// The epoch of the runtime attached now; the window's process installs it.
type AttachedEpoch = Box<dyn Fn() -> Option<String> + Send + Sync>;

static ATTACHED: OnceLock<AttachedEpoch> = OnceLock::new();

/// The restart offered for the runtime attached now, if any.
pub(crate) fn offered_now() -> Option<RestartRequired> {
    ATTACHED.get().and_then(|attached| attached()).and_then(|epoch| offered(&epoch))
}

fn withdraw(epoch: &str) {
    if let Some(offered) = OFFERED.lock().unwrap().as_mut() {
        offered.remove(epoch);
    }
}

/// Stop the runtime `stale` that cannot verify this window and attach a
/// fresh one the window launches; see [`relaunch_by`].
pub(crate) type Relaunch = Box<dyn Fn(&Desktop) -> Result<Arc<Desktop>> + Send + Sync>;

static RELAUNCH: OnceLock<Relaunch> = OnceLock::new();

/// Repair every guarded command this process sends with `relaunch`. Only the
/// window's process installs one.
#[cfg(target_os = "macos")]
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
/// one, once; Allow is not, since the computer waiting for it waited on the
/// runtime stopped. Any other command, or failure, is as `send` answered it.
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
    if command == crate::machine_wire::APPROVE {
        return Err(anyhow!(ASK_AGAIN));
    }
    match send(&fresh, params) {
        Err(error) if error.downcast_ref::<WindowKeyMissing>().is_some() => Err(anyhow!(consent::KEYCHAIN_DENIED)),
        Err(error) if unverifiable(&error) => Err(anyhow!("TerminalX restarted its runtime, but it still cannot verify this window: {error:#}")),
        answered => answered,
    }
}

/// Send guarded `command` with no one at this window to ask, as for an
/// account pairing grant: a runtime that cannot verify the window is never
/// restarted for it. When this window can repair that (`repairable`), the
/// restart is offered in Settings → Machines instead, naming what of the
/// runtime it would stop (`in_use`), and the command fails with that offer.
pub(crate) fn unattended<R: Attached>(
    runtime: &R,
    command: &str,
    params: Value,
    send: impl FnOnce(&R, Value) -> Result<Value>,
    repairable: bool,
    in_use: impl FnOnce(&R) -> Vec<String>,
) -> Result<Value> {
    match send(runtime, params) {
        Err(error) if repairable && consent::guards(command) && unverifiable(&error) => {
            log::warn!("the local runtime cannot verify this window ({error:#}); offering Restart runtime in Settings → Machines");
            Err(offer(RestartRequired { epoch: runtime.epoch().to_owned(), work: in_use(runtime) }))
        }
        sent => sent,
    }
}

/// A runtime, as a relaunch tells one from another.
pub(crate) trait Attached {
    fn epoch(&self) -> &str;
}

impl Attached for Desktop {
    fn epoch(&self) -> &str {
        Desktop::epoch(self)
    }
}

/// What a relaunch needs of the app; [`relaunch_by`] decides when.
pub(crate) trait Relauncher<R> {
    /// The runtime attached now, when it is no longer `epoch` and answers.
    fn replaced(&self, epoch: &str) -> Option<Arc<R>>;
    /// Read this window's consent key, or save a new one, as the fresh
    /// launch will to pin it.
    fn provision(&self) -> Result<()>;
    /// What `stale` serves apart from its work: computers and phones
    /// connected to it, or waiting for Allow.
    fn connected(&self, stale: &R) -> Vec<String>;
    /// What stopping `stale` would cut short, by name.
    fn work(&self, stale: &R) -> Vec<String>;
    /// Stop `stale`, only if nothing it runs would be cut short unless
    /// `forced`, and wait until it has gone.
    fn retire(&self, stale: &R, forced: bool) -> Result<()>;
    /// Wait for the fresh runtime the window launches in place of `stale`.
    fn reattach(&self, stale: &R) -> Result<Arc<R>>;
}

/// Replace `stale`, which cannot verify this window, with a runtime the
/// window launches. A runtime already replaced is not stopped again. One
/// whose replacement could not pin the key, because Keychain neither gives
/// nor saves it, is left running, with Keychain's message. Unless `forced`
/// (Restart runtime), one that serves a computer or phone, or whose work
/// would be cut short, is left running too, and the restart offered
/// ([`RestartRequired`]).
pub(crate) fn relaunch_by<R: Attached>(host: &impl Relauncher<R>, stale: &R, forced: bool) -> Result<Arc<R>> {
    let epoch = stale.epoch().to_owned();
    if let Some(current) = host.replaced(&epoch) {
        return Ok(current);
    }
    if let Err(error) = host.provision() {
        log::warn!("the window consent key cannot be read or saved, so the local runtime was left running: {error:#}");
        return Err(anyhow!(consent::KEYCHAIN_DENIED));
    }
    if !forced {
        let connected = host.connected(stale);
        if !connected.is_empty() {
            log::info!("the local runtime that cannot verify this window serves {}; it was left running", connected.join("; "));
            return Err(offer(RestartRequired { epoch, work: connected.into_iter().chain(host.work(stale)).collect() }));
        }
    }
    match host.retire(stale, forced) {
        Ok(()) => host.reattach(stale),
        // Another runtime took its place meanwhile: that one is attached.
        Err(error) if super::launch::refused(&error, "runtime_restarted") => host.reattach(stale),
        Err(error) if forced => Err(error.context("TerminalX could not restart its runtime")),
        Err(error) if super::launch::left_running(&error) => {
            log::info!("the local runtime that cannot verify this window was left running: {error:#}");
            Err(offer(RestartRequired { epoch, work: host.work(stale) }))
        }
        Err(error) => Err(error.context("TerminalX could not restart its runtime so it can verify this window")),
    }
}

/// What a runtime serves that a restart would cut off, by name: a computer
/// or phone waiting for Allow, which would have to ask again, and the
/// computers and phones connected to it. Nothing when it cannot tell.
pub(crate) fn connected(runtime: &Desktop) -> Vec<String> {
    match runtime.machine_host_status() {
        Ok(Some(status)) => connections(&status),
        Ok(None) => Vec::new(),
        Err(error) => {
            log::debug!("read what the local runtime serves: {error:#}");
            Vec::new()
        }
    }
}

fn connections(status: &crate::machine_wire::Status) -> Vec<String> {
    let mut named = Vec::new();
    if let Some(pending) = &status.pending {
        named.push(format!("{}, waiting for Allow, which would have to ask again", pending.label));
    }
    named.extend(status.computers.iter().filter(|computer| computer.connected).map(|computer| format!("the connection of {}", computer.label)));
    match status.phones.connected.len() {
        0 => {}
        1 => named.push("a connected phone".into()),
        phones => named.push(format!("{phones} connected phones")),
    }
    if status.phones.pending.is_some() {
        named.push("a phone waiting for Allow, which would have to ask again".into());
    }
    named
}

/// Everything restarting `runtime` would stop or cut off.
pub(crate) fn in_use(runtime: &Desktop) -> Vec<String> {
    let mut named = connected(runtime);
    named.extend(super::replace::work(runtime).unwrap_or_default());
    named
}

/// How long the fresh runtime may take to attach: its binary may be new to
/// this Mac's security checks, as after a handover.
const ATTACH_WITHIN: Duration = Duration::from_secs(60);

/// The app's relaunch, for every guarded command the window sends.
#[cfg(target_os = "macos")]
pub(crate) fn install_for(app: &tauri::AppHandle) {
    use tauri::Manager;
    let attached = app.clone();
    if ATTACHED.set(Box::new(move || attached.state::<crate::AppState>().runtime().map(|runtime| runtime.epoch().to_owned()))).is_err() {
        log::warn!("the attached runtime's epoch was installed twice");
    }
    let app = app.clone();
    install(Box::new(move |stale| relaunch(&app, stale, false)));
}

/// A relaunch as the app does it.
struct AppHost<'a> {
    app: &'a tauri::AppHandle,
    home: std::path::PathBuf,
}

impl Relauncher<Desktop> for AppHost<'_> {
    fn replaced(&self, epoch: &str) -> Option<Arc<Desktop>> {
        use tauri::Manager;
        self.app.state::<crate::AppState>().runtime().filter(|runtime| runtime.epoch() != epoch && runtime.attachment().is_ok())
    }

    fn provision(&self) -> Result<()> {
        // The key `launch::launch` pins, read or created the same way.
        #[cfg(target_os = "macos")]
        return consent::launch_public_key()?.map(drop).ok_or_else(|| anyhow!("this window has no consent key"));
        #[cfg(not(target_os = "macos"))]
        anyhow::bail!("this desktop cannot verify its window")
    }

    fn connected(&self, stale: &Desktop) -> Vec<String> {
        connected(stale)
    }

    fn work(&self, stale: &Desktop) -> Vec<String> {
        super::replace::work(stale).unwrap_or_default()
    }

    fn retire(&self, stale: &Desktop, forced: bool) -> Result<()> {
        if forced {
            super::launch::retire(&self.home, || stale.stop_all(), super::launch::Fallback::Forced)
        } else {
            let stopping = || stale.stopping();
            super::launch::retire(&self.home, || super::replace::stop_if_idle(stale), super::launch::Fallback::Agreed(&stopping))
        }
    }

    fn reattach(&self, stale: &Desktop) -> Result<Arc<Desktop>> {
        use tauri::{Emitter, Manager};
        log::info!("stopped the local runtime that could not verify this window; attaching a fresh one");
        let state = self.app.state::<crate::AppState>();
        *state.runtime_error.lock().unwrap() = "TerminalX is restarting its runtime so it can verify this window.".into();
        state.runtime_health.clear();
        // Nothing more is sent to the runtime that stopped. The supervisor's
        // next attempt, made now, launches a fresh runtime with the window's
        // consent key (`launch::launch`).
        stale.disconnect();
        state.runtime_supervisor.retry_now();
        let _ = self.app.emit("local_runtime_state", ());
        let deadline = Instant::now() + ATTACH_WITHIN;
        let fresh = loop {
            if let Some(fresh) = self.replaced(stale.epoch()) {
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
    }
}

/// Replace `stale` with a runtime this window launches, which pins its
/// consent key. `forced`: stop it with whatever it runs, as Restart runtime
/// does; otherwise only if nothing would be cut short.
fn relaunch(app: &tauri::AppHandle, stale: &Desktop, forced: bool) -> Result<Arc<Desktop>> {
    let _one = super::ui::RESTART.blocking_lock();
    relaunch_by(&AppHost { app, home: crate::store::root()? }, stale, forced)
}

/// Restart runtime, beside a [`RestartRequired`]: stop runtime `epoch` with
/// what it runs and attach a fresh one this window launches, which can verify
/// it. Only a runtime this window offered to restart is stopped. Each agent
/// stopped picks up its conversation again when its tab next starts. A
/// runtime another window or a switch already replaced is left alone.
#[tauri::command]
pub async fn local_runtime_restart_for_window(app: tauri::AppHandle, epoch: String) -> Result<(), String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(stale) = app.state::<crate::AppState>().runtime().filter(|runtime| runtime.epoch() == epoch) else { return Ok(()) };
        if offered(&epoch).is_none() {
            return Err("TerminalX did not offer to restart this runtime, so it was left running.".to_string());
        }
        relaunch(&app, &stale, true).map_err(|error| format!("{error:#}"))?;
        withdraw(&epoch);
        Ok(())
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
        assert!(!unverifiable(&anyhow!(consent::KEYCHAIN_DENIED)));
        // An agent, or a terminal the runtime runs, is no window to repair.
        assert!(!unverifiable(&refused("person_required", &format!("Only a person may do this, and {}.", Refusal::Descendant.says()))));
        assert!(!unverifiable(&refused("not_enabled", "Machines is off")));
    }

    struct Runtime(&'static str);

    impl Attached for Runtime {
        fn epoch(&self) -> &str {
            self.0
        }
    }

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
            let answered = guarded(&Runtime("adopted"), command, serde_json::json!({}), send, Some(&relaunch));
            assert!(relaunched.get(), "{command}");
            if command == crate::machine_wire::APPROVE {
                assert_eq!(answered.unwrap_err().to_string(), ASK_AGAIN);
            } else {
                answered.unwrap();
            }
        }
        let relaunch = |_: &Runtime| -> Result<Arc<Runtime>> { panic!("an unguarded command never restarts the runtime") };
        let send = |_: &Runtime, _| Err(refused("pairing_unavailable", ""));
        assert!(guarded(&Runtime("adopted"), crate::machine_wire::REVOKE, serde_json::json!({}), send, Some(&relaunch)).is_err());
    }

    #[test]
    fn allow_is_not_sent_again_to_a_runtime_that_never_saw_the_request() {
        let sent = Cell::new(0);
        let send = |runtime: &Runtime, _| {
            sent.set(sent.get() + 1);
            assert_eq!(runtime.0, "adopted", "the fresh runtime is not asked");
            Err(not_window())
        };
        let relaunch = |_: &Runtime| Ok(Arc::new(Runtime("fresh")));
        let error = guarded(&Runtime("adopted"), crate::machine_wire::APPROVE, serde_json::json!({ "requestId": "r" }), send, Some(&relaunch)).unwrap_err();
        assert!(error.to_string().contains("Ask again from the other computer"), "{error:#}");
        assert_eq!(sent.get(), 1);
    }

    #[test]
    fn a_denied_keychain_or_another_refusal_restarts_nothing() {
        let relaunch = |_: &Runtime| -> Result<Arc<Runtime>> { panic!("nothing to repair") };
        let denied = |_: &Runtime, _| Err(anyhow!(consent::KEYCHAIN_DENIED));
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
        // The key went missing again after the fresh launch provisioned it.
        let send = |_: &Runtime, _| Err(anyhow::Error::new(WindowKeyMissing));
        let error = guarded(&Runtime("adopted"), crate::machine_wire::CREATE_CODE, serde_json::json!({}), send, Some(&relaunch)).unwrap_err();
        assert_eq!(error.to_string(), consent::KEYCHAIN_DENIED);
        assert_eq!(relaunched.get(), 1);
        let send = |_: &Runtime, _| Err(not_window());
        let error = guarded(&Runtime("adopted"), crate::machine_wire::LET_BACK, serde_json::json!({}), send, Some(&relaunch)).unwrap_err();
        assert!(error.to_string().contains("still cannot verify this window"), "{error:#}");
        assert_eq!(relaunched.get(), 2);
    }

    /// The app's relaunch, in the order [`relaunch_by`] calls it, recorded.
    struct Host {
        calls: RefCell<Vec<String>>,
        replaced: Option<&'static str>,
        provision: fn() -> Result<()>,
        connected: Vec<String>,
        retire: fn(bool) -> Result<()>,
    }

    impl Host {
        fn idle() -> Self {
            Self { calls: RefCell::default(), replaced: None, provision: || Ok(()), connected: Vec::new(), retire: |_| Ok(()) }
        }

        fn calls(&self) -> Vec<String> {
            self.calls.borrow().clone()
        }
    }

    impl Relauncher<Runtime> for Host {
        fn replaced(&self, _: &str) -> Option<Arc<Runtime>> {
            self.calls.borrow_mut().push("replaced".into());
            self.replaced.map(|epoch| Arc::new(Runtime(epoch)))
        }
        fn provision(&self) -> Result<()> {
            self.calls.borrow_mut().push("provision".into());
            (self.provision)()
        }
        fn connected(&self, _: &Runtime) -> Vec<String> {
            self.calls.borrow_mut().push("connected".into());
            self.connected.clone()
        }
        fn work(&self, _: &Runtime) -> Vec<String> {
            self.calls.borrow_mut().push("work".into());
            vec!["Claude in api".into(), "a terminal in web".into()]
        }
        fn retire(&self, _: &Runtime, forced: bool) -> Result<()> {
            self.calls.borrow_mut().push(format!("retire forced={forced}"));
            (self.retire)(forced)
        }
        fn reattach(&self, _: &Runtime) -> Result<Arc<Runtime>> {
            self.calls.borrow_mut().push("reattach".into());
            Ok(Arc::new(Runtime("fresh")))
        }
    }

    fn busy(_: bool) -> Result<()> {
        let refusal = anyhow::Error::from(Refused { code: "runtime_busy".into(), message: "It is running work.".into() });
        Err(refusal.context(super::super::launch::LeftRunning("The TerminalX runtime has work under way; nothing was stopped.")))
    }

    #[test]
    fn an_idle_runtime_is_stopped_once_the_key_is_saved_then_the_fresh_one_attached() {
        let host = Host::idle();
        assert_eq!(relaunch_by(&host, &Runtime("idle-1"), false).unwrap().0, "fresh");
        assert_eq!(host.calls(), ["replaced", "provision", "connected", "retire forced=false", "reattach"]);
        assert_eq!(offered("idle-1"), None, "nothing to offer");
    }

    #[test]
    fn a_keychain_that_cannot_save_the_key_stops_nothing_and_keeps_its_message() {
        for forced in [false, true] {
            let host = Host { provision: || anyhow::bail!("errSecWrPerm: the store refused the write"), ..Host::idle() };
            let error = relaunch_by(&host, &Runtime("refused-1"), forced).err().unwrap();
            assert_eq!(error.to_string(), consent::KEYCHAIN_DENIED);
            assert_eq!(host.calls(), ["replaced", "provision"], "nothing was stopped (forced: {forced})");
        }
    }

    #[test]
    fn a_runtime_already_replaced_is_not_stopped_again() {
        let host = Host { replaced: Some("other"), ..Host::idle() };
        assert_eq!(relaunch_by(&host, &Runtime("replaced-1"), true).unwrap().0, "other");
        assert_eq!(host.calls(), ["replaced"]);
        // Replaced while it was being stopped: the one attached is used.
        let host = Host {
            retire: |_| {
                let refusal = anyhow::Error::from(Refused { code: "runtime_restarted".into(), message: "Another runtime was attached meanwhile.".into() });
                Err(refusal.context(super::super::launch::LeftRunning("replaced")))
            },
            ..Host::idle()
        };
        assert_eq!(relaunch_by(&host, &Runtime("replaced-2"), false).unwrap().0, "fresh");
        assert_eq!(offered("replaced-2"), None);
    }

    #[test]
    fn a_busy_runtime_is_left_running_and_the_restart_offered_for_it_alone() {
        let host = Host { retire: busy, ..Host::idle() };
        let error = relaunch_by(&host, &Runtime("busy-1"), false).err().unwrap();
        assert!(!host.calls().contains(&"reattach".to_string()), "nothing was stopped, so nothing new is attached");
        let required = error.downcast_ref::<RestartRequired>().expect("restart required");
        assert_eq!(required.epoch, "busy-1");
        assert_eq!(offered("busy-1").as_ref(), Some(required), "Restart runtime may stop this runtime");
        assert_eq!(offered("busy-2"), None, "and no other");
        let text = error.to_string();
        assert!(text.starts_with("runtime_restart_required:busy-1: "), "{text}");
        assert!(text.contains("Restart runtime"), "names the control: {text}");
        assert!(text.contains("Claude in api; a terminal in web"), "{text}");
        assert!(text.contains("picks up its conversation again"), "says what happens to sessions: {text}");
        withdraw("busy-1");
        assert_eq!(offered("busy-1"), None);
    }

    #[test]
    fn a_runtime_serving_a_computer_or_phone_is_not_restarted_by_itself() {
        let host = Host { connected: vec!["the connection of MacBook".into()], retire: |_| panic!("not stopped"), ..Host::idle() };
        let error = relaunch_by(&host, &Runtime("serving-1"), false).err().unwrap();
        let required = error.downcast_ref::<RestartRequired>().expect("restart required");
        assert_eq!(required.work, ["the connection of MacBook", "Claude in api", "a terminal in web"]);
        // Restart runtime stops it all the same.
        let host = Host { connected: vec!["the connection of MacBook".into()], ..Host::idle() };
        assert_eq!(relaunch_by(&host, &Runtime("serving-1"), true).unwrap().0, "fresh");
        assert_eq!(host.calls(), ["replaced", "provision", "retire forced=true", "reattach"]);
    }

    #[test]
    fn restart_runtime_that_fails_says_why_instead_of_offering_itself_again() {
        let host = Host {
            retire: |forced| {
                assert!(forced);
                Err(anyhow!("/usr/bin/other is not a TerminalX runtime of this home").context(super::super::launch::LeftRunning("The process holding the runtime socket was left running.")))
            },
            ..Host::idle()
        };
        let error = relaunch_by(&host, &Runtime("forced-1"), true).err().unwrap();
        assert!(error.downcast_ref::<RestartRequired>().is_none(), "{error:#}");
        assert!(format!("{error:#}").contains("was left running"), "{error:#}");
        assert_eq!(offered("forced-1"), None);
        // A failure that may have stopped something is no restart prompt either.
        let host = Host { retire: |_| anyhow::bail!("did not exit"), ..Host::idle() };
        let failed = relaunch_by(&host, &Runtime("failed-1"), false).err().unwrap();
        assert!(failed.downcast_ref::<RestartRequired>().is_none());
    }

    #[test]
    fn an_unattended_grant_never_restarts_the_runtime_and_offers_the_restart() {
        let send = |_: &Runtime, _| Err(refused("pairing_unavailable", Refusal::UnsupportedDesktop.says()));
        let error = unattended(&Runtime("grant-1"), crate::machine_wire::CREATE_CODE, serde_json::json!({ "grantRequestId": "g" }), send, true, |_| vec!["Codex in web".into()]).unwrap_err();
        let required = error.downcast_ref::<RestartRequired>().expect("restart offered");
        assert_eq!(required.work, ["Codex in web"]);
        assert_eq!(offered("grant-1").as_ref(), Some(required));
        // A window that cannot repair it offers nothing.
        let error = unattended(&Runtime("grant-2"), crate::machine_wire::CREATE_CODE, serde_json::json!({}), send, false, |_| panic!("not read")).unwrap_err();
        assert!(error.downcast_ref::<Refused>().is_some());
        assert_eq!(offered("grant-2"), None);
        // Any other failure, or an answer, is as it was.
        let other = |_: &Runtime, _| Err(refused("not_enabled", "Machines is off"));
        unattended(&Runtime("grant-3"), crate::machine_wire::CREATE_CODE, serde_json::json!({}), other, true, |_| panic!("not read")).unwrap_err();
        assert_eq!(offered("grant-3"), None);
        let answered = unattended(&Runtime("grant-4"), crate::machine_wire::CREATE_CODE, serde_json::json!({}), |_, _| Ok(Value::Null), true, |_| panic!("not read"));
        assert_eq!(answered.unwrap(), Value::Null);
    }

    #[test]
    fn names_the_computers_and_phones_a_restart_would_cut_off() {
        let mut status: crate::machine_wire::Status = serde_json::from_value(serde_json::json!({
            "enabled": true, "hostKey": "ready", "machineId": null, "listening": null, "phoneRoute": false, "error": null,
            "computers": [
                { "id": "c1", "label": "MacBook", "platform": null, "approvedAt": 1, "lastSeenAt": null, "connected": true },
                { "id": "c2", "label": "Studio", "platform": null, "approvedAt": 1, "lastSeenAt": null, "connected": false }
            ],
        }))
        .unwrap();
        assert_eq!(connections(&status), ["the connection of MacBook"]);
        status.computers.clear();
        assert!(connections(&status).is_empty());
        status.phones.connected = vec!["p1".into(), "p2".into()];
        assert_eq!(connections(&status), ["2 connected phones"]);
    }
}
