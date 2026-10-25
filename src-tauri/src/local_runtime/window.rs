//! Fixed window-only services registered by an authenticated desktop attachment.
//! The background owner never becomes a generic proxy for a guest-supplied RPC.
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::UnixStream;
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
        "computer.permissions" | "computer.permissionsStatus" | "computer.permissionsReset" | "computer.capabilities"
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
         | "share.approve" | "share.note" | "share.takeover" | "issues.view"
         | "issues.comment" | "issues.status" | "issues.assign" | "issues.label"
         | "issues.create" | "floating.show" | "floating.hide" | "floating.toggle"
         | "perf.terminal.start" | "perf.terminal.poll" | "window.terminalCounters"
         | "window.open" | "window.quit" | "window.stopAllAndQuit"
    )
}

fn unavailable(message: impl Into<String>) -> ControlError {
    ControlError::new("desktop_unavailable",message,Some("Open TerminalX. Check the result before repeating an action; it was not replayed.".into()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Dispatch { epoch: String, lease: String, command: String, params: Value }

pub(crate) fn receive(request: &ControlRequest, current: &super::client::AttachmentIdentity) -> Result<(String, Value), ControlError> {
    if request.command != "window.dispatch" { return Err(unavailable("Only registered window dispatch is accepted.")); }
    let dispatch: Dispatch = serde_json::from_value(request.params.clone()).map_err(|_| unavailable("Invalid window dispatch."))?;
    if dispatch.epoch != current.epoch || dispatch.lease != current.lease || !supported(&dispatch.command) {
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
}

#[derive(Default)]
pub(crate) struct Registry(Mutex<Option<Arc<Service>>>);

impl Registry {
    pub(crate) fn register(&self, lifetime: &Lifetime, params: Value) -> Result<Value, ControlError> {
        let registration: Registration = serde_json::from_value(params).map_err(|_| unavailable("Invalid desktop registration."))?;
        let attachment = lifetime.attachment(&registration.epoch,&registration.lease).map_err(|_| unavailable("The desktop attachment is no longer current."))?;
        let checked = (|| -> anyhow::Result<()> {
            let run = std::fs::canonicalize(crate::store::root()?.join("run"))?;
            let parent = registration.socket.parent().ok_or_else(|| anyhow::anyhow!("missing parent"))?;
            if std::fs::canonicalize(parent)? != run { anyhow::bail!("window endpoint must be in this runtime's private directory"); }
            let metadata = std::fs::symlink_metadata(&registration.socket)?;
            // SAFETY: geteuid has no preconditions.
            if !metadata.file_type().is_socket() || metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
                anyhow::bail!("window endpoint must be a private socket");
            }
            if !(32..=256).contains(&registration.token.len()) || !registration.token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                anyhow::bail!("invalid window credential");
            }
            Ok(())
        })();
        if checked.is_err() { return Err(unavailable("The desktop endpoint is not a private endpoint of this runtime.")); }
        let mut current = self.0.lock().unwrap();
        if let Some(previous) = current.as_ref().filter(|service| service.attachment.valid()) {
            if previous.lease == registration.lease && previous.socket == registration.socket
                && crate::hooks::token_matches(&previous.token,&registration.token) {
                return Ok(json!({"registered":true}));
            }
            return Err(unavailable("Another desktop currently provides this runtime's window services."));
        }
        let registered = attachment.enter().map_err(|_| unavailable("The desktop detached during registration."))?;
        *current = Some(Arc::new(Service { attachment: attachment.clone(), epoch: registration.epoch, lease: registration.lease, socket: registration.socket,
            token: zeroize::Zeroizing::new(registration.token), calls: AtomicUsize::new(0) }));
        drop(registered);
        Ok(json!({"registered":true}))
    }

    pub(crate) fn available(&self) -> bool {
        self.0.lock().unwrap().as_ref().is_some_and(|service| service.attachment.valid())
    }

    pub(crate) fn call(&self, command: &str, params: Value) -> Result<Value, ControlError> {
        if !supported(command) { return Err(unavailable("This operation is not a window service.")); }
        let service = self.0.lock().unwrap().clone().filter(|service| service.attachment.valid())
            .ok_or_else(|| unavailable("This operation needs an attached TerminalX window."))?;
        if !super::permissions::increment_bounded(&service.calls, MAX_CALLS) {
            return Err(unavailable("The desktop is handling too many requests. No new action was sent."));
        }
        struct Call<'a>(&'a AtomicUsize);
        impl Drop for Call<'_> { fn drop(&mut self) { self.0.fetch_sub(1,Ordering::AcqRel); } }
        let _call = Call(&service.calls);
        let result = (|| -> anyhow::Result<ControlResponse> {
            let mut socket = UnixStream::connect(&service.socket)?;
            let timeout = command.strip_prefix("cloud.").map(|action| crate::cloud_control::timeout_for(action,&params)+Duration::from_secs(15))
                .unwrap_or_else(|| if command == "window.terminalCounters" { crate::terminal_perf::COUNTERS_TIMEOUT + Duration::from_secs(1) } else { Duration::from_secs(360) });
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
