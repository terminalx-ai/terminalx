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
    changed(&required.epoch);
    required.into()
}

/// Called with a runtime's epoch whenever the restart offered for it is
/// made, changed or withdrawn; the window's process installs one that
/// sends Settings → Machines a fresh view.
type OnChange = Box<dyn Fn(&str) + Send + Sync>;

static ON_CHANGE: OnceLock<OnChange> = OnceLock::new();

/// Tell the window about every change to the restarts offered.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn on_change(notify: OnChange) {
    if ON_CHANGE.set(notify).is_err() {
        log::warn!("the restart offer's watcher was installed twice");
    }
}

fn changed(epoch: &str) {
    if let Some(notify) = ON_CHANGE.get() {
        notify(epoch);
    }
}

/// The restart offered for runtime `epoch`, with what restarting it would
/// stop now (`in_use`), which may differ from when it was offered: the
/// offer is kept with the list as Settings → Machines shows it.
pub(crate) fn offered_now_for(epoch: &str, in_use: impl FnOnce() -> Vec<String>) -> Option<RestartRequired> {
    offered(epoch)?;
    let now = RestartRequired { epoch: epoch.to_owned(), work: in_use() };
    let mut offered = OFFERED.lock().unwrap();
    let entry = offered.as_mut()?.get_mut(epoch)?;
    *entry = now.clone();
    Some(now)
}

/// The restart offered for runtime `epoch`, which Settings → Machines shows.
pub(crate) fn offered(epoch: &str) -> Option<RestartRequired> {
    OFFERED.lock().unwrap().as_ref().and_then(|offered| offered.get(epoch).cloned())
}

/// Runtime `attached` was attached in place of runtime `gone`, as after an
/// update handed it over: the restart offered for `gone` has gone with it, so
/// Settings → Machines no longer shows it (PRO-489).
pub(crate) fn attached_in_place_of(gone: &str, attached: &str) {
    if gone != attached {
        withdraw(gone);
    }
}

#[cfg(test)]
pub(crate) fn offer_for_test(required: RestartRequired) {
    let _ = offer(required);
}

