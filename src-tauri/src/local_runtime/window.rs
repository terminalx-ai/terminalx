//! Fixed window-only services registered by an authenticated desktop attachment.
//! The background owner never becomes a generic proxy for a guest-supplied RPC.
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use serde::Deserialize;
use serde_json::{json, Value};
use crate::control::{ControlError, ControlRequest, ControlResponse};
use super::{Attachment, Lifetime};

const MAX_RESPONSE: u64 = 32 * 1024 * 1024;
const MAX_CALLS: usize = 16;

pub(crate) fn supported(command: &str) -> bool {
    matches!(command,
        "computer.selfUi.authorize" | "computer.selfUi.snapshot" | "computer.selfUi.click" | "computer.selfUi.revoke"
         | "computer.permissions" | "computer.permissionsStatus" | "computer.permissionsReset" | "computer.capabilities"
         | "computer.listApps" | "computer.listWindows" | "computer.getAppState" | "computer.click"
         | "computer.performSecondaryAction" | "computer.scroll" | "computer.drag" | "computer.typeText"
         | "computer.pressKey" | "computer.hotkey" | "computer.pasteText" | "computer.setValue"
         | "browser.status" | "browser.tab.list" | "browser.tab.create" | "browser.tab.show"
         | "browser.tab.current" | "browser.tab.switch" | "browser.tab.close" | "browser.tab.profile.list"
         | "browser.tab.profile.create" | "browser.tab.profile.delete" | "browser.tab.profile.show" | "browser.tab.profile.set"
         | "browser.tab.profile.use-default" | "browser.tab.profile.clone" | "browser.goto" | "browser.back"
         | "browser.forward" | "browser.reload" | "browser.snapshot" | "browser.screenshot"
         | "browser.full-screenshot" | "browser.pdf" | "browser.eval" | "browser.scroll"
         | "browser.wait" | "browser.click" | "browser.dblclick" | "browser.hover"
         | "browser.focus" | "browser.check" | "browser.uncheck" | "browser.scrollintoview"
         | "browser.highlight" | "browser.fill" | "browser.type" | "browser.inserttext"
         | "browser.select" | "browser.clear" | "browser.select-all" | "browser.keypress"
         | "browser.drag" | "browser.upload" | "browser.download" | "browser.get"
         | "browser.is" | "browser.find" | "browser.mouse.move" | "browser.mouse.down"
         | "browser.mouse.up" | "browser.mouse.wheel" | "browser.exec" | "browser.cookie.get"
         | "browser.cookie.set" | "browser.cookie.delete" | "browser.console" | "browser.network"
         | "browser.capture.start" | "browser.capture.stop" | "browser.intercept.enable" | "browser.intercept.disable"
         | "browser.intercept.list" | "browser.viewport" | "browser.geolocation" | "browser.set.device"
         | "browser.set.offline" | "browser.set.headers" | "browser.set.credentials" | "browser.set.media"
         | "browser.clipboard.read" | "browser.clipboard.write" | "browser.dialog.accept" | "browser.dialog.dismiss"
         | "browser.dialog.status" | "browser.storage.local.get" | "browser.storage.local.set" | "browser.storage.local.clear"
         | "browser.storage.session.get" | "browser.storage.session.set" | "browser.storage.session.clear" | "cloud.status" | "cloud.projects.list"
         | "cloud.sessions.list" | "cloud.sessions.create" | "cloud.send" | "cloud.read"
         | "cloud.wait" | "cloud.stop" | "cloud.resume" | "share.create"
         | "share.list" | "share.edit" | "share.revoke" | "share.remove"
         | "share.approve" | "share.note" | "share.takeover"
         | "floating.show" | "floating.hide" | "floating.toggle"
         | "perf.terminal.start" | "perf.terminal.poll" | "window.terminalCounters"
         | "window.open" | "window.quit" | "window.stopAllAndQuit"
    ) || crate::machine_control::supported(command)
}

/// The subset of [`supported`] window services that strictly read state and
/// perform no UI automation, sharing, or remote mutation (S-16 default-deny).
pub(crate) fn read_only(command: &str) -> bool {
    matches!(
        command,
        "cloud.status" | "cloud.projects.list" | "cloud.sessions.list" | "cloud.read" | "cloud.wait"
            | "machine.list" | "machine.status" | "machine.projects.list" | "machine.sessions.list"
            | "machine.tabs.list" | "machine.read" | "machine.wait" | "machine.permissions.list"
            | "machine.worktrees.list"
    )
}

/// A window service asked for while the attached window has not proved it is
/// the window and Bots is on (PRO-507).
pub(crate) const UNPROVEN: &str = "While Bots is on, this TerminalX runtime takes window services only from a window that proves it is TerminalX with its key in Keychain, and the window attached has not.";

