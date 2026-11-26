//! One desktop attachment and independent PTY views for each of its windows.
//! All connections of one attachment reach the same owner. A closed view is
//! not a process stop, and a failed owner connection is never replaced behind
//! a pending request: losses are reported, and the supervisor replaces the
//! whole attachment or just one window's view (`supervisor.rs`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use anyhow::Result;

use super::{bridge::Bridge, client::{AttachmentIdentity, Blocked, Client, LIFECYCLE_TIMEOUT, QUICK_TIMEOUT}, sessions::Sessions};
use crate::{pty::Tap, sink::EventSink};

/// How long the owner's loop may go without finishing a pass before a window
/// says it is not responding. A pass normally takes a quarter of a second, but
/// the loop shares the sharing and tab locks with prompt delivery, which holds
/// them through a shared or mobile prompt's writes (each at most
/// `pty::INPUT_DEADLINE`, 30 s) and two paste waits (10 s each). This is well
/// past that, so a slow delivery that is still working is never taken for a
/// wedge, and restarting, which stops every agent, is not offered for one.
const LOOP_STALL: Duration = Duration::from_secs(120);

/// An owner too old to know a lifecycle command refuses it as unsupported.
/// How long an owner has to come to rest, write its handover record and say
/// so: each part of it is given 10 seconds, and stopping what it cannot
/// carry, when the reader agreed to, takes as long as Stop does.
/// A runtime that picks its own moment (told how long it has, `patienceMs`)
/// looks for one for most of this, holding nothing still meanwhile.
const HANDOVER_TIMEOUT: Duration = Duration::from_secs(300);
/// What of that is left for it to say so once its time is up.
const HANDOVER_REPLY: Duration = Duration::from_secs(60);
/// How long an owner has to check the binary it would be handed over to: it
/// gives that binary 30 seconds to say which handovers it reads.
const VERIFY_TIMEOUT: Duration = Duration::from_secs(45);

fn unsupported(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| cause.downcast_ref::<super::client::Refused>().is_some_and(|refused| refused.code == "unsupported"))
}

/// How long the owner's loop has gone without finishing a pass, once that is
/// past [`LOOP_STALL`]. An owner too old to say is taken at its word.
fn loop_stalled(liveness: &serde_json::Value) -> Option<Duration> {
    liveness["localRuntime"]["loopAgeMs"].as_u64().map(Duration::from_millis).filter(|age| *age >= LOOP_STALL)
}

/// Attachments, view connections and view renewals are numbered from one
/// sequence, so a later one always has a larger number than an earlier one.
static SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn next() -> u64 { SEQUENCE.fetch_add(1, Ordering::Relaxed) }

/// A connection that ended by itself, or an attachment dropped on purpose
/// while the app goes on running (the sharing fence), and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lost {
    Events { generation: u64, reason: String },
    View { generation: u64, window: String, reason: String },
}

pub type Watch = Arc<dyn Fn(Lost) + Send + Sync>;

#[derive(Default)]
struct Windows {
    bridges: HashMap<String, (u64, Bridge)>,
    /// When each window's view connection was last re-established. Its page
    /// re-attaches its terminals when this changes.
    renewed: HashMap<String, u64>,
}

/// Why a runtime cannot hold bots by this window's proof (PRO-489). `pinned`:
/// the runtime pinned the window's key, and did not take this app for the
/// window, which could not prove it; registering again with the proof
/// repairs it. Otherwise the runtime was started without the key (Keychain
/// could not be read at its launch), and holds bots by where a command comes
/// from, as on Linux, until it is restarted with the key.
#[derive(serde::Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UnprovenWindow {
    pub why: String,
    pub pinned: bool,
    /// The runtime pinned another key than the one this window's Keychain
    /// holds now (it was replaced since), so registering again cannot repair
    /// it: Restart runtime, offered as `runtime_restart_required:<epoch>: …`
    /// (PRO-507). None otherwise, and until the window first says it is
    /// unproven ([`Desktop::unproven_shown`], PRO-508).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restart: Option<String>,
}

/// A window the runtime did not take for the window, as its attachment
/// keeps it.
#[derive(Clone)]
struct Unproven {
    window: UnprovenWindow,
    /// The endpoint it registered, to register again with its proof
    /// ([`Desktop::prove_again`]).
    endpoint: crate::hooks::ControlEndpoint,
    /// The runtime pinned another key than this window's Keychain holds, so
    /// only a restart repairs it. The restart is offered when the window
    /// first says so, not when it registers (PRO-508): with Bots off no
    /// notice shows, and nothing is asked of the runtime or put in
    /// Settings → Machines for it.
    other_key: bool,
}

