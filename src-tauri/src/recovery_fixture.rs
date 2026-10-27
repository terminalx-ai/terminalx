//! Only compiled by the private desktop acceptance module. No RPCs or spawning.
use std::{collections::BTreeMap, fs::{File, OpenOptions}, io::Read, os::unix::{fs::{MetadataExt, OpenOptionsExt}, io::AsRawFd}, path::{Path, PathBuf}};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use base64::Engine as _;
use super::ROOT;

const FAKE: &[u8] = include_bytes!("../../scripts/remote-runtime/fake-claude");
const ADAPTER: &[u8] = include_bytes!("../../scripts/local-runtime/recovery-fixture.py");
const PROMPT: &str = "slow:600:1000";

pub(super) fn private_dir(path: &Path) -> Result<()> {
    let m = std::fs::symlink_metadata(path)?;
    ensure!(m.is_dir() && !m.file_type().is_symlink() && m.uid() == unsafe { libc::geteuid() } && m.mode() & 0o077 == 0, "unowned/private directory: {}", path.display());
    ensure!(path.canonicalize()? == path, "noncanonical private directory");
    Ok(())
}
fn private_read(path: &Path, max: u64) -> Result<Vec<u8>> {
    let mut f = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(path)?;
    let m = f.metadata()?;
    ensure!(m.is_file() && m.uid() == unsafe { libc::geteuid() } && m.mode() & 0o077 == 0 && m.nlink() == 1 && m.len() <= max, "untrusted/oversize fixture file");
    // Writer holds LOCK_EX for each complete durable journal row. Never block
    // on a foreign writer; busy/partial persistence remains INCOMPLETE.
    ensure!(unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_SH | libc::LOCK_NB) } == 0, "fixture persistence in progress");
    let mut bytes = Vec::new();
    (&mut f).take(max + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= max, "fixture file grew past bound");
    Ok(bytes)
}
fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn hash_file(path: &Path) -> Result<String> {
    let mut f = File::open(path)?;
    let m = f.metadata()?;
    ensure!(m.is_file() && m.len() <= 512 * 1024 * 1024, "executable size/type");
    let mut hash = Sha256::new();
    let mut block = [0; 65536];
    let mut total = 0u64;
    loop { let n = f.read(&mut block)?; if n == 0 { break; } total += n as u64;
        ensure!(total <= 512 * 1024 * 1024, "executable grew past bound"); hash.update(&block[..n]); }
    Ok(format!("{:x}", hash.finalize()))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Process {
    pid: u32, parent: u32, start_sec: u64, start_usec: u64, executable: PathBuf, sha256: String,
}
fn process(pid: u32) -> Result<Process> {
    ensure!(pid > 1 && pid <= i32::MAX as u32, "invalid fixture pid");
    // libc's Darwin ABI bindings, not a PID receipt or a shell/ps invocation.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info) as i32;
    let got = unsafe { libc::proc_pidinfo(pid as i32, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut libc::c_void, size) };
    ensure!(got == size && info.pbi_pid == pid && info.pbi_uid == unsafe { libc::geteuid() } && info.pbi_start_tvsec > 0, "fixture process identity unavailable");
    let mut path = [0u8; 4096];
    let n = unsafe { libc::proc_pidpath(pid as i32, path.as_mut_ptr().cast(), path.len() as u32) };
    ensure!(n > 0, "fixture executable unavailable");
    let end = path.iter().position(|b| *b == 0).context("unterminated executable path")?;
    let executable = PathBuf::from(std::str::from_utf8(&path[..end])?).canonicalize()?;
    let sha256 = hash_file(&executable)?;
    // Detect PID reuse while hashing instead of treating the earlier read as a lease.
    let mut again: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let got = unsafe { libc::proc_pidinfo(pid as i32, libc::PROC_PIDTBSDINFO, 0, &mut again as *mut _ as *mut libc::c_void, size) };
    ensure!(got == size && again.pbi_start_tvsec == info.pbi_start_tvsec && again.pbi_start_tvusec == info.pbi_start_tvusec && again.pbi_ppid == info.pbi_ppid, "fixture process changed during observation");
    Ok(Process { pid, parent:info.pbi_ppid, start_sec:info.pbi_start_tvsec, start_usec:info.pbi_start_tvusec, executable, sha256 })
}
fn argv(pid: u32) -> Result<Vec<String>> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as i32];
    let mut bytes = vec![0u8; 32768];
    let mut size = bytes.len();
    ensure!(unsafe { libc::sysctl(mib.as_mut_ptr(), 3, bytes.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) } == 0 && size >= 5 && size <= bytes.len(), "fixture argv unavailable/oversize");
    let argc = i32::from_ne_bytes(bytes[..4].try_into().unwrap());
    ensure!((2..=128).contains(&argc), "fixture argc");
    let mut pos = 4;
    while pos < size && bytes[pos] != 0 { pos += 1; }
    while pos < size && bytes[pos] == 0 { pos += 1; }
    let mut args = Vec::new();
    for _ in 0..argc {
        let end = (pos..size).find(|i| bytes[*i] == 0).context("truncated argv")?;
        args.push(std::str::from_utf8(&bytes[pos..end])?.to_owned()); pos = end + 1;
    }
    Ok(args)
}
fn belongs_to(child: &Process, owner: &Process) -> Result<()> {
    let mut parent = child.parent;
    for _ in 0..8 {
        if parent == owner.pid { ensure!(process(parent)? == *owner, "owner changed"); return Ok(()); }
        ensure!(parent > 1, "fixture not descended from owned runtime");
        parent = process(parent)?.parent;
    }
    anyhow::bail!("fixture ancestry exceeded fixed bound")
}

