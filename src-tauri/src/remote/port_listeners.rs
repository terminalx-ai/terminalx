//! What listens on the workspace's TCP ports, and which process runs it
//! (`ports.list`, PRO-355, docs/MACHINES.md "As built (PRO-355)").
//!
//! - Linux: `/proc/net/tcp` and `tcp6`, each listening socket's inode matched
//!   to a process through `/proc/<pid>/fd`; argv from `/proc/<pid>/cmdline`,
//!   the directory from `/proc/<pid>/cwd`.
//! - macOS: libproc (`proc_listallpids`, `PROC_PIDLISTFDS`,
//!   `PROC_PIDFDSOCKETINFO`), argv from `KERN_PROCARGS2`, the directory from
//!   `PROC_PIDVNODEPATHINFO`. No `lsof`: auto-forward reads this every 2 s.
//!
//! Only what this user may see is listed, which is what a person forwarding
//! their own development server wants. A listener counts when a loopback
//! connection reaches it: bound to 127.0.0.0/8, ::1, or every address.

use std::collections::BTreeMap;

use serde::Serialize;

/// The longest process name or directory sent (the web view drops longer).
pub const MAX_PROCESS_TEXT: usize = 512;

/// Interpreters whose script names the process better than they do.
const INTERPRETERS: [&str; 5] = ["node", "bun", "deno", "python", "ruby"];

/// One listening port, and the process behind it when it could be told.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Listener {
    pub port: u16,
    pub process: Option<Process>,
}

/// `ports.list`'s `process`: `{ name, pid, cwd? }`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Process {
    pub name: String,
    pub pid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// The ports something listens on that a loopback connection reaches, with
/// their processes, leaving out every port `own_pid` listens on. `None`
/// where this system gives no cheap way to tell (a port can still be opened
/// by number).
pub fn listening(own_pid: u32) -> Option<Vec<Listener>> {
    let sockets = sockets()?;
    Some(group(sockets, own_pid, describe))
}

/// One listening socket: its port and, when known, the process holding it.
type Socket = (u16, Option<u32>);

/// Group sockets by port, drop the ports `own_pid` holds, and name each
/// remaining port's process once.
fn group(sockets: Vec<Socket>, own_pid: u32, describe: impl Fn(u32) -> Option<Process>) -> Vec<Listener> {
    let mut ports: BTreeMap<u16, Option<u32>> = BTreeMap::new();
    let mut own = std::collections::HashSet::new();
    for (port, pid) in sockets {
        if pid == Some(own_pid) {
            own.insert(port);
            continue;
        }
        let entry = ports.entry(port).or_default();
        if entry.is_none() {
            *entry = pid;
        }
    }
    let mut described: BTreeMap<u32, Option<Process>> = BTreeMap::new();
    ports
        .into_iter()
        .filter(|(port, _)| !own.contains(port))
        .map(|(port, pid)| {
            let process = pid.and_then(|pid| described.entry(pid).or_insert_with(|| describe(pid)).clone());
            Listener { port, process }
        })
        .collect()
}

/// The short label for a command: the executable's file name or, for an
/// interpreter running a script, the script's file name
/// (`node …/node_modules/.bin/vite` is `vite`). `executable` is the path the
/// process was started from when known; `argv` its arguments, `argv[0]`
/// included.
pub fn process_name(executable: Option<&str>, argv: &[String]) -> Option<String> {
    let file_name = |path: &str| path.trim_end_matches('/').rsplit('/').next().filter(|name| !name.is_empty()).map(str::to_string);
    let program = executable.and_then(file_name).or_else(|| argv.first().map(String::as_str).and_then(file_name))?;
    let interpreter = [Some(program.as_str()), argv.first().map(String::as_str)]
        .into_iter()
        .flatten()
        .filter_map(file_name)
        .find_map(|name| {
            // `python3`, `python3.12`, `node22`: the family is what counts.
            let family = name.to_ascii_lowercase().trim_end_matches(|c: char| c.is_ascii_digit() || c == '.').to_string();
            INTERPRETERS.contains(&family.as_str()).then_some(family)
        });
    let name = match interpreter {
        Some(family) => {
            let mut rest = argv.iter().skip(1).filter(|arg| !arg.starts_with('-')).peekable();
            // `deno run main.ts`, `bun run dev`: the subcommand is not the script.
            if matches!(family.as_str(), "deno" | "bun") && rest.peek().is_some_and(|arg| matches!(arg.as_str(), "run" | "serve" | "task")) {
                rest.next();
            }
            rest.next().map(String::as_str).and_then(file_name).unwrap_or(program)
        }
        None => program,
    };
    Some(truncate(name.trim().to_string())).filter(|name| !name.is_empty())
}

