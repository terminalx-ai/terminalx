//! Where this computer listens for direct connections, and who it answers
//! (PRO-487, docs/MACHINES.md "As built (PRO-487)").
//!
//! One setting, `machines.listen`, decides which addresses TCP 6768 is bound
//! to: the runtime's listener for operating computers and phones
//! (`machine_host::direct`) and the window's phone listener
//! (`pairing::direct`) both read it here. Whatever is bound, a connection
//! whose source is a public address is refused before a byte of it is read,
//! unless the person allowed public callers (`machines.allowPublic`).
//!
//! Nothing here opens a socket: it is the policy, kept pure so both builds
//! and their tests share it.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// `machines.listen`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Listen {
    /// No listener: computers and phones reach this one through the relay.
    Relay,
    /// The machine's Tailscale address only.
    Tailscale,
    /// Its private and Tailscale addresses.
    Lan,
    /// Every interface, as every install did before the setting existed.
    All,
}

impl Listen {
    pub const EVERY: [Listen; 4] = [Listen::Relay, Listen::Tailscale, Listen::Lan, Listen::All];

    /// The word the command line and `settings.json` use.
    pub fn word(self) -> &'static str {
        match self {
            Listen::Relay => "relay",
            Listen::Tailscale => "tailscale",
            Listen::Lan => "lan",
            Listen::All => "all",
        }
    }

    pub fn from_word(word: &str) -> Option<Self> {
        Self::EVERY.into_iter().find(|listen| listen.word() == word)
    }

    /// As a person reads it.
    pub fn label(self) -> &'static str {
        match self {
            Listen::Relay => "Relay only",
            Listen::Tailscale => "Tailscale",
            Listen::Lan => "Local network",
            Listen::All => "All interfaces",
        }
    }

    /// What the choice exposes, in one sentence.
    pub fn exposes(self) -> &'static str {
        match self {
            Listen::Relay => "No port is opened. Computers and phones reach this one through the TerminalX relay, end-to-end encrypted.",
            Listen::Tailscale => "TCP 6768 on this computer's Tailscale address only.",
            Listen::Lan => "TCP 6768 on its private network and Tailscale addresses.",
            Listen::All => "TCP 6768 on every address this computer has, public ones included.",
        }
    }
}

/// `machines.listen` from `settings.json`. A value this build does not know
/// reads as [`Listen::Relay`]: a mistyped setting never opens a port.
pub fn lenient<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Listen>, D::Error> {
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(match value {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(word)) => Some(Listen::from_word(&word).unwrap_or(Listen::Relay)),
        Some(_) => Some(Listen::Relay),
    })
}

/// What the settings ask of a listener.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Plan {
    pub choice: Listen,
    /// The person chose it. False on an install that listened before the
    /// setting existed: it keeps every interface until they choose.
    pub chosen: bool,
    /// Callers from public addresses are answered.
    pub allow_public: bool,
    /// Nobody has said yet whether public callers are answered.
    pub public_unanswered: bool,
}

impl Plan {
    pub fn of(settings: &crate::store::settings::MachinesSettings) -> Self {
        Self {
            choice: settings.listen.unwrap_or(Listen::All),
            chosen: settings.listen.is_some(),
            allow_public: settings.allow_public == Some(true),
            public_unanswered: settings.listen.is_none() && settings.allow_public.is_none(),
        }
    }

    /// The plan in `settings.json` now. Blocking: reads the file.
    pub fn current() -> Self {
        Self::of(&crate::store::settings::load().machines)
    }

    /// The addresses a listener binds on a computer with `interfaces`.
    pub fn binds(&self, interfaces: &[Ipv4Addr]) -> Vec<Ipv4Addr> {
        bind_addresses(self.choice, interfaces)
    }

    /// Whether to ask the one-time question (decision 3): an install from
    /// before the setting, still on every interface, that a public caller
    /// can reach or has tried to.
    pub fn asks_public(&self, interfaces: &[Ipv4Addr], refused_public: bool) -> bool {
        self.public_unanswered && (refused_public || interfaces.iter().any(|address| is_public(IpAddr::V4(*address))))
    }
}

