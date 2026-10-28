//! Account-bound bootstrap delivery. The fixed SSH shim uploads one verified
//! loader; the loader installs through a durable native guest receipt. Neither
//! file installation nor a receipt starts an owner/Driver/provider or means Ready.
use super::{
    admission::Guard,
    journal::{self, Environment, Journal},
    macos_keys,
    macos_transport::{self, Endpoint, InstallPlan, Programs},
    process,
};
use anyhow::{bail, Context, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::OpenOptions,
    io::Read,
    os::{
        fd::AsRawFd,
        unix::fs::{OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    time::Duration,
};

const LIMIT: u64 = 512 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Intent {
    version: u32,
    request_id: String,
    environment: Environment,
    pub(super) plan: InstallPlan,
    runtime_bytes: u64,
}
impl Intent {
    fn validate(&self) -> Result<()> {
        journal::validate_id(&self.request_id)?;
        let pinned = macos_transport::binding(&self.environment)?;
        if self.version != 1
            || self.request_id != pinned.bootstrap_id
            || self.runtime_bytes < 32
            || self.runtime_bytes > LIMIT
            || json!(self.plan)
                != json!(macos_transport::install_plan(
                    &self.environment,
                    &pinned.runtime_sha256
                )?)
        {
            bail!("Bootstrap intent/plan/account/runtime changed")
        }
        Ok(())
    }
    pub(super) fn digest(&self) -> Result<String> {
        Ok(journal::digest(&serde_json::to_vec(self)?))
    }
    fn guest_directory(&self) -> Result<PathBuf> {
        Ok(
            Path::new(&macos_transport::binding(&self.environment)?.account.home)
                .join(".terminalx-bootstrap")
                .join(&self.request_id),
        )
    }
}
/// Sealed after exact digest, native architecture and signature verification.
struct Artifact {
    bytes: Vec<u8>,
}
impl Artifact {
    fn verify(bytes: Vec<u8>, expected: &str) -> Result<Self> {
        if bytes.len() < 32
            || bytes.len() as u64 > LIMIT
            || journal::digest(&bytes) != expected
            || bytes[..4] != [0xcf, 0xfa, 0xed, 0xfe]
            || u32::from_le_bytes(bytes[4..8].try_into()?) != 0x0100000c
        {
            bail!("Pinned arm64 Mach-O artifact required")
        }
        Ok(Self { bytes })
    }
    fn load(path: &Path, expected: &str, codesign: &Path) -> Result<Self> {
        let m = std::fs::symlink_metadata(path)?;
        if !path.is_absolute() || !m.is_file() || m.len() > LIMIT {
            bail!("Bundled runtime artifact unavailable")
        }
        let result = Self::verify(std::fs::read(path)?, expected)?;
        process::run(
            std::process::Command::new(codesign)
                .args(["--verify", "--strict"])
                .arg(path),
            b"",
            Duration::from_secs(30),
        )?;
        if std::fs::read(path)? != result.bytes {
            bail!("Verified runtime changed during attestation")
        }
        Ok(result)
    }
}
fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}
fn remote(intent: &Intent, action: &str) -> Result<String> {
    intent.validate()?;
    let directory = intent.guest_directory()?;
    let base = directory.parent().context("Bootstrap directory missing")?;
    let pinned = macos_transport::binding(&intent.environment)?;
    let common=format!("set -eu; umask 077; test \"$(/usr/bin/id -u)\" = {}; test \"$(/usr/bin/id -g)\" = {}; test ! -L {}; ",pinned.account.uid,pinned.account.gid,shell_quote(&base.to_string_lossy()));
    let home = shell_quote(&pinned.account.home);
    let common=format!("{common}test ! -L {home}; test -d {home}; test \"$(/usr/bin/stat -f %u {home})\" = {uid}; test \"$(/usr/bin/stat -f %d {home})\" = {device}; test \"$(/usr/bin/stat -f %i {home})\" = {inode}; test \"$(/usr/bin/id -un)\" = {name}; test \"$(/usr/bin/dscl . -read /Users/{name} NFSHomeDirectory)\" = 'NFSHomeDirectory: {raw_home}'; ",uid=pinned.account.uid,device=pinned.account.home_device,inode=pinned.account.home_inode,name=pinned.account.short_name,raw_home=pinned.account.home);
    let directory = shell_quote(&directory.to_string_lossy());
    let sha = &intent.plan.runtime_sha256;
    let script=match action {
        "upload"=>format!("{common}if test ! -e {base}; then /bin/mkdir -m 700 {base}; fi; test -d {base}; test \"$(/usr/bin/stat -f %u {base})\" = {uid}; test \"$(/usr/bin/stat -f %Lp {base})\" = 700; /bin/mkdir -m 700 {directory}; cd {directory}; printf %s {digest} > intent; /usr/bin/base64 -D > loader; test \"$(/usr/bin/shasum -a 256 loader | /usr/bin/cut -d ' ' -f1)\" = {sha}; /usr/bin/codesign --verify --strict loader; /bin/chmod 700 loader; printf %s {digest} > loader-complete; printf '{{\"ok\":true,\"result\":{{\"stage\":\"loaderVerified\",\"inputDigest\":\"{digest}\",\"runtimeSha256\":\"{sha}\"}}}}'",base=shell_quote(&base.to_string_lossy()),uid=pinned.account.uid,digest=intent.digest()?),
        "loaderReceipt"=>format!("{common}test ! -L {directory}; cd {directory}; test \"$(cat intent)\" = {digest}; test \"$(cat loader-complete)\" = {digest}; test ! -L loader; test \"$(/usr/bin/stat -f %u loader)\" = {uid}; test \"$(/usr/bin/stat -f %Lp loader)\" = 700; test \"$(/usr/bin/shasum -a 256 loader | /usr/bin/cut -d ' ' -f1)\" = {sha}; /usr/bin/codesign --verify --strict loader; printf '{{\"ok\":true,\"result\":{{\"stage\":\"loaderVerified\",\"inputDigest\":\"{digest}\",\"runtimeSha256\":\"{sha}\"}}}}'",digest=intent.digest()?,uid=pinned.account.uid),
        "install"|"receipt"|"toolsInstall"|"toolsReceipt"=>format!("{common}test ! -L {directory}; cd {directory}; test \"$(cat intent)\" = {digest}; test \"$(cat loader-complete)\" = {digest}; test ! -L loader; test \"$(/usr/bin/stat -f %u loader)\" = {uid}; test \"$(/usr/bin/stat -f %Lp loader)\" = 700; test \"$(/usr/bin/shasum -a 256 loader | /usr/bin/cut -d ' ' -f1)\" = {sha}; /usr/bin/codesign --verify --strict loader; exec ./loader local-vm-bootstrap {action}",digest=intent.digest()?,uid=pinned.account.uid),
        _=>bail!("Unknown bootstrap delivery action")
    };
    Ok(format!("/bin/sh -c {}", shell_quote(&script)))
}
fn invoke(
    root: &Path,
    intent: &Intent,
    endpoint: &Endpoint,
    programs: &Programs<'_>,
    action: &str,
    artifact: Option<&Artifact>,
) -> Result<Value> {
    let input = if action == "toolsInstall" {
        super::macos_tools::packet(intent)?
    } else if action == "toolsReceipt" {
        let mut input = serde_json::to_vec(
            &json!({"intent":intent,"profiles":super::macos_tools::profiles()}),
        )?;
        input.push(b'\n');
        input
    } else if action == "upload" {
        base64::engine::general_purpose::STANDARD
            .encode(&artifact.context("Verified artifact required")?.bytes)
            .into_bytes()
    } else {
        serde_json::to_vec(intent)?
    };
    transmit(root, intent, endpoint, programs, action, &input)
}
fn transmit(
    root: &Path,
    intent: &Intent,
    endpoint: &Endpoint,
    programs: &Programs<'_>,
    action: &str,
    input: &[u8],
) -> Result<Value> {
    let (mut command, _keys) = macos_transport::command_using(
        root,
        &intent.environment,
        endpoint,
        programs,
        &remote(intent, action)?,
        Duration::from_secs(30),
    )?;
    super::transport::decode(&process::run(
        &mut command,
        input,
        Duration::from_secs(180),
    )?)
}
fn record_path(root: &Path, key: &str) -> PathBuf {
    root.join("macos-bootstrap-delivery")
        .join(key)
        .join("record.json")
}
fn save(root: &Path, key: &str, record: &Value) -> Result<()> {
    journal::atomic_private_write(&record_path(root, key), &serde_json::to_vec(record)?)
}
fn validate_marker(marker: &Value, intent: &Intent) -> Result<()> {
    if marker["kind"] != "macosBootstrapDelivery"
        || marker["inputDigest"] != intent.digest()?
        || marker["target"]
            != json!(intent
                .environment
                .transport
                .target(&intent.environment.id, &intent.environment.generation))
    {
        bail!("Competing ownership prevents bootstrap delivery")
    }
    Ok(())
}
fn same_environment(a: &Environment, b: &Environment) -> bool {
    a.id == b.id
        && a.generation == b.generation
        && a.sandbox == b.sandbox
        && a.transport == b.transport
        && a.deleted_at.is_none()
        && b.deleted_at.is_none()
}
pub(super) fn status(root: &Path, env: &Environment) -> Result<Value> {
    let pinned = macos_transport::binding(env)?;
    let record: Value = serde_json::from_slice(&macos_keys::private_read(
        &record_path(root, &pinned.bootstrap_id),
        128 * 1024,
    )?)?;
    let intent: Intent = serde_json::from_value(record["intent"].clone())?;
    intent.validate()?;
    if !same_environment(env, &intent.environment) || record["inputDigest"] != intent.digest()? {
        bail!("Original bootstrap record differs")
    }
    Ok(record)
}
pub(super) fn reconcile(env: &Environment, expected_digest: &str) -> Result<Value> {
    macos_transport::require_available()?;
    let record = status(&super::host::root()?, env)?;
    if record["inputDigest"] != expected_digest {
        bail!("Displayed original bootstrap digest changed")
    }
    let action = match record["status"].as_str() {
        Some("loaderOutcomeUnknown") => "loaderReceipt",
        Some("installOutcomeUnknown") => "receipt",
        Some("toolsOutcomeUnknown") => "toolsReceipt",
        _ => return Ok(record),
    };
    deliver(env, &std::env::current_exe()?, action)
}
fn change_using(
    root: &Path,
    journal: &Journal,
    intent: &Intent,
    artifact: &Artifact,
    action: &str,
    mut call: impl FnMut(&str) -> Result<Value>,
) -> Result<Value> {
    intent.validate()?;
    macos_transport::binding(&intent.environment)?.check_retained(root)?;
    if Artifact::verify(artifact.bytes.clone(), &intent.plan.runtime_sha256)?
        .bytes
        .len() as u64
        != intent.runtime_bytes
    {
        bail!("Runtime artifact length changed")
    }
    let env = &intent.environment;
    let target = env.transport.target(&env.id, &env.generation);
    let guard = Guard::lock(root, &target)?;
    if guard.marker.try_exists()? {
        validate_marker(
            &serde_json::from_slice(&super::admission::read_marker(&guard.marker)?)?,
            intent,
        )?;
    }
    let state = journal.read()?;
    if !state.enabled
        || state.environments.get(&env.id).is_none_or(|current| {
            !same_environment(current, env) || current.manual_control || super::setup::busy(current)
        })
        || env.manual_control
        || super::setup::busy(env)
        || state
            .tasks
            .values()
            .any(|task| task.target.environment_id == env.id)
    {
        bail!("Bootstrap requires original unused environment and exclusive ownership")
    }
    let path = record_path(root, &intent.request_id);
    let existed = path.parent().unwrap().try_exists()?;
    let mut record = if existed {
        let record: Value = serde_json::from_slice(&macos_keys::private_read(&path, 128 * 1024)?)?;
        if record["intent"] != json!(intent) || record["inputDigest"] != intent.digest()? {
            bail!("Original delivery intent changed")
        }
        record
    } else {
        if action != "upload" {
            bail!("Original bootstrap delivery missing")
        }
        journal::private_directory(path.parent().unwrap())?;
        let record = json!({"intent":intent,"inputDigest":intent.digest()?,"status":"loaderOutcomeUnknown","ready":false});
        save(root, &intent.request_id, &record)?;
        macos_keys::write_new(&path.parent().unwrap().join("runtime"), &artifact.bytes)?;
        record
    };
    if record["status"] == "complete"
        || (record["status"] == "installed" && action != "toolsInstall")
        || (existed && action == "upload")
    {
        return Ok(record);
    }
    match action {
        "upload" if !existed => {}
        "loaderReceipt" if record["status"] == "loaderOutcomeUnknown" => {}
        "install" if record["status"] == "loaderVerified" => {
            record["status"] = json!("installOutcomeUnknown");
            save(root, &intent.request_id, &record)?;
        }
        "receipt" if record["status"] == "installOutcomeUnknown" => {}
        "toolsInstall" if record["status"] == "installed" => {
            record["status"] = json!("toolsOutcomeUnknown");
            save(root, &intent.request_id, &record)?;
        }
        "toolsReceipt" if record["status"] == "toolsOutcomeUnknown" => {}
        _ => bail!("Recover the original bootstrap stage; uncertain delivery is never replayed"),
    }
    journal::atomic_private_write(
        &guard.marker,
        &serde_json::to_vec(
            &json!({"kind":"macosBootstrapDelivery","inputDigest":intent.digest()?,"target":target}),
        )?,
    )?;
    let result = call(action);
    match result {
        Ok(observed) => {
            if observed["inputDigest"] != intent.digest()?
                || observed["runtimeSha256"] != intent.plan.runtime_sha256
            {
                bail!("Original bootstrap receipt identity changed")
            }
            if matches!(action, "upload" | "loaderReceipt") {
                if observed["stage"] != "loaderVerified" {
                    bail!("Loader completion unproven")
                }
                record["status"] = json!("loaderVerified");
                record["loaderReceipt"] = observed;
            } else {
                let tools = matches!(action, "toolsInstall" | "toolsReceipt");
                if (tools
                    && (observed["stage"] != "toolsInstalled"
                        || observed["profiles"] != super::macos_tools::profiles()))
                    || (!tools && observed["stage"] != "installed")
                    || observed["identity"] != intent.plan.identity
                    || observed["exitProof"] != "terminalReceiptUnderOriginalLock"
                {
                    bail!("Original native installer completion unproven")
                }
                record["status"] = json!(if tools { "complete" } else { "installed" });
                if tools {
                    record["toolsReceipt"] = observed;
                } else {
                    record["receipt"] = observed;
                }
            }
            save(root, &intent.request_id, &record)?;
            if matches!(record["status"].as_str(), Some("installed" | "complete")) {
                guard.completed()?;
            }
        }
        Err(error) => {
            record["detail"]=json!(format!("Original {action} outcome unknown; reconcile its receipt without replay: {error:#}"));
            save(root, &intent.request_id, &record)?;
        }
    }
    Ok(record)
}
pub(super) fn deliver(env: &Environment, runtime: &Path, action: &str) -> Result<Value> {
    macos_transport::require_available()?;
    let pinned = macos_transport::binding(env)?;
    let root = super::host::root()?;
    let journal = super::host::journal()?;
    let cached = record_path(&root, &pinned.bootstrap_id)
        .parent()
        .unwrap()
        .join("runtime");
    let runtime = if cached.try_exists()? {
        cached.as_path()
    } else {
        runtime
    };
    let key = macos_keys::produce(&root, pinned, false)?;
    if key["state"] != "ready" {
        bail!("Reconcile original per-guest key producer first")
    }
    let artifact = Artifact::load(
        runtime,
        &pinned.runtime_sha256,
        Path::new("/usr/bin/codesign"),
    )?;
    let intent = if record_path(&root, &pinned.bootstrap_id).try_exists()? {
        serde_json::from_value(status(&root, env)?["intent"].clone())?
    } else {
        Intent {
            version: 1,
            request_id: pinned.bootstrap_id.clone(),
            environment: env.clone(),
            plan: macos_transport::install_plan(env, &pinned.runtime_sha256)?,
            runtime_bytes: artifact.bytes.len() as u64,
        }
    };
    change_using(&root, &journal, &intent, &artifact, action, |action| {
        // Fresh exact VM/config candidate each step; SSH pin is still mandatory.
        let endpoint = super::macos_endpoint::observe(&root, env)?;
        invoke(
            &root,
            &intent,
            &endpoint,
            &Programs {
                ssh: Path::new("/usr/bin/ssh"),
                keygen: Path::new("/usr/bin/ssh-keygen"),
            },
            action,
            Some(&artifact),
        )
    })
}

/// Internal filesystem seam: fixtures supply disposable paths and synthetic
/// account observation. Production derives both from the OS account database.
fn guest_using(
    home: &Path,
    observed: &super::macos_account::Account,
    loader: &Path,
    intent: &Intent,
    action: &str,
    verify: impl Fn(&Path) -> Result<()>,
) -> Result<Value> {
    intent.validate()?;
    let account = &macos_transport::binding(&intent.environment)?.account;
    if observed != account || !matches!(action, "install" | "receipt") {
        bail!("Original guest account/action differs")
    }
    let directory = home.join(".terminalx-bootstrap").join(&intent.request_id);
    macos_keys::check_directory(&home.join(".terminalx-bootstrap"))?;
    macos_keys::check_directory(&directory)?;
    if macos_keys::private_read(&directory.join("intent"), 128)? != intent.digest()?.as_bytes()
        || macos_keys::private_read(&directory.join("loader-complete"), 128)?
            != intent.digest()?.as_bytes()
    {
        bail!("Authenticated loader delivery receipt missing")
    }
    let artifact = Artifact::verify(
        macos_keys::private_read(loader, LIMIT)?,
        &intent.plan.runtime_sha256,
    )?;
    if artifact.bytes.len() as u64 != intent.runtime_bytes {
        bail!("Loader length changed")
    }
    verify(loader)?;
    let receipt_path = directory.join("install-receipt.json");
    let existed = directory.join("installer.lock").try_exists()?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(action == "install")
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(directory.join("installer.lock"))?;
    // SAFETY: lock owns its descriptor; never unlink/replace this inode.
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        bail!("Original guest installer is active")
    }
    let mut record = if receipt_path.try_exists()? {
        let record: Value =
            serde_json::from_slice(&macos_keys::private_read(&receipt_path, 128 * 1024)?)?;
        if record["intent"] != json!(intent) {
            bail!("Retained guest bootstrap intent changed")
        }
        record
    } else {
        if action != "install" || existed {
            bail!("Original guest installer history missing")
        }
        let record = json!({"intent":intent,"stage":"outcomeUnknown"});
        macos_keys::write_new(&receipt_path, &serde_json::to_vec(&record)?)?;
        let base = home.join(".terminalx-local");
        // Never retrofit a current runtime, legacy account or retained history.
        std::fs::DirBuilder::new().mode(0o700).create(&base)?;
        journal::private_directory(&base.join("bin"))?;
        journal::private_directory(&base.join("runtime"))?;
        macos_keys::write_new(
            &base.join("identity.json"),
            &serde_json::to_vec(&intent.plan.identity)?,
        )?;
        macos_keys::write_new(&base.join("bin/terminalx-serve"), &artifact.bytes)?;
        std::fs::set_permissions(
            base.join("bin/terminalx-serve"),
            std::fs::Permissions::from_mode(0o700),
        )?;
        verify(&base.join("bin/terminalx-serve"))?;
        // Stage the LaunchAgent without writing the active LaunchAgents folder.
        macos_keys::write_new(
            &base.join("com.terminalx.local-guest.plist"),
            intent.plan.plist.as_bytes(),
        )?;
        let mut completed = record;
        completed["stage"] = json!("installed");
        journal::atomic_private_write(&receipt_path, &serde_json::to_vec(&completed)?)?;
        completed
    };
    if record["stage"] != "installed" {
        bail!("Original installer outcome unknown; no file mutation replay")
    }
    let base = home.join(".terminalx-local");
    if macos_keys::private_read(&base.join("identity.json"), 4096)?
        != serde_json::to_vec(&intent.plan.identity)?
        || journal::digest(&macos_keys::private_read(
            &base.join("bin/terminalx-serve"),
            LIMIT,
        )?) != intent.plan.runtime_sha256
        || macos_keys::private_read(&base.join("com.terminalx.local-guest.plist"), 64 * 1024)?
            != intent.plan.plist.as_bytes()
    {
        bail!("Installed runtime/identity changed")
    }
    verify(&base.join("bin/terminalx-serve"))?;
    record["inputDigest"] = json!(intent.digest()?);
    record["runtimeSha256"] = json!(intent.plan.runtime_sha256);
    record["identity"] = intent.plan.identity.clone();
    record["exitProof"] = json!("terminalReceiptUnderOriginalLock");
    record["ready"] = json!(false);
    Ok(record)
}
use std::os::unix::fs::DirBuilderExt;
pub(crate) fn run_cli(args: &[String]) -> i32 {
    let result = (|| -> Result<Value> {
        if args.len() != 1
            || !matches!(
                args[0].as_str(),
                "install" | "receipt" | "toolsInstall" | "toolsReceipt"
            )
        {
            bail!("Expected original bootstrap install/receipt")
        }
        let mut reader = std::io::BufReader::new(std::io::stdin());
        let tools = matches!(args[0].as_str(), "toolsInstall" | "toolsReceipt");
        let mut bytes = Vec::new();
        let intent: Intent = if tools {
            use std::io::BufRead;
            reader
                .by_ref()
                .take(64 * 1024 + 1)
                .read_until(b'\n', &mut bytes)?;
            if bytes.len() > 64 * 1024 || bytes.last() != Some(&b'\n') {
                bail!("Bounded tool header required")
            }
            let envelope: Value = serde_json::from_slice(&bytes)?;
            if envelope["profiles"] != super::macos_tools::profiles() {
                bail!("Pinned tool profiles changed")
            }
            serde_json::from_value(envelope["intent"].clone())?
        } else {
            reader
                .by_ref()
                .take(64 * 1024 + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() > 64 * 1024 {
                bail!("Bootstrap envelope exceeds bound")
            }
            serde_json::from_slice(&bytes)?
        };
        intent.validate()?;
        let account = &macos_transport::binding(&intent.environment)?.account;
        account.check_current_home()?;
        let loader = std::env::current_exe()?;
        if loader != intent.guest_directory()?.join("loader") {
            bail!("Bootstrap loader path differs from original operation")
        }
        if tools {
            guest_using(
                Path::new(&account.home),
                account,
                &loader,
                &intent,
                "receipt",
                |path| {
                    process::run(
                        std::process::Command::new("/usr/bin/codesign")
                            .args(["--verify", "--strict"])
                            .arg(path),
                        b"",
                        Duration::from_secs(30),
                    )?;
                    Ok(())
                },
            )?;
            return super::macos_tools::guest(
                Path::new(&account.home),
                &intent.guest_directory()?,
                &intent,
                &args[0],
                &mut reader,
            );
        }
        guest_using(
            Path::new(&account.home),
            account,
            &loader,
            &intent,
            &args[0],
            |path| {
                process::run(
                    std::process::Command::new("/usr/bin/codesign")
                        .args(["--verify", "--strict"])
                        .arg(path),
                    b"",
                    Duration::from_secs(30),
                )?;
                Ok(())
            },
        )
    })();
    match result {
        Ok(value) => {
            println!("{}", json!({"ok":true,"result":value}));
            0
        }
        Err(error) => {
            println!("{}", json!({"ok":false,"error":format!("{error:#}")}));
            1
        }
    }
}
#[cfg(test)]
#[path = "macos_delivery_tests.rs"]
pub(in crate::local_vm) mod tests;