/// At most [`MAX_PROCESS_TEXT`] bytes, cut on a character boundary.
fn truncate(mut text: String) -> String {
    if text.len() > MAX_PROCESS_TEXT {
        let mut end = MAX_PROCESS_TEXT;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    text
}

/// A directory is sent whole or not at all: a cut path names another one.
#[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
fn directory(path: String) -> Option<String> {
    (!path.is_empty() && path.len() <= MAX_PROCESS_TEXT).then_some(path)
}

// --- Linux -----------------------------------------------------------------

#[cfg(target_os = "linux")]
fn sockets() -> Option<Vec<Socket>> {
    let v4 = std::fs::read_to_string("/proc/net/tcp").ok()?;
    let v6 = std::fs::read_to_string("/proc/net/tcp6").unwrap_or_default();
    let listeners: Vec<(u16, Option<u64>)> = parse_listeners(&v4).into_iter().chain(parse_listeners(&v6)).collect();
    let wanted: std::collections::HashSet<u64> = listeners.iter().filter_map(|(_, inode)| *inode).filter(|inode| *inode != 0).collect();
    let owners = socket_owners(&wanted);
    Some(listeners.into_iter().map(|(port, inode)| (port, inode.and_then(|inode| owners.get(&inode).copied()))).collect())
}

/// Which process holds each of `wanted`'s socket inodes, as far as this user
/// can read `/proc/<pid>/fd`.
#[cfg(target_os = "linux")]
fn socket_owners(wanted: &std::collections::HashSet<u64>) -> std::collections::HashMap<u64, u32> {
    let mut owners = std::collections::HashMap::new();
    if wanted.is_empty() {
        return owners;
    }
    let Ok(entries) = std::fs::read_dir("/proc") else { return owners };
    for entry in entries.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|name| name.parse::<u32>().ok()) else { continue };
        let Ok(fds) = std::fs::read_dir(format!("/proc/{pid}/fd")) else { continue };
        for fd in fds.flatten() {
            let Ok(target) = std::fs::read_link(fd.path()) else { continue };
            let inode = target.to_str().and_then(|target| target.strip_prefix("socket:[")).and_then(|rest| rest.strip_suffix(']')).and_then(|inode| inode.parse::<u64>().ok());
            if let Some(inode) = inode.filter(|inode| wanted.contains(inode)) {
                owners.entry(inode).or_insert(pid);
            }
        }
        if owners.len() == wanted.len() {
            break;
        }
    }
    owners
}

#[cfg(target_os = "linux")]
fn describe(pid: u32) -> Option<Process> {
    let cmdline = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
    let argv: Vec<String> = cmdline.split(|byte| *byte == 0).filter(|arg| !arg.is_empty()).map(|arg| String::from_utf8_lossy(arg).into_owned()).collect();
    let executable = std::fs::read_link(format!("/proc/{pid}/exe")).ok().and_then(|path| path.to_str().map(str::to_string));
    let name = process_name(executable.as_deref(), &argv).or_else(|| {
        // A kernel thread or a process whose argv is gone: its short name.
        std::fs::read_to_string(format!("/proc/{pid}/comm")).ok().map(|comm| truncate(comm.trim().to_string())).filter(|comm| !comm.is_empty())
    })?;
    let cwd = std::fs::read_link(format!("/proc/{pid}/cwd")).ok().and_then(|path| path.to_str().map(str::to_string)).and_then(directory);
    Some(Process { name, pid, cwd })
}

