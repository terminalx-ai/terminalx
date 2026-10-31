//! Original restricted owner launch, subordinate to the existing restore ledger.
//! The installed catalog is empty. Only tests acquire a fixture Artifact; no RPC
//! accepts an executable, helper proof, endpoint, capability or child PID.
use super::super::{macos_bootstrap_helper, macos_personalization, macos_provision};
use super::{canonical, fs, journal, send, Binding, Directory, Node, Pin, Reference};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    os::{
        fd::AsRawFd,
        unix::{
            fs::MetadataExt,
            net::UnixStream,
            process::{CommandExt, ExitStatusExt},
        },
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const UPSTREAM: &str = "3350f504014c85416009a90fcb339fe556ce02fc";
const PATCH: &[u8] = include_bytes!("../../../integrations/lume-bootstrap/bootstrap.patch");
const PROFILE: &str = "lume-terminalx-bootstrap-v1";

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactPin {
    profile: String,
    source_commit: String,
    patch_sha256: String,
    executable_sha256: String,
    node: Node,
}
// No Deserialize/public constructor. Selection belongs to the trusted catalog,
// not UI parameters or a path on disk. Fixture acquisition exists only in tests.
struct Artifact {
    pin: ArtifactPin,
}
impl Artifact {
    fn production() -> Result<Self> {
        bail!("Restricted Lume catalog has no approved built/signed/accepted artifact; no executable or credential was accessed")
    }
    fn path(&self, root: &Path) -> PathBuf {
        root.join("bootstrap-artifacts")
            .join(&self.pin.executable_sha256)
            .join("lume")
    }
    fn verify(&self, root: &Path) -> Result<()> {
        if self.pin.profile != PROFILE
            || self.pin.source_commit != UPSTREAM
            || self.pin.patch_sha256 != journal::digest(PATCH)
        {
            bail!("Original bootstrap source/profile differs")
        }
        super::super::transport::validate_runtime_sha(&self.pin.executable_sha256)?;
        let path = self.path(root);
        let dir = open(path.parent().context("Artifact parent missing")?)?;
        let file = dir.open_file("lume", false, false, true)?;
        let meta = file.metadata()?;
        if Node::of(&meta) != self.pin.node
            || meta.mode() & 0o111 == 0
            || journal::digest(&dir.read("lume", 256 * 1024 * 1024, true)?)
                != self.pin.executable_sha256
        {
            bail!("Original candidate executable changed")
        }
        Ok(())
    }
}
fn open(path: &Path) -> Result<Directory> {
    // SAFETY: geteuid has no memory preconditions.
    Directory::open(path, unsafe { libc::geteuid() }, true)
}
fn pin(path: &Path, directory: bool) -> Result<Pin> {
    let meta = std::fs::symlink_metadata(path)?;
    let text = path.to_str().context("Bootstrap path must be UTF-8")?;
    if !path.is_absolute()
        || path.canonicalize()? != path
        || !text
            .bytes()
            .all(|b| (32..127).contains(&b) && b != b':' && b != b'\\')
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & if directory { 0o077 } else { 0o022 } != 0
        || if directory {
            !meta.is_dir()
        } else {
            !meta.is_file() || meta.nlink() != 1
        }
    {
        bail!("Original bootstrap path is aliased, unsafe or incompatible")
    }
    Ok(Pin {
        path: path.into(),
        device: meta.dev(),
        inode: meta.ino(),
    })
}
fn check_pins(reference: &Reference) -> Result<()> {
    for (role, expected) in &reference.binding.paths {
        let actual = pin(
            &expected.path,
            ["operation", "storage", "vm", "input", "output"].contains(&role.as_str()),
        )?;
        if actual.device != expected.device || actual.inode != expected.inode {
            bail!("Original launch path replaced")
        }
    }
    if journal::digest(&open(&reference.binding.paths["vm"].path)?.read(
        "config.json",
        64 * 1024,
        false,
    )?) != reference.binding.config_sha256
    {
        bail!("Original config bytes changed")
    }
    reference.check(&reference.binding.paths["operation"].path)
}
fn original_plan(
    root: &Path,
    key: &str,
    provision: &Directory,
    source: &Value,
) -> Result<(Value, String)> {
    let personalization = open(&root.join("macos-personalization").join(key))?;
    let record: Value = fs::json(&personalization, "record.json", 64 * 1024)?;
    let plan: macos_personalization::AccountPlan =
        serde_json::from_value(record["intent"]["account"].clone())?;
    journal::validate_id(&plan.password_reference)?;
    journal::validate_id(&plan.ssh_key_reference)?;
    if plan.password_reference == plan.ssh_key_reference {
        bail!("Account and transport references must remain distinct")
    }
    if record["inputDigest"] != journal::digest(&serde_json::to_vec(&record["intent"])?)
        || record["intent"]["target"] != source["target"]
    {
        bail!("Original account preparation changed")
    }
    let digest = journal::digest(&serde_json::to_vec(&record["intent"])?);
    // Legacy operations retain their original v1 manifest and history.
    if provision.exists("restricted-owner-intent.json")? {
        let retained: Value = fs::json(provision, "owner-helper-plan.json", 32 * 1024)?;
        if retained["accountName"] != plan.short_name
            || retained["accountHome"] != format!("/Users/{}", plan.short_name)
            || retained["binding"]["bootstrapId"] != key
            || retained["binding"]["target"] != source["target"]
        {
            bail!("Original helper/account preparation changed")
        }
        if retained["version"] == 2 {
            let context: super::plan::HostIntent =
                fs::json(provision, "owner-host-intent.json", 32 * 1024)?;
            context.validate()?;
            if retained["binding"]["parentSession"] != context.parent_session
                || retained["binding"]["parentTab"] != context.parent_tab
                || retained["binding"]["parentConversation"] != context.parent_conversation
                || retained["helperSha256"] != context.helper_sha256
                || retained["runtimeSha256"] != context.runtime_sha256
                || retained["accountIntentDigest"] != digest
            {
                bail!("Original host intent changed")
            }
        } else {
            macos_bootstrap_helper::validate_manifest_content(&retained)?;
        }
        return Ok((retained, digest));
    }
    // Guest account/mount/OS observations are neither required nor invented.
    let context: super::plan::HostIntent =
        fs::json(provision, "owner-host-intent.json", 32 * 1024)?;
    super::plan::retain_host_intent(provision, &context)?;
    if provision.exists("owner-helper-plan.json")? {
        bail!("Incomplete original host plan remains fenced")
    }
    let manifest = super::plan::create(key, &source["target"], &plan, &digest, &context)?;
    provision.write_new("owner-helper-plan.json", &serde_json::to_vec(&manifest)?)?;
    Ok((manifest, digest))
}
fn prepare(
    root: &Path,
    key: &str,
    artifact: &Artifact,
    source: &Value,
    plan: &Value,
    entropy: impl FnOnce() -> [u8; 32],
) -> Result<Reference> {
    let root_dir = open(root)?;
    let parent = root_dir.child("bo", !root_dir.exists("bo")?)?;
    let op = parent.child(key, true)?;
    let op_path = root.join("bo").join(key);
    let _lock = op.lock("launch.lock", true)?;
    for name in ["input", "receipt", "home", "tmp"] {
        op.child(name, true)?;
    }
    let storage = source["intent"]["storage"]
        .as_str()
        .context("Original storage missing")?;
    let name = source["intent"]["name"]
        .as_str()
        .context("Original VM name missing")?;
    let vm = Path::new(storage).join(name);
    let paths: BTreeMap<_, _> = [
        ("operation", op_path.clone(), true),
        ("storage", PathBuf::from(storage), true),
        ("vm", vm.clone(), true),
        ("config", vm.join("config.json"), false),
        ("disk", vm.join("disk.img"), false),
        ("nvram", vm.join("nvram.bin"), false),
        ("input", op_path.join("input"), true),
        ("output", op_path.join("receipt"), true),
    ]
    .into_iter()
    .map(|(role, path, dir)| Ok((role.to_string(), pin(&path, dir)?)))
    .collect::<Result<_>>()?;
    let mut manifest = plan.clone();
    for (role, share) in [("input", "input"), ("output", "output")] {
        manifest["binding"][share]["host"] =
            json!({"device":paths[role].device,"inode":paths[role].inode});
    }
    super::plan::validate(&manifest)?;
    let helper_bytes = canonical(&manifest)?;
    let h = &manifest["binding"];
    let text = |v: &Value| -> Result<String> {
        Ok(v.as_str().context("Original typed field missing")?.into())
    };
    let binding = Binding {
        version: 2,
        macos_major: 26,
        bootstrap_id: key.into(),
        owner_epoch: text(&h["ownerEpoch"])?,
        nonce: text(&h["nonce"])?,
        environment_id: text(&source["target"]["environmentId"])?,
        generation: text(&source["target"]["generation"])?,
        vm_fingerprint: text(&source["target"]["vmFingerprint"])?,
        restore_sha256: text(&source["target"]["restoreSha256"])?,
        runtime_sha256: text(&manifest["runtimeSha256"])?,
        helper_manifest_sha256: journal::digest(&helper_bytes),
        executable_sha256: artifact.pin.executable_sha256.clone(),
        parent_session: text(&h["parentSession"])?,
        parent_tab: text(&h["parentTab"])?,
        parent_conversation: text(&h["parentConversation"])?,
        input_share_id: text(&h["input"]["id"])?,
        output_share_id: text(&h["output"]["id"])?,
        config_sha256: journal::digest(&open(&vm)?.read("config.json", 64 * 1024, false)?),
        paths,
    };
    let raw = canonical(&json!(binding))?;
    op.write_new("owner-intent.json", &raw)?;
    op.write_new("expected-helper.json", &helper_bytes)?;
    op.child("input", false)?
        .write_new("host-plan.json", &helper_bytes)?;
    let secret = entropy();
    op.write_new("control.capability", &secret)?;
    op.write_new("prepared.json",&serde_json::to_vec(&json!({"bindingDigest":journal::digest(&raw),"capabilityDigest":journal::digest(&secret),"ready":false}))?)?;
    Reference::reopen(&op_path)
}
fn command(root: &Path, artifact: &Artifact, reference: &Reference, fd: i32) -> Result<Command> {
    let b = &reference.binding;
    let op = &b.paths["operation"].path;
    let name = b.paths["vm"]
        .path
        .file_name()
        .context("Original name missing")?;
    let mut command = Command::new(artifact.path(root));
    command
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("LC_ALL", "C")
        .env("HOME", op.join("home"))
        .env("TMPDIR", op.join("tmp"))
        .current_dir(op)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .arg("run")
        .arg(name)
        .args(["--display", "none", "--vnc", "disabled", "--storage"])
        .arg(&b.paths["storage"].path)
        .arg("--shared-dir")
        .arg(format!("{}:ro", b.paths["input"].path.display()))
        .arg("--shared-dir")
        .arg(format!("{}:rw", b.paths["output"].path.display()))
        .arg("--terminalx-bootstrap-fd")
        .arg(fd.to_string());
    // SAFETY: the child retains exactly the private socket across exec; fcntl
    // is async-signal-safe. No allocation, logging or host credential access.
    unsafe {
        command.pre_exec(move || {
            if libc::fcntl(fd, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    Ok(command)
}
fn state(stage: &str) -> Value {
    json!({"stage":stage,"ready":false,"trustAccepted":false,"replacementAllowed":false})
}
fn reconcile(reference: &Reference) -> Result<Value> {
    let prepared: Value = fs::json(&reference.root, "prepared.json", 32 * 1024)?;
    if prepared
        != json!({"bindingDigest":journal::digest(&reference.raw),"capabilityDigest":journal::digest(&reference.secret),"ready":false})
    {
        bail!("Original private reference changed or was only partially prepared")
    }
    let armed: Value = fs::json(&reference.root, "spawn-armed.json", 32 * 1024)?;
    let digest = journal::digest(&reference.raw);
    if armed["bindingDigest"] != digest {
        bail!("Original launch attempt differs")
    }
    journal::validate_id(
        armed["attemptId"]
            .as_str()
            .context("Original attempt missing")?,
    )?;
    if !reference.root.exists("spawned.json")? {
        return Ok(state("ownerOutcomeUnknown"));
    }
    let spawned: Value = fs::json(&reference.root, "spawned.json", 32 * 1024)?;
    if spawned["attemptId"] != armed["attemptId"] || spawned["bindingDigest"] != digest {
        bail!("Original child history differs")
    }
    let pid = u32::try_from(
        spawned["childPid"]
            .as_u64()
            .context("Original child handle receipt missing")?,
    )?;
    if pid == 0 {
        bail!("Original child identity invalid")
    }
    if reference.root.exists("process-exit.json")? {
        let exit: Value = fs::json(&reference.root, "process-exit.json", 32 * 1024)?;
        if exit["spawned"] != spawned {
            bail!("Original process outcome differs")
        }
        // Exit is retained evidence, never permission to replace or claim Ready.
        return Ok(state("originalChildExited"));
    }
    match reference.recover_launch(pid) {
        Ok(()) => {
            let mut result = state("originalOwnerConnected");
            if reference.binding.version == 2 {
                result["guestObservation"] = reference.guest_observation().unwrap_or_else(
                    |_| json!({"stage":"unavailableOrRefused","ready":false,"trustAccepted":false}),
                );
            }
            Ok(result)
        }
        Err(_) => Ok(state("ownerOutcomeUnknown")),
    }
}
fn execute(
    root: &Path,
    key: &str,
    artifact: &Artifact,
    mut checkpoint: impl FnMut(&str) -> Result<()>,
    entropy: impl FnOnce() -> [u8; 32],
) -> Result<Value> {
    journal::validate_id(key)?;
    open(root)?;
    artifact.verify(root)?;
    let provision = open(&root.join("macos-provision-operations").join(key))?;
    // The same retained lock excludes ordinary provisioning and other launchers.
    let _provision_lock = provision.lock("operation.lock", false)?;
    let source = macos_provision::created_for_bootstrap(root, key)?;
    let (plan, account_plan_digest) = original_plan(root, key, &provision, &source)?;
    let op_path = root.join("bo").join(key);
    // sockaddr_un is bounded; no fallback endpoint or caller-selected short path.
    if op_path.join("owner.sock").as_os_str().len() >= 104 {
        bail!("Private owner path exceeds native socket bound")
    }
    let intent = json!({"version":1,"sourceDigest":journal::digest(&serde_json::to_vec(&source)?),"artifact":artifact.pin,
        "helperPlanDigest":journal::digest(&serde_json::to_vec(&plan)?),"accountPlanDigest":account_plan_digest,"operation":op_path});
    let existed = provision.exists("restricted-owner-intent.json")?;
    if existed {
        if fs::json::<Value>(&provision, "restricted-owner-intent.json", 32 * 1024)? != intent {
            bail!("Original launch/artifact/parent preparation changed")
        }
    } else {
        if op_path.try_exists()? {
            bail!("Owner history exists without original provisioning intent")
        }
        provision.write_new(
            "restricted-owner-intent.json",
            &serde_json::to_vec(&intent)?,
        )?;
        checkpoint("intent")?;
    }
    let reference = if existed {
        Reference::reopen(&op_path)?
    } else {
        prepare(root, key, artifact, &source, &plan, entropy)?
    };
    let _lock = reference.root.lock("launch.lock", false)?;
    check_pins(&reference)?;
    artifact.verify(root)?;
    if existed {
        return reconcile(&reference);
    }
    checkpoint("prepared")?;
    let binding_digest = journal::digest(&reference.raw);
    let armed = json!({"attemptId":journal::new_id(),"bindingDigest":binding_digest});
    reference
        .root
        .write_new("spawn-armed.json", &serde_json::to_vec(&armed)?)?;
    checkpoint("armed")?;
    let (mut parent, child_socket) = UnixStream::pair()?;
    let mut command = command(root, artifact, &reference, child_socket.as_raw_fd())?;
    // Revalidate after the durable fence and before the only spawn. Any failure
    // remains fenced, even if this process knows it has not called spawn yet.
    macos_provision::created_for_bootstrap(root, key)?;
    check_pins(&reference)?;
    artifact.verify(root)?;
    let exit_directory = open(&op_path)?;
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            reference.root.write_new(
                "spawn-failed.json",
                &serde_json::to_vec(&json!({"attempt":armed,"kind":format!("{:?}",error.kind())}))?,
            )?;
            return Ok(state("originalSpawnFailed"));
        }
    };
    drop(child_socket);
    let pid = child.id();
    let spawned =
        json!({"attemptId":armed["attemptId"],"bindingDigest":binding_digest,"childPid":pid});
    let exit_spawned = spawned.clone();
    // Only the retained Child handle is waited. No PID probing, signaling,
    // cancellation kill, lock clearing or replacement occurs on any outcome.
    std::thread::spawn(move || {
        if let Ok(status) = child.wait() {
            let receipt = json!({"spawned":exit_spawned,"code":status.code(),"signal":status.signal(),"ready":false});
            if let Ok(bytes) = serde_json::to_vec(&receipt) {
                let _ = exit_directory.publish("process-exit.json", &bytes);
            }
        }
    });
    checkpoint("spawned")?;
    reference
        .root
        .write_new("spawned.json", &serde_json::to_vec(&spawned)?)?;
    artifact.verify(root)?;
    check_pins(&reference)?;
    if send(&mut parent, &reference.launch_packet()).is_err() {
        return Ok(state("ownerOutcomeUnknown"));
    }
    if reference
        .accept_launch_using(&mut parent, pid, || checkpoint("announcement"))
        .is_err()
    {
        return Ok(state("ownerOutcomeUnknown"));
    }
    reconcile(&reference)
}

pub(in crate::local_vm) fn request(params: &Value) -> Result<Value> {
    let artifact = Artifact::production()?; // Before root/tool/reference discovery.
    let root = super::super::host::root()?;
    let key = params["idempotencyKey"]
        .as_str()
        .context("Original restore request required")?;
    execute(
        &root,
        key,
        &artifact,
        |_| Ok(()),
        || {
            use rand_core::RngCore;
            let mut bytes = [0; 32];
            rand_core::OsRng.fill_bytes(&mut bytes);
            bytes
        },
    )
}

#[cfg(test)]
#[path = "macos_owner_launch_tests.rs"]
mod tests;
