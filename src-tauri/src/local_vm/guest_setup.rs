//! Explicit guest setup effects. The guest checkpoints intent before calling
//! this actor and checkpoints its receipts before returning them to callers.
//! Challenges and all provider output remain memory-only. No worker/provider
//! turn, permission approval, credential import, TCC write or Driver stop.
use super::{Identity, State};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use zeroize::Zeroize as _;

#[path = "guest_desktop_check.rs"]
mod desktop_check;
#[path = "guest_attachment_mcp.rs"]
pub(super) mod desktop_mcp;

const DRIVER: &str = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
const APP: &str = "/Applications/CuaDriver.app";
const RPC_WAIT: Duration = Duration::from_secs(20);
const LOGIN_LIFETIME: Duration = Duration::from_secs(15 * 60);
const MAX_OUTPUT: usize = 32 * 1024 * 1024;
// FD3 is a separate lifetime pipe, not Codex's JSON stdin. The trusted shell
// receives literal argv, never interpolated guest/host data. Its watcher kills
// only this helper group if the guest owner crashes. LaunchServices' Driver
// app is outside this group and is never killed by this component.
const WATCHDOG: &str = r#"exec 4<&0
"$@" <&4 3<&- 4<&- &
cli=$!
exec 4<&-
( IFS= read -r lifetime <&3; kill -KILL 0 ) </dev/null >/dev/null 2>&1 &
watch=$!
wait "$cli"
result=$?
kill "$watch" 2>/dev/null
wait "$watch" 2>/dev/null
exit "$result""#;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(super) enum Action {
    #[serde(rename = "driver.start")]
    DriverStart,
    #[serde(rename = "driver.requestPermissions")]
    DriverPermissions,
    #[serde(rename = "provider.codexDeviceLogin.start")]
    LoginStart,
    #[serde(rename = "provider.codexDeviceLogin.cancel")]
    LoginCancel,
    #[serde(rename = "provider.codexAccount.verify")]
    AccountVerify,
    #[serde(rename = "desktop.verify")]
    DesktopVerify,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt as _;

    fn params(action: Action, key: &str) -> Params {
        Params {
            environment_id: super::super::super::journal::new_id(),
            generation: super::super::super::journal::new_id(),
            action,
            idempotency_key: key.into(),
            confirm: true,
            login_id: None,
        }
    }
    fn script(path: &Path, text: &str) {
        std::fs::write(path, text).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    fn paths(home: &Path) -> Paths {
        Paths {
            home: home.into(),
            driver: home.join("driver"),
            app: home.join("CuaDriver.app"),
            open: home.join("open"),
            codex: Some(home.join("codex")),
            exits: Arc::new(AtomicBool::new(true)),
            verify_signature: false,
            login_allowed: true,
            provider_selection_valid: true,
        }
    }
    fn state(params: &Params) -> State {
        State {
            identity: Identity {
                account: None,
            macos_account: None,
                environment_id: params.environment_id.clone(),
                generation: params.generation.clone(),
                protocol: 1,
            },
            records: Default::default(),
            canceled_targets: Default::default(),
            manual_lease: None,
            attachments: Default::default(),
            provisioning_baseline: None,
            setup_operations: BTreeMap::from([(
                params.idempotency_key.clone(),
                Operation::working(params, None).unwrap(),
            )]),
        }
    }
    fn wait(actor: &Actor, condition: impl Fn(&View) -> bool) {
        wait_for(actor, Duration::from_secs(8), condition);
    }
    fn wait_for(actor: &Actor, timeout: Duration, condition: impl Fn(&View) -> bool) {
        let deadline = Instant::now() + timeout;
        loop {
            if condition(&actor.view.lock().unwrap()) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "disposable actor did not reach expected state"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn provider(home: &Path, mode: &str) {
        std::fs::write(home.join("mode"), mode).unwrap();
        script(
            &home.join("codex"),
            r##"#!/bin/sh
mode=$(cat "$HOME/mode")
while IFS= read -r line; do
case "$line" in
  *'"method":"initialize"'*) printf 'initialize\n' >> "$HOME/calls"; printf '%s\n' '{"id":1,"result":{}}' ;;
  *'"method":"initialized"'*) ;;
  *'"id":2,'*'"method":"account/read"'*)
    printf 'account/read:false\n' >> "$HOME/calls"
    if [ "$mode" = existing ]; then printf '%s\n' '{"id":2,"result":{"account":{"type":"chatgpt"},"requiresOpenaiAuth":true}}'
    else printf '%s\n' '{"id":2,"result":{"account":null,"requiresOpenaiAuth":true}}'; fi ;;
  *'"method":"account/login/start"'*)
    printf 'login/start\n' >> "$HOME/calls"
    printf '%s\n' '{"id":3,"result":{"type":"chatgptDeviceCode","loginId":"11111111-1111-4111-8111-111111111111","verificationUrl":"https://auth.openai.com/codex/device","userCode":"TEST-1234"}}'
    if [ "$mode" = complete ]; then
      printf '%s\n' '{"method":"account/login/completed","params":{"loginId":"22222222-2222-4222-8222-222222222222","success":true}}'
      printf '%s\n' '{"method":"account/login/completed","params":{"loginId":"11111111-1111-4111-8111-111111111111","success":true}}'
    fi ;;
  *'"id":5,'*'"method":"account/read"'*) printf 'account/confirmed:false\n' >> "$HOME/calls"; printf '%s\n' '{"id":5,"result":{"account":{"type":"chatgpt"},"requiresOpenaiAuth":true}}' ;;
  *'"method":"account/login/cancel"'*) printf 'login/cancel\n' >> "$HOME/calls"; printf '%s\n' '{"id":4,"result":{"status":"notFound"}}' ;;
  *) exit 91 ;;