/// Listening sockets in a `/proc/net/tcp` or `tcp6` table that are bound to
/// loopback or to every address, with their socket inode when the line has
/// one. One bound to a single other interface is not reachable over
/// loopback and is left out.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_listeners(table: &str) -> Vec<(u16, Option<u64>)> {
    const LISTEN: &str = "0A";
    table
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let local = *fields.get(1)?;
            if *fields.get(3)? != LISTEN {
                return None;
            }
            let (address, port) = local.rsplit_once(':')?;
            let reachable = match address.len() {
                // IPv4, little-endian: 127.x.x.x or 0.0.0.0.
                8 => address == "00000000" || address.ends_with("7F"),
                // IPv6 in four little-endian words: ::, ::1, or the IPv4 forms mapped.
                32 => {
                    address == "00000000000000000000000000000000"
                        || address == "00000000000000000000000001000000"
                        || (address.starts_with("0000000000000000FFFF0000") && (address.ends_with("00000000") || address.ends_with("7F")))
                }
                _ => false,
            };
            let port = reachable.then(|| u16::from_str_radix(port, 16).ok()).flatten().filter(|port| *port != 0)?;
            let inode = fields.get(9).and_then(|inode| inode.parse::<u64>().ok());
            Some((port, inode))
        })
        .collect()
}

// --- macOS -----------------------------------------------------------------

