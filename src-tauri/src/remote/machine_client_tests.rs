//! The machine supervisor against a scripted dialer: route order, one
//! owner per machine, a refused credential, and the move from the relay to
//! a direct route (docs/MACHINES.md "As built (PRO-345)").

use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;

const LAN: &str = "ws://192.168.1.20:6768/machine/1";
const BONJOUR: &str = "ws://mac-mini.local:6768/machine/1";
const TAILSCALE_IP: &str = "ws://100.101.102.103:6768/machine/1";
const TAILSCALE_NAME: &str = "ws://mac-mini.tail1234.ts.net:6768/machine/1";
const MACHINE: &str = "cs1uhCLEB_ttCYaQ";

fn credential(user: &str) -> RelayCredential {
    RelayCredential {
        info: RelayInfo {
            director_url: "https://relay.example".into(),
            cell_url: "https://cell.example".into(),
            assignment_epoch: 1,
            relay_host_id: MACHINE.into(),
            relay_device_id: "computer-desk".into(),
            user_id: user.into(),
        },
        resume_token: Zeroizing::new("r".repeat(43)),
    }
}

fn target(endpoints: &[&str], route: MachineRoute, last: Option<RouteUsed>, relay: Option<&str>) -> Target {
    Target {
        machine_id: MACHINE.into(),
        public_key_b64: general_purpose::STANDARD.encode([1u8; 32]),
        direct_endpoints: endpoints.iter().map(|endpoint| endpoint.to_string()).collect(),
        route,
        last_route: last,
        last_seen_at: None,
        device_token: Zeroizing::new("device-token-0123456789".into()),
        client_secret: Zeroizing::new([7u8; 32]),
        label: "Test MacBook".into(),
        platform: "macos".into(),
        relay: relay.map(credential),
    }
}

fn direct(endpoint: &str) -> Route {
    Route::Direct { kind: classify(endpoint), endpoint: endpoint.into() }
}

fn used(endpoint: &str) -> RouteUsed {
    RouteUsed { kind: classify(endpoint), endpoint: Some(endpoint.into()) }
}

// ------------------------------------------------------------------ (1) route order

#[test]
fn tailscale_is_100_64_slash_10_or_ts_net_and_anything_else_is_lan() {
    assert_eq!(classify(LAN), RouteKind::Lan);
    assert_eq!(classify(BONJOUR), RouteKind::Lan);
    assert_eq!(classify(TAILSCALE_IP), RouteKind::Tailscale);
    assert_eq!(classify(TAILSCALE_NAME), RouteKind::Tailscale);
    assert_eq!(classify("ws://100.64.0.1:6768/machine/1"), RouteKind::Tailscale);
    assert_eq!(classify("ws://100.127.255.255:6768/machine/1"), RouteKind::Tailscale);
    assert_eq!(classify("ws://100.128.0.1:6768/machine/1"), RouteKind::Lan, "outside 100.64.0.0/10");
    assert_eq!(classify("ws://100.63.255.255:6768/machine/1"), RouteKind::Lan);
}

#[test]
fn routes_go_last_worked_then_lan_then_tailscale_then_relay() {
    let endpoints = [TAILSCALE_IP, LAN, TAILSCALE_NAME, BONJOUR];
    // Nothing worked yet: every lan endpoint, every tailscale one, the relay.
    let fresh = target(&endpoints, MachineRoute::RelayAndNearby, None, Some("user-1"));
    assert_eq!(plan_routes(&fresh, Some("user-1")), vec![direct(LAN), direct(BONJOUR), direct(TAILSCALE_IP), direct(TAILSCALE_NAME), Route::Relay]);
    // A Tailscale address worked last: it goes first, the rest keep their order.
    let tailscale_last = target(&endpoints, MachineRoute::RelayAndNearby, Some(used(TAILSCALE_NAME)), Some("user-1"));
    assert_eq!(plan_routes(&tailscale_last, Some("user-1")), vec![direct(TAILSCALE_NAME), direct(LAN), direct(BONJOUR), direct(TAILSCALE_IP), Route::Relay]);
    // The relay worked last and may be used: it goes first.
    let relay_last = target(&endpoints, MachineRoute::RelayAndNearby, Some(RouteUsed { kind: RouteKind::Relay, endpoint: None }), Some("user-1"));
    assert_eq!(plan_routes(&relay_last, Some("user-1")), vec![Route::Relay, direct(LAN), direct(BONJOUR), direct(TAILSCALE_IP), direct(TAILSCALE_NAME)]);
    // A last route the machine no longer advertises is not tried.
    let gone = target(&[LAN], MachineRoute::RelayAndNearby, Some(used(BONJOUR)), None);
    assert_eq!(plan_routes(&gone, None), vec![direct(LAN)]);
}

#[test]
fn the_relay_is_skipped_signed_out_on_this_network_only_and_without_a_credential() {
    let endpoints = [LAN, TAILSCALE_IP];
    let relay_last = Some(RouteUsed { kind: RouteKind::Relay, endpoint: None });
    let only_direct = vec![direct(LAN), direct(TAILSCALE_IP)];
    // Signed out.
    assert_eq!(plan_routes(&target(&endpoints, MachineRoute::RelayAndNearby, relay_last.clone(), Some("user-1")), None), only_direct);
    // Signed in as another account than the one that obtained the credential.
    assert_eq!(plan_routes(&target(&endpoints, MachineRoute::RelayAndNearby, relay_last.clone(), Some("user-1")), Some("user-2")), only_direct);
    // "Only this network".
    assert_eq!(plan_routes(&target(&endpoints, MachineRoute::ThisNetwork, relay_last.clone(), Some("user-1")), Some("user-1")), only_direct);
    // No credential.
    assert_eq!(plan_routes(&target(&endpoints, MachineRoute::RelayAndNearby, relay_last, None), Some("user-1")), only_direct);
    assert!(!relay_allowed(MachineRoute::RelayAndNearby, None, Some("user-1")));
    assert!(relay_allowed(MachineRoute::RelayAndNearby, Some(&credential("user-1").info), Some("user-1")));
}