static REMEMBERED: Mutex<Option<Plan>> = Mutex::new(None);

/// Keep `plan` as this process's current one: whoever owns a listener
/// (the runtime's machine host, the window's pairing manager) remembers it
/// each time it reads the settings, so code that only needs the answer does
/// not read the file.
pub fn remember(plan: Plan) {
    *REMEMBERED.lock().unwrap() = Some(plan);
}

/// The plan this process last remembered. Blocking the first time only, when
/// nobody has: it is read from `settings.json` then.
pub fn remembered() -> Plan {
    let mut remembered = REMEMBERED.lock().unwrap();
    *remembered.get_or_insert_with(Plan::current)
}

/// Write the choice to `settings.json`: where to listen, and whether callers
/// from public addresses are answered. The runtime and the window watch the
/// file. Blocking.
pub fn choose(listen: Listen, allow_public: bool) -> anyhow::Result<()> {
    let mut settings = crate::store::settings::load();
    settings.machines.listen = Some(listen);
    settings.machines.allow_public = Some(allow_public);
    crate::store::settings::save(&settings)
}

/// `100.64.0.0/10`, where Tailscale gives each machine its address, and
/// Tailscale's IPv6 range `fd7a:115c:a1e0::/48`.
pub fn is_tailscale(address: IpAddr) -> bool {
    match address.to_canonical() {
        IpAddr::V4(address) => address.octets()[0] == 100 && (address.octets()[1] & 0xC0) == 64,
        IpAddr::V6(address) => address.segments()[..3] == [0xfd7a, 0x115c, 0xa1e0],
    }
}

/// An RFC 1918 address: a home, office or cloud private network.
fn is_private_network(address: Ipv4Addr) -> bool {
    address.is_private()
}

/// Whether the internet can originate a connection from `address`: anything
/// but loopback, private, link-local, carrier-grade NAT (Tailscale's range),
/// the benchmarking range local proxies hand out, and their IPv6 kin.
pub fn is_public(address: IpAddr) -> bool {
    match address.to_canonical() {
        IpAddr::V4(address) => {
            let octets = address.octets();
            let shared = octets[0] == 100 && (octets[1] & 0xC0) == 64;
            let benchmarking = octets[0] == 198 && matches!(octets[1], 18 | 19);
            !(address.is_loopback() || address.is_private() || address.is_link_local() || address.is_unspecified() || address.is_broadcast() || address.is_multicast() || shared || benchmarking)
        }
        IpAddr::V6(address) => {
            let first = address.segments()[0];
            let unique_local = first & 0xfe00 == 0xfc00;
            let link_local = first & 0xffc0 == 0xfe80;
            !(address.is_loopback() || address.is_unspecified() || address.is_multicast() || unique_local || link_local)
        }
    }
}

/// The addresses `choice` binds among `interfaces`, in a stable order with
/// none twice. [`Listen::All`] is the wildcard; [`Listen::Relay`] is none.
pub fn bind_addresses(choice: Listen, interfaces: &[Ipv4Addr]) -> Vec<Ipv4Addr> {
    let mut addresses: Vec<Ipv4Addr> = match choice {
        Listen::Relay => Vec::new(),
        Listen::All => return vec![Ipv4Addr::UNSPECIFIED],
        Listen::Tailscale => interfaces.iter().copied().filter(|address| is_tailscale(IpAddr::V4(*address))).collect(),
        Listen::Lan => interfaces.iter().copied().filter(|address| is_private_network(*address) || is_tailscale(IpAddr::V4(*address))).collect(),
    };
    addresses.sort_unstable();
    addresses.dedup();
    addresses
}

/// This computer's IPv4 interface addresses, loopback included.
pub fn interfaces() -> Vec<Ipv4Addr> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|interface| match interface.ip() {
            IpAddr::V4(address) => Some(address),
            IpAddr::V6(_) => None,
        })
        .collect()
}

/// Whether a connection from `source` is answered.
pub fn caller_allowed(source: IpAddr, allow_public: bool) -> bool {
    allow_public || !is_public(source)
}