fn withdraw(epoch: &str) {
    let removed = OFFERED.lock().unwrap().as_mut().and_then(|offered| offered.remove(epoch));
    if removed.is_some() {
        changed(epoch);
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
    /// Forget the key [`Relauncher::provision`] kept for the fresh launch:
    /// the relaunch is over, whether a launch followed or not.
    fn unprovision(&self);
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
///
/// An update that hands the runtime over while it is being stopped keeps its
/// environment, so the runtime that took over cannot verify the window
/// either: it is relaunched the same way, once.
pub(crate) fn relaunch_by<R: Attached>(host: &impl Relauncher<R>, stale: &R, forced: bool) -> Result<Arc<R>> {
    let relaunched = relaunch_once(host, stale, forced, true);
    // Kept only for the launch this relaunch waits for (PRO-489): a later
    // launch reads Keychain again.
    host.unprovision();
    relaunched
}

/// Said when the runtime was handed over while it was being stopped, and the
/// one that took over cannot be relaunched in turn now.
pub(crate) const HANDED_OVER: &str = "The TerminalX runtime was updated while it was being restarted, so it was not restarted. Try again in a moment.";

fn relaunch_once<R: Attached>(host: &impl Relauncher<R>, stale: &R, forced: bool, again: bool) -> Result<Arc<R>> {
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
        Ok(()) => {
            let fresh = host.reattach(stale)?;
            // The runtime offered for has gone: so has the offer.
            withdraw(&epoch);
            Ok(fresh)
        }
        // Handed over meanwhile (an update): the runtime that took over
        // keeps the environment, and so cannot verify the window either.
        Err(error) if super::launch::refused(&error, "runtime_restarted") => {
            log::info!("the local runtime was handed over while it was being restarted: {error:#}");
            withdraw(&epoch);
            match host.replaced(&epoch) {
                Some(next) if again => relaunch_once(host, &*next, forced, false),
                _ => Err(anyhow!(HANDED_OVER)),
            }
        }
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
/// computers and phones connected to it. Nothing from a runtime too old to
/// host any. When it cannot tell, it says so: that is no reason to restart
/// it by itself.
pub(crate) fn connected(runtime: &Desktop) -> Vec<String> {
    match runtime.machine_host_status() {
        Ok(Some(status)) => connections(&status),
        Ok(None) => Vec::new(),
        Err(error) => {
            log::warn!("read what the local runtime serves: {error:#}");
            vec![CANNOT_TELL.into()]
        }
    }
}

/// What a runtime serves, when its status cannot be read.
pub(crate) const CANNOT_TELL: &str = "any computer or phone connected to it (TerminalX could not read which)";

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

/// The fresh runtime, as `attached` finds it, once it has attached within
/// `within`, looking every `every`.
fn attached_within<R>(within: Duration, every: Duration, attached: impl Fn() -> Option<Arc<R>>) -> Result<Arc<R>> {
    let deadline = Instant::now() + within;
    loop {
        if let Some(fresh) = attached() {
            return Ok(fresh);
        }
        if Instant::now() >= deadline {
            anyhow::bail!("TerminalX restarted its runtime, but the new one has not attached yet. Try again in a moment.");
        }
        std::thread::sleep(every);
    }
}

/// The app's relaunch, for every guarded command the window sends.
#[cfg(target_os = "macos")]
pub(crate) fn install_for(app: &tauri::AppHandle) {
    let watcher = app.clone();
    // Settings → Machines shows an offer made with no one at the window (an
    // account grant) as soon as it is made, and one withdrawn as it goes.
    on_change(Box::new(move |_| crate::machines::emit_host_view(&watcher)));
    let app = app.clone();
    install(Box::new(move |stale| relaunch(&app, stale, false)));
}

/// How a relaunch stops a runtime; [`retire_for_window`] decides which.
pub(crate) trait Stops {
    /// Stop it with whatever it runs.
    fn stop_all(&self) -> Result<()>;
    /// Stop it only if nothing it runs would be cut short.
    fn stop_if_idle(&self) -> Result<()>;
    /// Whether it has agreed to stop, and so refuses new work.
    fn stopping(&self) -> bool;
}

impl Stops for Desktop {
    fn stop_all(&self) -> Result<()> {
        Desktop::stop_all(self)
    }
    fn stop_if_idle(&self) -> Result<()> {
        super::replace::stop_if_idle(self)
    }
    fn stopping(&self) -> bool {
        Desktop::stopping(self)
    }
}

/// Stop `stale`, the runtime holding `home`, and wait until it has gone:
/// `forced` (Restart runtime) with whatever it runs; otherwise only once it
/// agreed, as nothing it runs would be cut short.
pub(crate) fn retire_for_window(home: &std::path::Path, stale: &impl Stops, forced: bool) -> Result<()> {
    if forced {
        super::launch::retire(home, || stale.stop_all(), super::launch::Fallback::Forced)
    } else {
        let stopping = || stale.stopping();
        super::launch::retire(home, || stale.stop_if_idle(), super::launch::Fallback::Agreed(&stopping))
    }
}

/// What attaching the fresh runtime needs of the app; [`reattach_by`]
/// decides the order.
pub(crate) trait Reattacher<R> {
    /// Tell the window the runtime is being restarted.
    fn restarting(&self);
    /// Send nothing more to `stale`, which has stopped.
    fn let_go(&self, stale: &R);
    /// Launch and attach a fresh runtime now, which pins the window's key.
    fn launch_now(&self);
    /// The runtime attached now, when it is no longer `epoch` and answers.
    fn replaced(&self, epoch: &str) -> Option<Arc<R>>;
    /// Give `fresh` the host key the window holds, before a command needs it.
    fn reconcile(&self, fresh: &Arc<R>);
}

/// Attach the runtime launched in place of `stale`, which has stopped,
/// waiting `within` for it.
pub(crate) fn reattach_by<R: Attached>(host: &impl Reattacher<R>, stale: &R, within: Duration) -> Result<Arc<R>> {
    host.restarting();
    host.let_go(stale);
    host.launch_now();
    let fresh = attached_within(within, Duration::from_millis(100), || host.replaced(stale.epoch()))?;
    host.reconcile(&fresh);
    Ok(fresh)
}

/// A relaunch as the app does it.
struct AppHost<'a> {
    app: &'a tauri::AppHandle,
    home: std::path::PathBuf,
}

fn attached_runtime(app: &tauri::AppHandle, epoch: &str) -> Option<Arc<Desktop>> {
    use tauri::Manager;
    app.state::<crate::AppState>().runtime().filter(|runtime| runtime.epoch() != epoch && runtime.attachment().is_ok())
}

impl Relauncher<Desktop> for AppHost<'_> {
    fn replaced(&self, epoch: &str) -> Option<Arc<Desktop>> {
        attached_runtime(self.app, epoch)
    }

    fn provision(&self) -> Result<()> {
        // The key `launch::launch` then pins without reading it again.
        #[cfg(target_os = "macos")]
        return consent::provision_launch_key()?.map(drop).ok_or_else(|| anyhow!("this window has no consent key"));
        #[cfg(not(target_os = "macos"))]
        anyhow::bail!("this desktop cannot verify its window")
    }

    fn unprovision(&self) {
        #[cfg(target_os = "macos")]
        consent::forget_launch_key();
    }

    fn connected(&self, stale: &Desktop) -> Vec<String> {
        connected(stale)
    }

    fn work(&self, stale: &Desktop) -> Vec<String> {
        super::replace::work(stale).unwrap_or_default()
    }

    fn retire(&self, stale: &Desktop, forced: bool) -> Result<()> {
        retire_for_window(&self.home, stale, forced)
    }

    fn reattach(&self, stale: &Desktop) -> Result<Arc<Desktop>> {
        log::info!("stopped the local runtime that could not verify this window; attaching a fresh one");
        reattach_by(&AppReattach(self.app), stale, ATTACH_WITHIN)
    }
}

/// Attaching the fresh runtime, as the app does it.
struct AppReattach<'a>(&'a tauri::AppHandle);