#[cfg(unix)]
#[test]
fn local_network_access_refused_is_host_unreachable_to_a_private_or_link_local_address() {
    let unreachable = std::io::Error::from_raw_os_error(libc::EHOSTUNREACH);
    let wrapped = tokio_tungstenite::tungstenite::Error::Io(std::io::Error::from_raw_os_error(libc::EHOSTUNREACH));
    assert!(local_network_denied(LAN, &unreachable));
    assert!(local_network_denied("ws://169.254.10.1:6768/machine/1", &wrapped));
    assert!(local_network_denied("ws://10.0.0.5:6768/machine/1", &wrapped));
    assert!(!local_network_denied(TAILSCALE_IP, &unreachable), "not a private address");
    assert!(!local_network_denied(BONJOUR, &unreachable), "a name, not an address");
    assert!(!local_network_denied(LAN, &std::io::Error::from_raw_os_error(libc::ECONNREFUSED)));
}

#[test]
fn a_wake_is_the_wall_clock_running_more_than_three_seconds_ahead() {
    assert!(!woke(Duration::from_secs(1), Duration::from_secs(1)));
    assert!(!woke(Duration::from_millis(3_900), Duration::from_secs(1)), "2.9 s ahead");
    assert!(woke(Duration::from_secs(600), Duration::from_secs(1)));
    assert!(!woke(Duration::from_secs(1), Duration::from_secs(5)), "the wall clock set back");
    let mut detector = WakeDetector::default();
    assert!(!detector.check());
}

#[test]
fn states_serialise_as_the_ui_reads_them() {
    let direct = MachineConnectionState::Direct { route: used(LAN), since: 5, rtt_ms: Some(12), local_network_denied: false };
    assert_eq!(serde_json::to_value(&direct).unwrap(), json!({ "state": "direct", "route": { "kind": "lan", "endpoint": LAN }, "since": 5, "rttMs": 12 }));
    let relay = MachineConnectionState::Relay { route: Route::Relay.used(), since: 5, rtt_ms: None, local_network_denied: true };
    assert_eq!(serde_json::to_value(&relay).unwrap(), json!({ "state": "relay", "route": { "kind": "relay", "endpoint": null }, "since": 5, "rttMs": null, "localNetworkDenied": true }));
    let reconnecting = MachineConnectionState::Reconnecting { lost_at: 9, attempt: 2, retry_in_ms: 500, trying: vec![RouteKind::Lan, RouteKind::Relay], local_network_denied: false };
    assert_eq!(serde_json::to_value(&reconnecting).unwrap(), json!({ "state": "reconnecting", "lostAt": 9, "attempt": 2, "retryInMs": 500, "trying": ["lan", "relay"] }));
    assert_eq!(serde_json::to_value(MachineConnectionState::Offline { last_seen_at: None, retry_in_ms: 10_000, local_network_denied: false }).unwrap(), json!({ "state": "offline", "lastSeenAt": null, "retryInMs": 10000 }));
    assert_eq!(
        serde_json::to_value(MachineConnectionState::NeedsUpdate { version: Some("0.2.30".into()), side: MachineUpdateSide::Machine }).unwrap(),
        json!({ "state": "needsUpdate", "version": "0.2.30", "side": "machine" })
    );
    assert_eq!(serde_json::to_value(MachineConnectionState::NeedsUpdate { version: None, side: MachineUpdateSide::ThisMac }).unwrap(), json!({ "state": "needsUpdate", "version": null, "side": "thisMac" }));
    assert_eq!(serde_json::to_value(MachineConnectionState::Updating { version: "0.2.34".into(), since: 7 }).unwrap(), json!({ "state": "updating", "version": "0.2.34", "since": 7 }));
    assert_eq!(serde_json::to_value(MachineConnectionState::AccessRemoved).unwrap(), json!({ "state": "accessRemoved" }));
    assert_eq!(serde_json::to_value(MachineConnectionState::Idle).unwrap(), json!({ "state": "idle" }));
    let view = MachineConnectionView { machine_id: MACHINE.into(), state: MachineConnectionState::Connecting { trying: vec![RouteKind::Lan], local_network_denied: false } };
    assert_eq!(serde_json::to_value(view).unwrap(), json!({ "machineId": MACHINE, "state": { "state": "connecting", "trying": ["lan"] } }));
    // A machine's `connected` names its link; a cloud workspace's does not.
    let connected = |link| ClientState::Connected { runtime_generation: 0, runtime_epoch: "e".into(), runtime_version: "v".into(), capabilities: vec![], authority: "manage".into(), you: None, link };
    assert_eq!(serde_json::to_value(connected(Some(3))).unwrap()["link"], 3);
    assert!(serde_json::to_value(connected(None)).unwrap().get("link").is_none());
}

// ------------------------------------------------------------------ a scripted machine

#[derive(Clone, Debug)]
enum Answer {
    Connect,
    Fail(DialFailure),
}

/// Answers each route as the test says, after `delay`, and counts attempts
/// that run at once.
struct Script {
    answers: Mutex<HashMap<String, Answer>>,
    delay: Duration,
    /// Routes slower than `delay`.
    slow: Mutex<HashMap<String, Duration>>,
    in_flight: AtomicUsize,
    most_at_once: AtomicUsize,
    dials: Mutex<Vec<(u64, Route)>>,
    /// Each established link's events, to say things on it or close it.
    links: Mutex<HashMap<u64, LinkEvents>>,
    /// Frames each link was sent, other than the supervisor's describes.
    sent: Mutex<Vec<(u64, Value)>>,
    provisions: AtomicUsize,
    /// Itself, for the futures it hands out.
    me: std::sync::Weak<Script>,
}

fn key(route: &Route) -> String {
    match route {
        Route::Direct { endpoint, .. } => endpoint.clone(),
        Route::Relay => "relay".into(),
    }
}