/// `sys/proc_info.h` structures libc does not declare. Their sizes are
/// checked against the SDK's at compile time: the kernel refuses a buffer
/// smaller than `PROC_PIDFDSOCKETINFO_SIZE`.
#[cfg(target_os = "macos")]
#[allow(non_camel_case_types, dead_code)]
mod darwin {
    pub const PROC_PIDFDSOCKETINFO: libc::c_int = 3;
    pub const SOCKINFO_TCP: libc::c_int = 2;
    pub const TSI_S_LISTEN: libc::c_int = 1;
    pub const INI_IPV4: u8 = 0x1;
    pub const INI_IPV6: u8 = 0x2;

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct proc_fileinfo {
        pub fi_openflags: u32,
        pub fi_status: u32,
        pub fi_offset: libc::off_t,
        pub fi_type: i32,
        pub fi_guardflags: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct sockbuf_info {
        pub sbi_cc: u32,
        pub sbi_hiwat: u32,
        pub sbi_mbcnt: u32,
        pub sbi_mbmax: u32,
        pub sbi_lowat: u32,
        pub sbi_flags: i16,
        pub sbi_timeo: i16,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct insi_v4 {
        pub in4_tos: u8,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct insi_v6 {
        pub in6_hlim: u8,
        pub in6_cksum: libc::c_int,
        pub in6_ifindex: u16,
        pub in6_hops: i16,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct in_sockinfo {
        pub insi_fport: libc::c_int,
        /// In network byte order, in the low 16 bits.
        pub insi_lport: libc::c_int,
        pub insi_gencnt: u64,
        pub insi_flags: u32,
        pub insi_flow: u32,
        pub insi_vflag: u8,
        pub insi_ip_ttl: u8,
        pub rfu_1: u32,
        /// `in4in6_addr` (the IPv4 address in its last 4 bytes) or `in6_addr`.
        pub insi_faddr: [u8; 16],
        pub insi_laddr: [u8; 16],
        pub insi_v4: insi_v4,
        pub insi_v6: insi_v6,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct tcp_sockinfo {
        pub tcpsi_ini: in_sockinfo,
        pub tcpsi_state: libc::c_int,
        pub tcpsi_timer: [libc::c_int; 4],
        pub tcpsi_mss: libc::c_int,
        pub tcpsi_flags: u32,
        pub rfu_1: u32,
        pub tcpsi_tp: u64,
    }

    /// Only the TCP member is read; the size is the largest member's
    /// (`un_sockinfo`, 528 bytes).
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub union soi_proto {
        pub pri_tcp: tcp_sockinfo,
        pub size: [u64; 66],
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct socket_info {
        pub soi_stat: libc::vinfo_stat,
        pub soi_so: u64,
        pub soi_pcb: u64,
        pub soi_type: libc::c_int,
        pub soi_protocol: libc::c_int,
        pub soi_family: libc::c_int,
        pub soi_options: i16,
        pub soi_linger: i16,
        pub soi_state: i16,
        pub soi_qlen: i16,
        pub soi_incqlen: i16,
        pub soi_qlimit: i16,
        pub soi_timeo: i16,
        pub soi_error: u16,
        pub soi_oobmark: u32,
        pub soi_rcv: sockbuf_info,
        pub soi_snd: sockbuf_info,
        pub soi_kind: libc::c_int,
        pub rfu_1: u32,
        pub soi_proto: soi_proto,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct socket_fdinfo {
        pub pfi: proc_fileinfo,
        pub psi: socket_info,
    }

    // From the macOS SDK (sizeof / offsetof in C).
    const _: () = assert!(std::mem::size_of::<in_sockinfo>() == 80);
    const _: () = assert!(std::mem::offset_of!(in_sockinfo, insi_laddr) == 48);
    const _: () = assert!(std::mem::offset_of!(in_sockinfo, insi_v6) == 68);
    const _: () = assert!(std::mem::size_of::<tcp_sockinfo>() == 120);
    const _: () = assert!(std::mem::offset_of!(tcp_sockinfo, tcpsi_state) == 80);
    const _: () = assert!(std::mem::size_of::<soi_proto>() == 528);
    const _: () = assert!(std::mem::offset_of!(socket_info, soi_family) == 160);
    const _: () = assert!(std::mem::offset_of!(socket_info, soi_kind) == 232);
    const _: () = assert!(std::mem::offset_of!(socket_info, soi_proto) == 240);
    const _: () = assert!(std::mem::size_of::<socket_info>() == 768);
    const _: () = assert!(std::mem::size_of::<socket_fdinfo>() == 792);
}

#[cfg(target_os = "macos")]
fn sockets() -> Option<Vec<Socket>> {
    use std::mem::{size_of, MaybeUninit};
    // How many processes there are, then the list, with room for a few more.
    // SAFETY: a null buffer asks only for the count.
    let estimate = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if estimate <= 0 {
        return None;
    }
    let mut pids = vec![0 as libc::pid_t; estimate as usize + 64];
    // SAFETY: the buffer holds `pids.len()` pids and its size in bytes is passed.
    let count = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), (pids.len() * size_of::<libc::pid_t>()) as libc::c_int) };
    if count <= 0 {
        return None;
    }
    pids.truncate(count as usize);
    let mut sockets = Vec::new();
    for pid in pids.into_iter().filter(|pid| *pid > 0) {
        // Another user's process answers nothing: it is not this person's.
        // SAFETY: a null buffer asks only for the size in bytes.
        let bytes = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
        if bytes <= 0 {
            continue;
        }
        let mut fds: Vec<libc::proc_fdinfo> = vec![libc::proc_fdinfo { proc_fd: 0, proc_fdtype: 0 }; bytes as usize / size_of::<libc::proc_fdinfo>() + 16];
        // SAFETY: the buffer holds `fds.len()` entries and its size in bytes is passed.
        let bytes = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, fds.as_mut_ptr().cast(), (fds.len() * size_of::<libc::proc_fdinfo>()) as libc::c_int) };
        if bytes <= 0 {
            continue;
        }
        fds.truncate(bytes as usize / size_of::<libc::proc_fdinfo>());
        for fd in fds.iter().filter(|fd| fd.proc_fdtype == libc::PROX_FDTYPE_SOCKET as u32) {
            let mut info = MaybeUninit::<darwin::socket_fdinfo>::zeroed();
            let size = size_of::<darwin::socket_fdinfo>() as libc::c_int;
            // SAFETY: `info` is `size` bytes, and zeroed memory is a valid value of every field.
            let read = unsafe { libc::proc_pidfdinfo(pid, fd.proc_fd, darwin::PROC_PIDFDSOCKETINFO, info.as_mut_ptr().cast(), size) };
            if read != size {
                continue;
            }
            // SAFETY: zero-initialised, then filled by the kernel.
            let info = unsafe { info.assume_init() };
            if let Some(port) = listening_port(&info.psi) {
                sockets.push((port, Some(pid as u32)));
            }
        }
    }
    Some(sockets)
}

/// The port of a TCP socket that listens where a loopback connection reaches.
#[cfg(target_os = "macos")]
fn listening_port(socket: &darwin::socket_info) -> Option<u16> {
    if socket.soi_kind != darwin::SOCKINFO_TCP || !matches!(socket.soi_family, libc::AF_INET | libc::AF_INET6) {
        return None;
    }
    // SAFETY: `soi_kind` says the TCP member is the one filled.
    let tcp = unsafe { socket.soi_proto.pri_tcp };
    if tcp.tcpsi_state != darwin::TSI_S_LISTEN {
        return None;
    }
    let ini = tcp.tcpsi_ini;
    let address = ini.insi_laddr;
    let reachable = if ini.insi_vflag & darwin::INI_IPV4 != 0 {
        // `in4in6_addr`: the IPv4 address is the last 4 bytes.
        let v4 = [address[12], address[13], address[14], address[15]];
        v4 == [0, 0, 0, 0] || v4[0] == 127
    } else if ini.insi_vflag & darwin::INI_IPV6 != 0 {
        let v6 = std::net::Ipv6Addr::from(address);
        v6.is_unspecified() || v6.is_loopback() || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_unspecified() || v4.is_loopback())
    } else {
        false
    };
    let port = u16::from_be(ini.insi_lport as u16);
    (reachable && port != 0).then_some(port)
}

#[cfg(target_os = "macos")]
fn describe(pid: u32) -> Option<Process> {
    let (executable, argv) = procargs(pid as libc::pid_t).map(|(executable, argv)| (Some(executable), argv)).unwrap_or_default();
    let name = process_name(executable.as_deref(), &argv).or_else(|| {
        let mut buffer = [0u8; 256];
        // SAFETY: the buffer's size is passed.
        let length = unsafe { libc::proc_name(pid as libc::c_int, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
        (length > 0).then(|| truncate(String::from_utf8_lossy(&buffer[..length as usize]).into_owned()))
    })?;
    Some(Process { name, pid, cwd: cwd(pid as libc::pid_t).and_then(directory) })
}

/// The executable path and argv a process was started with.
#[cfg(target_os = "macos")]
fn procargs(pid: libc::pid_t) -> Option<(String, Vec<String>)> {
    let mut argmax: libc::c_int = 0;
    let mut size = std::mem::size_of_val(&argmax);
    let mut name = [libc::CTL_KERN, libc::KERN_ARGMAX];
    // SAFETY: `argmax` is an int and its size is passed.
    if unsafe { libc::sysctl(name.as_mut_ptr(), 2, (&mut argmax as *mut libc::c_int).cast(), &mut size, std::ptr::null_mut(), 0) } != 0 || argmax <= 0 {
        return None;
    }
    let mut buffer = vec![0u8; argmax as usize];
    let mut size = buffer.len();
    let mut name = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    // SAFETY: the buffer's size is passed and updated to what was written.
    if unsafe { libc::sysctl(name.as_mut_ptr(), 3, buffer.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) } != 0 {
        return None;
    }
    buffer.truncate(size);
    parse_procargs(&buffer)
}

/// `KERN_PROCARGS2`: argc (a native int), the executable path, NUL padding,
/// then argc NUL-terminated arguments (the environment follows).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_procargs(buffer: &[u8]) -> Option<(String, Vec<String>)> {
    let argc = i32::from_ne_bytes(buffer.get(..4)?.try_into().ok()?);
    let rest = &buffer[4..];
    let path_end = rest.iter().position(|byte| *byte == 0)?;
    let executable = String::from_utf8_lossy(&rest[..path_end]).into_owned();
    let mut rest = &rest[path_end..];
    while let Some((0, tail)) = rest.split_first() {
        rest = tail;
    }
    let argv: Vec<String> = rest.split(|byte| *byte == 0).take(argc.max(0) as usize).map(|arg| String::from_utf8_lossy(arg).into_owned()).collect();
    Some((executable, argv))
}

#[cfg(target_os = "macos")]
fn cwd(pid: libc::pid_t) -> Option<String> {
    use std::mem::{size_of, MaybeUninit};
    let mut info = MaybeUninit::<libc::proc_vnodepathinfo>::zeroed();
    let size = size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    // SAFETY: `info` is `size` bytes, and zeroed memory is a valid value of every field.
    let read = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDVNODEPATHINFO, 0, info.as_mut_ptr().cast(), size) };
    if read != size {
        return None;
    }
    // SAFETY: zero-initialised, then filled by the kernel.
    let info = unsafe { info.assume_init() };
    let bytes: Vec<u8> = info.pvi_cdir.vip_path.iter().flatten().map(|byte| *byte as u8).take_while(|byte| *byte != 0).collect();
    (!bytes.is_empty()).then(|| String::from_utf8_lossy(&bytes).into_owned())
}