impl Reattacher<Desktop> for AppReattach<'_> {
    fn restarting(&self) {
        use tauri::Manager;
        let state = self.0.state::<crate::AppState>();
        *state.runtime_error.lock().unwrap() = "TerminalX is restarting its runtime so it can verify this window.".into();
        state.runtime_health.clear();
    }

    fn let_go(&self, stale: &Desktop) {
        stale.disconnect();
    }

    fn launch_now(&self) {
        use tauri::{Emitter, Manager};
        // The supervisor's next attempt, made now, launches a fresh runtime
        // with the window's consent key (`launch::launch`).
        self.0.state::<crate::AppState>().runtime_supervisor.retry_now();
        let _ = self.0.emit("local_runtime_state", ());
    }

    fn replaced(&self, epoch: &str) -> Option<Arc<Desktop>> {
        attached_runtime(self.0, epoch)
    }

    fn reconcile(&self, fresh: &Arc<Desktop>) {
        use tauri::Manager;
        self.0.state::<crate::AppState>().pairing.reconcile_machine(fresh);
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
///
/// `shown` is the offer as the window displayed it. What it stops is read
/// again first: when that is more than `shown` names, nothing is stopped and
/// the offer, with the new list, is the answer, so the person is asked again.
#[tauri::command]
pub async fn local_runtime_restart_for_window(app: tauri::AppHandle, epoch: String, shown: String) -> Result<(), String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let attached = app.state::<crate::AppState>().runtime();
        restart_for_window(attached, &epoch, &shown, in_use, |stale| relaunch(&app, stale, true))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// The body of [`local_runtime_restart_for_window`], with `attached` the
/// runtime attached now, `in_use` what stopping it would stop and `relaunch`
/// the forced relaunch.
fn restart_for_window<R: Attached>(
    attached: Option<Arc<R>>,
    epoch: &str,
    shown: &str,
    in_use: impl FnOnce(&R) -> Vec<String>,
    relaunch: impl FnOnce(&R) -> Result<Arc<R>>,
) -> Result<(), String> {
    match gate(attached.as_deref(), epoch, shown, in_use) {
        Gate::LeftAlone => Ok(()),
        Gate::NotOffered => Err(NOT_OFFERED.to_string()),
        Gate::MoreToStop(required) => Err(required.to_string()),
        Gate::Restart => {
            let stale = attached.expect("an offered runtime is attached");
            relaunch(&stale).map_err(|error| format!("{error:#}"))?;
            withdraw(epoch);
            Ok(())
        }
    }
}

/// Restart runtime, for a runtime it was not offered for.
pub(crate) const NOT_OFFERED: &str = "TerminalX did not offer to restart this runtime, so it was left running.";

/// What Restart runtime does for runtime `epoch`.
#[derive(Debug, PartialEq, Eq)]
enum Gate {
    /// Another runtime is attached now: nothing to stop.
    LeftAlone,
    /// No restart was offered for it: nothing is stopped.
    NotOffered,
    /// It would stop more than was shown: nothing is stopped, and this,
    /// the offer as it stands now, is shown instead.
    MoreToStop(RestartRequired),
    Restart,
}

/// Whether Restart runtime may stop runtime `epoch`, with `attached` the
/// runtime attached now, `shown` the offer as the window displayed it and
/// `in_use` what stopping it would stop now.
///
/// What was shown is the offer kept for `epoch` only when its text is the
/// text the window sends back: a view built since may have replaced the list
/// before the window displayed it (PRO-489). Names are counted, not merely
/// looked up, since two works may share one.
fn gate<R: Attached>(attached: Option<&R>, epoch: &str, shown: &str, in_use: impl FnOnce(&R) -> Vec<String>) -> Gate {
    let Some(runtime) = attached.filter(|runtime| runtime.epoch() == epoch) else { return Gate::LeftAlone };
    let Some(offer) = offered(epoch) else { return Gate::NotOffered };
    let now = in_use(runtime);
    if offer.to_string() == shown && within(&now, &offer.work) {
        return Gate::Restart;
    }
    let required = RestartRequired { epoch: epoch.to_owned(), work: now };
    OFFERED.lock().unwrap().get_or_insert_with(HashMap::new).insert(epoch.to_owned(), required.clone());
    changed(epoch);
    Gate::MoreToStop(required)
}

/// Whether every name in `now` is in `shown` at least as many times.
fn within(now: &[String], shown: &[String]) -> bool {
    let mut left: HashMap<&str, usize> = HashMap::new();
    for named in shown {
        *left.entry(named).or_default() += 1;
    }
    now.iter().all(|named| match left.get_mut(named.as_str()) {
        Some(count) if *count > 0 => {
            *count -= 1;
            true
        }
        _ => false,
    })
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
        /// The runtime an update hands over to while one is being stopped.
        handed_to: Option<&'static str>,
        provision: fn() -> Result<()>,
        connected: Vec<String>,
        retire: fn(&str, bool) -> Result<()>,
    }

    impl Host {
        fn idle() -> Self {
            Self { calls: RefCell::default(), replaced: None, handed_to: None, provision: || Ok(()), connected: Vec::new(), retire: |_, _| Ok(()) }
        }

        fn calls(&self) -> Vec<String> {
            self.calls.borrow().clone()
        }
    }

    impl Relauncher<Runtime> for Host {
        fn replaced(&self, epoch: &str) -> Option<Arc<Runtime>> {
            let handed = self.calls.borrow().iter().any(|call| call.starts_with("retire")) && self.handed_to != Some(epoch);
            self.calls.borrow_mut().push("replaced".into());
            self.replaced.or(self.handed_to.filter(|_| handed)).map(|epoch| Arc::new(Runtime(epoch)))
        }
        fn provision(&self) -> Result<()> {
            self.calls.borrow_mut().push("provision".into());
            (self.provision)()
        }
        fn unprovision(&self) {
            self.calls.borrow_mut().push("unprovision".into());
        }
        fn connected(&self, _: &Runtime) -> Vec<String> {
            self.calls.borrow_mut().push("connected".into());
            self.connected.clone()
        }
        fn work(&self, _: &Runtime) -> Vec<String> {
            self.calls.borrow_mut().push("work".into());
            vec!["Claude in api".into(), "a terminal in web".into()]
        }
        fn retire(&self, stale: &Runtime, forced: bool) -> Result<()> {
            self.calls.borrow_mut().push(format!("retire {} forced={forced}", stale.0));
            (self.retire)(stale.0, forced)
        }
        fn reattach(&self, _: &Runtime) -> Result<Arc<Runtime>> {
            self.calls.borrow_mut().push("reattach".into());
            Ok(Arc::new(Runtime("fresh")))
        }
    }

    fn busy(_: &str, _: bool) -> Result<()> {
        let refusal = anyhow::Error::from(Refused { code: "runtime_busy".into(), message: "It is running work.".into() });
        Err(refusal.context(super::super::launch::LeftRunning("The TerminalX runtime has work under way; nothing was stopped.")))
    }

    #[test]
    fn an_idle_runtime_is_stopped_once_the_key_is_saved_then_the_fresh_one_attached() {
        let host = Host::idle();
        assert_eq!(relaunch_by(&host, &Runtime("idle-1"), false).unwrap().0, "fresh");
        assert_eq!(host.calls(), ["replaced", "provision", "connected", "retire idle-1 forced=false", "reattach", "unprovision"]);
        assert_eq!(offered("idle-1"), None, "nothing to offer");
    }

    #[test]
    fn a_keychain_that_cannot_save_the_key_stops_nothing_and_keeps_its_message() {
        for forced in [false, true] {
            let host = Host { provision: || anyhow::bail!("errSecWrPerm: the store refused the write"), ..Host::idle() };
            let error = relaunch_by(&host, &Runtime("refused-1"), forced).err().unwrap();
            assert_eq!(error.to_string(), consent::KEYCHAIN_DENIED);
            assert_eq!(host.calls(), ["replaced", "provision", "unprovision"], "nothing was stopped (forced: {forced})");
        }
    }

    #[test]
    fn a_runtime_already_replaced_is_not_stopped_again() {
        let host = Host { replaced: Some("other"), ..Host::idle() };
        assert_eq!(relaunch_by(&host, &Runtime("replaced-1"), true).unwrap().0, "other");
        assert_eq!(host.calls(), ["replaced", "unprovision"]);
    }

    fn handed_over(stale: &str, _: bool) -> Result<()> {
        if stale.starts_with("handed-") {
            return Ok(());
        }
        let refusal = anyhow::Error::from(Refused { code: "runtime_restarted".into(), message: "Another runtime was attached meanwhile.".into() });
        Err(refusal.context(super::super::launch::LeftRunning("The TerminalX runtime was replaced before it could be stopped; nothing was stopped.")))
    }

    #[test]
    fn a_runtime_handed_over_while_it_is_stopped_is_relaunched_as_the_one_that_took_over() {
        for forced in [false, true] {
            let _ = offer(RestartRequired { epoch: "handover-1".into(), work: Vec::new() });
            let host = Host { handed_to: Some("handed-1"), retire: handed_over, ..Host::idle() };
            assert_eq!(relaunch_by(&host, &Runtime("handover-1"), forced).unwrap().0, "fresh");
            let calls = host.calls();
            assert!(calls.contains(&format!("retire handover-1 forced={forced}")) && calls.contains(&format!("retire handed-1 forced={forced}")), "{calls:?}");
            assert_eq!(calls[calls.len() - 2..], ["reattach", "unprovision"], "{calls:?}");
            assert_eq!(offered("handover-1"), None, "the offer for the runtime handed over is gone");
        }
    }

    #[test]
    fn a_handover_not_attached_yet_or_handed_over_twice_restarts_nothing_and_says_so() {
        for forced in [false, true] {
            // Nothing attached in its place yet.
            let _ = offer(RestartRequired { epoch: "handover-2".into(), work: Vec::new() });
            let host = Host { retire: handed_over, ..Host::idle() };
            let error = relaunch_by(&host, &Runtime("handover-2"), forced).err().unwrap();
            assert_eq!(error.to_string(), HANDED_OVER);
            assert!(!host.calls().contains(&"reattach".to_string()));
            assert_eq!(offered("handover-2"), None);
            // The one that took over is handed over too: one try only.
            let host = Host { handed_to: Some("handover-again"), retire: |_, _| handed_over("x", false), ..Host::idle() };
            let error = relaunch_by(&host, &Runtime("handover-3"), forced).err().unwrap();
            assert_eq!(error.to_string(), HANDED_OVER);
            assert_eq!(host.calls().iter().filter(|call| call.starts_with("retire")).count(), 2);
        }
    }

    #[test]
    fn a_fresh_runtime_attached_withdraws_the_restart_offered_for_the_one_it_replaced() {
        // Offered for a grant; then a person's command repaired it.
        let _ = offer(RestartRequired { epoch: "settle-1".into(), work: Vec::new() });
        let host = Host::idle();
        assert_eq!(relaunch_by(&host, &Runtime("settle-1"), false).unwrap().0, "fresh");
        assert_eq!(offered("settle-1"), None);
    }

    /// Epochs the window was told about, by [`changed`].
    static NOTIFIED: Mutex<Vec<String>> = Mutex::new(Vec::new());

    fn watch() {
        static WATCHING: std::sync::Once = std::sync::Once::new();
        WATCHING.call_once(|| on_change(Box::new(|epoch| NOTIFIED.lock().unwrap().push(epoch.to_owned()))));
    }

    fn notified(epoch: &str) -> usize {
        NOTIFIED.lock().unwrap().iter().filter(|notified| *notified == epoch).count()
    }

    #[test]
    fn the_window_is_told_when_an_offer_is_made_changed_or_withdrawn() {
        watch();
        // Made with no one at the window, as for an account grant.
        let send = |_: &Runtime, _| Err(refused("pairing_unavailable", Refusal::UnsupportedDesktop.says()));
        unattended(&Runtime("notify-1"), crate::machine_wire::CREATE_CODE, serde_json::json!({}), send, true, |_| Vec::new()).unwrap_err();
        assert_eq!(notified("notify-1"), 1);
        // Restart runtime finds more to stop: the new list is announced.
        assert!(matches!(gate(Some(&Runtime("notify-1")), "notify-1", &shown("notify-1", &[]), |_| vec!["a terminal in web".into()]), Gate::MoreToStop(_)));
        assert_eq!(notified("notify-1"), 2);
        withdraw("notify-1");
        assert_eq!(notified("notify-1"), 3);
        withdraw("notify-1");
        assert_eq!(notified("notify-1"), 3, "nothing withdrawn, nothing to tell");
        // A fresh runtime attached: the offer for the one it replaced goes, announced.
        let _ = offer(RestartRequired { epoch: "notify-2".into(), work: Vec::new() });
        relaunch_by(&Host::idle(), &Runtime("notify-2"), false).unwrap();
        assert_eq!(notified("notify-2"), 2);
        assert_eq!(offered("notify-2"), None);
    }

    fn shown(epoch: &str, work: &[&str]) -> String {
        RestartRequired { epoch: epoch.into(), work: work.iter().map(|named| named.to_string()).collect() }.to_string()
    }

    #[test]
    fn restart_runtime_stops_only_the_runtime_offered_with_no_more_than_was_shown() {
        let api = shown("gate-1", &["Claude in api"]);
        // Another runtime is attached now, or none: nothing is stopped.
        assert_eq!(gate(Some(&Runtime("gate-other")), "gate-1", &api, |_| panic!("not read")), Gate::LeftAlone);
        assert_eq!(gate::<Runtime>(None, "gate-1", &api, |_| panic!("not read")), Gate::LeftAlone);
        // Attached, but no restart was offered for it: a web view naming any
        // epoch it likes stops nothing.
        assert_eq!(gate(Some(&Runtime("gate-1")), "gate-1", &api, |_| panic!("not read")), Gate::NotOffered);
        let _ = offer(RestartRequired { epoch: "gate-1".into(), work: vec!["Claude in api".into()] });
        // Less or the same as shown: restarted.
        assert_eq!(gate(Some(&Runtime("gate-1")), "gate-1", &api, |_| Vec::new()), Gate::Restart);
        assert_eq!(gate(Some(&Runtime("gate-1")), "gate-1", &api, |_| vec!["Claude in api".into()]), Gate::Restart);
        // More: asked again, with what it would stop now.
        let Gate::MoreToStop(required) = gate(Some(&Runtime("gate-1")), "gate-1", &api, |_| vec!["Claude in api".into(), "a terminal in web".into()]) else { panic!("asked again") };
        assert_eq!(required.work, ["Claude in api", "a terminal in web"]);
        assert_eq!(offered("gate-1"), Some(required.clone()));
        // The window still showing the first list is asked again, though the
        // offer kept names both now.
        let Gate::MoreToStop(again) = gate(Some(&Runtime("gate-1")), "gate-1", &api, |_| vec!["a terminal in web".into()]) else { panic!("asked again") };
        // The window sent back the text it showed last: restarted.
        assert_eq!(gate(Some(&Runtime("gate-1")), "gate-1", &again.to_string(), |_| vec!["a terminal in web".into()]), Gate::Restart, "once shown");
        // An older text, now superseded, is not.
        assert!(matches!(gate(Some(&Runtime("gate-1")), "gate-1", &required.to_string(), |_| vec!["a terminal in web".into()]), Gate::MoreToStop(_)));
    }

    /// PRO-489: what was shown is the text the window sends back, not the
    /// list kept, which a view built since may have replaced unseen.
    #[test]
    fn restart_runtime_compares_with_the_text_the_window_showed() {
        let _ = offer(RestartRequired { epoch: "shown-1".into(), work: vec!["Claude in api".into()] });
        let displayed = shown("shown-1", &["Claude in api"]);
        // A view built meanwhile read more, and nothing displayed it yet.
        offered_now_for("shown-1", || vec!["Claude in api".into(), "Codex in web".into()]);
        assert!(matches!(gate(Some(&Runtime("shown-1")), "shown-1", &displayed, |_| vec!["Claude in api".into(), "Codex in web".into()]), Gate::MoreToStop(_)));
        // Two works of one name: shown once, two stop now.
        let _ = offer(RestartRequired { epoch: "shown-2".into(), work: vec!["Claude in api".into()] });
        let displayed = shown("shown-2", &["Claude in api"]);
        let Gate::MoreToStop(required) = gate(Some(&Runtime("shown-2")), "shown-2", &displayed, |_| vec!["Claude in api".into(), "Claude in api".into()]) else { panic!("asked again") };
        assert_eq!(required.work, ["Claude in api", "Claude in api"]);
        // Text the window never had: asked again, nothing stopped.
        assert!(matches!(gate(Some(&Runtime("shown-2")), "shown-2", "anything", |_| Vec::new()), Gate::MoreToStop(_)));
    }

    #[test]
    fn counts_names_rather_than_looking_them_up() {
        let names = |names: &[&str]| names.iter().map(|named| named.to_string()).collect::<Vec<_>>();
        assert!(within(&names(&[]), &names(&[])));
        assert!(within(&names(&["a", "b"]), &names(&["b", "a", "c"])));
        assert!(within(&names(&["a", "a"]), &names(&["a", "a"])));
        assert!(!within(&names(&["a", "a"]), &names(&["a"])));
        assert!(!within(&names(&["c"]), &names(&["a"])));
    }

    /// The command body: what it stops and what it answers.
    #[test]
    fn restart_runtime_relaunches_only_what_the_gate_lets_it() {
        let never = |_: &Runtime| -> Result<Arc<Runtime>> { panic!("nothing is stopped") };
        // Replaced since: nothing to do, and the banner goes on the next read.
        assert_eq!(restart_for_window(Some(Arc::new(Runtime("body-other"))), "body-1", "", |_| Vec::new(), never), Ok(()));
        assert_eq!(restart_for_window(Some(Arc::new(Runtime("body-1"))), "body-1", "", |_| Vec::new(), never), Err(NOT_OFFERED.to_string()));
        let _ = offer(RestartRequired { epoch: "body-1".into(), work: vec!["Claude in api".into()] });
        let displayed = shown("body-1", &["Claude in api"]);
        let more = restart_for_window(Some(Arc::new(Runtime("body-1"))), "body-1", &displayed, |_| vec!["Claude in api".into(), "Codex in web".into()], never).unwrap_err();
        assert!(more.starts_with("runtime_restart_required:body-1: ") && more.contains("Claude in api; Codex in web"), "{more}");
        // Shown as it stands: restarted, forced, and the offer withdrawn.
        let relaunched = Cell::new(false);
        restart_for_window(Some(Arc::new(Runtime("body-1"))), "body-1", &more, |_| Vec::new(), |stale| {
            assert_eq!(stale.0, "body-1");
            relaunched.set(true);
            Ok(Arc::new(Runtime("fresh")))
        })
        .unwrap();
        assert!(relaunched.get());
        assert_eq!(offered("body-1"), None);
        // A relaunch that fails says why, and the offer stands.
        let _ = offer(RestartRequired { epoch: "body-2".into(), work: Vec::new() });
        let failed = restart_for_window(Some(Arc::new(Runtime("body-2"))), "body-2", &shown("body-2", &[]), |_| Vec::new(), |_| Err(anyhow!(HANDED_OVER))).unwrap_err();
        assert_eq!(failed, HANDED_OVER);
        assert!(offered("body-2").is_some());
    }

    /// PRO-489: an update hands the runtime over; its offer goes with it.
    #[test]
    fn a_runtime_attached_in_place_of_another_withdraws_its_offer() {
        watch();
        let _ = offer(RestartRequired { epoch: "place-1".into(), work: Vec::new() });
        attached_in_place_of("place-1", "place-1");
        assert!(offered("place-1").is_some(), "the same runtime reattached keeps it");
        attached_in_place_of("place-1", "place-2");
        assert_eq!(offered("place-1"), None);
        assert_eq!(notified("place-1"), 2, "made, then withdrawn");
    }

    /// The app's reattach, in its order, with the supervisor and window
    /// recorded (`AppReattach`).
    struct Attaching {
        calls: RefCell<Vec<String>>,
        attaches_after: usize,
    }

    impl Reattacher<Runtime> for Attaching {
        fn restarting(&self) {
            self.calls.borrow_mut().push("restarting".into());
        }
        fn let_go(&self, stale: &Runtime) {
            self.calls.borrow_mut().push(format!("let go {}", stale.0));
        }
        fn launch_now(&self) {
            self.calls.borrow_mut().push("launch".into());
        }
        fn replaced(&self, epoch: &str) -> Option<Arc<Runtime>> {
            assert_eq!(epoch, "old");
            let looked = self.calls.borrow().iter().filter(|call| *call == "replaced").count();
            self.calls.borrow_mut().push("replaced".into());
            (looked + 1 >= self.attaches_after).then(|| Arc::new(Runtime("fresh")))
        }
        fn reconcile(&self, fresh: &Arc<Runtime>) {
            self.calls.borrow_mut().push(format!("reconcile {}", fresh.0));
        }
    }

    #[test]
    fn reattach_lets_go_launches_then_gives_the_fresh_runtime_the_host_key() {
        let host = Attaching { calls: RefCell::default(), attaches_after: 2 };
        assert_eq!(reattach_by(&host, &Runtime("old"), Duration::from_secs(5)).unwrap().0, "fresh");
        assert_eq!(*host.calls.borrow(), ["restarting", "let go old", "launch", "replaced", "replaced", "reconcile fresh"]);
        // None attaches: said, and no key given to anything.
        let host = Attaching { calls: RefCell::default(), attaches_after: usize::MAX };
        let error = reattach_by(&host, &Runtime("old"), Duration::from_millis(150)).err().unwrap();
        assert!(error.to_string().contains("has not attached yet"), "{error:#}");
        assert!(!host.calls.borrow().iter().any(|call| call.starts_with("reconcile")));
    }

    /// The app's retire (`AppHost::retire`) against a runtime owner holding
    /// a home's socket, as `launch::retire` finds it.
    struct Owner {
        asked: RefCell<Vec<&'static str>>,
        owner: RefCell<Option<std::process::Child>>,
        stops: bool,
        agreed: bool,
    }

    impl Owner {
        fn exit(&self) {
            if let Some(mut owner) = self.owner.borrow_mut().take() {
                owner.kill().unwrap();
                owner.wait().unwrap();
            }
        }
    }

    impl Stops for Owner {
        fn stop_all(&self) -> Result<()> {
            self.asked.borrow_mut().push("stop all");
            if self.stops {
                self.exit();
                Ok(())
            } else {
                anyhow::bail!("timed out")
            }
        }
        fn stop_if_idle(&self) -> Result<()> {
            self.asked.borrow_mut().push("stop if idle");
            if self.stops {
                self.exit();
                Ok(())
            } else {
                anyhow::bail!("timed out")
            }
        }
        fn stopping(&self) -> bool {
            self.asked.borrow_mut().push("stopping");
            self.agreed
        }
    }

    #[test]
    fn retire_asks_restart_runtime_to_stop_all_and_a_repair_only_if_idle() {
        use super::super::launch::tests::{installed_owner, reap, running};
        for (forced, stops, agreed, asked, stopped) in [
            (true, true, false, vec!["stop all"], true),
            (false, true, false, vec!["stop if idle"], true),
            // Restart runtime stops one that does not stop when asked.
            (true, false, false, vec!["stop all"], true),
            // A repair stops one that did not agree only if it agreed.
            (false, false, true, vec!["stop if idle", "stopping"], true),
            (false, false, false, vec!["stop if idle", "stopping"], false),
        ] {
            let fixture = tempfile::tempdir().unwrap();
            let (home, child, terminal) = installed_owner(fixture.path());
            let pid = child.id() as libc::pid_t;
            let owner = Owner { asked: RefCell::default(), owner: RefCell::new(Some(child)), stops, agreed };
            let retired = retire_for_window(&home, &owner, forced);
            assert_eq!(*owner.asked.borrow(), asked, "forced {forced}, stops {stops}, agreed {agreed}");
            assert_eq!(retired.is_ok(), stopped, "forced {forced}, stops {stops}, agreed {agreed}: {retired:?}");
            if !stopped {
                assert!(super::super::launch::left_running(&retired.unwrap_err()));
                assert!(running(pid), "left running");
            }
            let left = owner.owner.borrow_mut().take();
            match left {
                Some(child) => reap(child, terminal),
                // SAFETY: the fixture's own terminal session.
                None => unsafe {
                    libc::kill(-terminal, libc::SIGKILL);
                },
            }
        }
    }

    #[test]
    fn the_offer_shown_names_what_a_restart_would_stop_now() {
        assert_eq!(offered_now_for("now-1", || panic!("no offer, nothing read")), None);
        let _ = offer(RestartRequired { epoch: "now-1".into(), work: vec!["Claude in api".into()] });
        let shown = offered_now_for("now-1", || vec!["Codex in web".into()]).unwrap();
        assert_eq!(shown.work, ["Codex in web"]);
        assert_eq!(offered("now-1").unwrap().work, ["Codex in web"], "kept as shown");
    }

    #[test]
    fn the_fresh_runtime_is_waited_for_until_it_attaches() {
        let looked = Cell::new(0);
        let fresh = attached_within(Duration::from_secs(5), Duration::from_millis(1), || {
            looked.set(looked.get() + 1);
            (looked.get() == 3).then(|| Arc::new(Runtime("fresh")))
        })
        .unwrap();
        assert_eq!((fresh.0, looked.get()), ("fresh", 3));
        let error = attached_within::<Runtime>(Duration::from_millis(20), Duration::from_millis(5), || None).err().unwrap();
        assert!(error.to_string().contains("has not attached yet"), "{error:#}");
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
        let host = Host { connected: vec!["the connection of MacBook".into()], retire: |_, _| panic!("not stopped"), ..Host::idle() };
        let error = relaunch_by(&host, &Runtime("serving-1"), false).err().unwrap();
        let required = error.downcast_ref::<RestartRequired>().expect("restart required");
        assert_eq!(required.work, ["the connection of MacBook", "Claude in api", "a terminal in web"]);
        // Restart runtime stops it all the same.
        let host = Host { connected: vec!["the connection of MacBook".into()], ..Host::idle() };
        assert_eq!(relaunch_by(&host, &Runtime("serving-1"), true).unwrap().0, "fresh");
        assert_eq!(host.calls(), ["replaced", "provision", "retire serving-1 forced=true", "reattach", "unprovision"]);
    }

    #[test]
    fn restart_runtime_that_fails_says_why_instead_of_offering_itself_again() {
        let host = Host {
            retire: |_, forced| {
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
        let host = Host { retire: |_, _| anyhow::bail!("did not exit"), ..Host::idle() };
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
