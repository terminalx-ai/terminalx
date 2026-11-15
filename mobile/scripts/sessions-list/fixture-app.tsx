// Stands in for src/state/AppProvider.tsx in the Sessions list fixture only.
// Everything else is the production app. No pairing, account, network or
// private data: one Mac, connected, holding the sessions below.
import type { PropsWithChildren } from "react";
import type { SessionSummary } from "../../src/data/host-api";
import type { SessionStatusInput } from "@terminalx/portable/sessionStatus";

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const pr = (fields: Record<string, unknown>, branch: string) => ({ branch, branchStatus: { branch, checked: true, headMatches: true, pr: { number: 781, state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", checks: "SUCCESS", inMergeQueue: false, ...fields } } });
type Tab = { title: string; harness?: string; minutes: number; facts: SessionStatusInput["tabs"][number] };
function session(id: string, title: string, project: string, branch: string | null, minutes: number, tabs: Tab[], facts: Omit<SessionStatusInput, "tabs"> = {}, kind: "project" | "quick" = "project"): SessionSummary {
  return {
    id, title, project, branch, kind, worktree: branch ?? "scratch", modified: ago(minutes), issueRef: "PRO-986",
    tabs: tabs.map((tab, index) => ({ id: `${id}-${index}`, title: tab.title, harness: tab.harness ?? "claude", status: tab.facts.status, modified: ago(tab.minutes) })),
    rowStatus: { tabs: tabs.map((tab) => tab.facts), branch, ...facts },
  };
}

const sessions: SessionSummary[] = [
  session("question", "Mobile question card", "acme-app", "acme/979-mobile-answer", 2, [{ title: "Claude Code", minutes: 2, facts: { status: "waiting", activity: "needs_answer" } }]),
  session("approval", "Rust cleanup", "acme-api", "acme/rust-cleanup-session", 9, [{ title: "Codex", harness: "codex", minutes: 9, facts: { status: "waiting", activity: "needs_permission" } }]),
  session("review", "Review and merge", "acme-app", "main", 0, [
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

const host = { id: "studio", label: "Studio MacBook", hostName: "Studio MacBook", publicKeyB64: "fixture", endpoint: "fixture", lastConnectedAt: now, provenance: { kind: "explicit" as const } };
const quiet = async () => undefined;
const listen = () => () => undefined;
// The other tabs mount beside Sessions: a Mac that offers nothing beyond the session list.
const api = new Proxy({}, {
  get: (_, name) => typeof name !== "string" ? undefined
    : name.startsWith("on") ? listen
    : name === "features" ? async () => ({})
    : async () => { throw new Error("Not on the fixture's Mac"); },
});
const value = {
  ready: true, session: null, hosts: [host], availableHosts: [], installationState: "ready", activeHost: host,
  connectionStage: "connected", connectionAttempt: 0, connectionEpoch: 1, sessions, loadingMachines: false,
  connectionSince: null, connectionWaiting: false, online: true, updating: false, beginUpdate: () => () => undefined, retryConnection: () => undefined,
  error: null, logs: [], pairingProgress: null,
  connection: { onEvent: listen, onConnected: listen, onStage: listen, onLog: listen, restart: () => undefined, reportError: () => undefined, retryNow: () => undefined },
  api,
  signIn: quiet, signOut: quiet, refreshMachines: quiet, pairAvailable: quiet, pairCode: quiet, retryPairing: quiet,
  connectHost: async () => true, disconnectHost: () => undefined, forgetHost: quiet, renameHost: quiet, reconnectHost: quiet, refreshSessions: quiet, clearError: () => undefined,
};

export function AppProvider({ children }: PropsWithChildren) { return children; }
// The fixture's state is fixed; the production type is the screen's contract.
export function useApp() { return value as never; }