/// What a registration's answer says of a window not taken for the window:
/// why, whether the runtime pins a key, and whether it pins another than
/// this window proved with. None for a window taken for it. `local`: what
/// kept the proof from being made here.
fn unproven_answer(answer: &serde_json::Value, local: Option<String>) -> Option<(UnprovenWindow, bool)> {
    // Attached, but not taken for the window (review 2): a runtime whose
    // window's key is pinned took no proof from this one, so with Bots on it
    // changes nothing until it can prove it (the Keychain unlocked, then Try
    // again, which registers again with the proof). It still shows what
    // runs, and says so (M2).
    if answer["proven"] == false {
        let why = local.unwrap_or_else(|| answer["message"].as_str().unwrap_or("no proof").to_owned());
        // Proved with another key than the runtime pinned: only a restart
        // pins this window's (PRO-507).
        let other_key = answer["message"].as_str().is_some_and(|message| message.contains(crate::serve_cli::consent::Refusal::OtherKey.says()));
        return Some((UnprovenWindow { why, pinned: true, restart: None }, other_key));
    }
    // A runtime started without the window's key (Keychain could not be read
    // at its launch) holds bots by placement alone; the window says so, for a
    // restart with the key to repair (PRO-489).
    if answer["pinned"] == false {
        let why = answer["message"].as_str().unwrap_or("This runtime was started without the window's key.").to_owned();
        return Some((UnprovenWindow { why, pinned: false, restart: None }, false));
    }
    None
}

/// What an unproven window says of itself where it is shown, which is only
/// while Bots is on (`bots`). The first time, one whose runtime pinned
/// another key offers Restart runtime through `offer`, which asks the runtime
/// what a restart would stop: once, under `offering`, and outside `state`'s
/// lock, which a registration takes.
fn shown(state: &Mutex<Option<Unproven>>, offering: &Mutex<()>, bots: bool, offer: impl FnOnce() -> Option<String>) -> Option<UnprovenWindow> {
    if !bots {
        return None;
    }
    let owed = |unproven: &Unproven| unproven.other_key && unproven.window.restart.is_none();
    let _offering = offering.lock().unwrap_or_else(|e| e.into_inner());
    {
        let state = state.lock().unwrap();
        let unproven = state.as_ref()?;
        if !owed(unproven) {
            return Some(unproven.window.clone());
        }
    }
    let offered = offer();
    let mut state = state.lock().unwrap();
    let unproven = state.as_mut()?;
    if owed(unproven) {
        unproven.window.restart = offered;
    }
    Some(unproven.window.clone())
}

pub struct Desktop {
    client: Arc<Client>,
    events: Bridge,
    sink: Arc<dyn EventSink>,
    watch: Option<Watch>,
    generation: u64,
    windows: Arc<Mutex<Windows>>,
    /// Why the runtime attached this window without taking it for the
    /// window (PRO-489). None once proven, or where none is asked.
    unproven: Mutex<Option<Unproven>>,
    /// Held while the restart is offered for an unproven window ([`shown`]).
    offering: Mutex<()>,
}

impl Desktop {
    /// The owner drains already admitted remote writes before acknowledging.
    pub fn refresh_data_privacy(&self) -> Result<crate::data_privacy::Status> {
        self.client.refresh_data_privacy()
    }

    pub fn connect(client: Arc<Client>, sink: Arc<dyn EventSink>) -> Result<Self> {
        Self::connect_watched(client, sink, None)
    }

    pub fn connect_watched(client: Arc<Client>, sink: Arc<dyn EventSink>, watch: Option<Watch>) -> Result<Self> {
        let generation = next();
        let lost = watch.clone().map(|watch| -> super::bridge::Lost { Box::new(move |reason| watch(Lost::Events { generation, reason })) });
        let events = Bridge::connect(&client, sink.clone(), lost)?;
        Ok(Self { client, events, sink, watch, generation, windows: Arc::default(), unproven: Mutex::default(), offering: Mutex::default() })
    }

    /// Attach again through `client`, which discovery found: the same owner,
    /// or one that replaced it. No request is replayed.
    pub fn reconnect(&self, client: Arc<Client>) -> Result<Self> {
        // End the old event publisher before opening another, and revoke old
        // sharing leases even if the new connection fails. Session processes
        // remain owned by the runtime throughout.
        let previous = self.events.identity();
        self.close();
        // Socket EOF cleanup runs on another owner thread. Complete a control
        // round trip before registering the replacement, so it cannot race a
        // still-valid old window lease. An already-expired lease is harmless;
        // a replaced owner refuses the old epoch, and a hung one times out.
        let _: Result<serde_json::Value> = self.client.call_within("runtime.detach", serde_json::to_value(previous)?, LIFECYCLE_TIMEOUT);
        // The caller must publish the new identity before exposing services.
        Self::connect_watched(client, self.sink.clone(), self.watch.clone())
    }

    /// Install the attachment used to validate incoming calls before the owner
    /// can dispatch any. Failure revokes this attachment, including when the
    /// owner accepted registration but its response was lost.
    pub fn activate_window(self: &Arc<Self>, endpoint: crate::hooks::ControlEndpoint,
        publish: impl FnOnce(&Arc<Self>) -> Result<()>) -> Result<()> {
        let result = publish(self).and_then(|()| self.register_window(endpoint));
        if result.is_err() { self.close(); }
        result
    }