impl Script {
    fn new(delay: Duration, answers: &[(&str, Answer)]) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            answers: Mutex::new(answers.iter().map(|(route, answer)| (route.to_string(), answer.clone())).collect()),
            delay,
            slow: Mutex::new(HashMap::new()),
            in_flight: AtomicUsize::new(0),
            most_at_once: AtomicUsize::new(0),
            dials: Mutex::new(Vec::new()),
            links: Mutex::new(HashMap::new()),
            sent: Mutex::new(Vec::new()),
            provisions: AtomicUsize::new(0),
        })
    }

    fn answer(&self, route: &str, answer: Answer) {
        self.answers.lock().unwrap().insert(route.into(), answer);
    }

    fn slow(&self, route: &str, delay: Duration) {
        self.slow.lock().unwrap().insert(route.into(), delay);
    }

    fn dialed(&self) -> Vec<Route> {
        self.dials.lock().unwrap().iter().map(|(_, route)| route.clone()).collect()
    }

    fn link_of(&self, route: &Route) -> u64 {
        self.dials.lock().unwrap().iter().rev().find(|(_, dialed)| dialed == route).map(|(link, _)| *link).expect("dialed")
    }

    fn say(&self, link: u64, message: Value) {
        let _ = self.links.lock().unwrap()[&link].send((link, LinkEvent::Message(message)));
    }

    fn close(&self, link: u64) {
        let _ = self.links.lock().unwrap()[&link].send((link, LinkEvent::Closed(Closed { code: None, reason: "gone".into() })));
    }

    /// One attempt under way until the guard drops: when it ends, and when
    /// it is cancelled.
    fn begin(self: &Arc<Self>) -> InFlight {
        let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.most_at_once.fetch_max(now, Ordering::SeqCst);
        InFlight(self.clone())
    }
}

struct InFlight(Arc<Script>);

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

fn hello() -> Value {
    json!({ "runtime": { "version": "0.2.33", "runtimeGeneration": 0, "epoch": "epoch-1" }, "capabilities": ["machine/1", "machine/2", "session/1", "ports/1"], "authority": "manage" })
}

impl Dialer for Script {
    fn dial(&self, _target: Arc<Target>, route: Route, _relay_access: bool, link: u64, events: LinkEvents) -> BoxFuture<Result<Established, DialFailure>> {
        let script = self.me.upgrade().expect("the test holds the script");
        let in_flight = script.begin();
        self.dials.lock().unwrap().push((link, route.clone()));
        let answer = self.answers.lock().unwrap().get(&key(&route)).cloned().unwrap_or(Answer::Fail(DialFailure::unreachable("not scripted")));
        let delay = self.slow.lock().unwrap().get(&key(&route)).copied().unwrap_or(self.delay);
        Box::pin(async move {
            tokio::time::sleep(delay).await;
            drop(in_flight);
            match answer {
                Answer::Fail(failure) => Err(failure),
                Answer::Connect => {
                    let (frames, mut outgoing) = mpsc::unbounded_channel::<Value>();
                    script.links.lock().unwrap().insert(link, events.clone());
                    let recorder = script.clone();
                    tokio::spawn(async move {
                        while let Some(frame) = outgoing.recv().await {
                            if frame["method"] == "machine.describe" {
                                let _ = events.send((link, LinkEvent::Message(json!({ "id": frame["id"], "ok": true, "result": { "machineId": MACHINE } }))));
                            } else {
                                recorder.sent.lock().unwrap().push((link, frame));
                            }
                        }
                        let _ = events.send((link, LinkEvent::Closed(Closed { code: None, reason: "stopped".into() })));
                    });
                    Ok(Established { hello: hello(), described: json!({ "machineId": MACHINE }), rtt_ms: Some(4), frames, relay_access: None, rotated_token: None })
                }
            }
        })
    }

    fn provision(&self, _target: Arc<Target>, _access: RelayAccess, _user_id: String) -> BoxFuture<Result<RelayCredential>> {
        let script = self.me.upgrade().expect("the test holds the script");
        let in_flight = script.begin();
        self.provisions.fetch_add(1, Ordering::SeqCst);
        let delay = self.delay;
        Box::pin(async move {
            tokio::time::sleep(delay).await;
            drop(in_flight);
            Err(anyhow!("no relay in this test"))
        })
    }
}

struct Env {
    target: Mutex<Target>,
    /// The version the record last saw.
    recorded: Mutex<Option<String>>,
    user: Mutex<Option<String>>,
    described: Mutex<Vec<RouteUsed>>,
    dropped: AtomicUsize,
}

impl Env {
    fn new(target: Target, user: Option<&str>) -> Arc<Self> {
        Arc::new(Self { target: Mutex::new(target), recorded: Mutex::new(None), user: Mutex::new(user.map(str::to_string)), described: Mutex::new(Vec::new()), dropped: AtomicUsize::new(0) })
    }
}

impl MachineEnv for Env {
    fn target(&self) -> Result<Target> {
        Ok(self.target.lock().unwrap().clone())
    }
    fn signed_in_user(&self) -> Option<String> {
        self.user.lock().unwrap().clone()
    }
    fn described(&self, _described: &Value, route: &RouteUsed) {
        self.described.lock().unwrap().push(route.clone());
        self.target.lock().unwrap().last_route = Some(route.clone());
    }
    fn save_relay(&self, credential: &RelayCredential) -> Result<()> {
        self.target.lock().unwrap().relay = Some(credential.clone());
        Ok(())
    }
    fn drop_relay(&self) {
        self.dropped.fetch_add(1, Ordering::SeqCst);
        self.target.lock().unwrap().relay = None;
    }
    fn recorded_version(&self) -> Option<String> {
        self.recorded.lock().unwrap().clone()
    }
}

/// Everything a supervisor said, both to the web view and as machine states.
#[derive(Debug, Clone)]
enum Said {
    Web(ClientState),
    Message(Value),
    Machine(MachineConnectionState),
}

/// What a supervisor says, in the order it said it. It sends the web
/// view's state before the machine state on the same task, so reading the
/// client channel first whenever both have something keeps that order.
struct Watch {
    client: mpsc::UnboundedReceiver<ClientEvent>,
    machine: mpsc::UnboundedReceiver<MachineConnectionState>,
}

fn start(env: Arc<Env>, script: Arc<Script>) -> (MachineSupervisor, Watch) {
    let (events, client) = mpsc::unbounded_channel();
    let (states, machine) = mpsc::unbounded_channel();
    let on_state: OnState = Arc::new(move |view: &MachineConnectionView| {
        let _ = states.send(view.state.clone());
    });
    let supervisor = MachineSupervisor::start(MACHINE, env, script, events, on_state);
    (supervisor, Watch { client, machine })
}

impl Watch {
    async fn next(&mut self) -> Said {
        tokio::select! {
            biased;
            Some(event) = self.client.recv() => match event {
                ClientEvent::State(state) => Said::Web(state),
                ClientEvent::Message(message) => Said::Message(message),
            },
            Some(state) = self.machine.recv() => Said::Machine(state),
        }
    }

