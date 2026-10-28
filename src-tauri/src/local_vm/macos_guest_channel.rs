//! Candidate guest observation transport. This does not acquire Channel: the
//! VZ socket identifies a VM route, not a helper process or a personal account.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use rand_core::RngCore;
use std::{
    fs::File,
    io::{Read, Write},
    os::fd::AsRawFd,
    time::Instant,
};

#[cfg(target_os = "macos")]
use std::os::fd::FromRawFd;

const PORT: u32 = 49871;
const LIMIT: usize = 64 * 1024;

// Only the fixed guest->host VZ transport. No endpoint/port, SSH config, host
// path, key, agent or environment overrides. Never executed by fixture tests.
#[cfg(target_os = "macos")]
fn connect_guest() -> Result<File> {
    // SAFETY: system socket constants; ownership transfers only on success.
    let fd = unsafe { libc::socket(libc::PF_VSOCK, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: successful socket returned a unique owned descriptor.
    let file = unsafe { File::from_raw_fd(fd) };
    configure(&file)?;
    let address = libc::sockaddr_vm {
        svm_len: std::mem::size_of::<libc::sockaddr_vm>() as u8,
        svm_family: libc::AF_VSOCK as libc::sa_family_t,
        svm_reserved1: 0,
        svm_port: PORT,
        svm_cid: libc::VMADDR_CID_HOST,
    };
    // SAFETY: pointer/length match the installed Darwin sockaddr_vm ABI.
    let code = unsafe {
        libc::connect(
            fd,
            (&address as *const libc::sockaddr_vm).cast(),
            std::mem::size_of_val(&address) as libc::socklen_t,
        )
    };
    if code != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EINPROGRESS) {
        return Err(std::io::Error::last_os_error().into());
    }
    wait(
        &file,
        libc::POLLOUT,
        Instant::now() + Duration::from_secs(3),
    )?;
    let mut error: i32 = 0;
    let mut length = std::mem::size_of_val(&error) as libc::socklen_t;
    // SAFETY: correctly sized writable SO_ERROR output for the owned socket.
    if unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_ERROR,
            (&mut error as *mut i32).cast(),
            &mut length,
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    if error != 0 {
        return Err(std::io::Error::from_raw_os_error(error).into());
    }
    Ok(file)
}
fn configure(file: &File) -> Result<()> {
    // SAFETY: descriptor is owned; only nonblocking and close-on-exec flags.
    unsafe {
        let flags = libc::fcntl(file.as_raw_fd(), libc::F_GETFL);
        if flags < 0
            || libc::fcntl(file.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) < 0
            || libc::fcntl(file.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) < 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    #[cfg(target_os = "macos")]
    {
        let yes: i32 = 1;
        // SAFETY: live socket, correctly sized SO_NOSIGPIPE input.
        if unsafe {
            libc::setsockopt(
                file.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_NOSIGPIPE,
                (&yes as *const i32).cast(),
                std::mem::size_of_val(&yes) as libc::socklen_t,
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    Ok(())
}
fn wait(file: &File, event: i16, deadline: Instant) -> Result<()> {
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .context("Guest observation deadline elapsed")?;
        let mut p = libc::pollfd {
            fd: file.as_raw_fd(),
            events: event,
            revents: 0,
        };
        // SAFETY: one live writable pollfd, bounded timeout.
        let n = unsafe { libc::poll(&mut p, 1, remaining.as_millis().clamp(1, 3000) as i32) };
        if n < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
            continue;
        }
        if n != 1 || p.revents & (event | libc::POLLHUP | libc::POLLERR) == 0 {
            bail!("Guest observation transport unavailable")
        }
        return Ok(());
    }
}
fn transfer(file: &mut File, bytes: &mut [u8], writing: bool) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut offset = 0;
    while offset < bytes.len() {
        wait(
            file,
            if writing { libc::POLLOUT } else { libc::POLLIN },
            deadline,
        )?;
        let result = if writing {
            file.write(&bytes[offset..])
        } else {
            file.read(&mut bytes[offset..])
        };
        match result {
            Ok(0) => bail!("Original guest observation disconnected"),
            Ok(n) => offset += n,
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock
                ) =>
            {
                continue
            }
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
fn read(file: &mut File) -> Result<Vec<u8>> {
    let mut size = [0; 4];
    transfer(file, &mut size, false)?;
    let size = u32::from_be_bytes(size) as usize;
    if size == 0 || size > LIMIT {
        bail!("Bounded guest observation frame required")
    }
    let mut bytes = vec![0; size];
    transfer(file, &mut bytes, false)?;
    Ok(bytes)
}
fn send(file: &mut File, value: &Value) -> Result<()> {
    let bytes = super::super::macos_owner_channel::canonical(value)?;
    if bytes.len() > LIMIT {
        bail!("Bounded guest observation frame required")
    }
    let mut frame = (bytes.len() as u32).to_be_bytes().to_vec();
    frame.extend(bytes);
    transfer(file, &mut frame, true)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Offer {
    challenge: String,
    host_plan: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Challenge {
    version: u32,
    binding_digest: String,
    owner_epoch: String,
    client_nonce: String,
    server_nonce: String,
    plan_sha256: String,
}

// Source and mount descriptors are acquired by a future verified helper launch,
// never request JSON. Tests supply synthetic sources/opened disposable mounts.
// Even correctly observed local data is only a claim from the host's viewpoint.
fn observe(
    file: &mut File,
    input: &Directory,
    output: &Directory,
    source: &Source,
) -> Result<Value> {
    configure(file)?;
    input.check()?;
    output.check()?;
    if input.node()? == output.node()? {
        bail!("Distinct mount descriptors required")
    }
    let mut random = [0; 32];
    rand_core::OsRng.fill_bytes(&mut random);
    let nonce: String = random.iter().map(|b| format!("{b:02x}")).collect();
    send(file, &json!({"version":1,"clientNonce":nonce}))?;
    let offer: Offer = serde_json::from_slice(&read(file)?)?;
    let challenge_bytes = STANDARD.decode(offer.challenge)?;
    let plan_bytes = STANDARD.decode(offer.host_plan)?;
    if challenge_bytes.len() > 8192 || plan_bytes.len() > 32 * 1024 {
        bail!("Observation offer exceeds bound")
    }
    let challenge: Challenge = serde_json::from_slice(&challenge_bytes)?;
    let plan: Value = serde_json::from_slice(&plan_bytes)?;
    super::super::macos_owner_channel::plan::validate(&plan)?;
    for sha in [
        &challenge.binding_digest,
        &challenge.server_nonce,
        &challenge.plan_sha256,
    ] {
        super::super::transport::validate_runtime_sha(sha)?;
    }
    if challenge.version != 1
        || challenge.client_nonce != nonce
        || challenge.owner_epoch != plan["binding"]["ownerEpoch"]
        || challenge.plan_sha256 != journal::digest(&plan_bytes)
        || input.read("host-plan.json", 32 * 1024, true)? != plan_bytes
        || input.read("guest-probe.json", 8192, true)? != challenge_bytes
    {
        bail!("Original owner challenge or mounted input differs")
    }
    macos_account_name(&source.user.short_name, &source.user.home)?;
    validate_os(&source.os_version, &source.os_build)?;
    if source.user.uid < 501
        || source.user.gid == 0
        || source.user.short_name != plan["accountName"]
        || source.user.home != plan["accountHome"]
        || input.uid()? != source.user.uid
        || output.uid()? != source.user.uid
    {
        bail!("Observed account/mount ownership differs from human account intent")
    }
    let helper_sha = journal::digest(&source.helper.read(
        "terminalx-bootstrap-helper",
        64 * 1024 * 1024,
        false,
    )?);
    if plan["helperSha256"] != helper_sha {
        bail!("Observed helper bytes differ")
    }
    let claims = json!({"accountName":source.user.short_name,"accountHome":source.user.home,"uid":source.user.uid,
        "osVersion":source.os_version,"osBuild":source.os_build,"helperSha256":helper_sha,
        "input":input.node()?,"output":output.node()?});
    // Exclusive original intent before the only guest write. A lost reply never
    // retries this echo, recreates an attempt or acquires account authority.
    output.write_new("guest-observation-intent.json", &challenge_bytes)?;
    input.check()?;
    output.check()?;
    output.write_new("guest-mount-echo.json", &challenge_bytes)?;
    send(
        file,
        &json!({"challengeSha256":journal::digest(&challenge_bytes),"claims":claims}),
    )?;
    let receipt: Value = serde_json::from_slice(&read(file)?)?;
    if receipt
        != json!({"version":1,"bindingDigest":challenge.binding_digest,"ownerEpoch":challenge.owner_epoch,
        "challengeSha256":journal::digest(&challenge_bytes),"claims":claims,"vmRouteObserved":true,
        "shareRoundTripObserved":true,"accountAuthenticated":false,"helperAuthenticated":false,"trustAccepted":false,"ready":false})
    {
        bail!("Observation reply changed or incorrectly promoted trust")
    }
    input.check()?;
    output.check()?;
    output.write_new(
        "guest-observation-reply.json",
        &serde_json::to_vec(&receipt)?,
    )?;
    Ok(receipt)
}

pub(super) fn acquire_authenticated() -> Result<Channel> {
    // Refuse BEFORE socket, mount/account discovery or reading any public key.
    // No production constructor can turn vmRouteObserved or JSON into authority.
    bail!("VZ authenticates only the VM route, not guest UID/process/helper identity; authenticated helper broker is unavailable until verified signed helper delivery/launch and mount acquisition exist")
}

#[cfg(test)]
#[path = "macos_guest_channel_tests.rs"]
mod tests;