/// How often a refused public caller is logged.
const REFUSAL_LOG_EVERY: Duration = Duration::from_secs(60 * 60);

/// Counts refused public callers and says when one is worth a log line: the
/// first, then the first of each hour after, with how many came between.
#[derive(Default)]
pub struct Refusals {
    state: Mutex<RefusalState>,
}

#[derive(Default)]
struct RefusalState {
    logged_at: Option<Instant>,
    since: u64,
}

impl Refusals {
    /// Note a refusal at `now`. `Some(earlier)` when it should be logged,
    /// with how many were refused unlogged since the last line.
    pub fn note(&self, now: Instant) -> Option<u64> {
        let mut state = self.state.lock().unwrap();
        if state.logged_at.is_some_and(|at| now.saturating_duration_since(at) < REFUSAL_LOG_EVERY) {
            state.since += 1;
            return None;
        }
        state.logged_at = Some(now);
        Some(std::mem::take(&mut state.since))
    }
}

/// Refuse `source` if the plan does, logging the first refusal each hour.
/// `listener` names who refused, for the log. Whether it is answered.
pub fn admit(source: SocketAddr, allow_public: bool, refusals: &Refusals, listener: &str) -> bool {
    if caller_allowed(source.ip(), allow_public) {
        return true;
    }
    if let Some(earlier) = refusals.note(Instant::now()) {
        let more = if earlier > 0 { format!(" ({earlier} more were refused since the last time this was logged)") } else { String::new() };
        log::warn!("{listener}: refused a connection from the public address {}{more}. Public callers are not answered unless you allow them.", source.ip());
    }
    false
}

/// Who the runtime runs as, and what that user may do (PRO-487).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunsAs {
    pub user: String,
    /// The effective user is root: every paired computer and every agent
    /// here acts as root.
    pub root: bool,
    /// `sudo` works for this user without a password. `None`: not known
    /// (not checked yet, or root, who needs none).
    pub passwordless_sudo: Option<bool>,
}

static RUNS_AS: OnceLock<RunsAs> = OnceLock::new();
static RUNS_AS_PROBE: std::sync::Once = std::sync::Once::new();

/// How long `sudo -n true` may take before it is taken for "no".
const SUDO_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Who this process runs as, without asking `sudo` anything.
pub fn current_user() -> (String, bool) {
    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions.
        let uid = unsafe { libc::geteuid() };
        let name = user_name(uid).or_else(|| std::env::var("USER").ok().filter(|user| !user.is_empty())).unwrap_or_else(|| format!("uid {uid}"));
        (name, uid == 0)
    }
    #[cfg(not(unix))]
    {
        (std::env::var("USERNAME").unwrap_or_else(|_| "this user".into()), false)
    }
}

#[cfg(unix)]
fn user_name(uid: libc::uid_t) -> Option<String> {
    let mut buffer = vec![0 as libc::c_char; 4096];
    let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
    let mut found: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: the buffer outlives the call and its length is passed; `found`
    // is null unless the entry was filled in from that buffer.
    let status = unsafe { libc::getpwuid_r(uid, &mut entry, buffer.as_mut_ptr(), buffer.len(), &mut found) };
    if status != 0 || found.is_null() || entry.pw_name.is_null() {
        return None;
    }
    // SAFETY: `pw_name` points at a NUL-terminated string inside `buffer`.
    let name = unsafe { std::ffi::CStr::from_ptr(entry.pw_name) }.to_string_lossy().into_owned();
    (!name.is_empty()).then_some(name)
}