    /// Everything said until `wanted` holds of something, within ten seconds.
    async fn until(&mut self, what: &str, wanted: impl Fn(&Said) -> bool) -> Vec<Said> {
        let mut said = Vec::new();
        let found = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let next = self.next().await;
                said.push(next.clone());
                if wanted(&next) {
                    return;
                }
            }
        })
        .await;
        assert!(found.is_ok(), "never saw {what}; saw {said:#?}");
        said
    }

    /// What is said within `within`, waiting the whole time.
    async fn quiet(&mut self, within: Duration) -> Vec<Said> {
        let mut said = Vec::new();
        let _ = tokio::time::timeout(within, async {
            loop {
                said.push(self.next().await);
            }
        })
        .await;
        said
    }
}

fn machine_state(said: &Said, wanted: impl Fn(&MachineConnectionState) -> bool) -> bool {
    matches!(said, Said::Machine(state) if wanted(state))
}

fn link_of(said: &Said) -> Option<u64> {
    match said {
        Said::Web(ClientState::Connected { link, .. }) => *link,
        _ => None,
    }
}

#[tokio::test]
async fn a_round_dials_the_planned_routes_in_order_one_at_a_time() {
    let script = Script::new(Duration::from_millis(5), &[]);
    let env = Env::new(target(&[TAILSCALE_IP, LAN, BONJOUR], MachineRoute::RelayAndNearby, Some(used(BONJOUR)), Some("user-1")), Some("user-1"));
    let (supervisor, mut watch) = start(env, script.clone());
    watch.until("waiting after a failed round", |said| machine_state(said, |state| matches!(state, MachineConnectionState::Connecting { .. }))).await;
    watch.until("the retry wait", |said| matches!(said, Said::Web(ClientState::Connecting { attempt: 1 }))).await;
    assert_eq!(script.dialed()[..4], [direct(BONJOUR), direct(LAN), direct(TAILSCALE_IP), Route::Relay]);
    supervisor.stop();
}

// ------------------------------------------------------------------ (2) one owner