esac
done
"##,
        );
        std::fs::create_dir_all(home.join(".local/bin")).unwrap();
        std::fs::hard_link(home.join("codex"), home.join(".local/bin/codex")).unwrap();
    }

    #[test]
    fn owned_setup_can_launch_a_guest_shebang_provider_without_inherited_credentials() {
        let home = tempfile::tempdir().unwrap();
        let selected = paths(home.path());
        let bin = home.path().join(".local/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let node = crate::binpath::resolve("node").expect("Node is a development prerequisite");
        std::os::unix::fs::symlink(node, bin.join("node")).unwrap();
        let program = home.path().join("provider.js");
        script(&program, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({home:process.env.HOME, inheritedControl:Object.keys(process.env).some(k=>k.startsWith('TERMINALX_')||k.startsWith('RACCOON_')), inheritedAuth:['OPENAI_API_KEY','CODEX_HOME','CODEX_ACCESS_TOKEN'].some(k=>k in process.env)}))\n");
        let output = finite(
            &program,
            &[],
            &selected,
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(output.code, 0, "{}", String::from_utf8_lossy(&output.err));
        let receipt: Value = serde_json::from_slice(&output.bytes).unwrap();
        assert_eq!(
            receipt,
            json!({"home":home.path(),"inheritedControl":false,"inheritedAuth":false})
        );
        assert!(selected.exits.load(Ordering::Acquire));
    }

    #[test]
    fn explicit_account_check_retains_bounded_evidence_and_never_starts_sign_in() {
        for mode in ["existing", "pending"] {
            let home = tempfile::tempdir().unwrap();
            provider(home.path(), mode);
            let actor = Actor::default();
            actor
                .launch_with(
                    params(Action::AccountVerify, "account-only"),
                    paths(home.path()),
                )
                .unwrap();
            wait(&actor, |view| !view.busy);
            let receipt = actor.receipts().pop().unwrap().receipt;
            assert_eq!(receipt.status, Status::Complete);
            assert_eq!(
                std::fs::read_to_string(home.path().join("calls")).unwrap(),
                "initialize\naccount/read:false\n"
            );
            if let Some(boot) = super::super::boot_identity() {
                let mut proof = receipt.account_verification.unwrap();
                let binding = super::super::readiness::account_binding(home.path()).unwrap();
                assert_eq!(proof.authenticated, mode == "existing");
                assert!(proof.current(Some(&boot), Some(&binding)));
                assert!(!proof.current(None, Some(&binding)));
                assert!(!proof.current(
                    Some(&super::super::super::journal::new_id()),
                    Some(&binding)
                ));
                proof.verified_at =
                    (chrono::Utc::now() - chrono::Duration::minutes(11)).to_rfc3339();
                assert!(!proof.current(Some(&boot), Some(&binding)));
                proof.verified_at =
                    (chrono::Utc::now() + chrono::Duration::minutes(1)).to_rfc3339();
                assert!(!proof.current(Some(&boot), Some(&binding)));
                proof.verified_at = super::super::now();
                std::fs::create_dir_all(home.path().join(".codex")).unwrap();
                std::fs::write(
                    home.path().join(".codex/config.toml"),
                    "cli_auth_credentials_store = 'keyring'\n",
                )
                .unwrap();
                assert!(!proof.current(
                    Some(&boot),
                    super::super::readiness::account_binding(home.path())
                        .ok()
                        .as_ref()
                ));
            }
            let disk = serde_json::to_string(&actor.receipts().pop().unwrap().receipt).unwrap();
            assert!(
                !disk.contains("email")
                    && !disk.contains("userCode")
                    && !disk.contains("access_token")
            );
        }
    }

    #[test]
    fn device_flow_uses_one_owned_process_and_requires_matching_notification_plus_account_receipt()
    {
        let home = tempfile::tempdir().unwrap();
        provider(home.path(), "complete");
        let actor = Actor::default();
        let params = params(Action::LoginStart, "one-process");
        actor
            .launch_with(params.clone(), paths(home.path()))
            .unwrap();
        wait(&actor, |v| !v.busy);
        let update = actor.receipts().pop().unwrap();
        assert_eq!(update.receipt.status, Status::Complete);
        assert!(update.helper_exit_confirmed);
        let calls = std::fs::read_to_string(home.path().join("calls")).unwrap();
        assert_eq!(
            calls,
            "initialize\naccount/read:false\nlogin/start\naccount/confirmed:false\n"
        );
        assert!(!calls.contains("turn/start"));
        actor.shutdown();
    }

    #[test]
    fn authenticated_account_is_never_logged_in_again_and_prior_unknown_cannot_start_new_flow() {
        for (mode, allow, status) in [
            ("existing", true, Status::Complete),
            ("pending", false, Status::Failed),
        ] {
            let home = tempfile::tempdir().unwrap();
            provider(home.path(), mode);
            let actor = Actor::default();
            let params = params(Action::LoginStart, "review-only");
            let mut selected = paths(home.path());
            selected.login_allowed = allow;
            actor.launch_with(params, selected).unwrap();
            wait(&actor, |v| !v.busy);
            assert_eq!(actor.receipts().pop().unwrap().receipt.status, status);
            assert_eq!(
                std::fs::read_to_string(home.path().join("calls")).unwrap(),
                "initialize\naccount/read:false\n"
            );
        }
    }

    #[test]
    fn live_challenge_is_memory_only_and_cancel_not_found_stays_unknown() {
        let home = tempfile::tempdir().unwrap();
        provider(home.path(), "pending");
        let actor = Actor::default();
        let params = params(Action::LoginStart, "pending-login");
        actor
            .launch_with(params.clone(), paths(home.path()))
            .unwrap();
        wait(&actor, |v| {
            v.auth.as_ref().is_some_and(|a| a.status == "awaitingUser")
        });
        let mut retained = state(&params);
        retained
            .setup_operations
            .get_mut("pending-login")
            .unwrap()
            .receipt = actor.receipts().pop().unwrap().receipt;
        let response = actor.auth(&retained, "pending-login");
        assert_eq!(response["status"], "awaitingUser");
        assert_eq!(response["challenge"]["userCode"], "TEST-1234");
        let disk = serde_json::to_string(&retained).unwrap();
        assert!(!disk.contains("TEST-1234"));
        assert!(!disk.contains("verificationUrl"));
        assert!(!disk.contains("loginId"));
        let mut cancel = params.clone();
        cancel.action = Action::LoginCancel;
        cancel.idempotency_key = "cancel-once".into();
        cancel.login_id = Some("11111111-1111-4111-8111-111111111111".into());
        actor.launch_with(cancel, paths(home.path())).unwrap();
        wait(&actor, |v| !v.busy);
        let updates = actor.receipts();
        assert_eq!(updates.len(), 2);
        assert!(updates
            .iter()
            .all(|u| u.receipt.status == Status::OutcomeUnknown && u.helper_exit_confirmed));
        assert!(std::fs::read_to_string(home.path().join("calls"))
            .unwrap()
            .ends_with("login/cancel\n"));
    }

    #[test]
    fn owner_shutdown_kills_only_owned_helper_and_never_reports_success() {
        let home = tempfile::tempdir().unwrap();
        provider(home.path(), "pending");
        let actor = Actor::default();
        let params = params(Action::LoginStart, "shutdown-login");
        actor.launch_with(params, paths(home.path())).unwrap();
        wait(&actor, |v| {
            v.auth.as_ref().is_some_and(|a| a.status == "awaitingUser")
        });
        let started = Instant::now();
        actor.shutdown();
        assert!(started.elapsed() < Duration::from_secs(4));
        let result = actor.receipts().pop().unwrap();
        assert_eq!(result.receipt.status, Status::OutcomeUnknown);
        assert!(result.helper_exit_confirmed);
    }

    #[test]
    fn driver_start_uses_explicit_prompt_suppression_and_proves_running_after_open_admission() {
        let home = tempfile::tempdir().unwrap();
        script(
            &home.path().join("driver"),
            r##"#!/bin/sh
case "$*" in
  --version) printf 'cua-driver 0.28.0\n' ;;
  status) if [ -f "$HOME/running" ]; then printf 'Cua Driver daemon is running\n'; else printf 'Cua Driver daemon is not running\n' >&2; exit 1; fi ;;
  *) exit 92 ;;
esac
"##,
        );
        script(
            &home.path().join("open"),
            r##"#!/bin/sh
printf '%s\n' "$*" > "$HOME/open-args"
touch "$HOME/running"
"##,
        );
        let actor = Actor::default();
        actor
            .launch_with(
                params(Action::DriverStart, "driver-once"),
                paths(home.path()),
            )
            .unwrap();
        wait(&actor, |v| !v.busy);
        let result = actor.receipts().pop().unwrap();
        assert_eq!(result.receipt.status, Status::Complete);
        assert!(result.helper_exit_confirmed);
        let args = std::fs::read_to_string(home.path().join("open-args")).unwrap();
        assert!(args.ends_with("--args serve --no-permissions-gate\n"));
        assert!(!args.contains("permissions grant"));
    }

    #[test]
    fn permission_request_is_not_reissued_when_readonly_status_already_proves_grants() {
        let home = tempfile::tempdir().unwrap();
        script(
            &home.path().join("driver"),
            r##"#!/bin/sh
case "$*" in
  --version) printf 'cua-driver 0.28.0\n' ;;
  'permissions status --json') printf '%s\n' '{"accessibility":true,"screen_recording":true,"source":{"attribution":"driver-daemon","bundle_id":"com.trycua.driver"}}' ;;
  *) touch "$HOME/forbidden"; exit 93 ;;