pub(super) fn challenge() -> Result<String> {
    let bytes = private_read(&Path::new(ROOT).join("challenge"), 64)?;
    let value = String::from_utf8(bytes)?;
    ensure!(uuid::Uuid::parse_str(&value).is_ok(), "invalid challenge");
    Ok(value)
}
pub(super) fn handoff(name: &str, expected: &str) -> Result<bool> {
    ensure!(matches!(name, "fixture-ready" | "clear-ready"), "unknown fixture handoff");
    let path = Path::new(ROOT).join(name);
    if !path.try_exists()? { return Ok(false); }
    ensure!(String::from_utf8(private_read(&path, 64)?)? == expected, "stale fixture handoff");
    Ok(true)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(super) struct Pane {
    session: String, tab: String, pane: String, process: Process,
    canonical_messages: u64, starts: u64, submits: u64,
}
#[derive(Clone, Debug, Serialize)]
pub(super) struct Bound {
    pub challenge: String, owner: Process, epoch: String,
    panes: BTreeMap<String, Pane>, pub cursors: BTreeMap<String, u64>,
    fake_sha256: String, adapter_sha256: String,
}
impl Bound {
    pub fn visible_cursor(&self, bytes: &[u8]) -> Result<(String,u64)> {
        let text = String::from_utf8_lossy(bytes);
        let mut last = None;
        for line in text.split_inclusive('\n').filter(|s| s.ends_with('\n')) {
            for (id, pane) in &self.panes {
                let prefix = format!("TX643:{}:{}:", self.challenge, pane.process.pid);
                if let Some(n) = line.trim().strip_prefix(&prefix).and_then(|s| s.parse::<u64>().ok()) {
                    last = Some((id.clone(), n));
                }
            }
        }
        last.context("no fixture marker accepted by visible window tap")
    }
    pub fn same_lifetimes(&self, newer: &Self) -> bool {
        self.challenge == newer.challenge && self.owner == newer.owner && self.epoch == newer.epoch && self.panes == newer.panes
    }
    pub fn fresh_output(&self, newer: &Self) -> bool {
        self.same_lifetimes(newer) && self.cursors.iter().all(|(id,n)| newer.cursors.get(id).is_some_and(|m| m > n))
    }
}

fn journal(pid: u32, nonce: &str) -> Result<(u64, u64, u64)> {
    let bytes = private_read(&Path::new(ROOT).join(format!("launch-{pid}.jsonl")), 256 * 1024)?;
    parse_journal(&bytes, pid, nonce)
}
fn parse_journal(bytes: &[u8], pid: u32, nonce: &str) -> Result<(u64,u64,u64)> {
    ensure!(bytes.last() == Some(&b'\n'), "partial fixture journal");
    let mut starts = 0; let mut submits = 0; let mut cursor = 0;
    for (i, row) in bytes.split(|b| *b == b'\n').filter(|b| !b.is_empty()).enumerate() {
        let v: Value = serde_json::from_slice(row)?;
        ensure!(v["seq"].as_u64() == Some(i as u64 + 1) && v["pid"].as_u64() == Some(pid as u64) && v["challenge"] == nonce, "journal identity/sequence");
        match v["kind"].as_str() {
            Some("start") => { ensure!(i == 0, "extra fixture start"); starts += 1; }
            Some("submit") => { ensure!(v["text"] == PROMPT, "unexpected fixture input"); submits += 1; }
            Some("output") => { ensure!(v["cursor"].as_u64() == Some(cursor + 1), "output sequence"); cursor += 1; }
            _ => anyhow::bail!("fixture exited or unknown journal event"),
        }
    }
    ensure!(starts == 1 && submits == 1 && cursor > 0, "fixture not ready or replayed submit");
    Ok((starts, submits, cursor))
}

pub(super) fn bind(evidence: &Value) -> Result<Bound> {
    ensure!(evidence["owner"]["pid"].as_u64().is_some_and(|n| n > 1 && n <= i32::MAX as u64)
        && evidence["panes"].as_array().is_some_and(|p| p.len() == 2), "no native fixture envelope");
    for part in ["", "home", "state", "bin", "fixture"] { private_dir(&Path::new(ROOT).join(part))?; }
    ensure!(digest(&private_read(&Path::new(ROOT).join("fake-claude"), 65536)?) == digest(FAKE), "fake source mismatch");
    ensure!(digest(&private_read(&Path::new(ROOT).join("bin/claude"), 65536)?) == digest(ADAPTER), "adapter source mismatch");
    // Compile-time pins from the reviewed guest interpreter inventory, NOT an
    // environment/receipt override. Absent pins keep the boundary closed.
    let python_path = option_env!("TERMINALX_RECOVERY_PYTHON_PATH").context("missing compiled interpreter path pin")?;
    let python_hash = option_env!("TERMINALX_RECOVERY_PYTHON_SHA256").context("missing compiled interpreter hash pin")?;
    ensure!(python_hash.len() == 64 && python_hash.bytes().all(|b| b.is_ascii_hexdigit()), "invalid interpreter pin");
    let nonce = challenge()?;
    let owner_pid = evidence["owner"]["pid"].as_u64().context("owner pid")?;
    ensure!(owner_pid <= i32::MAX as u64, "owner pid range");
    let owner = process(owner_pid as u32)?;
    ensure!(owner.parent == std::process::id(), "owner was not launched by this fixture desktop");
    ensure!(owner.executable.starts_with(Path::new(ROOT).join("state/runtime")), "owner outside private installed runtime");
    let bundled = std::env::current_exe()?.parent().context("app executable parent")?.parent().context("app Contents")?.join("Resources/local-runtime/terminalx-serve");
    ensure!(owner.sha256 == hash_file(&bundled)?, "running owner differs from signed bundle resource");
    let epoch = evidence["owner"]["epoch"].as_str().context("owner epoch")?.to_owned();
    let rows = evidence["panes"].as_array().context("fixture panes")?;
    ensure!(rows.len() == 2, "two fixture processes required");
    let mut panes = BTreeMap::new(); let mut cursors = BTreeMap::new(); let mut pids = Vec::new();
    for row in rows {
        let pid = row["output"]["pid"].as_u64().context("pane pid")?;
        ensure!(pid <= i32::MAX as u64 && !pids.contains(&pid), "pane pid range/duplicate"); pids.push(pid);
        let process = process(pid as u32)?;
        ensure!(process.executable == Path::new(python_path) && process.sha256 == python_hash, "not pinned no-account interpreter");
        let args = argv(pid as u32)?;
        ensure!(args.get(1).is_some_and(|s| s == &format!("{ROOT}/bin/claude")), "not fixed fixture adapter argv");
        let provider = row["providerSession"].as_str().context("fixture provider session")?;
        ensure!(args.windows(2).any(|a| a[0] == "--session-id" && a[1] == provider) && !args.iter().any(|s| s == "--resume"), "not this fresh fixture session launch");
        belongs_to(&process, &owner)?;
        let (starts, submits, produced) = journal(pid as u32, &nonce)?;
        let decoded = base64::engine::general_purpose::STANDARD.decode(row["output"]["data"].as_str().context("pty bytes")?)?;
        let prefix = format!("TX643:{nonce}:{pid}:");
        let cursor = String::from_utf8_lossy(&decoded).split_inclusive('\n').filter(|s| s.ends_with('\n'))
            .filter_map(|s| s.trim().strip_prefix(&prefix)?.parse::<u64>().ok()).max().context("no complete numbered PTY output")?;
        ensure!(cursor <= produced, "output beyond durable fixture journal");
        let id = row["pane"].as_str().context("pane id")?.to_owned();
        let canonical_messages = row["canonicalUserMessages"].as_u64().context("message counter")?;
        ensure!(canonical_messages == 1, "canonical replay/new message");
        let pane = Pane { session:row["session"].as_str().context("session")?.into(), tab:row["tab"].as_str().context("tab")?.into(), pane:id.clone(), process, canonical_messages, starts, submits };
        ensure!(panes.insert(id.clone(), pane).is_none(), "duplicate pane"); cursors.insert(id, cursor);
    }
    // Extra launch records mean an unexpected restart, not harmless leftovers.
    let expected: Vec<String> = pids.iter().map(|pid|format!("launch-{pid}.jsonl")).collect();
    for entry in std::fs::read_dir(ROOT)? {
        let name = entry?.file_name().to_string_lossy().into_owned();
        ensure!(!name.starts_with("launch-") || expected.contains(&name), "unexpected fixture launch");
    }
    ensure!(process(owner.pid)? == owner, "owner changed during fixture binding");
    for pane in panes.values() { ensure!(process(pane.process.pid)? == pane.process, "fixture changed during binding"); }
    Ok(Bound { challenge:nonce, owner, epoch, panes, cursors, fake_sha256:digest(FAKE), adapter_sha256:digest(ADAPTER) })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(seq: u64, kind: &str) -> String {
        serde_json::json!({"seq":seq,"kind":kind,"pid":42,"challenge":"nonce",
            "text":PROMPT,"cursor":1}).to_string() + "\n"
    }
    #[test]
    fn journal_rejects_partial_duplicate_submit_and_wrong_start_identity() {
        let valid = row(1,"start") + &row(2,"submit") + &row(3,"output");
        assert_eq!(parse_journal(valid.as_bytes(),42,"nonce").unwrap(), (1,1,1));
        assert!(parse_journal(valid.trim_end().as_bytes(),42,"nonce").is_err());
        assert!(parse_journal((valid.clone()+&row(4,"submit")).as_bytes(),42,"nonce").is_err());
        assert!(parse_journal(valid.as_bytes(),43,"nonce").is_err());
        assert!(parse_journal(valid.as_bytes(),42,"old-nonce").is_err());
    }
    #[test]
    fn a_truthy_receipt_is_not_a_native_fixture_envelope() {
        assert!(bind(&serde_json::json!({"verified":true,"pid":42})).is_err());
    }
    #[test]
    fn pid_reuse_and_extra_submit_do_not_pass_fresh_output() {
        let process = Process { pid:42,parent:20,start_sec:100,start_usec:1,
            executable:PathBuf::from("/fixture/python"),sha256:"pin".into() };
        let pane = Pane { session:"s".into(),tab:"t".into(),pane:"p".into(),
            process:process.clone(),canonical_messages:1,starts:1,submits:1 };
        let before = Bound { challenge:"nonce".into(),owner:process,epoch:"epoch".into(),
            panes:BTreeMap::from([("p".into(),pane)]),cursors:BTreeMap::from([("p".into(),1)]),
            fake_sha256:"fake".into(),adapter_sha256:"adapter".into() };
        let mut after = before.clone();
        assert!(before.visible_cursor(b"TX643:nonce:42:2").is_err());
        assert_eq!(before.visible_cursor(b"TX643:nonce:42:2\r\n").unwrap(), ("p".into(),2));
        assert!(!before.fresh_output(&after));
        after.cursors.insert("p".into(),2);
        assert!(before.fresh_output(&after));
        after.panes.get_mut("p").unwrap().process.start_usec += 1;
        assert!(!before.fresh_output(&after));
        after = before.clone(); after.cursors.insert("p".into(),2);
        after.panes.get_mut("p").unwrap().submits += 1;
        assert!(!before.fresh_output(&after));
    }
}