#[test]
fn concurrent_attaches_start_one_owner_per_machine() {
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    let owners = Arc::new(Owners::default());
    let started = Arc::new(AtomicUsize::new(0));
    let script = Script::new(Duration::from_millis(50), &[]);
    let env = Env::new(target(&[LAN], MachineRoute::ThisNetwork, None, None), None);
    let threads: Vec<_> = (0..16)
        .map(|_| {
            let (owners, started, script, env, handle) = (owners.clone(), started.clone(), script.clone(), env.clone(), runtime.handle().clone());
            std::thread::spawn(move || {
                let _entered = handle.enter();
                owners
                    .attach(MACHINE, "main", || {
                        started.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(20));
                        let (events, _) = mpsc::unbounded_channel();
                        let supervisor = MachineSupervisor::start(MACHINE, env, script, events, Arc::new(|_: &MachineConnectionView| {}));
                        Ok((format!("machine-{}", uuid::Uuid::new_v4().simple()), supervisor))
                    })
                    .unwrap()
            })
        })
        .collect();
    let ids: BTreeSet<String> = threads.into_iter().map(|thread| thread.join().unwrap()).collect();
    assert_eq!(started.load(Ordering::SeqCst), 1, "one supervisor");
    assert_eq!(ids.len(), 1, "every attach got the same connection id");
    // A detached owner is replaced by the next attach.
    let id = ids.into_iter().next().unwrap();
    owners.get(MACHINE).unwrap().stop();
    let _entered = runtime.handle().enter();
    let again = owners.attach(MACHINE, "main", || {
        let (events, _) = mpsc::unbounded_channel();
        Ok(("machine-again".into(), MachineSupervisor::start(MACHINE, env.clone(), script.clone(), events, Arc::new(|_: &MachineConnectionView| {}))))
    });
    assert_eq!(again.unwrap(), "machine-again");
    assert_ne!(id, "machine-again");
    owners.get(MACHINE).unwrap().stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn wakes_network_changes_and_try_again_never_run_two_attempts_for_one_machine() {
    // Slow routes, so every nudge lands while an attempt is under way.
    let script = Script::new(Duration::from_millis(60), &[("relay", Answer::Connect)]);
    let env = Env::new(target(&[LAN, TAILSCALE_IP], MachineRoute::RelayAndNearby, None, Some("user-1")), Some("user-1"));
    let (supervisor, mut watch) = start(env.clone(), script.clone());

    // Waiting and retrying: nudges from everywhere at once.
    script.answer("relay", Answer::Fail(DialFailure::unreachable("down")));
    let nudgers: Vec<_> = (0..4)
        .map(|n| {
            let supervisor = supervisor.clone();
            tokio::spawn(async move {
                for i in 0..40 {
                    match (n + i) % 3 {
                        0 => supervisor.nudge(),
                        1 => supervisor.try_again(),
                        _ => supervisor.relay_rules_changed(),
                    }
                    tokio::time::sleep(Duration::from_millis(7)).await;
                }
            })
        })
        .collect();
    for nudger in nudgers {
        nudger.await.unwrap();
    }
    assert_eq!(script.most_at_once.load(Ordering::SeqCst), 1, "two attempts ran at once while reconnecting");

    // On the relay: every nudge probes the direct routes, one probe at a time.
    script.answer("relay", Answer::Connect);
    supervisor.try_again();
    watch.until("the relay", |said| machine_state(said, |state| matches!(state, MachineConnectionState::Relay { .. }))).await;
    let before = script.dialed().len();
    for _ in 0..30 {
        supervisor.nudge();
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(script.dialed().len() > before, "nudges on the relay probe the direct routes");
    // The relay link drops while a probe is still dialing: the probe is
    // cancelled before the next round dials, never run beside it.
    supervisor.nudge();
    tokio::time::sleep(Duration::from_millis(5)).await;
    script.close(script.link_of(&Route::Relay));
    watch.until("the relay again", |said| matches!(said, Said::Web(ClientState::Connected { .. })) && script.dialed().len() > before + 1).await;
    assert_eq!(script.most_at_once.load(Ordering::SeqCst), 1, "a probe ran beside another attempt");
    supervisor.stop();
}

// ------------------------------------------------------------------ (3) access removed

#[tokio::test]
async fn a_refused_credential_ends_in_access_removed_and_nothing_retries_until_try_again() {
    let script = Script::new(Duration::from_millis(1), &[(LAN, Answer::Fail(DialFailure::AccessRemoved)), (TAILSCALE_IP, Answer::Connect)]);
    let env = Env::new(target(&[LAN, TAILSCALE_IP], MachineRoute::ThisNetwork, None, None), None);
    let (supervisor, mut watch) = start(env, script.clone());
    let said = watch.until("access removed", |said| machine_state(said, |state| *state == MachineConnectionState::AccessRemoved)).await;
    assert!(said.iter().any(|said| matches!(said, Said::Web(ClientState::Stopped))), "the web view is told stopped: {said:?}");
    assert_eq!(script.dialed(), vec![direct(LAN)], "no other route is tried with a refused credential");
    assert_eq!(supervisor.state(), MachineConnectionState::AccessRemoved);

    // Wakes and network changes do not retry; time does not either.
    supervisor.nudge();
    supervisor.relay_rules_changed();
    let quiet = watch.quiet(Duration::from_millis(1_500)).await;
    assert!(quiet.is_empty(), "{quiet:?}");
    assert_eq!(script.dialed().len(), 1, "nothing retried");

    // "Try again" tries once more.
    script.answer(LAN, Answer::Connect);
    supervisor.try_again();
    watch.until("connected", |said| machine_state(said, |state| matches!(state, MachineConnectionState::Direct { .. }))).await;
    assert_eq!(script.dialed().len(), 2);
    supervisor.stop();
    watch.until("idle", |said| machine_state(said, |state| *state == MachineConnectionState::Idle)).await;
}

#[tokio::test]
async fn a_runtime_without_machine_1_needs_an_update_and_a_refused_relay_credential_is_forgotten() {
    let script = Script::new(Duration::from_millis(1), &[("relay", Answer::Fail(DialFailure::RelayCredentialRefused)), (LAN, Answer::Fail(DialFailure::NeedsUpdate { version: Some("0.2.20".into()), offered: vec![] }))]);
    let env = Env::new(target(&[LAN], MachineRoute::RelayAndNearby, Some(RouteUsed { kind: RouteKind::Relay, endpoint: None }), Some("user-1")), Some("user-1"));
    let (supervisor, mut watch) = start(env.clone(), script.clone());
    watch.until("needs update", |said| machine_state(said, |state| *state == MachineConnectionState::NeedsUpdate { version: Some("0.2.20".into()), side: MachineUpdateSide::Machine })).await;
    assert_eq!(script.dialed(), vec![Route::Relay, direct(LAN)]);
    assert_eq!(env.dropped.load(Ordering::SeqCst), 1, "the refused relay credential is deleted");
    assert!(env.target().unwrap().relay.is_none());
    supervisor.stop();
}

// ------------------------------------------------------------------ (4) relay to direct

#[tokio::test]
async fn moving_from_the_relay_to_a_direct_route_says_connected_with_a_new_link_and_nothing_in_between() {
    let script = Script::new(Duration::from_millis(1), &[("relay", Answer::Connect)]);
    let env = Env::new(target(&[LAN], MachineRoute::RelayAndNearby, None, Some("user-1")), Some("user-1"));
    let (supervisor, mut watch) = start(env.clone(), script.clone());
    let said = watch.until("the relay", |said| matches!(said, Said::Web(ClientState::Connected { .. }))).await;
    let relay_link = said.iter().rev().find_map(link_of).unwrap();
    watch.until("the relay state", |said| machine_state(said, |state| matches!(state, MachineConnectionState::Relay { .. }))).await;
    assert_eq!(script.link_of(&Route::Relay), relay_link);
    assert!(supervisor.send(json!({ "id": "web-1", "method": "session.list", "params": {} })));

    // The direct route comes back; a nudge (a probe) finds it.
    script.answer(LAN, Answer::Connect);
    supervisor.nudge();
    let moved = watch.until("connected again", |said| matches!(said, Said::Web(ClientState::Connected { .. }))).await;
    let direct_link = moved.iter().rev().find_map(link_of).unwrap();
    assert_ne!(direct_link, relay_link, "a new link");
    assert!(
        moved.iter().all(|said| !matches!(
            said,
            Said::Web(ClientState::Reconnecting { .. } | ClientState::Connecting { .. } | ClientState::Stopped | ClientState::Idle)
                | Said::Machine(MachineConnectionState::Reconnecting { .. } | MachineConnectionState::Connecting { .. } | MachineConnectionState::Idle | MachineConnectionState::Offline { .. })
        )),
        "nothing between the relay and the direct route: {moved:#?}"
    );
    watch.until("the direct state", |said| machine_state(said, |state| matches!(state, MachineConnectionState::Direct { route, .. } if route.endpoint.as_deref() == Some(LAN)))).await;
    assert_eq!(env.described.lock().unwrap().last().unwrap(), &used(LAN), "the record's last route");

    // Frames go to the direct link from now on.
    assert!(supervisor.send(json!({ "id": "web-2", "method": "session.list", "params": {} })));
    tokio::time::sleep(Duration::from_millis(50)).await;
    let sent: Vec<(u64, String)> = script.sent.lock().unwrap().iter().map(|(link, frame)| (*link, frame["id"].as_str().unwrap().to_string())).collect();
    assert_eq!(sent, vec![(relay_link, "web-1".into()), (direct_link, "web-2".into())]);

    // The relay link drains: an answer to what was sent on it still arrives, its notifications do not.
    script.say(relay_link, json!({ "id": "web-1", "ok": true, "result": { "sessions": [] } }));
    script.say(relay_link, json!({ "event": "session.sessions", "params": {} }));
    script.say(direct_link, json!({ "event": "machine.changed", "params": {} }));
    let delivered = watch.until("the direct link's notification", |said| matches!(said, Said::Message(message) if message["event"] == "machine.changed")).await;
    let messages: Vec<&Value> = delivered.iter().filter_map(|said| match said { Said::Message(message) => Some(message), _ => None }).collect();
    assert_eq!(messages, vec![&json!({ "id": "web-1", "ok": true, "result": { "sessions": [] } }), &json!({ "event": "machine.changed", "params": {} })]);
    supervisor.stop();
}

#[tokio::test]
async fn losing_the_link_reconnects_on_the_route_that_last_worked() {
    let script = Script::new(Duration::from_millis(1), &[(TAILSCALE_IP, Answer::Connect)]);
    let env = Env::new(target(&[LAN, TAILSCALE_IP], MachineRoute::ThisNetwork, None, None), None);
    let (supervisor, mut watch) = start(env, script.clone());
    watch.until("connected", |said| machine_state(said, |state| matches!(state, MachineConnectionState::Direct { .. }))).await;
    assert_eq!(script.dialed(), vec![direct(LAN), direct(TAILSCALE_IP)]);
    script.close(script.link_of(&direct(TAILSCALE_IP)));
    watch.until("reconnecting", |said| machine_state(said, |state| matches!(state, MachineConnectionState::Reconnecting { .. }))).await;
    watch.until("connected again", |said| machine_state(said, |state| matches!(state, MachineConnectionState::Direct { .. }))).await;
    assert_eq!(script.dialed()[2], direct(TAILSCALE_IP), "the route that last worked goes first");
    supervisor.stop();
}

#[tokio::test]
async fn the_machine_refusing_the_device_token_on_the_relay_link_is_access_removed_and_keeps_the_relay_credential() {
    // No direct address answers; the relay takes the resume credential and
    // the machine behind it refuses the device token.
    let script = Script::new(Duration::from_millis(1), &[("relay", Answer::Fail(DialFailure::AccessRemoved))]);
    let env = Env::new(target(&[LAN], MachineRoute::RelayAndNearby, None, Some("user-1")), Some("user-1"));
    let (supervisor, mut watch) = start(env.clone(), script.clone());
    let said = watch.until("access removed", |said| machine_state(said, |state| *state == MachineConnectionState::AccessRemoved)).await;
    assert!(said.iter().any(|said| matches!(said, Said::Web(ClientState::Stopped))), "{said:?}");
    assert_eq!(script.dialed(), vec![direct(LAN), Route::Relay]);
    assert_eq!(env.dropped.load(Ordering::SeqCst), 0, "the relay credential was not what was refused");
    supervisor.nudge();
    assert!(watch.quiet(Duration::from_millis(1_000)).await.is_empty());
    assert_eq!(script.dialed().len(), 2, "nothing retried");
    supervisor.stop();
}

// ------------------------------------------------------------------ review of PR #1020

#[tokio::test]
async fn a_web_view_attaching_to_a_live_owner_hears_its_state_and_the_owner_stops_only_when_the_last_lets_go() {
    let script = Script::new(Duration::from_millis(1), &[(LAN, Answer::Connect)]);
    let env = Env::new(target(&[LAN], MachineRoute::ThisNetwork, None, None), None);
    let owners = Owners::default();
    let mut watch = None;
    let mut start_owner = || {
        let (events, client) = mpsc::unbounded_channel();
        let (states, machine) = mpsc::unbounded_channel();
        let on_state: OnState = Arc::new(move |view: &MachineConnectionView| {
            let _ = states.send(view.state.clone());
        });
        watch = Some(Watch { client, machine });
        Ok(("machine-1".to_string(), MachineSupervisor::start(MACHINE, env.clone(), script.clone(), events, on_state)))
    };
    assert_eq!(owners.attach(MACHINE, "main", &mut start_owner).unwrap(), "machine-1");
    let mut watch = watch.take().unwrap();
    let said = watch.until("connected", |said| matches!(said, Said::Web(ClientState::Connected { .. }))).await;
    let link = said.iter().rev().find_map(link_of).unwrap();
    watch.until("direct", |said| machine_state(said, |state| matches!(state, MachineConnectionState::Direct { .. }))).await;

    // A second window, or the same one after a reload: the same owner, and
    // the web views are told `connected` on the same link at once.
    for holder in ["second", "main"] {
        let again = owners.attach(MACHINE, holder, || panic!("a second owner started")).unwrap();
        assert_eq!(again, "machine-1");
        let replayed = watch.until("the current state again", |said| matches!(said, Said::Web(ClientState::Connected { .. }))).await;
        assert_eq!(replayed.iter().rev().find_map(link_of), Some(link), "the same link, so nothing resubscribes");
    }
    assert_eq!(script.dialed().len(), 1, "nothing dialed again");

    // One window lets go: the other keeps the connection.
    let owner = owners.get(MACHINE).unwrap();
    assert!(!owner.release(Some("second")));
    assert!(!owner.is_stopped());
    assert!(owner.send(json!({ "id": "web-1", "method": "session.list", "params": {} })));
    // A window that never held it lets go of nothing.
    assert!(!owner.release(Some("never-held")));
    // The last one lets go: the owner stops, and the next attach starts another.
    assert!(owner.release(Some("main")));
    assert!(owner.is_stopped());
    watch.until("idle", |said| machine_state(said, |state| *state == MachineConnectionState::Idle)).await;
    let mut started = false;
    let next = owners.attach(MACHINE, "main", || {
        started = true;
        let (events, _) = mpsc::unbounded_channel();
        Ok(("machine-2".into(), MachineSupervisor::start(MACHINE, env.clone(), script.clone(), events, Arc::new(|_: &MachineConnectionView| {}))))
    });
    assert_eq!(next.unwrap(), "machine-2");
    assert!(started);
    owners.get(MACHINE).unwrap().stop();
}

#[tokio::test]
async fn losing_the_relay_while_a_probe_dials_dead_direct_routes_reconnects_at_once() {
    // Two direct addresses that take their whole time to fail, and a relay that answers.
    let script = Script::new(Duration::from_millis(1), &[("relay", Answer::Connect)]);
    script.slow(LAN, Duration::from_secs(3));
    script.slow(TAILSCALE_IP, Duration::from_secs(3));
    let env = Env::new(target(&[LAN, TAILSCALE_IP], MachineRoute::RelayAndNearby, Some(RouteUsed { kind: RouteKind::Relay, endpoint: None }), Some("user-1")), Some("user-1"));
    let (supervisor, mut watch) = start(env, script.clone());
    watch.until("the relay", |said| machine_state(said, |state| matches!(state, MachineConnectionState::Relay { .. }))).await;
    let relay_link = script.link_of(&Route::Relay);

    // A wake: the probe starts on the dead direct routes, and then the relay link drops.
    supervisor.nudge();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(script.dialed().last(), Some(&direct(LAN)), "the probe is dialing");
    let lost = Instant::now();
    script.close(relay_link);
    watch.until("reconnecting", |said| machine_state(said, |state| matches!(state, MachineConnectionState::Reconnecting { .. }))).await;
    assert!(lost.elapsed() < Duration::from_millis(500), "the state says the link is gone at once, not after the probe: {:?}", lost.elapsed());
    let said = watch.until("the relay again", |said| matches!(said, Said::Web(ClientState::Connected { .. }))).await;
    assert!(said.iter().rev().find_map(link_of).unwrap() != relay_link);
    assert!(lost.elapsed() < Duration::from_secs(1), "reconnected without waiting for the probe: {:?}", lost.elapsed());
    assert_eq!(script.most_at_once.load(Ordering::SeqCst), 1, "the probe was cancelled before the round dialed");
    supervisor.stop();
}

#[tokio::test]
async fn choosing_only_this_network_closes_a_relay_link_at_once() {
    let script = Script::new(Duration::from_millis(1), &[("relay", Answer::Connect)]);
    let env = Env::new(target(&[LAN], MachineRoute::RelayAndNearby, None, Some("user-1")), Some("user-1"));
    let (supervisor, mut watch) = start(env.clone(), script.clone());
    watch.until("the relay", |said| machine_state(said, |state| matches!(state, MachineConnectionState::Relay { .. }))).await;
    let dialed = script.dialed().len();

    // "Only this network": the record changes, and the owner is told.
    env.target.lock().unwrap().route = MachineRoute::ThisNetwork;
    supervisor.relay_rules_changed();
    watch.until("the relay link closed", |said| machine_state(said, |state| matches!(state, MachineConnectionState::Reconnecting { .. }))).await;
    assert!(!supervisor.send(json!({ "id": "web-1", "method": "session.list", "params": {} })), "nothing goes through the relay any more");
    watch.until("the next round's wait", |said| matches!(said, Said::Web(ClientState::Reconnecting { .. })) && script.dialed().len() > dialed).await;
    assert!(script.dialed()[dialed..].iter().all(|route| *route != Route::Relay), "only this network is tried: {:?}", &script.dialed()[dialed..]);

    // A direct link is left alone.
    script.answer(LAN, Answer::Connect);
    supervisor.try_again();
    watch.until("direct", |said| machine_state(said, |state| matches!(state, MachineConnectionState::Direct { .. }))).await;
    supervisor.relay_rules_changed();
    assert!(watch.quiet(Duration::from_millis(300)).await.iter().all(|said| !matches!(said, Said::Machine(MachineConnectionState::Reconnecting { .. }))));
    supervisor.stop();
}

#[tokio::test]
async fn a_closed_window_lets_go_so_turning_machines_off_in_the_last_one_stops_the_owner() {
    let script = Script::new(Duration::from_millis(1), &[(LAN, Answer::Connect)]);
    let env = Env::new(target(&[LAN], MachineRoute::ThisNetwork, None, None), None);
    let owners = Owners::default();
    let start_owner = || {
        let (events, _) = mpsc::unbounded_channel();
        Ok(("machine-1".to_string(), MachineSupervisor::start(MACHINE, env.clone(), script.clone(), events, Arc::new(|_: &MachineConnectionView| {}))))
    };
    owners.attach(MACHINE, "main", start_owner).unwrap();
    owners.attach(MACHINE, "chat-1", || panic!("a second owner started")).unwrap();
    let owner = owners.get(MACHINE).unwrap();
    assert!(owner.holds("main") && owner.holds("chat-1"));
    assert!(!owner.holds("chat-2"), "a window that never attached holds nothing");

    // The chat window closes without detaching: its hold goes with it.
    assert!(!owner.release(Some("chat-1")), "the main window still holds it");
    assert!(!owner.holds("chat-1"));
    assert!(!owner.is_stopped());
    // Machines off in the main window: the last hold goes, and the owner stops.
    assert!(owner.release(Some("main")));
    assert!(owner.is_stopped());
}

// ------------------------------------------------------------------ (5) versions and updates (PRO-354)

#[test]
fn the_older_side_updates_by_version_else_by_what_the_machine_offers() {
    let none: Vec<String> = Vec::new();
    // The machine is older, the same, or unknown: the machine updates.
    assert_eq!(update_side(Some("0.2.27"), &none, "0.2.33"), MachineUpdateSide::Machine);
    assert_eq!(update_side(Some("0.2.33"), &none, "0.2.33"), MachineUpdateSide::Machine);
    assert_eq!(update_side(None, &none, "0.2.33"), MachineUpdateSide::Machine);
    assert_eq!(update_side(Some("not a version"), &none, "0.2.33"), MachineUpdateSide::Machine);
    // The machine is newer: this Mac updates.
    assert_eq!(update_side(Some("0.2.35"), &none, "0.2.33"), MachineUpdateSide::ThisMac);
    assert_eq!(update_side(Some("v0.3.0"), &none, "0.2.33"), MachineUpdateSide::ThisMac);
    // No version, but it offers namespaces this desktop does not know: it is the newer one.
    assert_eq!(update_side(None, &["machine/99".to_string()], "0.2.33"), MachineUpdateSide::ThisMac);
    assert_eq!(update_side(None, &["session/1".to_string()], "0.2.33"), MachineUpdateSide::Machine);
    // A version, when there is one, decides over the namespaces.
    assert_eq!(update_side(Some("0.2.20"), &["machine/99".to_string()], "0.2.33"), MachineUpdateSide::Machine);
}

#[test]
fn update_required_carries_the_runtime_version_and_what_it_offers() {
    let refused = json!({ "code": "update_required", "message": "no shared namespace", "data": { "runtimeVersion": "0.2.40", "offered": ["machine/4", "session/9"] } });
    assert_eq!(update_required_failure(&refused), DialFailure::NeedsUpdate { version: Some("0.2.40".into()), offered: vec!["machine/4".into(), "session/9".into()] });
    // An older runtime sends no data.
    assert_eq!(update_required_failure(&json!({ "code": "update_required" })), DialFailure::NeedsUpdate { version: None, offered: vec![] });
    assert!(wanted_capabilities().contains(&crate::remote::machine::MACHINE_3), "this desktop asks for machine/3");
    assert!(wanted_capabilities().contains(&crate::remote::machine::MACHINE_6), "this desktop asks for machine/6 (PRO-351)");
}

#[test]
fn update_changed_says_when_the_machine_hands_over() {
    let changed = |progress: Value| json!({ "event": "machine.updateChanged", "params": { "status": { "method": "installer", "current": "0.2.33", "progress": progress } } });
    assert_eq!(handing_over(&changed(json!({ "phase": "handingOver", "version": "0.2.34", "since": 99 }))), Some(Some(("0.2.34".into(), 99))));
    assert_eq!(handing_over(&changed(json!({ "phase": "trial", "version": "0.2.34", "since": 99 }))), Some(None));
    assert_eq!(handing_over(&changed(json!({ "phase": "idle" }))), Some(None));
    assert_eq!(handing_over(&json!({ "event": "machine.changed", "params": {} })), None);
}

#[tokio::test]
async fn update_required_from_a_newer_machine_says_this_mac_updates() {
    let newer = DialFailure::NeedsUpdate { version: Some("99.0.0".into()), offered: vec!["machine/99".into()] };
    let script = Script::new(Duration::from_millis(1), &[(LAN, Answer::Fail(newer))]);
    let env = Env::new(target(&[LAN], MachineRoute::ThisNetwork, None, None), None);
    let (supervisor, mut watch) = start(env, script);
    let said = watch.until("needs update", |said| machine_state(said, |state| matches!(state, MachineConnectionState::NeedsUpdate { .. }))).await;
    assert!(said.iter().any(|said| matches!(said, Said::Web(ClientState::UpdateRequired))), "the web view hears update required");
    assert!(matches!(said.last(), Some(Said::Machine(MachineConnectionState::NeedsUpdate { version: Some(version), side: MachineUpdateSide::ThisMac })) if version == "99.0.0"));
    supervisor.stop();
}

#[tokio::test]
async fn an_older_runtime_without_data_is_judged_by_the_recorded_version() {
    let script = Script::new(Duration::from_millis(1), &[(LAN, Answer::Fail(DialFailure::NeedsUpdate { version: None, offered: vec![] }))]);
    let env = Env::new(target(&[LAN], MachineRoute::ThisNetwork, None, None), None);
    *env.recorded.lock().unwrap() = Some("0.2.27".into());
    let (supervisor, mut watch) = start(env, script);
    watch
        .until("needs update with the recorded version", |said| {
            machine_state(said, |state| *state == MachineConnectionState::NeedsUpdate { version: Some("0.2.27".into()), side: MachineUpdateSide::Machine })
        })
        .await;
    supervisor.stop();
}

#[tokio::test]
async fn a_link_lost_while_the_machine_hands_over_is_updating_until_it_answers_again() {
    let script = Script::new(Duration::from_millis(1), &[(LAN, Answer::Connect)]);
    let env = Env::new(target(&[LAN], MachineRoute::ThisNetwork, None, None), None);
    let (supervisor, mut watch) = start(env, script.clone());
    watch.until("connected", |said| machine_state(said, |state| matches!(state, MachineConnectionState::Direct { .. }))).await;
    let link = script.link_of(&direct(LAN));

    // The machine says it hands over; the notification still reaches the web view.
    let changed = json!({ "event": "machine.updateChanged", "params": { "status": { "progress": { "phase": "handingOver", "version": "0.2.34", "since": 1234 } } } });
    script.say(link, changed.clone());
    watch.until("the notification", |said| matches!(said, Said::Message(message) if *message == changed)).await;

    // The runtime execs: the link drops and nothing answers for a while.
    script.answer(LAN, Answer::Fail(DialFailure::unreachable("restarting")));
    script.close(link);
    let said = watch.until("updating", |said| machine_state(said, |state| matches!(state, MachineConnectionState::Updating { .. }))).await;
    assert!(
        said.iter().all(|said| !matches!(said, Said::Machine(MachineConnectionState::Reconnecting { .. } | MachineConnectionState::Offline { .. }))),
        "updating, not reconnecting: {said:#?}"
    );
    assert!(matches!(said.last(), Some(Said::Machine(MachineConnectionState::Updating { version, since: 1234 })) if version == "0.2.34"));

    // The new runtime answers: connected, and a later loss is a plain reconnect.
    script.answer(LAN, Answer::Connect);
    supervisor.nudge();
    watch.until("connected again", |said| machine_state(said, |state| matches!(state, MachineConnectionState::Direct { .. }))).await;
    script.answer(LAN, Answer::Fail(DialFailure::unreachable("down")));
    script.close(script.link_of(&direct(LAN)));
    watch.until("reconnecting", |said| machine_state(said, |state| matches!(state, MachineConnectionState::Reconnecting { .. }))).await;
    supervisor.stop();
}

#[tokio::test]
async fn a_handover_that_ends_otherwise_leaves_a_plain_reconnect() {
    let script = Script::new(Duration::from_millis(1), &[(LAN, Answer::Connect)]);
    let env = Env::new(target(&[LAN], MachineRoute::ThisNetwork, None, None), None);
    let (supervisor, mut watch) = start(env, script.clone());
    watch.until("connected", |said| machine_state(said, |state| matches!(state, MachineConnectionState::Direct { .. }))).await;
    let link = script.link_of(&direct(LAN));
    script.say(link, json!({ "event": "machine.updateChanged", "params": { "status": { "progress": { "phase": "handingOver", "version": "0.2.34", "since": 1 } } } }));
    let failed = json!({ "event": "machine.updateChanged", "params": { "status": { "progress": { "phase": "failed", "version": "0.2.34", "at": 2, "message": "trial", "running": "0.2.33", "rolledBack": false } } } });
    script.say(link, failed.clone());
    watch.until("the failure", |said| matches!(said, Said::Message(message) if *message == failed)).await;
    script.answer(LAN, Answer::Fail(DialFailure::unreachable("down")));
    script.close(link);
    let said = watch.until("reconnecting", |said| machine_state(said, |state| matches!(state, MachineConnectionState::Reconnecting { .. }))).await;
    assert!(said.iter().all(|said| !matches!(said, Said::Machine(MachineConnectionState::Updating { .. }))), "no longer updating: {said:#?}");
    supervisor.stop();
}