// --- Elsewhere ---------------------------------------------------------------

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn sockets() -> Option<Vec<Socket>> {
    None
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn describe(_pid: u32) -> Option<Process> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn an_interpreter_is_named_by_its_script() {
        assert_eq!(process_name(Some("/usr/local/bin/node"), &argv(&["node", "/repo/console/node_modules/.bin/vite", "--port", "5173"])).as_deref(), Some("vite"));
        // Flags before the script are skipped; a versioned interpreter is still one.
        assert_eq!(process_name(Some("/usr/bin/python3.12"), &argv(&["python3", "-u", "server.py"])).as_deref(), Some("server.py"));
        assert_eq!(process_name(Some("/opt/homebrew/bin/ruby"), &argv(&["ruby", "bin/rails"])).as_deref(), Some("rails"));
        assert_eq!(process_name(Some("/Users/me/.deno/bin/deno"), &argv(&["deno", "run", "--allow-net", "main.ts"])).as_deref(), Some("main.ts"));
        assert_eq!(process_name(Some("/Users/me/.bun/bin/bun"), &argv(&["bun", "run", "dev.ts"])).as_deref(), Some("dev.ts"));
        // The interpreter alone (a REPL, or only flags): its own name.
        assert_eq!(process_name(Some("/usr/local/bin/node"), &argv(&["node", "--inspect"])).as_deref(), Some("node"));
        // Known by argv[0] when the executable path says little.
        assert_eq!(process_name(None, &argv(&["/usr/bin/node", "/srv/app/server.js"])).as_deref(), Some("server.js"));
    }

    #[test]
    fn a_plain_executable_is_named_by_its_file_name() {
        assert_eq!(process_name(Some("/usr/local/bin/caddy"), &argv(&["caddy", "run", "--config", "Caddyfile"])).as_deref(), Some("caddy"));
        assert_eq!(process_name(Some("/repo/target/debug/api-server"), &argv(&["./target/debug/api-server", "serve.js"])).as_deref(), Some("api-server"));
        // A name like an interpreter's but not one.
        assert_eq!(process_name(Some("/usr/bin/nodemon"), &argv(&["nodemon", "index.js"])).as_deref(), Some("nodemon"));
        assert_eq!(process_name(None, &[]), None);
        // Never longer than the web view keeps.
        let long = format!("/bin/{}", "é".repeat(400));
        let name = process_name(Some(&long), &[]).unwrap();
        assert!(name.len() <= MAX_PROCESS_TEXT && name.chars().all(|c| c == 'é'), "{}", name.len());
        assert_eq!(directory("/".repeat(MAX_PROCESS_TEXT + 1)), None);
    }

    #[test]
    fn the_runtimes_own_ports_are_left_out_and_each_port_is_listed_once() {
        let describe = |pid: u32| Some(Process { name: format!("p{pid}"), pid, cwd: None });
        // 3000 twice (IPv4 and IPv6), 4000 the runtime's own, 5000 with no known owner.
        let listed = group(vec![(3000, Some(10)), (4000, Some(7)), (3000, Some(10)), (5000, None), (4000, None)], 7, describe);
        assert_eq!(
            listed,
            vec![
                Listener { port: 3000, process: Some(Process { name: "p10".into(), pid: 10, cwd: None }) },
                Listener { port: 5000, process: None },
            ]
        );
    }

    #[test]
    fn listeners_are_read_from_the_proc_tables() {
        let v4 = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
                  0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0\n\
                  1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2 1 0\n\
                  2: 0A00000A:2000 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 3 1 0\n\
                  3: 0100007F:C350 0100007F:0BB8 01 00000000:00000000 00:00000000 00000000  1000        0 4 1 0\n";
        // Loopback and any-address listeners, with their inodes; not one bound
        // to another interface, and not an established connection.
        assert_eq!(parse_listeners(v4), vec![(3000, Some(1)), (8080, Some(2))]);
        let v6 = "  sl  local_address                         remote_address                        st\n\
                  0: 00000000000000000000000000000000:1389 00000000000000000000000000000000:0000 0A 0 0 0\n\
                  1: 00000000000000000000000001000000:1F91 00000000000000000000000000000000:0000 0A 0 0 0\n\
                  2: 000080FE00000000FF005450B6AD1DFE:0050 00000000000000000000000000000000:0000 0A 0 0 0\n";
        assert_eq!(parse_listeners(v6), vec![(5001, None), (8081, None)]);
        assert!(parse_listeners("garbage\nmore garbage").is_empty());
    }

    #[test]
    fn procargs_give_the_executable_and_argv_without_the_environment() {
        let mut buffer = 3i32.to_ne_bytes().to_vec();
        buffer.extend_from_slice(b"/usr/local/bin/node\0\0\0\0node\0/repo/node_modules/.bin/vite\0--host\0PATH=/usr/bin\0");
        let (executable, argv) = parse_procargs(&buffer).unwrap();
        assert_eq!(executable, "/usr/local/bin/node");
        assert_eq!(argv, ["node", "/repo/node_modules/.bin/vite", "--host"]);
        assert_eq!(parse_procargs(&[1, 0]), None);
    }

    /// This test process's own listener is found, named and left out when it
    /// is the runtime's.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_real_listener_is_found_with_its_process() {
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let own = std::process::id();
        let found = listening(own.wrapping_add(1)).expect("this system lists listeners");
        let entry = found.iter().find(|listener| listener.port == port).expect("the test's listener is listed");
        let process = entry.process.as_ref().expect("its process is known");
        assert_eq!(process.pid, own);
        assert!(!process.name.is_empty());
        assert!(process.cwd.as_deref().is_some_and(|cwd| cwd.starts_with('/')), "{process:?}");
        assert!(listening(own).unwrap().iter().all(|listener| listener.port != port), "the runtime's own port is left out");
    }
}