esac
"##,
        );
        let actor = Actor::default();
        actor
            .launch_with(
                params(Action::DriverPermissions, "already-granted"),
                paths(home.path()),
            )
            .unwrap();
        wait(&actor, |v| !v.busy);
        assert_eq!(
            actor.receipts().pop().unwrap().receipt.status,
            Status::Complete
        );
        assert!(!home.path().join("forbidden").exists());
    }

    #[test]
    fn unknown_helper_exit_stays_fenced_but_positive_exit_or_changed_boot_does_not_erase_unknown() {
        let params = params(Action::LoginStart, "unknown-login");
        let boot = super::super::super::journal::new_id();
        let other = super::super::super::journal::new_id();
        let mut op = Operation::working(&params, Some(boot.clone())).unwrap();
        op.interrupted();
        assert!(op.holds(Some(&boot)));
        assert!(op.holds(None));
        assert!(!op.holds(Some(&other)));
        assert_eq!(op.receipt.status, Status::OutcomeUnknown);
        op.helper_exit_confirmed = true;
        assert!(!op.holds(Some(&boot)));
        assert_eq!(op.receipt.status, Status::OutcomeUnknown);
    }

    #[test]
    fn unsupported_challenge_and_generic_ack_are_never_authentication_or_desktop_proof() {
        for url in [
            "https://auth.openai.com/codex/device?x=1",
            "https://evil.example/",
            "https://user@auth.openai.com/codex/device",
        ] {
            assert!(parse_challenge(
                &json!({"type":"chatgptDeviceCode","loginId":"11111111-1111-4111-8111-111111111111",
                "verificationUrl":url,"userCode":"TEST-1234"})
            )
            .is_err());
        }
        assert!(!recognized_account(&json!({"account":{}})));
        assert!(!captured_desktop(br#"{"ok":true}"#));
        assert!(!captured_desktop(br#"{"screenshot_png_b64":"aGVsbG8="}"#));
    }

    #[test]
    fn desktop_proof_requires_native_readback_save_and_exact_document_close() {
        for save in [true, false] {
            let home = tempfile::tempdir().unwrap();
            let selected = paths(home.path());
            std::fs::write(home.path().join("save"), if save { "yes" } else { "no" }).unwrap();
            script(
                &selected.open,
                "#!/bin/sh\nprintf '%s' \"$3\" > \"$HOME/checkfile\"\n",
            );
            script(
                &selected.driver,
                r##"#!/usr/bin/python3
import json,os,pathlib,sys
h=pathlib.Path(os.environ['HOME'])
if sys.argv[1:] == ['--version']:
 print('cua-driver 0.28.0'); sys.exit()
if sys.argv[1:] == ['permissions','status','--json']:
 print(json.dumps({'accessibility':True,'screen_recording':True,'source':{'attribution':'driver-daemon','bundle_id':'com.trycua.driver'}})); sys.exit()
tool=sys.argv[2]
if tool == 'get_desktop_state':
 print(json.dumps({'screenshot_png_b64':'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aUKsAAAAASUVORK5CYII='})); sys.exit()
doc=pathlib.Path((h/'checkfile').read_text())
args=json.loads(sys.argv[3])
with (h/'desktop-calls').open('a') as log: log.write(tool+'\n')
if tool == 'list_windows':
 print(json.dumps({'windows':[] if (h/'closed').exists() else [{'app_name':'TextEdit','title':doc.name,'is_on_screen':True,'pid':10,'window_id':20}]}))
elif tool == 'get_window_state':
 print(json.dumps({'pid':10,'window_id':20,'elements':[{'role':'AXTextArea','value':(h/'typed').read_text() if (h/'typed').exists() else '', 'element_token':'s1:1'}]}))
elif tool == 'type_text':
 (h/'typed').write_text(args['text']); print('{}')
elif tool == 'invoke_menu':
 # Driver 0.28.0's actual guest TextEdit snapshot exposes Save (no ellipsis)
 # for this existing .txt document; Save As… is a separate native item.
 if args['path']==['File','Save'] and (h/'save').read_text()=='yes': doc.write_text((h/'typed').read_text())
 if args['path']==['File','Close']: (h/'closed').touch()
 print('{}')
else: sys.exit(99)
"##,
            );
            let actor = Actor::default();
            actor
                .launch_with(params(Action::DesktopVerify, "native-check"), selected)
                .unwrap();
            // The no-save case deliberately consumes the production five-second
            // save deadline, in addition to several owned Python helper launches.
            // Allow scheduling headroom under the full workspace suite; this is
            // only the test's watchdog, not the native proof's timeout or criteria.
            wait_for(&actor, Duration::from_secs(30), |view| !view.busy);
            let receipt = actor.receipts().pop().unwrap().receipt;
            let document =
                PathBuf::from(std::fs::read_to_string(home.path().join("checkfile")).unwrap());
            if save {
                assert_eq!(receipt.status, Status::Complete);
                if super::super::boot_identity().is_some() {
                    assert!(receipt.verification.unwrap().desktop_usable);
                }
                assert!(!document.exists());
            } else {
                assert_eq!(receipt.status, Status::OutcomeUnknown);
                assert_eq!(
                    receipt.detail.as_deref(),
                    Some("guest_native_desktop_save_unverified")
                );
                assert!(receipt.verification.is_none());
                assert!(document.exists());
                assert!(!home.path().join("closed").exists());
            }
            let calls = std::fs::read_to_string(home.path().join("desktop-calls")).unwrap();
            assert_eq!(calls.lines().filter(|call| *call == "type_text").count(), 1);
        }
    }

    #[test]
    fn capture_without_native_input_readback_cannot_produce_desktop_verification() {
        let home = tempfile::tempdir().unwrap();
        let selected = paths(home.path());
        std::fs::write(&selected.driver,r#"#!/bin/sh
case "$*" in
  --version) printf 'cua-driver 0.28.0\n';;
  'permissions status --json') printf '%s\n' '{"accessibility":true,"screen_recording":true,"source":{"attribution":"driver-daemon","bundle_id":"com.trycua.driver"}}';;
  'call get_desktop_state') printf '%s\n' '{"screenshot_png_b64":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aUKsAAAAASUVORK5CYII="}';;
  *) exit 99;;
esac
"#).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&selected.driver, std::fs::Permissions::from_mode(0o700)).unwrap();
        let actor = Actor::default();
        actor
            .launch_with(params(Action::DesktopVerify, "capture"), selected)
            .unwrap();
        wait(&actor, |view| !view.busy);
        let receipt = actor.receipts().pop().unwrap().receipt;
        assert_eq!(receipt.status, Status::OutcomeUnknown);
        assert!(receipt.verification.is_none());
        actor.shutdown();
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Params {
    pub environment_id: String,
    pub generation: String,
    pub action: Action,
    pub idempotency_key: String,
    pub confirm: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login_id: Option<String>,
}

impl Params {
    pub fn validate(&self, identity: &Identity) -> Result<()> {
        if self.environment_id != identity.environment_id || self.generation != identity.generation
        {
            bail!("Guest setup identity mismatch");
        }
        key(&self.idempotency_key)?;
        if !self.confirm {
            bail!("Explicit confirm:true is required for guest setup");
        }
        match (self.action, &self.login_id) {
            (Action::LoginCancel, Some(id)) => super::validate_id(id)?,
            (Action::LoginCancel, None) => bail!("Cancel requires the exact live loginId"),
            (_, Some(_)) => bail!("loginId is only valid for explicit cancellation"),
            _ => {}
        }
        Ok(())
    }
    pub fn digest(&self) -> Result<String> {
        Ok(super::digest(&serde_json::to_vec(self)?))
    }
}

pub(super) fn key(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 200 || value.chars().any(char::is_control) {
        bail!("A bounded exact idempotencyKey is required");
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AuthParams {
    environment_id: String,
    generation: String,
    pub idempotency_key: String,
}
impl AuthParams {
    pub fn check(&self, identity: &Identity) -> Result<()> {
        if self.environment_id != identity.environment_id || self.generation != identity.generation
        {
            bail!("Guest setup auth identity mismatch");
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum Status {
    Working,
    NeedsAttention,
    Complete,
    OutcomeUnknown,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Receipt {
    pub action: Action,
    pub idempotency_key: String,
    pub status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification: Option<Verification>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_verification: Option<AccountVerification>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AccountVerification {
    pub boot_identity: String,
    pub verified_at: String,
    pub binding: super::readiness::AccountBinding,
    pub authenticated: bool,
}

impl AccountVerification {
    pub fn current(
        &self,
        boot: Option<&str>,
        binding: Option<&super::readiness::AccountBinding>,
    ) -> bool {
        let age = chrono::DateTime::parse_from_rfc3339(&self.verified_at)
            .ok()
            .map(|at| chrono::Utc::now().signed_duration_since(at));
        boot == Some(self.boot_identity.as_str())
            && binding == Some(&self.binding)
            && age.is_some_and(|age| {
                age >= chrono::Duration::zero() && age < chrono::Duration::minutes(10)
            })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Verification {
    pub boot_identity: String,
    pub verified_at: String,
    pub driver_executable_sha256: String,
    pub capture_verified: bool,
    pub desktop_usable: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Operation {
    pub receipt: Receipt,
    pub digest: String,
    pub environment_id: String,
    pub generation: String,
    pub boot_identity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default)]
    pub helper_exit_confirmed: bool,
}

impl Operation {
    pub fn validate(&self, key_value: &str, identity: &Identity) -> Result<()> {
        key(key_value)?;
        if self.receipt.idempotency_key != key_value
            || self.environment_id != identity.environment_id
            || self.generation != identity.generation
            || self.digest.len() != 64
            || !self.digest.bytes().all(|b| b.is_ascii_hexdigit())
        {
            bail!("Damaged guest setup operation binding");
        }
        if let Some(boot) = &self.boot_identity {
            super::validate_id(boot)?;
        }
        if let Some(at) = &self.started_at {
            chrono::DateTime::parse_from_rfc3339(at).context("Damaged guest setup start time")?;
        }
        Ok(())
    }
    pub fn working(params: &Params, boot: Option<String>) -> Result<Self> {
        Ok(Self {
            receipt: Receipt {
                action: params.action,
                idempotency_key: params.idempotency_key.clone(),
                status: Status::Working,
                detail: None,
                verification: None,
                account_verification: None,
            },
            digest: params.digest()?,
            environment_id: params.environment_id.clone(),
            generation: params.generation.clone(),
            boot_identity: boot,
            started_at: Some(super::now()),
            helper_exit_confirmed: false,
        })
    }
    pub fn holds(&self, boot: Option<&str>) -> bool {
        !self.helper_exit_confirmed
            && !(matches!((&self.boot_identity,boot),
            (Some(previous),Some(current)) if previous != current))
    }
    pub fn interrupted(&mut self) {
        if matches!(
            self.receipt.status,
            Status::Working | Status::NeedsAttention
        ) {
            self.receipt.status = Status::OutcomeUnknown;
            self.receipt.detail = Some("setup_actor_lost_no_effect_replayed".into());
        }
    }
}

pub(super) fn holds_admission(state: &State, boot: Option<&str>) -> bool {
    state.setup_operations.values().any(|op| op.holds(boot))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Challenge {
    pub login_id: String,
    verification_url: String,
    user_code: String,
}
impl Drop for Challenge {
    fn drop(&mut self) {
        self.login_id.zeroize();
        self.verification_url.zeroize();
        self.user_code.zeroize();
    }
}

#[derive(Clone)]
struct AuthView {
    key: String,
    status: &'static str,
    challenge: Option<Challenge>,
}

#[derive(Clone)]
pub(super) struct ActorReceipt {
    pub receipt: Receipt,
    pub helper_exit_confirmed: bool,
}

#[derive(Default)]
struct View {
    busy: bool,
    receipts: BTreeMap<String, ActorReceipt>,
    auth: Option<AuthView>,
}

enum Control {
    Cancel { key: String, login_id: String },
    Shutdown,
}
struct Live {
    join: std::thread::JoinHandle<()>,
    sender: mpsc::Sender<Control>,
}

#[derive(Default)]
pub(super) struct Actor {
    closed: Arc<AtomicBool>,
    view: Arc<Mutex<View>>,
    live: Mutex<Option<Live>>,
}

impl Actor {
    #[cfg(test)]
    pub(super) fn test_receipt(&self, receipt: Receipt, helper_exit_confirmed: bool) {
        self.view.lock().unwrap().receipts.insert(
            receipt.idempotency_key.clone(),
            ActorReceipt {
                receipt,
                helper_exit_confirmed,
            },
        );
    }
    pub fn receipts(&self) -> Vec<ActorReceipt> {
        self.view
            .lock()
            .unwrap()
            .receipts
            .values()
            .cloned()
            .collect()
    }
    pub fn busy(&self) -> bool {
        self.view.lock().unwrap().busy
    }
    pub fn launch(&self, params: Params, base: &Path, login_allowed: bool) -> Result<()> {
        let mut paths = Paths::guest(base)?;
        paths.login_allowed = login_allowed;
        self.launch_with(params, paths)
    }
    fn launch_with(&self, params: Params, paths: Paths) -> Result<()> {
        let mut live = self.live.lock().unwrap();
        if self.closed.load(Ordering::Acquire) {
            bail!("Guest setup is stopping");
        }
        if params.action == Action::LoginCancel {
            let view = self.view.lock().unwrap();
            let matches = view.busy
                && view.auth.as_ref().is_some_and(|a| {
                    a.status == "awaitingUser"
                        && a.challenge
                            .as_ref()
                            .is_some_and(|c| Some(&c.login_id) == params.login_id.as_ref())
                });
            if !matches {
                drop(view);
                publish(
                    &self.view,
                    &params.idempotency_key,
                    params.action,
                    Status::OutcomeUnknown,
                    "live_login_not_found_external_outcome_unknown",
                    true,
                );
                return Ok(());
            }
            drop(view);
            let sent = live
                .as_ref()
                .context("Login actor unavailable")?
                .sender
                .send(Control::Cancel {
                    key: params.idempotency_key.clone(),
                    login_id: params.login_id.context("loginId required")?,
                });
            if sent.is_err() {
                publish(
                    &self.view,
                    &params.idempotency_key,
                    params.action,
                    Status::OutcomeUnknown,
                    "login_actor_lost_external_outcome_unknown",
                    false,
                );
            }
            return Ok(());
        }
        if self.busy() {
            bail!("Another guest setup actor is active");
        }
        if let Some(previous) = live.take() {
            let _ = previous.join.join();
        }
        let (sender, receiver) = mpsc::channel();
        self.view.lock().unwrap().busy = true;
        let view = self.view.clone();
        let closed = self.closed.clone();
        let failed_key = params.idempotency_key.clone();
        let action = params.action;
        let join = std::thread::Builder::new()
            .name("guest-setup".into())
            .spawn(move || {
                run(params, paths, &closed, &view, receiver);
                view.lock().unwrap().busy = false;
            });
        match join {
            Ok(join) => *live = Some(Live { join, sender }),
            Err(_) => {
                self.view.lock().unwrap().busy = false;
                publish(
                    &self.view,
                    &failed_key,
                    action,
                    Status::Failed,
                    "setup_actor_could_not_start",
                    true,
                );
            }
        }
        Ok(())
    }
    pub fn auth(&self, state: &State, key: &str) -> Value {
        let op = state
            .setup_operations
            .get(key)
            .filter(|o| o.receipt.action == Action::LoginStart);
        let view = self.view.lock().unwrap();
        let auth = view.auth.as_ref().filter(|a| a.key == key);
        let status = match op.map(|o| o.receipt.status) {
            None => "none",
            Some(Status::Complete) => "complete",
            Some(Status::Failed) => "failed",
            Some(Status::OutcomeUnknown) => "outcomeUnknown",
            Some(Status::Working | Status::NeedsAttention) => {
                auth.map(|a| a.status).unwrap_or("pending")
            }
        };
        let mut result = json!({"protocol":1,"environmentId":state.identity.environment_id,
            "generation":state.identity.generation,"idempotencyKey":key,"status":status});
        if status == "awaitingUser" {
            if let Some(challenge) = auth.and_then(|a| a.challenge.as_ref()) {
                result["challenge"] = serde_json::to_value(challenge).expect("serialize challenge");
            }
        }
        result
    }
    pub fn shutdown(&self) {
        self.closed.store(true, Ordering::Release);
        let mut live = self.live.lock().unwrap();
        if let Some(worker) = live.as_ref() {
            let _ = worker.sender.send(Control::Shutdown);
        }
        if let Some(worker) = live.take() {
            let deadline = Instant::now() + Duration::from_secs(3);
            while !worker.join.is_finished() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            if worker.join.is_finished() {
                let _ = worker.join.join();
            }
            // An unconfirmed actor remains fenced; never report cancellation.
        }
    }
}
impl Drop for Actor {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn publish(
    view: &Mutex<View>,
    key: &str,
    action: Action,
    status: Status,
    detail: &str,
    exited: bool,
) {
    view.lock().unwrap().receipts.insert(
        key.into(),
        ActorReceipt {
            receipt: Receipt {
                action,
                idempotency_key: key.into(),
                status,
                detail: Some(detail.into()),
                verification: None,
                account_verification: None,
            },
            helper_exit_confirmed: exited,
        },
    );
}

#[derive(Clone)]
struct Paths {
    home: PathBuf,
    driver: PathBuf,
    app: PathBuf,
    open: PathBuf,
    codex: Option<PathBuf>,
    exits: Arc<AtomicBool>,
    verify_signature: bool,
    login_allowed: bool,
    provider_selection_valid: bool,
}
impl Paths {
    fn guest(base: &Path) -> Result<Self> {
        super::check_setup_identity(base)?;
        let home = base
            .parent()
            .context("Pinned guest home missing")?
            .to_path_buf();
        if Some(home.as_path()) != super::installation()?.parent() {
            bail!("Pinned guest home required");
        }
        let codex = super::readiness::codex_program(&home);
        let provider_selection_valid = super::readiness::account_selection_valid(&home)
            && (codex.is_none() || super::readiness::account_binding(&home).is_ok());
        Ok(Self {
            home,
            driver: DRIVER.into(),
            app: APP.into(),
            open: "/usr/bin/open".into(),
            codex,
            exits: Arc::new(AtomicBool::new(true)),
            verify_signature: true,
            login_allowed: true,
            provider_selection_valid,
        })
    }
}

struct OwnedChild {
    line_limit: usize,
    child: Child,
    group: Option<u32>,
    lifetime: Option<OwnedFd>,
    stdin: Option<ChildStdin>,
    stdout: ChildStdout,
    stderr: ChildStderr,
    out: Vec<u8>,
    err: Vec<u8>,
    deferred: VecDeque<Value>,
    code: Option<i32>,
    exits: Arc<AtomicBool>,
}

fn nonblocking(fd: i32) -> Result<()> {
    // SAFETY: these descriptors are owned by the current helper.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    Ok(())
}

impl OwnedChild {
    fn spawn(program: &Path, args: &[&str], paths: &Paths, closed: &AtomicBool) -> Result<Self> {
        if closed.load(Ordering::Acquire) {
            bail!("Setup stopping before spawn");
        }
        let mut fds = [0; 2];
        // SAFETY: pipe initializes two fresh owned descriptors.
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let read = unsafe { OwnedFd::from_raw_fd(fds[0]) };
        let write = unsafe { OwnedFd::from_raw_fd(fds[1]) };
        for fd in [read.as_raw_fd(), write.as_raw_fd()] {
            if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
                return Err(std::io::Error::last_os_error().into());
            }
        }
        let inherited = read.as_raw_fd();
        // Retained guest CLIs may be npm/shebang launchers. Use the disclosed
        // guest tool locations, never the host owner's inherited PATH.
        let guest_path = std::env::join_paths([
            paths.home.join(".terminalx-local/bin"),
            paths.home.join(".local/bin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
            PathBuf::from("/usr/sbin"),
            PathBuf::from("/sbin"),
        ])?;
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", WATCHDOG, "terminalx-guest-setup"])
            .arg(program)
            .args(args)
            .env_clear()
            .env("HOME", &paths.home)
            .env("PATH", guest_path)
            .env("TERM", "dumb")
            .env("NO_COLOR", "1")
            .env("LANG", "en_US.UTF-8")
            .current_dir(&paths.home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        // Preserve the existing guest Codex store, never force file/keyring.
        // The default home is pinned; custom selectors are refused before auth.
        unsafe {
            cmd.pre_exec(move || {
                if libc::dup2(inherited, 3) < 0 || libc::fcntl(3, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = cmd.spawn()?;
        drop(read);
        let group = Some(child.id());
        // All three pipes were requested above; they are always present.
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let owned = Self {
            line_limit: 1024 * 1024,
            child,
            group,
            lifetime: Some(write),
            stdin: Some(stdin),
            stdout,
            stderr,
            out: vec![],
            err: vec![],
            deferred: VecDeque::new(),
            code: None,
            exits: paths.exits.clone(),
        };
        nonblocking(owned.stdin.as_ref().unwrap().as_raw_fd())?;
        nonblocking(owned.stdout.as_raw_fd())?;
        nonblocking(owned.stderr.as_raw_fd())?;
        if closed.load(Ordering::Acquire) {
            bail!("Setup stopped after spawn; outcome unknown");
        }
        Ok(owned)
    }
    fn pump(&mut self) -> Result<()> {
        fn read(pipe: &mut impl Read, buffer: &mut Vec<u8>, limit: usize) -> Result<()> {
            let mut bytes = [0u8; 8192];
            for _ in 0..16 {
                match pipe.read(&mut bytes) {
                    Ok(0) => break,
                    Ok(n) => {
                        if buffer.len() + n > limit {
                            bail!("Setup output limit");
                        }
                        buffer.extend_from_slice(&bytes[..n]);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(e) => return Err(e.into()),
                }
            }
            bytes.zeroize();
            Ok(())
        }
        read(&mut self.stdout, &mut self.out, MAX_OUTPUT)?;
        read(&mut self.stderr, &mut self.err, 64 * 1024)?;
        if let Some(status) = self.child.try_wait()? {
            self.code = Some(status.code().unwrap_or(-1));
        }
        Ok(())
    }
    fn send(&mut self, value: Value, closed: &AtomicBool) -> Result<()> {
        let mut bytes = serde_json::to_vec(&value)?;
        bytes.push(b'\n');
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut offset = 0;
        while offset < bytes.len() {
            if closed.load(Ordering::Acquire) || Instant::now() >= deadline {
                bytes.zeroize();
                bail!("Setup stdin outcome unknown");
            }
            match self
                .stdin
                .as_mut()
                .context("Setup input closed")?
                .write(&bytes[offset..])
            {
                Ok(0) => bail!("Setup input closed"),
                Ok(n) => offset += n,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(e) => return Err(e.into()),
            }
        }
        bytes.zeroize();
        Ok(())
    }
    fn next(&mut self, wait: Duration, closed: &AtomicBool) -> Result<Option<Value>> {
        let deadline = Instant::now() + wait;
        loop {
            self.pump()?;
            if let Some(n) = self.out.iter().position(|b| *b == b'\n') {
                if n > self.line_limit {
                    bail!("Setup JSON line limit");
                }
                let mut line: Vec<_> = self.out.drain(..=n).collect();
                let value = serde_json::from_slice(&line).ok();
                line.zeroize();
                if value.is_some() {
                    return Ok(value);
                }
            }
            if closed.load(Ordering::Acquire) || self.code.is_some() {
                bail!("Setup actor stopped; external outcome unknown");
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn response(&mut self, id: u64, closed: &AtomicBool) -> Result<Value> {
        let deadline = Instant::now() + RPC_WAIT;
        while Instant::now() < deadline {
            if let Some(value) = self.next(Duration::from_millis(100), closed)? {
                if value["id"].as_u64() == Some(id) {
                    if value.get("error").is_some_and(|v| !v.is_null()) {
                        bail!("Setup provider refused request");
                    }
                    return value
                        .get("result")
                        .cloned()
                        .context("Missing setup provider receipt");
                }
                if self.deferred.len() >= 64 {
                    bail!("Setup notification limit");
                }
                self.deferred.push_back(value);
            }
        }
        bail!("Setup provider receipt timed out")
    }
    fn wait(&mut self, timeout: Duration, closed: &AtomicBool) -> Result<i32> {
        let deadline = Instant::now() + timeout;
        loop {
            self.pump()?;
            if let Some(code) = self.code {
                return Ok(code);
            }
            if closed.load(Ordering::Acquire) || Instant::now() >= deadline {
                bail!("Setup helper ended without confirmed outcome");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    fn stop(&mut self) -> bool {
        self.lifetime.take();
        self.stdin.take();
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            let Some(pid) = self.group else {
                return true;
            };
            let _ = self.child.try_wait();
            if !crate::harness::host::group_or_process_alive(pid) {
                self.group = None;
                return true;
            }
            // Only the captured, still-owned group can be signaled.
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if !self.stop() {
            self.exits.store(false, Ordering::Release);
        }
        self.out.zeroize();
        self.err.zeroize();
    }
}

struct Output {
    code: i32,
    bytes: Vec<u8>,
    err: Vec<u8>,
}
impl Drop for Output {
    fn drop(&mut self) {
        self.bytes.zeroize();
        self.err.zeroize();
    }
}
fn finite(
    program: &Path,
    args: &[&str],
    paths: &Paths,
    closed: &AtomicBool,
    timeout: Duration,
) -> Result<Output> {
    let mut child = OwnedChild::spawn(program, args, paths, closed)?;
    child.stdin.take();
    let code = child.wait(timeout, closed)?;
    // Receipt collection also remains bounded after the direct child exits.
    child.pump()?;
    Ok(Output {
        code,
        bytes: std::mem::take(&mut child.out),
        err: std::mem::take(&mut child.err),
    })
}

fn run(
    params: Params,
    paths: Paths,
    closed: &AtomicBool,
    view: &Mutex<View>,
    control: mpsc::Receiver<Control>,
) {
    let account_binding = (params.action == Action::AccountVerify)
        .then(|| {
            Some((
                super::boot_identity()?,
                super::readiness::account_binding(&paths.home).ok()?,
            ))
        })
        .flatten();
    let capture_binding = (params.action == Action::DesktopVerify)
        .then(|| {
            Some((
                super::boot_identity()?,
                super::readiness::executable_sha256(&paths.driver).ok()?,
            ))
        })
        .flatten();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if matches!(params.action, Action::LoginStart | Action::AccountVerify) {
            login(&params, &paths, closed, view, control)
        } else {
            driver_action(params.action, &paths, closed)
        }
    }));
    let (mut status, mut detail) = match result {
        Ok(Ok(result)) => result,
        _ => (
            Status::OutcomeUnknown,
            "setup_effect_outcome_unknown_inspect_before_retry",
        ),
    };
    let exited = paths.exits.load(Ordering::Acquire);
    if !exited {
        status = Status::OutcomeUnknown;
    }
    let account_verification = if params.action == Action::AccountVerify
        && status == Status::Complete
        && exited
    {
        account_binding
            .filter(|(boot, binding)| {
                super::boot_identity().as_ref() == Some(boot)
                    && super::readiness::account_binding(&paths.home).as_ref().ok() == Some(binding)
            })
            .map(|(boot_identity, binding)| AccountVerification {
                boot_identity,
                binding,
                verified_at: super::now(),
                authenticated: detail == "guest_provider_already_authenticated_no_login_started",
            })
    } else {
        None
    };
    if params.action == Action::AccountVerify
        && status == Status::Complete
        && account_verification.is_none()
    {
        status = Status::Failed;
        detail = "guest_account_binding_changed_check_again_no_login_started";
    }
    let verification =
        if params.action == Action::DesktopVerify && status == Status::Complete && exited {
            capture_binding
                .filter(|(boot, sha)| {
                    super::boot_identity().as_ref() == Some(boot)
                        && super::readiness::executable_sha256(&paths.driver)
                            .as_ref()
                            .ok()
                            == Some(sha)
                })
                .map(|(boot, sha)| Verification {
                    boot_identity: boot,
                    verified_at: super::now(),
                    driver_executable_sha256: sha,
                    capture_verified: true,
                    desktop_usable: detail == "explicit_guest_desktop_input_readback_verified",
                })
        } else {
            None
        };
    // Publish the receipt and its capture proof together. A journal tick must
    // never freeze an earlier terminal receipt without its matching proof.
    view.lock().unwrap().receipts.insert(
        params.idempotency_key.clone(),
        ActorReceipt {
            receipt: Receipt {
                action: params.action,
                idempotency_key: params.idempotency_key.clone(),
                status,
                detail: Some(detail.into()),
                verification,
                account_verification,
            },
            helper_exit_confirmed: exited,
        },
    );
    if params.action == Action::LoginStart {
        let mut view = view.lock().unwrap();
        if let Some(auth) = view
            .auth
            .as_mut()
            .filter(|a| a.key == params.idempotency_key)
        {
            auth.status = match status {
                Status::Complete => "complete",
                Status::Failed => "failed",
                _ => "outcomeUnknown",
            };
            auth.challenge = None;
        }
    }
}

fn driver_action(
    action: Action,
    paths: &Paths,
    closed: &AtomicBool,
) -> Result<(Status, &'static str)> {
    if paths.verify_signature {
        let checked = finite(
            Path::new("/usr/bin/codesign"),
            &[
                "--verify",
                "--deep",
                "--strict",
                "-R",
                "=identifier \"com.trycua.driver\" and anchor apple generic",
                paths.app.to_str().context("Driver bundle path")?,
            ],
            paths,
            closed,
            Duration::from_secs(10),
        )?;
        if checked.code != 0 {
            return Ok((Status::Failed, "driver_signature_invalid_no_action_started"));
        }
    }
    let version = finite(
        &paths.driver,
        &["--version"],
        paths,
        closed,
        Duration::from_secs(5),
    )?;
    if version.code != 0
        || !matches!(
            std::str::from_utf8(&version.bytes).ok().map(str::trim),
            Some("cua-driver 0.28.0" | "cua-driver-rs 0.28.0")
        )
    {
        return Ok((Status::Failed, "driver_version_mismatch_no_action_started"));
    }
    match action {
        Action::DriverStart => {
            if driver_running(paths, closed)? {
                return Ok((Status::Complete, "driver_already_running"));
            }
            let launched = finite(
                &paths.open,
                &[
                    "-n",
                    "-g",
                    "-a",
                    paths.app.to_str().context("Driver app path")?,
                    "--args",
                    "serve",
                    "--no-permissions-gate",
                ],
                paths,
                closed,
                Duration::from_secs(10),
            )?;
            if launched.code != 0 {
                return Ok((Status::OutcomeUnknown, "driver_launch_outcome_unknown"));
            }
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline && !closed.load(Ordering::Acquire) {
                if driver_running(paths, closed)? {
                    return Ok((Status::Complete, "driver_running_permissions_not_requested"));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Ok((Status::OutcomeUnknown, "driver_launch_not_confirmed"))
        }
        Action::DriverPermissions => {
            if permissions_granted(paths, closed)? {
                return Ok((
                    Status::Complete,
                    "driver_permissions_already_granted_capture_not_probed",
                ));
            }
            let granted = finite(
                &paths.driver,
                &["permissions", "grant"],
                paths,
                closed,
                Duration::from_secs(8 * 60),
            )?;
            if granted.code == 0 && permissions_granted(paths, closed)? {
                Ok((
                    Status::Complete,
                    "driver_explicit_permissions_and_capture_verified",
                ))
            } else {
                Ok((
                    Status::OutcomeUnknown,
                    "permission_request_ended_human_consent_outcome_unknown",
                ))
            }
        }
        Action::DesktopVerify => {
            if !permissions_granted(paths, closed)? {
                return Ok((
                    Status::Failed,
                    "driver_permissions_not_verified_no_capture_started",
                ));
            }
            let result = finite(
                &paths.driver,
                &["call", "get_desktop_state"],
                paths,
                closed,
                Duration::from_secs(20),
            )?;
            if result.code == 0 && captured_desktop(&result.bytes) {
                match desktop_check::verify(paths, closed) {
                    Ok(()) => Ok((
                        Status::Complete,
                        "explicit_guest_desktop_input_readback_verified",
                    )),
                    Err(error) => Ok((
                        Status::OutcomeUnknown,
                        desktop_check::failure_reason(&error),
                    )),
                }
            } else {
                Ok((
                    Status::OutcomeUnknown,
                    "explicit_desktop_capture_not_verified",
                ))
            }
        }
        _ => bail!("Unexpected setup action"),
    }
}

fn driver_running(paths: &Paths, closed: &AtomicBool) -> Result<bool> {
    let result = finite(
        &paths.driver,
        &["status"],
        paths,
        closed,
        Duration::from_secs(5),
    )?;
    if result.code == 0
        && std::str::from_utf8(&result.bytes)
            .is_ok_and(|s| s.lines().next() == Some("Cua Driver daemon is running"))
    {
        Ok(true)
    } else if result.code == 1 && result.err == b"Cua Driver daemon is not running\n" {
        Ok(false)
    } else {
        bail!("Driver liveness unknown; no launch admitted")
    }
}
fn permissions_granted(paths: &Paths, closed: &AtomicBool) -> Result<bool> {
    let result = finite(
        &paths.driver,
        &["permissions", "status", "--json"],
        paths,
        closed,
        Duration::from_secs(5),
    )?;
    let value: Value = serde_json::from_slice(&result.bytes).unwrap_or(Value::Null);
    Ok(result.code == 0
        && value["accessibility"] == true
        && value["screen_recording"] == true
        && value.pointer("/source/attribution").and_then(Value::as_str) == Some("driver-daemon")
        && value.pointer("/source/bundle_id").and_then(Value::as_str) == Some("com.trycua.driver"))
}
fn captured_desktop(bytes: &[u8]) -> bool {
    use base64::Engine as _;
    let Ok(mut value) = serde_json::from_slice::<Value>(bytes) else {
        return false;
    };
    if value["isError"] == true || value["ok"] == false {
        return false;
    }
    let Some(mut encoded) = value
        .get_mut("screenshot_png_b64")
        .and_then(|v| v.take().as_str().map(str::to_owned))
    else {
        return false;
    };
    let decoded = base64::engine::general_purpose::STANDARD.decode(&encoded);
    encoded.zeroize();
    let Ok(mut png) = decoded else {
        return false;
    };
    let valid = png.len() > 24
        && png.starts_with(b"\x89PNG\r\n\x1a\n")
        && &png[12..16] == b"IHDR"
        && u32::from_be_bytes(png[16..20].try_into().unwrap()) > 0
        && u32::from_be_bytes(png[20..24].try_into().unwrap()) > 0;
    png.zeroize();
    valid
}

fn login(
    params: &Params,
    paths: &Paths,
    closed: &AtomicBool,
    view: &Mutex<View>,
    control: mpsc::Receiver<Control>,
) -> Result<(Status, &'static str)> {
    if !paths.provider_selection_valid {
        return Ok((
            Status::Failed,
            "existing_provider_auth_selection_requires_review_no_login_started",
        ));
    }
    let Some(program) = paths.codex.as_ref() else {
        return Ok((Status::Failed, "guest_codex_missing_no_login_started"));
    };
    let mut child = OwnedChild::spawn(program, &["app-server"], paths, closed)?;
    child.send(json!({"id":1,"method":"initialize","params":{"clientInfo":{
        "name":"terminalx_guest_setup","title":"TerminalX guest setup","version":env!("CARGO_PKG_VERSION")}}}),closed)?;
    child.response(1, closed)?;
    child.send(json!({"method":"initialized","params":{}}), closed)?;
    let account = read_account(&mut child, 2, closed)?;
    if recognized_account(&account) {
        return Ok((
            Status::Complete,
            "guest_provider_already_authenticated_no_login_started",
        ));
    }
    if params.action == Action::AccountVerify {
        return Ok(
            if account.get("account") == Some(&Value::Null) && account["requiresOpenaiAuth"] == true
            {
                (
                    Status::Complete,
                    "guest_provider_account_missing_no_login_started",
                )
            } else {
                (
                    Status::Failed,
                    "guest_provider_auth_not_required_or_unrecognized_no_login_started",
                )
            },
        );
    }
    if account.get("account") != Some(&Value::Null) || account["requiresOpenaiAuth"] != true {
        return Ok((
            Status::Failed,
            "guest_provider_auth_not_required_or_unrecognized_no_login_started",
        ));
    }
    if !paths.login_allowed {
        return Ok((
            Status::Failed,
            "prior_login_outcome_unknown_explicit_reconciliation_required",
        ));
    }
    view.lock().unwrap().auth = Some(AuthView {
        key: params.idempotency_key.clone(),
        status: "pending",
        challenge: None,
    });
    // Pinned Codex 0.153.4 internally sets open_browser:false for this public
    // request variant; there is no public open_browser parameter to invent.
    child.send(
        json!({"id":3,"method":"account/login/start","params":{"type":"chatgptDeviceCode"}}),
        closed,
    )?;
    let response = child.response(3, closed)?;
    let challenge = parse_challenge(&response)?;
    let login_id = challenge.login_id.clone();
    {
        let mut view = view.lock().unwrap();
        view.auth = Some(AuthView {
            key: params.idempotency_key.clone(),
            status: "awaitingUser",
            challenge: Some(challenge),
        });
        view.receipts.insert(
            params.idempotency_key.clone(),
            ActorReceipt {
                receipt: Receipt {
                    action: Action::LoginStart,
                    idempotency_key: params.idempotency_key.clone(),
                    status: Status::NeedsAttention,
                    detail: Some("device_login_awaiting_user".into()),
                    verification: None,
                    account_verification: None,
                },
                helper_exit_confirmed: false,
            },
        );
    }
    let deadline = Instant::now() + LOGIN_LIFETIME;
    while Instant::now() < deadline && !closed.load(Ordering::Acquire) {
        match control.try_recv() {
            Ok(Control::Shutdown) => bail!("Setup shutdown"),
            Ok(Control::Cancel {
                key,
                login_id: cancel_id,
            }) => {
                let result = (|| -> Result<bool> {
                    if cancel_id != login_id {
                        bail!("Login target changed");
                    }
                    child.send(json!({"id":4,"method":"account/login/cancel","params":{"loginId":cancel_id}}),closed)?;
                    Ok(child.response(4, closed)?["status"] == "canceled")
                })();
                // Even a successful local cancellation cannot revoke a
                // provider authorization the person may already have given.
                let detail = if matches!(result, Ok(true)) {
                    "local_login_wait_canceled_external_authorization_unknown"
                } else {
                    "login_cancel_not_confirmed_external_outcome_unknown"
                };
                drop(child);
                publish(
                    view,
                    &key,
                    Action::LoginCancel,
                    Status::OutcomeUnknown,
                    detail,
                    paths.exits.load(Ordering::Acquire),
                );
                return Ok((Status::OutcomeUnknown, detail));
            }
            Err(mpsc::TryRecvError::Empty) => {}
            Err(mpsc::TryRecvError::Disconnected) => bail!("Setup owner unavailable"),
        }
        let message = match child.deferred.pop_front() {
            Some(message) => Some(message),
            None => child.next(Duration::from_millis(100), closed)?,
        };
        if let Some(message) = message {
            if message["method"] == "account/login/completed"
                && message.pointer("/params/loginId").and_then(Value::as_str) == Some(&login_id)
            {
                if message.pointer("/params/success").and_then(Value::as_bool) != Some(true) {
                    return Ok((
                        Status::OutcomeUnknown,
                        "provider_login_did_not_confirm_success",
                    ));
                }
                let account = read_account(&mut child, 5, closed)?;
                if recognized_account(&account) {
                    return Ok((
                        Status::Complete,
                        "provider_login_completed_and_local_account_confirmed",
                    ));
                }
                return Ok((
                    Status::OutcomeUnknown,
                    "provider_login_completed_without_account_receipt",
                ));
            }
        }
    }
    bail!("Setup login lifetime ended; outcome unknown")
}

fn read_account(child: &mut OwnedChild, id: u64, closed: &AtomicBool) -> Result<Value> {
    child.send(
        json!({"id":id,"method":"account/read","params":{"refreshToken":false}}),
        closed,
    )?;
    child.response(id, closed)
}
fn recognized_account(value: &Value) -> bool {
    matches!(
        value.pointer("/account/type").and_then(Value::as_str),
        Some("chatgpt" | "apiKey")
    )
}
fn parse_challenge(value: &Value) -> Result<Challenge> {
    if value["type"] != "chatgptDeviceCode" {
        bail!("Unsupported device login reply");
    }
    let login_id = value["loginId"].as_str().context("Missing login binding")?;
    super::validate_id(login_id)?;
    let url = value["verificationUrl"]
        .as_str()
        .context("Missing device URL")?;
    if url != "https://auth.openai.com/codex/device" {
        bail!("Untrusted device URL");
    }
    let code = value["userCode"]
        .as_str()
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 64
                && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
        .context("Invalid device code")?;
    Ok(Challenge {
        login_id: login_id.into(),
        verification_url: url.into(),
        user_code: code.into(),
    })
}