    /// The listener is private to this window. Only the owner publishes home discovery.
    fn register_window(&self, endpoint: crate::hooks::ControlEndpoint) -> Result<()> {
        let attachment = self.attachment()?;
        let registration = serde_json::json!({
            "epoch":attachment.epoch,"lease":attachment.lease,"socket":endpoint.socket,"token":endpoint.token
        });
        let (registered, local) = register_proving(|witnessed| if witnessed {
            self.client.call_within::<serde_json::Value>(crate::serve_cli::consent::WINDOW_REGISTER, registration.clone(), LIFECYCLE_TIMEOUT)
        } else {
            self.client.call_unwitnessed(crate::serve_cli::consent::WINDOW_REGISTER, registration.clone(), LIFECYCLE_TIMEOUT)
        });
        match registered {
            // Its own earlier lease was revoked before this one was taken, so
            // the window services belong to a different desktop process.
            Err(error) if format!("{error:#}").contains("Another desktop currently provides") =>
                Err(Blocked("Another TerminalX window is connected to this background runtime. Close it, then try again.".into()).into()),
            // Not answered, or refused: what was known of this window stays,
            // as when Try again finds the runtime not answering (PRO-508).
            Err(error) => Err(error),
            Ok(answer) => {
                let unproven = unproven_answer(&answer, local);
                if let Some((window, _)) = &unproven {
                    log::warn!("the runtime did not take this window for the window (key pinned: {}): {}", window.pinned, window.why);
                }
                *self.unproven.lock().unwrap() = unproven.map(|(window, other_key)| Unproven { window, endpoint, other_key });
                Ok(())
            }
        }
    }

    /// Why the runtime attached this window without taking it for the
    /// window, while it has not proved it since (PRO-489): while Bots is on,
    /// its session and terminal changes are refused until it does.
    pub fn unproven(&self) -> Option<UnprovenWindow> {
        self.unproven.lock().unwrap().as_ref().map(|unproven| unproven.window.clone())
    }

    /// [`Self::unproven`], as the window's notice shows it, which it does
    /// only while Bots is on (`bots`). The first time, a window whose
    /// runtime pinned another key than its Keychain holds offers Restart
    /// runtime, here and in Settings → Machines (PRO-507): that asks the
    /// runtime what a restart would stop, so it is not done at registration
    /// or while Bots is off, when nothing shows it (PRO-508). Only the
    /// desktop window offers one (`window_consent`).
    pub fn unproven_shown(&self, bots: bool) -> Option<UnprovenWindow> {
        shown(&self.unproven, &self.offering, bots, || {
            #[cfg(all(unix, feature = "desktop"))]
            return Some(super::window_consent::offer_restart(self));
            #[cfg(not(all(unix, feature = "desktop")))]
            None
        })
    }

    /// Register again, with the window's proof: what Try again does once the
    /// Keychain can be read. Whether the runtime now takes this window for
    /// the window; a window it already took, or never asked to prove
    /// itself, has nothing to do.
    pub fn prove_again(&self) -> Result<bool> {
        let Some(unproven) = self.unproven.lock().unwrap().clone() else { return Ok(true) };
        // Only a restart pins a key a runtime started without (`window_consent`),
        // or another than it pinned.
        if !unproven.window.pinned || unproven.other_key {
            return Ok(false);
        }
        self.register_window(unproven.endpoint)?;
        Ok(self.unproven().is_none())
    }

    /// Drop the attachment without reporting it: replacing it, or failing to publish it.
    fn close(&self) {
        self.events.disconnect();
        self.windows.lock().unwrap().bridges.clear();
    }

    /// Drop the attachment on purpose. The app goes on, so the supervisor
    /// attaches again with a new lease; on quit it has been halted first.
    pub fn disconnect(&self) {
        self.close();
        if let Some(watch) = &self.watch {
            watch(Lost::Events { generation: self.generation, reason: "the desktop let the attachment go".into() });
        }
    }

    pub fn attachment(&self) -> Result<AttachmentIdentity> { self.events.attachment() }

    /// The owner this desktop is pinned to, whether or not its events still flow.
    pub fn epoch(&self) -> &str { self.client.epoch() }

    /// The owner's build: its version, and what it can serve a phone (#730).
    pub fn build(&self) -> &super::client::Build { self.client.build() }

    /// The owner's full status. See [`Client::status`].
    pub fn status(&self) -> Result<serde_json::Value> { self.client.status() }

    /// Whether the owner answers, and its own loop still turns. A loop held
    /// up behind a lock is a wedged owner even while it answers (#661). The
    /// question waits on nothing of the owner's, so a probe of a wedged owner
    /// never takes one of its request places for good.
    pub fn probe(&self) -> Result<()> {
        if let Some(age) = loop_stalled(&self.client.liveness(QUICK_TIMEOUT)?) {
            anyhow::bail!("The TerminalX runtime answers, but its work loop has been stuck for {} seconds.", age.as_secs());
        }
        Ok(())
    }

    pub fn generation(&self) -> u64 { self.generation }

    /// When `window`'s view connection was last re-established (0: never).
    pub fn renewed(&self, window: &str) -> u64 {
        self.windows.lock().unwrap().renewed.get(window).copied().unwrap_or(0)
    }

