// Stands in for src/state/AppProvider.tsx in the phone fixture only (see README.md).
// Everything else is the production app: its screens, its HostApi, its
// transcript sync and cache. Under HostApi a stand-in connection answers the
// Mac's requests with the placeholder data below. No pairing, account,
// network or private data.
//
// The state to show comes from the launch, as `-fixtureScenario <name>`
// (iOS puts launch arguments into NSUserDefaults, which `Settings` reads).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from "react";
import { Settings } from "react-native";
import * as Notifications from "expo-notifications";
import type { AgentEvent, Payload } from "@terminalx/portable/events";
import type { SessionStatusInput } from "@terminalx/portable/sessionStatus";
import { HostApi, type SessionSummary } from "../../src/data/host-api";
import { cacheEpoch, writeCache, writeSaved } from "../../src/data/transcript-cache";
import { restoreLocalNotifications } from "../../src/notifications/local";
import { updateNotificationSettings } from "../../src/notifications/store";
import type { LockScreenShow } from "../../src/notifications/model";
import { ACCOUNT_PAIRING_CAPABILITY, hostIdForPublicKey } from "../../src/pairing/contracts";
import type { AccountHost } from "../../src/pairing/account-client";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { HOSTS_KEY, type StoredHost } from "../../src/store/hosts";
import type { HostConnection, ConnectionStage } from "../../src/transport/connection";
import { useWaited, WAITING_AFTER_MS } from "../../src/state/connection-view";
import type { AccessCodeAnswer, AccessCodeRequest } from "../../src/auth/access-code";
import { AUTH_CONFIG, redeemAccessCode, type CloudSession } from "../../src/auth/protocol";

/**
 * Each state the 22.01–22.05 boards draw.
 * - connected: the Mac answers at once.
 * - connecting: the phone has just begun trying (saved messages show).
 * - waiting: it has been trying for longer than the wait (the real clock turns it to "Waiting for Mac…").
 * - offline: the phone has no network.
 * - held: the Mac disconnected this phone.
 * - updating: connected, and the transcript read is still under way.
 * - slow-refresh: connected; a refresh of the session list takes a few seconds (pull to refresh).
 * The session screen's conversation is chosen by the tab opened, so one launch shows all its states.
 */
type Scenario = "connected" | "connecting" | "waiting" | "offline" | "held" | "updating" | "slow-refresh";
const SCENARIOS: readonly Scenario[] = ["connected", "connecting", "waiting", "offline", "held", "updating", "slow-refresh"];
const asked = Settings.get("fixtureScenario");
const scenario: Scenario = SCENARIOS.includes(asked) ? asked : "connected";

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

// Keys of 32 bytes, so each machine's id is the one its key gives, as on a real account.
const key = (seed: number) => btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => (seed * 31 + index * 7) % 256)));
const machine = (seed: number) => ({ publicKeyB64: key(seed), id: hostIdForPublicKey(key(seed))! });
const studio = machine(1);
const mini = machine(2);
const imac = machine(3);
const laptop = machine(4);
const build = machine(5);

const storedHost = (who: { id: string; publicKeyB64: string }, hostName: string, lastConnected: number): StoredHost => ({
  id: who.id, label: hostName, hostName, publicKeyB64: who.publicKeyB64, endpoint: "fixture", lastConnectedAt: lastConnected, provenance: { kind: "explicit" },
});
const accountHost = (who: { id: string; publicKeyB64: string }, displayName: string, reachability: AccountHost["reachability"], seenMinutesAgo: number): AccountHost => ({
  hostId: who.id, hostPublicKeyB64: who.publicKeyB64, bindingGeneration: 1, displayName, platform: "darwin", capabilities: [ACCOUNT_PAIRING_CAPABILITY], state: "active", reachability, lastSeenAt: ago(seenMinutesAgo),
});
const DAY = 24 * 60;
const HOSTS: StoredHost[] = [
  storedHost(studio, "Studio MacBook", now),
  storedHost(mini, "Mac mini", now - 3 * 60_000),
  storedHost(imac, "Office iMac", now - 2 * DAY * 60_000),
  storedHost(laptop, "Old laptop", now - 21 * DAY * 60_000),
];
const ACCOUNT: AccountHost[] = [
  accountHost(studio, "Studio MacBook", "live", 0),
  accountHost(mini, "Mac mini", "live", 1),
  accountHost(imac, "Office iMac", "exited", 2 * DAY),
  accountHost(laptop, "Old laptop", "exited", 21 * DAY),
  accountHost(build, "Build server", "live", 1),
];