/// Whether `sudo -k -n true` succeeds: sudo is installed and lets this user
/// run a command without typing a password. `-k` ignores a credential cached
/// from a password typed a moment ago (`sudo loginctl enable-linger` in the
/// same terminal), and does not renew it; `-n` never prompts. It runs
/// nothing else. Blocking, for up to [`SUDO_PROBE_TIMEOUT`].
pub fn passwordless_sudo() -> bool {
    let child = std::process::Command::new("sudo")
        .args(["-k", "-n", "true"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    let Ok(mut child) = child else { return false };
    let deadline = Instant::now() + SUDO_PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

/// Who this process runs as, with the sudo answer. Blocking the first time
/// (`sudo -n true`); the answer is kept for the life of the process, so
/// sudo's log gains one line a start, not one a status read.
pub fn runs_as() -> RunsAs {
    RUNS_AS
        .get_or_init(|| {
            let (user, root) = current_user();
            let passwordless_sudo = if root { None } else { Some(passwordless_sudo()) };
            RunsAs { user, root, passwordless_sudo }
        })
        .clone()
}

/// [`runs_as`] if it is known already, else who without the sudo answer.
/// `probe`: have a background thread find that answer, for the next call.
/// Never blocks.
pub fn runs_as_now(probe: bool) -> RunsAs {
    if let Some(known) = RUNS_AS.get() {
        return known.clone();
    }
    if probe {
        RUNS_AS_PROBE.call_once(|| {
            std::thread::spawn(|| {
                runs_as();
            });
        });
    }
    let (user, root) = current_user();
    RunsAs { user, root, passwordless_sudo: None }
}

/// Whether a failed bind means another listener holds the port. Windows
/// answers a bind over a listener with access denied as well as "in use".
pub(crate) fn port_taken(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::AddrInUse || (cfg!(windows) && error.kind() == std::io::ErrorKind::PermissionDenied)
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_port_is_taken_when_the_system_says_so_in_its_own_words() {
        use std::io::{Error, ErrorKind};
        assert!(super::port_taken(&Error::from(ErrorKind::AddrInUse)));
        assert_eq!(super::port_taken(&Error::from(ErrorKind::PermissionDenied)), cfg!(windows));
        assert!(!super::port_taken(&Error::from(ErrorKind::AddrNotAvailable)));
    }

    use super::*;

    fn v4(address: &str) -> Ipv4Addr {
        address.parse().unwrap()
    }

    fn ip(address: &str) -> IpAddr {
        address.parse().unwrap()
    }

    #[test]
    fn each_choice_binds_only_its_addresses() {
        let interfaces = [v4("127.0.0.1"), v4("192.168.1.20"), v4("100.93.49.78"), v4("203.0.113.7"), v4("10.0.0.4"), v4("169.254.3.4"), v4("192.168.1.20")];
        assert_eq!(bind_addresses(Listen::Relay, &interfaces), Vec::<Ipv4Addr>::new(), "relay only opens nothing");
        assert_eq!(bind_addresses(Listen::Tailscale, &interfaces), vec![v4("100.93.49.78")]);
        assert_eq!(bind_addresses(Listen::Lan, &interfaces), vec![v4("10.0.0.4"), v4("100.93.49.78"), v4("192.168.1.20")], "private and Tailscale, never the public one");
        assert_eq!(bind_addresses(Listen::All, &interfaces), vec![Ipv4Addr::UNSPECIFIED]);
        assert_eq!(bind_addresses(Listen::Tailscale, &[v4("192.168.1.20")]), Vec::<Ipv4Addr>::new(), "no Tailscale address, nothing to bind");
    }

    #[test]
    fn public_sources_are_the_ones_the_internet_can_send() {
        for public in ["203.0.113.7", "8.8.8.8", "100.128.0.1", "100.63.255.255", "172.32.0.1", "2001:db8::1", "::ffff:8.8.8.8"] {
            assert!(is_public(ip(public)), "{public}");
            assert!(!caller_allowed(ip(public), false), "{public} is refused");
            assert!(caller_allowed(ip(public), true), "{public} is answered once allowed");
        }
        for local in ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.20", "169.254.1.2", "100.64.0.1", "100.127.255.254", "198.18.0.1", "::1", "fe80::1", "fd7a:115c:a1e0::1", "fc00::1", "::ffff:192.168.1.20"] {
            assert!(!is_public(ip(local)), "{local}");
            assert!(caller_allowed(ip(local), false), "{local} is answered under every choice");
        }
        assert!(is_tailscale(ip("100.64.0.1")) && is_tailscale(ip("fd7a:115c:a1e0::1")) && !is_tailscale(ip("100.128.0.1")));
    }

    #[test]
    fn the_first_refusal_each_hour_is_logged_with_the_count_between() {
        let refusals = Refusals::default();
        let start = Instant::now();
        assert_eq!(refusals.note(start), Some(0), "the first");
        assert_eq!(refusals.note(start + Duration::from_secs(1)), None);
        assert_eq!(refusals.note(start + Duration::from_secs(3599)), None);
        assert_eq!(refusals.note(start + Duration::from_secs(3600)), Some(2), "the first of the next hour, with the two between");
        assert_eq!(refusals.note(start + Duration::from_secs(3601)), None);
    }

    #[test]
    fn an_install_from_before_the_setting_keeps_every_interface_and_refuses_public_callers() {
        use crate::store::settings::MachinesSettings;
        let before = Plan::of(&MachinesSettings { allow_operating: true, listen: None, allow_public: None });
        assert_eq!((before.choice, before.chosen, before.allow_public, before.public_unanswered), (Listen::All, false, false, true));
        assert!(before.asks_public(&[v4("203.0.113.7")], false), "a public address of its own");
        assert!(before.asks_public(&[v4("10.0.0.4")], true), "behind NAT, once a public caller was refused");
        assert!(!before.asks_public(&[v4("10.0.0.4")], false), "nothing public reaches it");

        let kept = Plan::of(&MachinesSettings { allow_operating: true, listen: Some(Listen::All), allow_public: Some(true) });
        assert_eq!((kept.chosen, kept.allow_public, kept.public_unanswered), (true, true, false));
        assert!(!kept.asks_public(&[v4("203.0.113.7")], true), "answered: asked once");

        let closed = Plan::of(&MachinesSettings { allow_operating: true, listen: Some(Listen::Relay), allow_public: Some(false) });
        assert_eq!(closed.binds(&[v4("203.0.113.7"), v4("192.168.1.20")]), Vec::<Ipv4Addr>::new());
        assert!(!closed.allow_public);
    }

    #[test]
    fn the_setting_reads_leniently_and_never_opens_a_port_for_a_typo() {
        #[derive(Deserialize)]
        struct Holder {
            #[serde(default, deserialize_with = "lenient")]
            listen: Option<Listen>,
        }
        let read = |json: &str| serde_json::from_str::<Holder>(json).unwrap().listen;
        assert_eq!(read(r#"{}"#), None);
        assert_eq!(read(r#"{"listen":null}"#), None);
        assert_eq!(read(r#"{"listen":"lan"}"#), Some(Listen::Lan));
        assert_eq!(read(r#"{"listen":"everything"}"#), Some(Listen::Relay));
        assert_eq!(read(r#"{"listen":7}"#), Some(Listen::Relay));
        for listen in Listen::EVERY {
            assert_eq!(Listen::from_word(listen.word()), Some(listen));
            assert_eq!(serde_json::to_value(listen).unwrap(), listen.word());
        }
    }

    #[test]
    fn who_it_runs_as_is_named_without_asking_sudo() {
        let (user, root) = current_user();
        assert!(!user.is_empty());
        // SAFETY: geteuid has no preconditions.
        #[cfg(unix)]
        assert_eq!(root, unsafe { libc::geteuid() } == 0);
        let now = runs_as_now(false);
        assert_eq!((now.user, now.root), (user, root));
    }
    /// A changed choice reaches the file: the settings writer keeps keys it
    /// does not know from the disk, so these two must be ones it knows.
    #[test]
    fn a_changed_choice_replaces_the_one_on_disk() {
        let _home = crate::store::temp_home();
        choose(Listen::Relay, false).unwrap();
        assert_eq!(Plan::current().choice, Listen::Relay);
        choose(Listen::All, true).unwrap();
        let plan = Plan::current();
        assert_eq!((plan.choice, plan.chosen, plan.allow_public), (Listen::All, true, true));
        choose(Listen::Lan, false).unwrap();
        let on_disk: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(crate::store::root().unwrap().join("settings.json")).unwrap()).unwrap();
        assert_eq!((on_disk["machines"]["listen"].as_str(), on_disk["machines"]["allowPublic"].as_bool()), (Some("lan"), Some(false)), "{on_disk}");
    }

}