    pub fn sessions(&self) -> Result<Sessions> {
        self.attachment()?;
        Ok(Sessions::new(self.client.clone()))
    }

    pub fn terminals(&self) -> Result<super::terminals::Terminals> {
        self.attachment()?;
        Ok(super::terminals::Terminals::new(self.client.clone()))
    }

    pub fn stop_all(&self) -> Result<()> { self.client.stop_all() }

    /// Whether the owner has agreed to stop: it refuses any new work (#730).
    /// `false` when it does not say, as when it does not answer.
    pub fn stopping(&self) -> bool {
        self.client.liveness(QUICK_TIMEOUT).is_ok_and(|liveness| liveness["localRuntime"]["stopping"] == true)
    }

    /// What stopping the owner now would cut short, as it says (#730).
    /// `None` from an owner too old to say: TerminalX 0.2.22 and before.
    pub fn work(&self) -> Result<Option<Vec<crate::session::retire::Work>>> {
        match self.client.quick::<serde_json::Value>("runtime.work", serde_json::json!({})) {
            Ok(answer) => Ok(Some(serde_json::from_value(answer["work"].clone())?)),
            Err(error) if unsupported(&error) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// What handing the owner over to `binary` would have to stop: the agents
    /// its handover record cannot carry (#765). Refused by an owner that
    /// cannot be handed over to `binary` (`handover_unsupported`).
    /// Given no `binary`, only what would have to stop is asked, which
    /// waits on nothing but the tabs.
    pub fn handover_plan(&self, binary: Option<&std::path::Path>) -> Result<Vec<crate::session::retire::Work>> {
        let params = serde_json::json!({"epoch": self.client.epoch(), "binary": binary});
        // Checking a binary new to this Mac may wait on its security checks.
        let answer: serde_json::Value = match binary {
            Some(_) => self.client.call_within("runtime.handover.plan", params, VERIFY_TIMEOUT)?,
            None => self.client.quick("runtime.handover.plan", params)?,
        };
        Ok(serde_json::from_value(answer["unadoptable"].clone())?)
    }

    /// Replace the owner with `binary` in its own process, keeping every
    /// agent and terminal it runs (#765), stopping first only `stop`, which
    /// the reader agreed to. Returns once the owner says it is handing over;
    /// [`super::launch::taken_over`] says when the new runtime answers.
    pub fn hand_over(&self, binary: &std::path::Path, stop: &[crate::session::retire::Work], within: Option<Duration>) -> Result<()> {
        let within = within.unwrap_or(HANDOVER_TIMEOUT);
        self.hand_over_patiently(binary, stop, within, within.saturating_sub(HANDOVER_REPLY.min(within / 2)))
    }

    /// [`Self::hand_over`], waiting `within` for an owner told it has
    /// `patience` to find its moment. With more patience than that, an owner
    /// that picks its own moment goes on looking after this has given up on
    /// hearing of it, and hands over when it finds one, whoever is there to
    /// be told: as an update that is about to relaunch the app wants.
    pub fn hand_over_patiently(&self, binary: &std::path::Path, stop: &[crate::session::retire::Work], within: Duration, patience: Duration) -> Result<()> {
        // A runtime that picks its own moment is told how long it has to
        // find one; one from before it could answers within its own limits.
        let _: serde_json::Value = self.client.call_within("runtime.handover",
            serde_json::json!({"epoch": self.client.epoch(), "binary": binary, "stop": stop, "patienceMs": patience.as_millis() as u64}), within)?;
        Ok(())
    }

    /// Stop the owner as Stop All does, only if nothing would be cut short,
    /// as the owner decides under the lock that admits work (#730). A refusal
    /// says `runtime_busy`. `false` from an owner too old to decide.
    pub fn stop_all_if_idle(&self) -> Result<bool> {
        match self.client.call::<serde_json::Value>("runtime.stopAllIfIdle", serde_json::json!({"epoch": self.client.epoch()})) {
            Ok(_) => Ok(true),
            Err(error) if unsupported(&error) => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// Internal owner RPC only. Identity comes from the desktop's verified
    /// account, never from a guest frame; owner-side admission remains final.
    #[cfg(feature = "desktop")]
    pub(crate) fn sharing(&self, context: &crate::account::AccountContext, method: &str, mut params: serde_json::Value) -> Result<serde_json::Value> {
        use serde_json::json;
        let attachment = self.attachment()?;
        let actor = json!({ "epoch": attachment.epoch, "lease": attachment.lease,
            "generation": context.generation, "userId": context.user_id,
            "profileId": context.profile_id, "organizationId": context.organization_id });
        // Registering and reading the share are quick; changes such as a stop
        // may wait for the agents they act on.
        if method != "clear" {
            let _: serde_json::Value = self.client.quick("runtime.sharing.register", json!({"actor": actor}))?;
        }
        let object = params.as_object_mut().ok_or_else(|| anyhow::anyhow!("Sharing parameters must be an object."))?;
        object.insert("actor".into(), actor);
        let command = format!("runtime.sharing.{method}");
        if matches!(method, "status" | "clear") { self.client.quick(&command, params) } else { self.client.call(&command, params) }
    }


    #[cfg(feature = "desktop")]
    pub(crate) fn mobile(&self, actor: &super::mobile::Actor, method: &str, mut params: serde_json::Value) -> Result<serde_json::Value> {
        let attachment = self.attachment()?;
        if actor.epoch != attachment.epoch || actor.lease != attachment.lease {
            anyhow::bail!("The paired-device attachment changed. Reconnect the device.");
        }
        params.as_object_mut().ok_or_else(|| anyhow::anyhow!("Mobile parameters must be an object."))?
            .insert("actor".into(), serde_json::to_value(actor)?);
        // Fences and checks are quick; they also run as the app quits.
        let command = format!("runtime.mobile.{method}");
        if matches!(method, "clear" | "revoke" | "check") { self.client.quick(&command, params) } else { self.client.call(&command, params) }
    }

    /// The runtime's machine host (PRO-341, `crate::machine_wire`): its
    /// status, or `None` from a runtime too old to host.
    #[cfg(feature = "desktop")]
    pub(crate) fn machine_host_status(&self) -> Result<Option<crate::machine_wire::Status>> {
        match self.client.quick::<serde_json::Value>(crate::machine_wire::STATUS, serde_json::json!({})) {
            Ok(status) => Ok(Some(serde_json::from_value(status)?)),
            Err(error) if unsupported(&error) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// A machine host command that names this attachment. One only a person
    /// may send, refused because this runtime cannot verify the window, is
    /// sent again to a fresh runtime the window launches (PRO-486,
    /// `window_consent`).
    #[cfg(all(unix, feature = "desktop"))]
    pub(crate) fn machine_host(&self, command: &str, params: serde_json::Value) -> Result<serde_json::Value> {
        let relaunch = super::window_consent::installed().map(|relaunch| relaunch.as_ref() as super::window_consent::Relaunching<'_, Self>);
        super::window_consent::guarded(self, command, params, |runtime, params| runtime.machine_host_once(command, params), relaunch)
    }

    /// A Bots action from this window (PRO-468). One that gives a bot more
    /// carries this window's proof, and a runtime that cannot verify it is
    /// repaired as for pairing: a fresh runtime when nothing would stop, else
    /// Restart runtime offered (`window_consent::guarded`). An update that
    /// gives nothing more asks for no proof: the runtime judges it again itself.
    #[cfg(all(unix, feature = "desktop"))]
    pub(crate) fn bots(&self, operation: &str, params: serde_json::Value) -> Result<serde_json::Value> {
        use crate::serve_cli::consent;
        let mut request = serde_json::json!({"operation": operation, "params": params});
        // An update that gives the bot nothing more (`bots::gives_more`) is sent without a proof.
        if operation == "update" {
            if let Ok(patch) = serde_json::from_value::<crate::bots::BotPatch>(request["params"]["patch"].clone()) {
                let current = self.sessions()?.bots::<crate::bots::Bot>("get", serde_json::json!({"id": request["params"]["id"]})).ok();
                request[consent::GIVES_MORE] = serde_json::json!(current.is_none_or(|bot| crate::bots::gives_more(&bot, &patch)));
            }
        }
        if !consent::guards_request(consent::BOTS_COMMAND, &request) {
            return self.sessions()?.bots_request(request);
        }
        let relaunch = super::window_consent::installed().map(|relaunch| relaunch.as_ref() as super::window_consent::Relaunching<'_, Self>);
        super::window_consent::guarded(self, consent::BOTS_COMMAND, request, |runtime, request| runtime.sessions()?.bots_request(request), relaunch)
    }

    /// [`Self::bots`] on Windows: no window signs for a Bots action there, so
    /// nothing is proved or repaired; the runtime refuses what needs a
    /// person and judges an `update` itself (`control::bots_without_a_window`).
    #[cfg(all(not(unix), feature = "desktop"))]
    pub(crate) fn bots(&self, operation: &str, params: serde_json::Value) -> Result<serde_json::Value> {
        self.sessions()?.bots_request(serde_json::json!({"operation": operation, "params": params}))
    }

    /// [`Self::machine_host`] with no one at the window to ask, as for an
    /// account pairing grant: a runtime that cannot verify the window is not
    /// restarted for it, and Settings → Machines offers the restart instead
    /// (PRO-486, `window_consent::unattended`).
    #[cfg(all(unix, feature = "desktop"))]
    pub(crate) fn machine_host_unattended(&self, command: &str, params: serde_json::Value) -> Result<serde_json::Value> {
        let repairable = super::window_consent::installed().is_some();
        super::window_consent::unattended(self, command, params, |runtime, params| runtime.machine_host_once(command, params), repairable, super::window_consent::in_use)
    }

    /// Windows has no `window_consent` (PRO-486): its consent
    /// (`consent_windows.rs`) has no missing-Keychain-key refusal to repair by
    /// relaunching the runtime, so a refusal reaches the caller as it is.
    #[cfg(all(not(unix), feature = "desktop"))]
    pub(crate) fn machine_host(&self, command: &str, params: serde_json::Value) -> Result<serde_json::Value> {
        self.machine_host_once(command, params)
    }

    /// [`Self::machine_host`] with no one at the window to ask; the same on Windows.
    #[cfg(all(not(unix), feature = "desktop"))]
    pub(crate) fn machine_host_unattended(&self, command: &str, params: serde_json::Value) -> Result<serde_json::Value> {
        self.machine_host_once(command, params)
    }

    #[cfg(feature = "desktop")]
    fn machine_host_once(&self, command: &str, mut params: serde_json::Value) -> Result<serde_json::Value> {
        let attachment = self.attachment()?;
        let object = params.as_object_mut().ok_or_else(|| anyhow::anyhow!("Machine host parameters must be an object."))?;
        object.insert("epoch".into(), attachment.epoch.into());
        object.insert("lease".into(), attachment.lease.into());
        self.client.quick(command, params)
    }

    /// A relay control request through the runtime's registration
    /// (`machine_wire::RELAY_CONTROL`, PRO-368). The runtime waits up to 15 s
    /// for the relay, so this allows a little more than a quick call.
    #[cfg(feature = "desktop")]
    pub(crate) fn relay_control(&self, frame: serde_json::Value) -> Result<serde_json::Value> {
        let attachment = self.attachment()?;
        self.client.call_within(
            crate::machine_wire::RELAY_CONTROL,
            serde_json::json!({ "epoch": attachment.epoch, "lease": attachment.lease, "frame": frame }),
            std::time::Duration::from_secs(20),
        )
    }

    /// A view connection for `window`. When it ends by itself it leaves the
    /// window, so the next attach opens another, and the loss is reported.
    fn view(&self, window: &str) -> Result<(u64, Bridge)> {
        let id = next();
        let windows = Arc::downgrade(&self.windows);
        let (watch, generation, label) = (self.watch.clone(), self.generation, window.to_owned());
        let lost: super::bridge::Lost = Box::new(move |reason| {
            let Some(windows) = Weak::upgrade(&windows) else { return };
            let dead = {
                let mut windows = windows.lock().unwrap();
                if windows.bridges.get(&label).is_some_and(|(current, _)| *current == id) { windows.bridges.remove(&label) } else { None }
            };
            // Dropped outside the lock: dropping a bridge takes its own lock.
            drop(dead);
            // Reported even when an attach already replaced it: views attached
            // over the dead one still have to move to the new one.
            if let Some(watch) = watch { watch(Lost::View { generation, window: label, reason }); }
        });
        Ok((id, Bridge::connect_views(&self.client, self.sink.clone(), window, Some(lost))?))
    }

    pub fn attach(&self, window: &str, id: &str, token: &str, tap: Tap) -> Result<()> {
        self.attach_sized(window, id, token, Box::new(move |bytes, _| tap(bytes)))
    }

    pub fn attach_sized(&self, window: &str, id: &str, token: &str, tap: crate::pty::SizedTap) -> Result<()> {
        self.attachment()?;
        let mut windows = self.windows.lock().unwrap();
        if !windows.bridges.get(window).is_some_and(|(_, bridge)| bridge.attachment().is_ok()) {
            let view = self.view(window)?;
            windows.bridges.insert(window.into(), view);
        }
        windows.bridges[window].1.attach_sized(id, token, tap)
    }

    /// Re-establish `window`'s view connection after a loss, and mark it
    /// renewed so the window's page attaches its terminals to it.
    pub fn reopen_view(&self, window: &str) -> Result<u64> {
        self.attachment()?;
        let mut windows = self.windows.lock().unwrap();
        if !windows.bridges.get(window).is_some_and(|(_, bridge)| bridge.attachment().is_ok()) {
            let view = self.view(window)?;
            windows.bridges.insert(window.into(), view);
        }
        let renewed = next();
        windows.renewed.insert(window.into(), renewed);
        Ok(renewed)
    }

    pub fn ack(&self, window: &str, id: &str, token: &str, drawn: u64) -> Result<()> {
        if let Some((_, bridge)) = self.windows.lock().unwrap().bridges.get(window) {
            bridge.ack(id, token, drawn)?;
        }
        Ok(())
    }

    pub fn detach(&self, window: &str, id: &str, token: &str) -> Result<()> {
        if let Some((_, bridge)) = self.windows.lock().unwrap().bridges.get(window) {
            bridge.detach(id, token)?;
        }
        Ok(())
    }

    /// Page reload or window destruction releases just that window's lease and
    /// outstanding bytes. A new page obtains a fresh connection and replay.
    pub fn detach_window(&self, window: &str) {
        let dropped = self.windows.lock().unwrap().bridges.remove(window);
        drop(dropped);
    }
}

/// The window's registration, sent through `send` (witnessed or not), and
/// what kept its proof from being made here: Keychain locked or denied.
/// Witnessed, with the window's proof (PRO-489): while Bots is on, a runtime
/// whose window's key is pinned takes only a registrant that proves it for
/// the window. One that does not answer in time is sent once more with its
/// proof (PRO-507): registering again on the same lease is the same
/// registration. One that still does not answer is the answer (PRO-508): the
/// runtime may yet take either send, and one without the proof after them
/// would undo what they proved, so none is sent, and the wait ends at two
/// sends. A runtime from before the proof refuses the witness as an unknown
/// field, and a window that cannot read its key makes none: each registers
/// as before, without it, and the runtime judges.
fn register_proving(mut send: impl FnMut(bool) -> Result<serde_json::Value>) -> (Result<serde_json::Value>, Option<String>) {
    let unanswered = |answer: &Result<serde_json::Value>| answer.as_ref().err().is_some_and(|error| error.downcast_ref::<super::client::Unresponsive>().is_some());
    let mut answer = send(true);
    if unanswered(&answer) {
        log::info!("the window's registration with its proof was not answered in time; sending it once more");
        answer = send(true);
        if unanswered(&answer) {
            return (answer, None);
        }
    }
    match answer {
        Err(error) if error.downcast_ref::<super::client::Refused>().is_none_or(|refused| refused.message.contains("Invalid desktop registration")) => {
            log::info!("register the window without its proof: {error:#}");
            let local = error.downcast_ref::<super::client::Refused>().is_none().then(|| format!("{error:#}"));
            (send(false), local)
        }
        answered => (answered, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// PRO-507: a registration with the window's proof that is not answered
    /// in time is sent once more with it; one that is refused is not sent
    /// again, and a proof that cannot be made here says why. PRO-508: one
    /// unanswered twice is not sent a third time without the proof, which
    /// would undo what a late-taken send proved; so no sequence of answers
    /// waits out more than two sends.
    #[test]
    fn an_unanswered_registration_is_sent_once_more_with_its_proof_and_never_without_it() {
        use super::super::client::{Refused, Unresponsive};
        type Answer = Box<dyn Fn() -> Result<serde_json::Value>>;
        let timeout = || -> Answer { Box::new(|| Err(Unresponsive { command: "register".into(), waited: LIFECYCLE_TIMEOUT }.into())) };
        let old_runtime = || -> Answer { Box::new(|| Err(Refused { code: "desktop_unavailable".into(), message: "Invalid desktop registration.".into() }.into())) };
        let locked = || -> Answer { Box::new(|| Err(anyhow::anyhow!("Keychain is locked"))) };
        let registered = || -> Answer { Box::new(|| Ok(json!({"registered": true}))) };
        // What was sent, the answer, what kept the proof from being made, and
        // how many sends went unanswered: each of those waits LIFECYCLE_TIMEOUT.
        let run = |answers: Vec<Answer>| {
            let mut sent = Vec::new();
            let mut waited = 0;
            let mut answers = answers.into_iter();
            let (answer, local) = register_proving(|witnessed| {
                sent.push(witnessed);
                let answer = answers.next().expect("no more sends")();
                if answer.as_ref().is_err_and(|error| error.downcast_ref::<Unresponsive>().is_some()) { waited += 1; }
                answer
            });
            assert!(answers.next().is_none(), "every scripted answer was asked for");
            (sent, answer.map_err(|error| format!("{error:#}")), local, waited)
        };
        let (sent, answer, local, _) = run(vec![timeout(), registered()]);
        assert_eq!((sent, answer, local), (vec![true, true], Ok(json!({"registered": true})), None), "answered the second time, with its proof");

        // Twice unanswered: that is the answer. No send without the proof follows.
        let mut sent = Vec::new();
        let (answer, local) = register_proving(|witnessed| { sent.push(witnessed); timeout()() });
        assert_eq!(sent, vec![true, true], "never a third send, and none without the proof");
        assert!(answer.unwrap_err().downcast_ref::<Unresponsive>().is_some() && local.is_none(), "the runtime is not answering");

        let (sent, answer, ..) = run(vec![Box::new(|| Err(Refused { code: "unavailable".into(), message: "Another desktop currently provides this runtime's window services.".into() }.into()))]);
        assert!(sent == vec![true] && answer.unwrap_err().contains("Another desktop"), "a refusal is the answer");
        let (sent, _, local, _) = run(vec![locked(), registered()]);
        assert_eq!((sent, local.as_deref()), (vec![true, false], Some("Keychain is locked")), "no proof made here: without it, and why");
        let (sent, answer, local, _) = run(vec![old_runtime(), registered()]);
        assert_eq!((sent, answer, local), (vec![true, false], Ok(json!({"registered": true})), None), "a runtime from before the proof: without it");

        // The wait is at most two sends (20 s), whatever is answered between.
        for (answers, sends) in [
            (vec![timeout(), timeout()], vec![true, true]),
            (vec![timeout(), old_runtime(), timeout()], vec![true, true, false]),
            (vec![timeout(), locked(), timeout()], vec![true, true, false]),
            (vec![old_runtime(), timeout()], vec![true, false]),
            (vec![locked(), timeout()], vec![true, false]),
        ] {
            let (sent, answer, _, waited) = run(answers);
            assert!(answer.is_err() && waited <= 2, "{sent:?} waited out {waited} sends");
            assert_eq!(sent, sends);
        }
    }

    fn unproven_state(answer: serde_json::Value) -> Mutex<Option<Unproven>> {
        let endpoint = crate::hooks::ControlEndpoint::adopted("/run/w.sock".into(), "ab".repeat(16));
        Mutex::new(unproven_answer(&answer, None).map(|(window, other_key)| Unproven { window, endpoint, other_key }))
    }

    fn other_key_answer() -> serde_json::Value {
        json!({"registered": true, "proven": false, "message": format!("This was refused: {}.", crate::serve_cli::consent::Refusal::OtherKey.says())})
    }

    /// PRO-508: a window whose runtime pinned another key than its Keychain
    /// holds records no restart offer when it registers, and asks the runtime
    /// nothing for one; nor while Bots is off, however often its status is
    /// read. Bots on, the first time it says it is unproven it offers the
    /// restart, once.
    #[test]
    fn a_replaced_key_offers_the_restart_only_when_the_window_says_so_with_bots_on() {
        let offers = AtomicU64::new(0);
        let offer = || { offers.fetch_add(1, Ordering::SeqCst); Some("runtime_restart_required:e: Restart runtime starts a new one.".to_owned()) };
        let (state, offering) = (unproven_state(other_key_answer()), Mutex::new(()));
        let registered = state.lock().unwrap().clone().unwrap();
        assert!(registered.other_key && registered.window.pinned && registered.window.restart.is_none(), "registered: nothing offered yet");

        for _ in 0..3 {
            assert_eq!(shown(&state, &offering, false, offer), None, "Bots off: no notice");
        }
        assert_eq!(offers.load(Ordering::SeqCst), 0, "Bots off: nothing asked of the runtime, nothing offered");
        assert!(state.lock().unwrap().as_ref().unwrap().window.restart.is_none());

        let said = shown(&state, &offering, true, offer).unwrap();
        assert!(said.restart.as_deref().is_some_and(|restart| restart.starts_with("runtime_restart_required:e:")), "{said:?}");
        assert_eq!(shown(&state, &offering, true, offer), Some(said.clone()));
        assert_eq!(offers.load(Ordering::SeqCst), 1, "offered once, not on every status read");
        // Bots off again: the notice goes, and nothing more is asked.
        assert_eq!(shown(&state, &offering, false, offer), None);
        assert_eq!(offers.load(Ordering::SeqCst), 1);

        // Read from several windows at once: still one offer.
        let (state, offering) = (unproven_state(other_key_answer()), Mutex::new(()));
        std::thread::scope(|scope| for _ in 0..4 {
            scope.spawn(|| assert!(shown(&state, &offering, true, offer).unwrap().restart.is_some()));
        });
        assert_eq!(offers.load(Ordering::SeqCst), 2);

        // Proven while the restart was being worked out: nothing is said.
        let (state, offering) = (unproven_state(other_key_answer()), Mutex::new(()));
        assert_eq!(shown(&state, &offering, true, || { *state.lock().unwrap() = None; Some("offer".into()) }), None);
    }

    /// Only a replaced key offers a restart: a locked Keychain is repaired
    /// by Try again, and a runtime with no key pinned by Settings → Machines.
    #[test]
    fn a_window_that_can_prove_itself_again_or_has_no_key_pinned_offers_no_restart() {
        let never = || -> Option<String> { panic!("no restart is offered for this") };
        let offering = Mutex::new(());
        let (window, other_key) = unproven_answer(&json!({"registered": false, "proven": false, "message": "refused"}), Some("Keychain is locked".into())).unwrap();
        assert_eq!((window.clone(), other_key), (UnprovenWindow { why: "Keychain is locked".into(), pinned: true, restart: None }, false));
        let locked = unproven_state(json!({"registered": false, "proven": false, "message": "refused"}));
        assert_eq!(shown(&locked, &offering, true, never).unwrap().why, "refused");
        let unpinned = unproven_state(json!({"registered": true, "pinned": false, "message": "no key"}));
        assert_eq!(shown(&unpinned, &offering, true, never), Some(UnprovenWindow { why: "no key".into(), pinned: false, restart: None }));
        assert!(unproven_answer(&json!({"registered": true}), None).is_none(), "taken for the window");
        assert_eq!(shown(&unproven_state(json!({"registered": true})), &offering, true, never), None);
    }

    #[test]
    fn only_a_loop_stuck_past_the_limit_is_a_wedge() {
        let age = |ms: u64| json!({"localRuntime": {"loopAgeMs": ms}});
        assert_eq!(loop_stalled(&age(250)), None);
        assert_eq!(loop_stalled(&age(LOOP_STALL.as_millis() as u64 - 1)), None, "a slow delivery that still works");
        assert_eq!(loop_stalled(&age(LOOP_STALL.as_millis() as u64)), Some(LOOP_STALL));
        assert_eq!(loop_stalled(&age(7 * 3600 * 1000)), Some(Duration::from_secs(7 * 3600)));
        // An owner still starting, or too old to say, is not judged by it.
        assert_eq!(loop_stalled(&json!({"localRuntime": {"loopAgeMs": null}})), None);
        assert_eq!(loop_stalled(&json!({"localRuntime": {}})), None);
    }
}