fn unavailable(message: impl Into<String>) -> ControlError {
    ControlError::new("desktop_unavailable",message,Some("Open TerminalX. Check the result before repeating an action; it was not replayed.".into()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Dispatch { epoch: String, lease: String, command: String, params: Value }

pub(crate) fn receive(request: &ControlRequest, current: &super::client::AttachmentIdentity) -> Result<(String, Value), ControlError> {
    if request.command != "window.dispatch" { return Err(unavailable("Only registered window dispatch is accepted.")); }
    let dispatch: Dispatch = serde_json::from_value(request.params.clone()).map_err(|_| unavailable("Invalid window dispatch."))?;
    if dispatch.epoch != current.epoch || dispatch.lease != current.lease || !(supported(&dispatch.command) || matches!(dispatch.command.as_str(), "environment.snapshot" | "agentKey.snapshot")) {
        return Err(unavailable("This request does not belong to the current desktop attachment."));
    }
    Ok((dispatch.command,dispatch.params))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Registration { epoch: String, lease: String, socket: PathBuf, token: String }

struct Service {
    attachment: Arc<Attachment>,
    epoch: String,
    lease: String,
    socket: PathBuf,
    token: zeroize::Zeroizing<String>,
    calls: AtomicUsize,
    /// Registered without the window's proof on a runtime that pins its key,
    /// while Bots was off (PRO-489): it serves only while Bots stays off, and
    /// gives way to a registration that proves it (PRO-507).
    unproven: bool,
}

/// The endpoint a desktop registers must be one of this runtime's own: a
/// private socket in its `run` directory, or on Windows a pipe of its home
/// (every dial to it then checks the pipe is this user's and served by one
/// of this user's processes).
fn private_endpoint(socket: &std::path::Path) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{FileTypeExt, MetadataExt};
        let run = crate::paths::canonicalize(crate::store::root()?.join("run"))?;
        let parent = socket.parent().ok_or_else(|| anyhow::anyhow!("missing parent"))?;
        if crate::paths::canonicalize(parent)? != run { anyhow::bail!("window endpoint must be in this runtime's private directory"); }
        let metadata = std::fs::symlink_metadata(socket)?;
        // SAFETY: geteuid has no preconditions.
        if !metadata.file_type().is_socket() || metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            anyhow::bail!("window endpoint must be a private socket");
        }
    }
    #[cfg(windows)]
    if !crate::ipc::in_home(&crate::paths::canonicalize(crate::store::root()?)?, socket) {
        anyhow::bail!("window endpoint must be one of this runtime's own pipes");
    }
    Ok(())
}

#[derive(Default)]
pub(crate) struct Registry(Mutex<Option<Arc<Service>>>, Mutex<Option<Recognised>>, Mutex<Option<Arc<Attachment>>>);

/// The window's process (pid, start time), and whether this runtime saw it
/// prove it is the window; one a handover carried over, or one taken by
/// where it runs, it did not.
#[derive(Clone, Copy)]
struct Recognised { process: (i32, u64), proven: bool }

/// The window's process this runtime last knew, for a handover to carry (PRO-468).
static KNOWN_WINDOW: Mutex<Option<(i32, u64)>> = Mutex::new(None);

/// The window's process as this runtime knows it now: for the handover record.
#[cfg(unix)]
pub(crate) fn known_window() -> Option<(i32, u64)> {
    *KNOWN_WINDOW.lock().unwrap_or_else(|e| e.into_inner())
}

impl Registry {
    pub(crate) fn register(&self, lifetime: &Lifetime, params: Value) -> Result<Value, ControlError> {
        self.register_as(lifetime, params, false)
    }

    /// [`Self::register`], for a window that did not prove it is the window
    /// on a runtime that pins its key. Kept only for legacy slot bookkeeping;
    /// unproven providers never serve window RPCs (S-37).
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn register_unproven(&self, lifetime: &Lifetime, params: Value) -> Result<Value, ControlError> {
        self.register_as(lifetime, params, true)
    }

    /// A registration as it must be before it is taken, or changes anything
    /// here: on a current attachment of this runtime, naming a private
    /// endpoint of it and a credential of the right shape.
    fn checked(lifetime: &Lifetime, params: Value) -> Result<(Registration, Arc<Attachment>), ControlError> {
        let registration: Registration = serde_json::from_value(params).map_err(|_| unavailable("Invalid desktop registration."))?;
        let attachment = lifetime.attachment(&registration.epoch,&registration.lease).map_err(|_| unavailable("The desktop attachment is no longer current."))?;
        let checked = (|| -> anyhow::Result<()> {
            private_endpoint(&registration.socket)?;
            if !(32..=256).contains(&registration.token.len()) || !registration.token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                anyhow::bail!("invalid window credential");
            }
            Ok(())
        })();
        if checked.is_err() { return Err(unavailable("The desktop endpoint is not a private endpoint of this runtime.")); }
        Ok((registration, attachment))
    }

    /// Whether `params` is a registration this runtime would consider, as
    /// [`Self::register`] refuses one that is not. A registration that did
    /// not prove it is the window is checked so before it unseats anyone or
    /// is noted as refused (PRO-508): the control token alone, which every
    /// agent tab holds, sends none that passes.
    pub(crate) fn validate(&self, lifetime: &Lifetime, params: &Value) -> Result<(), ControlError> {
        Self::checked(lifetime, params.clone()).map(drop)
    }

    fn register_as(&self, lifetime: &Lifetime, params: Value, unproven: bool) -> Result<Value, ControlError> {
        let (registration, attachment) = Self::checked(lifetime, params)?;
        let mut current = self.0.lock().unwrap();
        if let Some(previous) = current.as_ref().filter(|service| service.attachment.valid()) {
            let same = previous.lease == registration.lease && previous.socket == registration.socket
                && crate::hooks::token_matches(&previous.token,&registration.token);
            // An unproven provider serves nothing (S-37) and always gives way
            // to a subsequent registration.
            let gives_way = previous.unproven;
            if same && (!previous.unproven || unproven) {
                return Ok(json!({"registered":true}));
            }
            if !same && !gives_way {
                return Err(unavailable("Another desktop currently provides this runtime's window services."));
            }
        }
        let registered = attachment.enter().map_err(|_| unavailable("The desktop detached during registration."))?;
        *current = Some(Arc::new(Service { attachment: attachment.clone(), epoch: registration.epoch, lease: registration.lease, socket: registration.socket,
            token: zeroize::Zeroizing::new(registration.token), calls: AtomicUsize::new(0), unproven }));
        drop(registered);
        *self.2.lock().unwrap_or_else(|e| e.into_inner()) = None;
        Ok(json!({"registered":true}))
    }

    /// A registration as the window, on `params`' attachment, that the
    /// runtime refused for want of the window's proof: a window service asked
    /// for meanwhile says so, and not that no window is open (PRO-507, S-37).
    pub(crate) fn refused_unproven(&self, lifetime: &Lifetime, params: &Value) {
        let attachment = lifetime.attachment(params["epoch"].as_str().unwrap_or_default(), params["lease"].as_str().unwrap_or_default());
        if let Ok(attachment) = attachment {
            *self.2.lock().unwrap_or_else(|e| e.into_inner()) = Some(attachment);
        }
    }

    /// The provider of window services now: unconditionally refuses unproven
    /// providers regardless of whether Bots is enabled, so an unproven caller
    /// cannot intercept window-forwarded RPCs (S-37).
    fn live(&self) -> Option<Arc<Service>> {
        let service = self.0.lock().unwrap().clone().filter(|service| service.attachment.valid())?;
        if service.unproven {
            *self.2.lock().unwrap_or_else(|e| e.into_inner()) = Some(service.attachment.clone());
            return None;
        }
        Some(service)
    }

    /// Why no window serves: an attached window that has not proved it is
    /// the window, or none attached.
    fn missing(&self) -> ControlError {
        let unproven = self.2.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|attachment| attachment.valid());
        if unproven {
            return ControlError::new("desktop_unavailable", UNPROVEN,
                Some("In the TerminalX window, unlock your login Keychain, then choose Try again on its notice. Check the result before repeating an action; it was not replayed.".into()));
        }
        unavailable("This operation needs an attached TerminalX window.")
    }

    /// The window's process (pid and start time, PRO-468): the last one to
    /// register here, or the one the runtime this one replaced knew. Kept
    /// until the next registration, so the same window process's frames held
    /// across a handover, and those it sends between a new attachment and its
    /// register reply, are its own. A window process this runtime has not
    /// seen yet (an app launched afresh against a runtime that outlived the
    /// old one) is not: while Bots is on its writes are refused until its
    /// registration is answered. The guard checks the start time against the
    /// live process, so one that ended, or a later one given its pid, is not
    /// it. Where the window's key is pinned, only a registrant that proved it
    /// is recognised (`control`, PRO-489).
    #[cfg_attr(not(unix), allow(dead_code))]
    pub(crate) fn window_process(&self) -> Option<(i32, u64)> {
        self.1.lock().unwrap_or_else(|e| e.into_inner()).map(|recognised| recognised.process)
    }

    /// Recognise `process` as the window, after it registered. The caller
    /// leaves out a registrant that runs in a pane or under this runtime.
    /// `proven`: it proved it with the window's key here.
    #[cfg_attr(not(unix), allow(dead_code))]
    pub(crate) fn recognise(&self, process: (i32, u64), proven: bool) {
        *self.1.lock().unwrap_or_else(|e| e.into_inner()) = Some(Recognised { process, proven });
        *KNOWN_WINDOW.lock().unwrap_or_else(|e| e.into_inner()) = Some(process);
    }

    /// A valid registration as the window from process `caller` did not
    /// prove it is (PRO-507): the window as recognised before is no longer,
    /// when it is that process. A registration another process sent unseats
    /// no one (PRO-508): not a window that proved it here, nor one a handover
    /// carried over, which registers here itself and is judged then. Where
    /// the sender cannot be told, only one this runtime never saw prove it is
    /// unseated.
    #[cfg_attr(not(unix), allow(dead_code))]
    pub(crate) fn unproven_from(&self, caller: Option<i32>) {
        let mut recognised = self.1.lock().unwrap_or_else(|e| e.into_inner());
        if recognised.is_some_and(|window| caller.map_or(!window.proven, |caller| caller == window.process.0)) {
            *recognised = None;
            *KNOWN_WINDOW.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
    }

    /// The window's process the runtime this one replaced knew, until a window registers here.
    #[cfg(any(unix, test))]
    pub(crate) fn handed_over(&self, process: Option<(i32, u64)>) {
        let mut known = self.1.lock().unwrap_or_else(|e| e.into_inner());
        if known.is_none() {
            *known = process.map(|process| Recognised { process, proven: false });
            *KNOWN_WINDOW.lock().unwrap_or_else(|e| e.into_inner()) = process;
        }
    }

    pub(crate) fn available(&self) -> bool {
        self.live().is_some()
    }

    #[cfg(any(unix, test))]
    pub(crate) fn environment_snapshot(&self, key: &str, revision: &str) -> anyhow::Result<crate::store::environment::Snapshot> {
        let value = self.dispatch("environment.snapshot", json!({ "key": key, "revision": revision }))
            .map_err(|_| anyhow::anyhow!("Environment overrides are unavailable."))?;
        serde_json::from_value(value).map_err(|_| anyhow::anyhow!("Invalid environment snapshot."))
    }

    /// An agent's saved API key (PRO-306), from the desktop's Keychain, for
    /// this runtime's memory only. Like an environment snapshot it travels
    /// only in the private response, and no public command can ask for it.
    #[cfg(any(unix, test))]
    pub(crate) fn agent_key_snapshot(&self, harness: &str, revision: &str) -> anyhow::Result<zeroize::Zeroizing<String>> {
        let mut value = self.dispatch("agentKey.snapshot", json!({ "harness": harness, "revision": revision }))
            .map_err(|_| anyhow::anyhow!("The agent's API key is unavailable."))?;
        anyhow::ensure!(value["revision"] == revision, "The agent's API key changed.");
        // Moved out, not copied: the response holds no other copy of it.
        match value.get_mut("key").map(Value::take) {
            Some(Value::String(key)) => Ok(zeroize::Zeroizing::new(key)),
            _ => anyhow::bail!("Invalid agent key snapshot."),
        }
    }

    /// Ask the window to refresh the account's desktop Cloud Session if it
    /// is about to expire (PRO-368). Nothing secret comes back: the window
    /// keeps the runtime's copy of the session (`machine_account`) itself,
    /// so one process alone rotates its refresh token.
    #[cfg(unix)]
    pub(crate) fn refresh_account(&self) -> anyhow::Result<()> {
        self.dispatch("account.refresh", json!({}))
            .map(|_| ())
            .map_err(|_| anyhow::anyhow!("The window could not refresh the account session."))
    }

    pub(crate) fn call(&self, command: &str, params: Value) -> Result<Value, ControlError> {
        if !supported(command) { return Err(unavailable("This operation is not a window service.")); }
        self.dispatch(command, params)
    }

    // Internal service responses may carry secrets. They are never proxied by
    // public control commands and only travel on this private, lease-bound socket.
    fn dispatch(&self, command: &str, params: Value) -> Result<Value, ControlError> {
        let service = self.live().ok_or_else(|| self.missing())?;
        if !super::permissions::increment_bounded(&service.calls, MAX_CALLS) {
            return Err(unavailable("The desktop is handling too many requests. No new action was sent."));
        }
        struct Call<'a>(&'a AtomicUsize);
        impl Drop for Call<'_> { fn drop(&mut self) { self.0.fetch_sub(1,Ordering::AcqRel); } }
        let _call = Call(&service.calls);
        let result = (|| -> anyhow::Result<ControlResponse> {
            let mut socket = crate::ipc::connect(&service.socket)?;
            let timeout = command.strip_prefix("cloud.").map(|action| crate::cloud_control::timeout_for(action,&params)+Duration::from_secs(15))
                .or_else(|| command.strip_prefix("machine.").map(|action| crate::machine_control::timeout_for(action,&params)+Duration::from_secs(15)))
                .unwrap_or_else(|| if matches!(command, "environment.snapshot" | "agentKey.snapshot") { Duration::from_secs(10) } else if command == "account.refresh" { Duration::from_secs(45) } else if command == "window.terminalCounters" { crate::terminal_perf::COUNTERS_TIMEOUT + Duration::from_secs(1) } else { Duration::from_secs(360) });
            socket.set_read_timeout(Some(timeout))?;
            socket.set_write_timeout(Some(Duration::from_secs(5)))?;
            let dispatch = service.attachment.enter()?;
            let request = ControlRequest { id: uuid::Uuid::new_v4().to_string(), token: service.token.to_string(), command: "window.dispatch".into(), params: json!({"epoch":service.epoch,"lease":service.lease,"command":command,"params":params}) };
            serde_json::to_writer(&mut socket,&request)?;
            socket.write_all(b"\n")?;
            drop(dispatch);
            let mut response = String::new();
            BufReader::new(socket).take(MAX_RESPONSE+1).read_line(&mut response)?;
            if response.len() as u64 > MAX_RESPONSE { anyhow::bail!("desktop response exceeds its bound"); }
            let response: ControlResponse = serde_json::from_str(&response)?;
            if response.id != request.id { anyhow::bail!("desktop response does not match the request"); }
            Ok(response)
        })().map_err(|_| unavailable("The desktop did not return a valid result. The action was not retried."))?;
        if !service.attachment.valid() { return Err(unavailable("The desktop attachment changed before its result arrived.")); }
        if result.ok { Ok(result.result.unwrap_or(Value::Null)) }
        else { Err(result.error.unwrap_or_else(|| unavailable("The desktop returned an invalid refusal."))) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::{prepare_control, serve_private, HookReply};

    fn attach(lifetime: &Lifetime) -> Value {
        lifetime.command("runtime.attach", json!({"protocol": super::super::PROTOCOL})).unwrap()
    }

    fn registration(attachment: &Value, endpoint: &crate::hooks::ControlEndpoint) -> Value {
        json!({"epoch":attachment["epoch"], "lease":attachment["lease"], "socket":endpoint.socket, "token":endpoint.token})
    }

    #[test]
    fn non_deletion_issue_operations_never_require_window_dispatch() {
        for action in ["list", "view", "create", "comment", "status", "assign", "label"] {
            assert!(!supported(&format!("issues.{action}")), "{action}");
        }
    }

    #[test]
    fn environment_snapshot_is_private_to_the_registered_desktop_and_cannot_be_proxied() {
        assert!(!supported("environment.snapshot"));
        let registry = Registry::default();
        assert!(registry.call("environment.snapshot", json!({"key":"user","revision":"r"})).is_err());
        let current = super::super::client::AttachmentIdentity { epoch:"owner".into(), lease:"desktop".into() };
        let mut request = ControlRequest { id:"test".into(), token:"private-window-token".into(), command:"window.dispatch".into(),
            params: json!({"epoch":"owner","lease":"desktop","command":"environment.snapshot","params":{"key":"user","revision":"r"}}) };
        assert!(receive(&request, &current).is_ok());
        request.params["lease"] = json!("another-desktop");
        assert!(receive(&request, &current).is_err());
    }

    /// PRO-306: an agent's API key is fetched like an environment snapshot,
    /// and no more reachable: never a window service another command can
    /// ask for, and only from the current desktop attachment.
    #[test]
    fn agent_key_snapshot_is_private_to_the_registered_desktop_and_cannot_be_proxied() {
        assert!(!supported("agentKey.snapshot"));
        let registry = Registry::default();
        assert!(registry.call("agentKey.snapshot", json!({"harness":"claude","revision":"r"})).is_err());
        let current = super::super::client::AttachmentIdentity { epoch:"owner".into(), lease:"desktop".into() };
        let mut request = ControlRequest { id:"test".into(), token:"private-window-token".into(), command:"window.dispatch".into(),
            params: json!({"epoch":"owner","lease":"desktop","command":"agentKey.snapshot","params":{"harness":"claude","revision":"r"}}) };
        assert!(receive(&request, &current).is_ok());
        request.params["lease"] = json!("another-desktop");
        assert!(receive(&request, &current).is_err());
        request.params["lease"] = json!("desktop");
        request.params["epoch"] = json!("old-owner");
        assert!(receive(&request, &current).is_err());
        // Only by way of the registered window's dispatch, never as a command of its own.
        request.params["epoch"] = json!("owner");
        request.command = "agentKey.snapshot".into();
        assert!(receive(&request, &current).is_err());
    }

    #[test]
    fn agent_key_travels_only_in_the_private_response_for_the_revision_asked() {
        let _home = crate::store::temp_home();
        let lifetime = Lifetime::new(Duration::from_secs(60));
        let endpoint = prepare_control().unwrap();
        let attachment = attach(&lifetime);
        let identity = super::super::client::AttachmentIdentity {
            epoch: attachment["epoch"].as_str().unwrap().into(), lease: attachment["lease"].as_str().unwrap().into(),
        };
        serve_private(endpoint.clone(), |_| HookReply::default(), move |request| {
            let (command, params) = receive(&request, &identity).unwrap();
            assert_eq!(command, "agentKey.snapshot");
            assert!(!serde_json::to_string(&request).unwrap().contains("sk-ant-private"));
            // A desktop that answers for another revision is not believed.
            let revision = if params["revision"] == "stale" { "current" } else { params["revision"].as_str().unwrap() };
            ControlResponse::success(request.id, json!({"revision":revision,"key":"sk-ant-private-0123456789abcdef"}))
        }).unwrap();
        lifetime.window.register(&lifetime, registration(&attachment, &endpoint)).unwrap();
        assert_eq!(lifetime.window.agent_key_snapshot("claude", "r1").unwrap().as_str(), "sk-ant-private-0123456789abcdef");
        assert!(lifetime.window.agent_key_snapshot("claude", "stale").is_err());
        assert!(lifetime.window.call("agentKey.snapshot", json!({"harness":"claude","revision":"r1"})).is_err());
    }

    #[test]
    fn environment_values_travel_only_in_the_private_response() {
        let _home = crate::store::temp_home();
        let lifetime = Lifetime::new(Duration::from_secs(60));
        let endpoint = prepare_control().unwrap();
        let attachment = attach(&lifetime);
        let identity = super::super::client::AttachmentIdentity {
            epoch: attachment["epoch"].as_str().unwrap().into(), lease: attachment["lease"].as_str().unwrap().into(),
        };
        serve_private(endpoint.clone(), |_| HookReply::default(), move |request| {
            let (command, params) = receive(&request, &identity).unwrap();
            assert_eq!(command, "environment.snapshot");
            assert_eq!(params, json!({"key":"user","revision":"revision"}));
            assert!(!serde_json::to_string(&request).unwrap().contains("private-value"));
            ControlResponse::success(request.id, json!({"revision":"revision","values":{"KEY":"private-value"}}))
        }).unwrap();
        lifetime.window.register(&lifetime, registration(&attachment, &endpoint)).unwrap();
        let snapshot = lifetime.window.environment_snapshot("user", "revision").unwrap();
        assert_eq!(serde_json::to_value(snapshot).unwrap()["values"]["KEY"], "private-value");
        assert!(lifetime.window.call("environment.snapshot", json!({})).is_err());
    }

    #[test]
    fn receiver_rejects_old_owner_lease_and_commands_outside_the_allowlist() {
        let current = super::super::client::AttachmentIdentity { epoch:"current-owner".into(),lease:"current-window".into() };
        let mut request = ControlRequest { id:"test".into(),token:"already-authenticated".into(),command:"window.dispatch".into(),params:json!({"epoch":current.epoch,"lease":current.lease,"command":"browser.storage.local.get","params":{}}) };
        assert!(receive(&request,&current).is_ok());
        request.params["lease"] = json!("old-window");
        assert!(receive(&request,&current).is_err());
        request.params["lease"] = json!(current.lease);
        request.params["epoch"] = json!("old-owner");
        assert!(receive(&request,&current).is_err());
        request.params["epoch"] = json!(current.epoch);
        for command in ["runtime.stopAll","permissions.allow","computer.unknown","browser.storage.local.unknown"] {
            request.params["command"] = json!(command);
            assert!(receive(&request,&current).is_err());
        }
        request.command = "computer.listApps".into();
        assert!(receive(&request,&current).is_err());
    }

    #[test]
    fn window_services_are_authenticated_fenced_and_never_a_session_proxy() {
        let _home = crate::store::temp_home();
        let lifetime = Lifetime::new(Duration::from_secs(60));
        let endpoint = prepare_control().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        serve_private(endpoint.clone(), |_| HookReply::default(), move |request| {
            seen.fetch_add(1,Ordering::SeqCst);
            ControlResponse::success(request.id, json!({"command":request.params["command"]}))
        }).unwrap();
        assert!(lifetime.window.call("computer.listApps", json!({})).is_err());
        let attachment = attach(&lifetime);
        let mut wrong = registration(&attachment,&endpoint);
        wrong["epoch"] = json!("another-owner");
        assert!(lifetime.window.register(&lifetime,wrong).is_err());
        lifetime.window.register(&lifetime,registration(&attachment,&endpoint)).unwrap();
        lifetime.window.register(&lifetime,registration(&attachment,&endpoint)).unwrap();
        assert!(lifetime.window.available());
        assert_eq!(lifetime.window.call("computer.listApps",json!({})).unwrap()["command"],"computer.listApps");
        for command in ["runtime.stopAll", "runtime.session.send", "permissions.allow", "send", "worktrees.delete"] {
            assert!(lifetime.window.call(command,json!({})).is_err());
        }
        let second = attach(&lifetime);
        assert!(lifetime.window.register(&lifetime,registration(&second,&endpoint)).is_err());
        lifetime.command("runtime.detach",attachment.clone()).unwrap();
        assert!(!lifetime.window.available());
        assert!(lifetime.window.call("computer.listApps",json!({})).is_err());
        assert!(lifetime.window.register(&lifetime,registration(&attachment,&endpoint)).is_err());
        assert_eq!(calls.load(Ordering::SeqCst),1);
        lifetime.window.register(&lifetime,registration(&second,&endpoint)).unwrap();
        assert!(lifetime.window.call("computer.listApps",json!({})).is_ok());
        assert_eq!(calls.load(Ordering::SeqCst),2);
    }

    /// PRO-507: a window registered without its proof while Bots was off
    /// serves only while Bots is off: it is held, not dropped, while Bots is
    /// on, and serves again once Bots is off (review of #1468, item 1). It
    /// gives way to a registration that proves it, Bots on or off, and to any
    /// while Bots is on; a window service asked for meanwhile says why, not
    /// that no window is open.
    #[test]
    #[cfg_attr(windows, ignore = "Bots are off on Windows")]
    fn an_unproven_window_serves_only_with_bots_off_and_gives_way_to_a_proven_one() {
        let _home = crate::store::temp_home();
        let bots = |on: bool| {
            let mut settings = crate::store::settings::load();
            settings.experimental.bots = on;
            crate::store::settings::save(&settings).unwrap();
        };
        let lifetime = Lifetime::new(Duration::from_secs(60));
        let endpoint = prepare_control().unwrap();
        serve_private(endpoint.clone(), |_| HookReply::default(), move |request| ControlResponse::success(request.id, json!({"command":request.params["command"]}))).unwrap();
        bots(false);
        let unproven = attach(&lifetime);
        lifetime.window.register_unproven(&lifetime, registration(&unproven, &endpoint)).unwrap();
        // S-37: unproven providers never serve window RPCs, even with Bots off.
        assert!(!lifetime.window.available(), "unproven provider never serves even with Bots off");
        let error = lifetime.window.call("computer.listApps", json!({})).unwrap_err();
        assert_eq!(error.code, "desktop_unavailable");
        assert!(error.message == UNPROVEN && error.recovery.as_deref().is_some_and(|hint| hint.contains("Try again")), "{error:?}");
        // The window, proving it on another lease, takes over.
        let proven = attach(&lifetime);
        lifetime.window.register(&lifetime, registration(&proven, &endpoint)).unwrap();
        assert!(lifetime.window.register_unproven(&lifetime, registration(&unproven, &endpoint)).is_err(), "a proven window is not unseated");
        assert!(lifetime.window.call("computer.listApps", json!({})).is_ok());
        lifetime.command("runtime.detach", proven).unwrap();

        // Bots on or off: an unproven provider serves nothing, and gives way to a proven window.
        let other = attach(&lifetime);
        lifetime.window.register_unproven(&lifetime, registration(&other, &endpoint)).unwrap();
        bots(true);
        assert!(!lifetime.window.available(), "held while Bots is on");
        let error = lifetime.window.call("computer.listApps", json!({})).unwrap_err();
        assert_eq!(error.code, "desktop_unavailable");
        assert!(error.message == UNPROVEN && error.recovery.as_deref().is_some_and(|hint| hint.contains("Try again")), "{error:?}");
        bots(false);
        assert!(!lifetime.window.available(), "still refused with Bots off (S-37)");
        let third = attach(&lifetime);
        lifetime.window.register_unproven(&lifetime, registration(&third, &endpoint)).unwrap();
        lifetime.window.register(&lifetime, registration(&other, &endpoint)).unwrap();
        bots(true);
        assert!(lifetime.window.call("computer.listApps", json!({})).is_ok(), "a window proved serves while Bots is on");
        lifetime.command("runtime.detach", third).unwrap();
        lifetime.command("runtime.detach", other).unwrap();
        // A registration refused for want of proof says why too, while it is attached.
        let refused = attach(&lifetime);
        lifetime.window.refused_unproven(&lifetime, &registration(&refused, &endpoint));
        assert_eq!(lifetime.window.call("computer.listApps", json!({})).unwrap_err().message, UNPROVEN);
        lifetime.command("runtime.detach", refused).unwrap();
        assert_ne!(lifetime.window.call("computer.listApps", json!({})).unwrap_err().message, UNPROVEN, "detached: no window at all");
    }

    /// PRO-507: a registration that does not prove it is the window unseats
    /// the window recognised before when it is the same process. PRO-508:
    /// another process's unseats neither a window that proved it here nor
    /// one a handover carried over; a sender that cannot be told unseats only
    /// one never proved here.
    #[test]
    fn an_unproven_registration_unseats_only_a_window_it_may_be() {
        let registry = Registry::default();
        registry.handed_over(Some((10, 1)));
        registry.unproven_from(Some(99));
        assert_eq!(registry.window_process(), Some((10, 1)), "another process does not unseat a handover's window");
        registry.unproven_from(Some(10));
        assert_eq!(registry.window_process(), None, "a handover's window that cannot prove it here is no longer taken for it");
        registry.handed_over(Some((10, 1)));
        registry.unproven_from(None);
        assert_eq!(registry.window_process(), None, "a sender that cannot be told: one never proved here is unseated");
        registry.recognise((10, 1), true);
        registry.unproven_from(Some(99));
        assert_eq!(registry.window_process(), Some((10, 1)), "another process does not unseat a proven window");
        registry.unproven_from(None);
        assert_eq!(registry.window_process(), Some((10, 1)));
        registry.unproven_from(Some(10));
        assert_eq!(registry.window_process(), None, "the window that cannot prove it now is no longer taken for it");
        registry.recognise((11, 2), false);
        registry.unproven_from(None);
        assert_eq!(registry.window_process(), None, "one taken by where it runs is unseated");
    }

    /// PRO-508: what a registration must be before it is considered: on a
    /// current attachment, a private socket of this runtime, a credential of
    /// the right shape. `validate` refuses what `register` refuses for it.
    #[test]
    fn a_registration_is_valid_only_on_a_current_attachment_and_a_private_endpoint() {
        let _home = crate::store::temp_home();
        let lifetime = Lifetime::new(Duration::from_secs(60));
        let endpoint = prepare_control().unwrap();
        serve_private(endpoint.clone(), |_| HookReply::default(), move |request| ControlResponse::success(request.id, json!({}))).unwrap();
        let attachment = attach(&lifetime);
        let valid = registration(&attachment, &endpoint);
        lifetime.window.validate(&lifetime, &valid).unwrap();
        assert!(!lifetime.window.available(), "validating registers nothing");
        let with = |field: &str, value: Value| { let mut registration = valid.clone(); registration[field] = value; registration };
        let mut bare = valid.clone();
        bare.as_object_mut().unwrap().remove("lease");
        for (invalid, says) in [
            (json!({}), "Invalid desktop registration."),
            (bare, "Invalid desktop registration."),
            (with("extra", json!(1)), "Invalid desktop registration."),
            (with("lease", json!("not-a-lease")), "The desktop attachment is no longer current."),
            (with("epoch", json!("another-owner")), "The desktop attachment is no longer current."),
            (with("socket", json!(std::env::temp_dir().join("elsewhere.sock"))), "The desktop endpoint is not a private endpoint of this runtime."),
            (with("token", json!("short")), "The desktop endpoint is not a private endpoint of this runtime."),
        ] {
            let refused = lifetime.window.validate(&lifetime, &invalid).unwrap_err();
            assert_eq!((refused.code.as_str(), refused.message.as_str()), ("desktop_unavailable", says), "{invalid}");
            assert_eq!(lifetime.window.register_unproven(&lifetime, invalid).unwrap_err().message, says);
        }
        lifetime.command("runtime.detach", attachment).unwrap();
        assert_eq!(lifetime.window.validate(&lifetime, &valid).unwrap_err().message, "The desktop attachment is no longer current.", "detached");
    }

    #[test]
    fn window_refusal_codes_survive_and_invalid_responses_are_not_retried() {
        let _home = crate::store::temp_home();
        let lifetime = Lifetime::new(Duration::from_secs(60));
        let endpoint = prepare_control().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        serve_private(endpoint.clone(), |_| HookReply::default(), move |request| {
            seen.fetch_add(1,Ordering::SeqCst);
            if request.params["command"] == "computer.listApps" {
                ControlResponse::failure(request.id, ControlError::new("permission_denied","Native consent refused.",None::<String>))
            } else { ControlResponse::success("wrong-request",json!({})) }
        }).unwrap();
        let attachment = attach(&lifetime);
        lifetime.window.register(&lifetime,registration(&attachment,&endpoint)).unwrap();
        assert_eq!(lifetime.window.call("computer.listApps",json!({})).unwrap_err().code,"permission_denied");
        assert_eq!(lifetime.window.call("computer.listWindows",json!({})).unwrap_err().code,"desktop_unavailable");
        assert_eq!(calls.load(Ordering::SeqCst),2);
    }

    #[test]
    fn detached_inflight_result_is_rejected_without_replaying_to_new_window() {
        let _home = crate::store::temp_home();
        let lifetime = Lifetime::new(Duration::from_secs(60));
        let endpoint = prepare_control().unwrap();
        let (sent,received) = std::sync::mpsc::sync_channel(1);
        let (resume,wait) = std::sync::mpsc::sync_channel(1);
        let wait = Mutex::new(wait);
        serve_private(endpoint.clone(), |_| HookReply::default(), move |request| {
            sent.send(()).unwrap();
            wait.lock().unwrap().recv_timeout(Duration::from_secs(5)).unwrap();
            ControlResponse::success(request.id,json!({"completed":true}))
        }).unwrap();
        let attachment = attach(&lifetime);
        lifetime.window.register(&lifetime,registration(&attachment,&endpoint)).unwrap();
        let caller = lifetime.clone();
        let request = std::thread::spawn(move || caller.window.call("browser.status",json!({})));
        received.recv_timeout(Duration::from_secs(5)).unwrap();
        lifetime.command("runtime.detach",attachment).unwrap();
        resume.send(()).unwrap();
        assert_eq!(request.join().unwrap().unwrap_err().code,"desktop_unavailable");
        assert!(lifetime.window.call("browser.status",json!({})).is_err());
        assert!(received.try_recv().is_err());
    }
}