// ---- Sessions (22.04) ----

const pr = (fields: Record<string, unknown>, branch: string) => ({ branch, branchStatus: { branch, checked: true, headMatches: true, pr: { number: 781, state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", checks: "SUCCESS", inMergeQueue: false, ...fields } } });
type Tab = { title: string; harness?: string; minutes: number; facts: SessionStatusInput["tabs"][number] };
function session(id: string, title: string, project: string, branch: string | null, minutes: number, tabs: Tab[], facts: Omit<SessionStatusInput, "tabs"> = {}, kind: "project" | "quick" = "project"): SessionSummary {
  return {
    id, title, project, branch, kind, worktree: branch ?? "scratch", modified: ago(minutes), issueRef: "PRO-986",
    tabs: tabs.map((tab, index) => ({ id: `${id}-${index}`, title: tab.title, harness: tab.harness ?? "claude", status: tab.facts.status, modified: ago(tab.minutes) })),
    rowStatus: { tabs: tabs.map((tab) => tab.facts), branch, ...facts },
  };
}

const SESSIONS: SessionSummary[] = [
  session("question", "Mobile question card", "acme-app", "acme/979-mobile-answer", 2, [{ title: "Claude Code", minutes: 2, facts: { status: "waiting", activity: "needs_answer" } }]),
  session("approval", "Rust cleanup", "acme-api", "acme/rust-cleanup-session", 9, [{ title: "Codex", harness: "codex", minutes: 9, facts: { status: "waiting", activity: "needs_permission" } }]),
  // With `-fixtureTabs states` the session screen's (22.03): one tab per state it draws.
  session("review", "Review and merge", "acme-app", "main", 0, Settings.get("fixtureTabs") === "states" ? [
    { title: "Review and merge", minutes: 0, facts: { status: "in_progress", activity: null } },
    { title: "Mobile question card", minutes: 1, facts: { status: "waiting", activity: "needs_answer" } },
    { title: "Status table", minutes: 3, facts: { status: "in_progress", activity: null } },
    { title: "Merge report", minutes: 18, facts: { status: "completed", activity: null } },
  ] : [
    { title: "Chief of staff", minutes: 0, facts: { status: "in_progress", activity: null } },
    { title: "File the mobile issues", minutes: 18, facts: { status: "completed", activity: null } },
  ]),
  session("runtime", "Runtime handover", "acme-app", "acme/pro-341-runtime", 4, [{ title: "Claude Code", minutes: 4, facts: { status: "in_progress", activity: null } }]),
  session("docs", "Docs search index", "acme-api", "acme/docs-search", 6, [{ title: "Codex", harness: "codex", minutes: 6, facts: { status: "idle", activity: "background" } }]),
  session("roster", "Roster and presence", "acme-app", "acme/pro-128-roster", 52, [
    { title: "Roster", minutes: 52, facts: { status: "idle", activity: null } },
    { title: "Presence", minutes: 64, facts: { status: "idle", activity: null } },
    { title: "Review fixes", harness: "codex", minutes: 70, facts: { status: "idle", activity: null } },
  ], { ...pr({ state: "MERGED" }, "acme/pro-128-roster") }),
  session("checks", "Billing webhooks", "acme-api", "acme/billing-webhooks", 95, [{ title: "Claude Code", minutes: 95, facts: { status: "idle", activity: null } }], { ...pr({ checks: "FAILURE" }, "acme/billing-webhooks") }),
  session("phase", "Phase 2 team layer", "acme-app", "acme/pro-120-phase-2", 720, [{ title: "Claude Code", minutes: 720, facts: { status: "idle", activity: null } }], { work: "uncommitted" }),
  session("quick", "Explain the relay cells", "Quick chats", null, 1500, [{ title: "Claude Code", minutes: 1500, facts: { status: "idle", activity: null } }], {}, "quick"),
];

// ---- Conversations (22.03) ----

const REPLY = "The review is fixed and pushed. Two checks are still running; I will merge when they pass.";
const TABLE = "Where each ticket stands:\n\n| Ticket | Stage | Next | ETA |\n| --- | --- | --- | --- |\n| PRO-341 | Review | I verify, then merge | Today |\n| PRO-128 | Paused | Driver restarts Thursday | Thu |\n| PRO-114 | Checks | Wait for the macOS job | 40 min |";
const COMMANDS: { title: string; command: string; output: string }[] = [
  { title: "Check the time and each ticket's state", command: "date '+%H:%M'; for p in \"PRO-341\" \"PRO-128\" \"PRO-114\"; do gh issue view \"$p\" --json state; done", output: "10:22\nOPEN\nOPEN\nOPEN" },
  { title: "Read the last lines of the task log", command: "tail -6 ~/work/acme-app/tasks/build.log", output: "build ok\nchecks: 2 running" },
];

/** A conversation as a Mac records it: a finished turn, the reader's question, two commands, then what the tab is showing. */
function conversation(sessionId: string, tabId: string, ending: "working" | "question" | "done", reply = REPLY): AgentEvent[] {
  let seq = 0;
  const at = (minutes: number) => ago(minutes);
  // `messageTs`: the verified send time a current Mac records, which the phone shows under a message.
  const event = (minutes: number, payload: Payload): AgentEvent => ({ id: `${tabId}-${++seq}`, sessionId, tabId, harness: "claude", seq, ts: at(minutes), messageTs: at(minutes), payload });
  const events: AgentEvent[] = [
    // Earlier turns, so the conversation fills the screen as a working one does.
    event(40, { type: "user_message", text: "Pick up the review on the mobile question card.", queued: false }),
    event(40, { type: "turn_started", model: "claude-opus-5-5" }),
    event(31, { type: "assistant_text", text: "Done. I split the card into its own component, kept the answer buttons at 44 pt, and added tests for a question with no options." }),
    event(31, { type: "turn_completed", status: "ok", authFailed: false, durationMs: 540_000 }),
    event(20, { type: "user_message", text: "Any review comments left?", queued: false }),
    event(20, { type: "turn_started", model: "claude-opus-5-5" }),
    event(18, { type: "assistant_text", text: "Two: a stale comment in the session screen, and a missing test for the read-only card. Both are small; I'll fix them now." }),
    event(18, { type: "turn_completed", status: "ok", authFailed: false, durationMs: 120_000 }),
    event(9, { type: "user_message", text: "Fix the review comments and push.", queued: false }),
    event(9, { type: "turn_started", model: "claude-opus-5-5" }),
    event(6, { type: "assistant_text", text: reply }),
    event(6, { type: "turn_completed", status: "ok", authFailed: false, durationMs: 180_000 }),
    event(3, { type: "user_message", text: "What's the latest status?", queued: false }),
    event(3, { type: "turn_started", model: "claude-opus-5-5" }),
  ];
  COMMANDS.forEach((step, index) => {
    const callId = `${tabId}-call-${index}`;
    events.push(event(3, { type: "tool_call_started", callId, name: "Bash", toolType: "shell", input: { command: step.command, description: step.title }, title: step.title }));
    events.push(event(2, { type: "tool_call_completed", callId, result: { text: step.output, isError: false, exitCode: 0 } }));
  });
  if (ending === "question") events.push(event(1, { type: "questions_asked", requestId: `${tabId}-ask`, toolUseId: `${tabId}-ask-tool`, questions: [{ question: "Merge now, or wait for the macOS job?", header: "Merge", multiSelect: false, freeText: false, options: [{ label: "Merge now" }, { label: "Wait for it" }] }] }));
  if (ending === "done") events.push(event(1, { type: "turn_completed", status: "ok", authFailed: false, durationMs: 120_000 }));
  return events;
}

const CONVERSATIONS: Record<string, AgentEvent[]> = {
  "review-0": conversation("review", "review-0", "working"),
  "review-1": conversation("review", "review-1", "question"),
  "review-2": conversation("review", "review-2", "working", TABLE),
  "review-3": conversation("review", "review-3", "done"),
};

// ---- Notifications (22.07) ----

/**
 * With `-fixtureLockScreen everything|nothing` the phone has notifications on
 * at that lock-screen level, and the Mac has three it sent while the phone was
 * away. They reach iOS through the app's own path (`restoreLocalNotifications`
 * asks `notifications.missedSince`, then filters, words and schedules each).
 * Without it, the choices are the ones 22.07 frames 2 and 3 draw.
 */
const LOCK_LEVELS: readonly LockScreenShow[] = ["everything", "sessionName", "nothing"];
const lockAsked = Settings.get("fixtureLockScreen");
const lockScreen: LockScreenShow | null = LOCK_LEVELS.includes(lockAsked) ? lockAsked : null;
/** A new epoch each launch, as after a Mac restarts: the phone's watermark from an earlier capture does not hold them back. */
const EPOCH = `fixture-${now}`;
/** As the Mac sends them (#990): oldest first, so the newest is on top. */
const MAC_NOTIFICATIONS = [
  { seq: 1, epoch: EPOCH, kind: "finished", sessionId: "runtime", tabId: "runtime-0", sessionTitle: "Runtime handover", title: "Runtime handover finished", body: "Merged, and the checks passed." },
  { seq: 2, epoch: EPOCH, kind: "approval", sessionId: "approval", tabId: "approval-0", sessionTitle: "Rust cleanup", title: "Rust cleanup needs approval", body: "Run: cargo clean in the build folder", approval: { requestId: "approval-0-ask" } },
  { seq: 3, epoch: EPOCH, kind: "question", sessionId: "question", tabId: "question-0", sessionTitle: "Mobile question card", title: "Mobile question card needs your answer", body: "Merge now, or wait for the macOS job?", question: { requestId: "question-0-ask", options: [{ label: "Merge now" }, { label: "Wait for it" }] } },
];
/** The choices 22.07 draws: the defaults, Office iMac off, quiet hours on, and the lock screen's level. */
const seedNotifications = () => updateNotificationSettings((current) => ({
  ...current,
  allow: true,
  machines: { ...current.machines, [imac.id]: false },
  quietHours: { ...current.quietHours, on: lockScreen === null },
  lockScreen: { ...current.lockScreen, show: lockScreen ?? "sessionName" },
}));

// ---- The Mac, as the phone's requests reach it ----

const MODELS = [{ id: "claude-opus-5-5", label: "Opus 5.5", harness: "claude", efforts: ["low", "medium", "high"], defaultEffort: "high", acceptsImages: true, isDefault: true, upgrade: null, description: null }];
const answer = <T,>(value: T) => ({ ok: true as const, value });
/** A tab's model and mode, as the Mac reports them (`session.tab`). */
const TAB = { harness: "claude", model: "claude-opus-5-5", effort: "high", permissionMode: "default", status: "in_progress" };
/** What Studio MacBook offers; saved as from an earlier connection too, as on a phone that has used it before. */
const FEATURES = { transcript: 1, sessionControls: 1, closeTab: 1, questions: 1, macSettings: 1, terminal: 1, sendIds: 1 };
/** The Mac's cursor digest is a SHA-256 in hex. */
const DIGEST = "0".repeat(64);
const never = new Promise<never>(() => undefined);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The Mac's side of the protocol for the requests the screens make. */
class FixtureConnection {
  private events = new Set<(event: { method: string; params?: unknown }) => void>();
  constructor(private readonly connected: () => boolean) {}
  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<{ ok: true; value: T } | { ok: false; refusal: { code: string; message: string } }> {
    // As the real connection does (`src/transport/connection.ts`): no client, no request.
    if (!this.connected()) throw new Error("Host is disconnected");
    const reply = (value: unknown) => answer(value as T);
    switch (method) {
      case "sync.capabilities": return reply(FEATURES);
      case "sessions.summaries": return reply({ sessions: SESSIONS });
      case "session.sync": {
        // The read that "updating" keeps under way.
        if (scenario === "updating") await never;
        const tabEvents = CONVERSATIONS[String(params.tabId)] ?? [];
        const cursor = params.cursor as { offset: number } | undefined;
        if (cursor) return reply({ events: [], cursor: { offset: cursor.offset, digest: DIGEST }, reset: false, hasMore: false, hasEarlier: false });
        return reply({ events: tabEvents, cursor: { offset: tabEvents.length, digest: DIGEST }, reset: true, hasMore: false, hasEarlier: false });
      }
      case "session.tail": return reply({ events: [], hasMore: false });
      case "chat.list": return reply({ messages: [] });
      case "session.tab": return reply(TAB);
      case "models.list": return reply(MODELS);
      case "mac.settings": case "mac.setSettings": return reply({ nativeCodex: params.nativeCodex ?? true });
      case "host.describe": return reply({ name: "Studio MacBook" });
      case "notifications.missedSince": return reply({ events: lockScreen ? MAC_NOTIFICATIONS : [] });
      default: return reply({});
    }
  }
  subscribe(_method: string, _params: unknown, listener: (result: unknown) => void): () => void {
    let live = this.connected();
    // The Mac confirms a subscription, then sends nothing new.
    if (live) setTimeout(() => { if (live) listener({ subscriptionId: "fixture" }); }, 0);
    return () => { live = false; };
  }
  onEvent(listener: (event: { method: string; params?: unknown }) => void) { this.events.add(listener); return () => { this.events.delete(listener); }; }
  onStage() { return () => undefined; }
  onLog() { return () => undefined; }
  onConnected() { return () => undefined; }
  transport() { return this.connected() ? "direct" as const : null; }
  reassemblesFragments() { return Promise.resolve(true); }
  restart() {}
  retryNow() {}
  reportError() {}
}

// ---- The app state ----

const STAGE: Record<Scenario, ConnectionStage> = {
  connected: "connected", updating: "connected", "slow-refresh": "connected",
  connecting: "connecting", waiting: "connecting", offline: "connecting", held: "disconnected-on-mac",
};
const trying = scenario === "connecting" || scenario === "waiting" || scenario === "offline";

/**
 * The private beta's access code (25.08, PRO-551). With `fixtureAccessCode: <answer>`
 * the phone starts signed out with no machines; Sign in is held at the beta (after
 * a few seconds of "Signing in…", so the wait can be shot), and every code is
 * sent through the app's own `redeemAccessCode` to a server in memory that answers
 * as the argument says, as the server's contract (PRO-550) words it:
 * `accepted`, `invalid`, `expired`, `exhausted`, `rate-limited`, `ended` (the
 * ticket is gone) or `error` (a server error). `fixtureAccessEmail` is the address
 * the sign-in is for. The ticket is a placeholder, never a real one.
 */
const ACCESS_ANSWERS: Record<string, { status: number; body: Record<string, unknown> }> = {
  accepted: { status: 200, body: { status: "accepted" } },
  invalid: { status: 404, body: { error: "invalid" } },
  expired: { status: 410, body: { error: "expired" } },
  exhausted: { status: 409, body: { error: "exhausted" } },
  "rate-limited": { status: 429, body: { error: "rate_limited", retryAfter: 30 } },
  ended: { status: 401, body: { error: "invalid_grant" } },
  error: { status: 500, body: { error: "server_error" } },
};
const accessAsked = Settings.get("fixtureAccessCode");
const accessAnswer = typeof accessAsked === "string" && accessAsked in ACCESS_ANSWERS ? ACCESS_ANSWERS[accessAsked]! : null;
const accessEmailAsked = Settings.get("fixtureAccessEmail");
const ACCESS_EMAIL = typeof accessEmailAsked === "string" && accessEmailAsked.includes("@") ? accessEmailAsked : "alex@example.com";
const SIGNED_IN: CloudSession = { accessToken: "fixture", refreshToken: "fixture", expiresAt: now + DAY * 60_000, user: { userId: "fixture", email: "alex@example.com", displayName: "Alex" } };
/** The redeem route, in memory: it answers after a moment, so "Checking the code…" can be shot. */
const accessServer: typeof fetch = async () => {
  await pause(3_000);
  const answer = accessAnswer!;
  const body = answer.status === 200 ? { ...answer.body, ...SIGNED_IN, user: { ...SIGNED_IN.user, email: ACCESS_EMAIL } } : answer.body;
  return new Response(JSON.stringify(body), { status: answer.status, headers: { "content-type": "application/json" } });
};

type Value = Record<string, unknown>;
const AppContext = createContext<Value | null>(null);

export function AppProvider({ children }: PropsWithChildren) {
  const connected = STAGE[scenario] === "connected";
  const connection = useMemo(() => new FixtureConnection(() => connected), [connected]);
  const api = useMemo(() => new HostApi(connection as unknown as HostConnection), [connection]);
  const [ready, setReady] = useState(false);
  const [hosts, setHosts] = useState(accessAnswer ? [] : HOSTS);
  const [session, setSession] = useState<CloudSession | null>(accessAnswer ? null : SIGNED_IN);
  const [signingIn, setSigningIn] = useState(false);
  const [accessCode, setAccessCode] = useState<AccessCodeRequest | null>(null);
  const ticket = useRef<string | null>(null);
  const holds = useRef(0);
  const signIn = useCallback(async () => {
    if (!accessAnswer) return;
    setSigningIn(true);
    await pause(4_000);
    ticket.current = "cah_fixture.placeholder";
    setAccessCode({ id: ++holds.current, email: ACCESS_EMAIL });
    setSigningIn(false);
  }, []);
  const redeem = useCallback(async (code: string): Promise<AccessCodeAnswer> => {
    if (!ticket.current) return { status: "ticket_dead" };
    const outcome = await redeemAccessCode(AUTH_CONFIG, { ticket: ticket.current }, code, accessServer);
    if (outcome.status === "accepted") { ticket.current = null; setSession(outcome.session); return { status: "accepted" }; }
    if (outcome.status === "ticket_dead") ticket.current = null;
    return outcome;
  }, []);
  const [prefs, setPrefs] = useState<Record<string, { customName?: string; hidden?: boolean }>>({});
  // "waiting" began trying long enough ago for the app's own clock to say so; the other
  // states keep no start, so a capture that takes more than 15 s still shows them.
  const [since] = useState(() => scenario === "waiting" ? Date.now() - WAITING_AFTER_MS - 1_000 : null);
  const connectionWaiting = useWaited(since);
  const updates = useRef(0);
  const [updating, setUpdating] = useState(false);
  const beginUpdate = useCallback(() => {
    updates.current++;
    setUpdating(true);
    let ended = false;
    return () => { if (ended) return; ended = true; if (--updates.current === 0) setUpdating(false); };
  }, []);
  // What the phone saved from earlier visits: shown at once while it connects.
  useEffect(() => {
    void Promise.all([
      ...Object.entries(CONVERSATIONS).map(([tabId, events]) => writeCache(studio.id, "review", tabId, { events, hasEarlier: false })),
      // Saved as from an earlier connection, as SessionControls saves them: the composer's row stands while it connects (#983).
      writeSaved(studio.id, "features", FEATURES, cacheEpoch(studio.id)),
      writeSaved(studio.id, "models", MODELS, cacheEpoch(studio.id)),
      ...Object.keys(CONVERSATIONS).map((tabId) => writeSaved(studio.id, `tab:${JSON.stringify(["review", tabId])}`, TAB, cacheEpoch(studio.id))),
      seedNotifications(),
      // The paired machines' list as a real phone keeps it, so what reads the store (a notification's machine name) finds them.
      // Only the list: the fixture's ad hoc build has no keychain for the credentials beside it.
      AsyncStorage.setItem(HOSTS_KEY, JSON.stringify(HOSTS)),
    ]).then(() => setReady(true));
  }, []);
  // On connecting, as the app does: catch up on what the Mac sent while away, then subscribe.
  useEffect(() => {
    if (!ready || !connected) return;
    // A lock-screen capture starts from an empty Notification Center, not the last capture's.
    void (lockScreen ? Notifications.dismissAllNotificationsAsync() : Promise.resolve()).then(() => restoreLocalNotifications(connection as unknown as HostConnection, studio.id));
  }, [ready, connected, connection]);
  const refreshSessions = useCallback(async () => { if (scenario === "slow-refresh") await pause(6_000); }, []);
  const value: Value = {
    ready, session,
    hosts, accountHosts: ACCOUNT, availableHosts: ACCOUNT.filter((host) => !hosts.some((stored) => stored.publicKeyB64 === host.hostPublicKeyB64)), accountMachinePrefs: prefs,
    installationState: "ready", activeHost: hosts.find((host) => host.id === studio.id) ?? null,
    connectionStage: STAGE[scenario], connectionAttempt: trying ? 1 : 0, connectionEpoch: 1, connectionSince: since, connectionWaiting,
    online: scenario !== "offline", updating, beginUpdate, retryConnection: () => undefined,
    sessions: SESSIONS, loadingMachines: false, error: null, logs: [], pairingProgress: null,
    connection, api,
    signIn, signingIn, accessCode, redeemAccessCode: redeem,
    cancelAccessCode: () => { ticket.current = null; setAccessCode(null); },
    finishAccessCode: () => setAccessCode(null),
    signOut: async () => undefined, refreshMachines: async () => { await pause(1_500); }, pairAvailable: async () => undefined, pairCode: async () => undefined, retryPairing: async () => undefined,
    connectHost: async () => true, disconnectHost: () => undefined,
    forgetHost: async (id: string) => setHosts((current) => current.filter((host) => host.id !== id)),
    renameHost: async (id: string, name: string) => setHosts((current) => current.map((host) => host.id === id ? { ...host, customName: name.trim() || undefined } : host)),
    reconnectHost: async () => undefined,
    renameAccountMachine: async (id: string, name: string) => setPrefs((current) => ({ ...current, [id]: { ...current[id], customName: name.trim() || undefined } })),
    hideAccountMachine: async (id: string, hidden: boolean) => setPrefs((current) => ({ ...current, [id]: { ...current[id], hidden } })),
    refreshSessions, clearError: () => undefined,
  };
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

// The fixture's state is fixed by its scenario; the production type is the screens' contract.
export function useApp() { return useContext(AppContext) as never; }
