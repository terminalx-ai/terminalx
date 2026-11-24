/**
 * A running workspace for 25.10 (PRO-548): the phone's real catalog, link,
 * session and outbox connect to a workspace runtime that answers here, over
 * the real encrypted handshake and frames (`src/cloud/fake-runtime.ts`).
 * Only "Search filters" in Acme runs; every other workspace stays as 22.06
 * draws it.
 *
 * `fixtureStart` (a launch argument) picks what the runtime says:
 *
 * | value | what the phone sees |
 * | --- | --- |
 * | (none) | a manager the runtime lets start agents; no conversation yet |
 * | `tab` | the same, with one conversation (for Add agent tab) |
 * | `other` | a driver: told who can start one |
 * | `old` | a runtime from before PRO-546 (no `canStart`) |
 * | `unread` | `runtime.agents` is refused |
 * | `no-answer` | `session.create` and `session.addTab` never answer |
 * | `refused` | `session.create` is refused for the role |
 * | `prompt-failed` | the conversation starts, its first message does not reach the agent |
 * | `gone` | one conversation, closed elsewhere right after a message is sent to it |
 */
import { Settings } from "react-native";
import type { AgentEvent } from "@terminalx/portable/events";
import { b64 } from "../../src/cloud/crypto";
import { NOW, pairingCode, Refusal, relayHostId, Runtime, SILENT } from "../../src/cloud/fake-runtime";

export const LIVE_ID = "ws-search";
const scenario = () => {
  const value: unknown = Settings.get("fixtureStart");
  return typeof value === "string" ? value : "";
};

/** The list's row for it: running, with this person as its manager (or a driver for `other`). */
export const liveRole = (): "manager" | "driver" => (scenario() === "other" ? "driver" : "manager");

type Tab = { sessionId: string; tabId: string; title: string | null; harness: string; status: string; pendingPermissions: unknown[]; events: AgentEvent[] };
const tabs: Tab[] = [];
let runtime: Runtime | null = null;
let seeded = false;

const AGENTS = [
  {
    id: "claude", name: "Claude Code", caps: {}, defaultMode: "bypassPermissions", signIn: "signedIn", modes: ["plan", "manual", "auto", "acceptEdits", "bypassPermissions"],
    models: [
      { id: "opus", label: "Opus", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high", isDefault: true, alias: true },
      { id: "sonnet", label: "Sonnet", efforts: ["low", "medium", "high"], defaultEffort: "medium", isDefault: false, alias: true },
    ],
  },
  { id: "codex", name: "Codex", caps: {}, defaultMode: "bypassPermissions", modes: [], models: [] },
  { id: "gemini", name: "Gemini CLI", caps: {}, defaultMode: "bypassPermissions", signIn: "signedOut", modes: ["manual"], models: [] },
];

function event(tab: Tab, payload: AgentEvent["payload"]): AgentEvent {
  const seq = tab.events.length + 1;
  const ts = new Date().toISOString();
  return { id: `${tab.tabId}-${seq}`, sessionId: tab.sessionId, tabId: tab.tabId, harness: tab.harness, seq, ts, messageTs: ts, payload };
}

function seed() {
  if (seeded) return;
  seeded = true;
  if (scenario() !== "tab" && scenario() !== "gone") return;
  const tab: Tab = { sessionId: "s-search", tabId: "t-search", title: "Add the price filter", harness: "claude", status: "idle", pendingPermissions: [], events: [] };
  tab.events.push(event(tab, { type: "user_message", text: "Add the price filter to the search page.", queued: false }));
  tab.events.push(event(tab, { type: "turn_started", model: "opus" }));
  tab.events.push(event(tab, { type: "assistant_text", text: "The price filter is in, with a test for the empty range. Want me to open the pull request?" }));
  tab.events.push(event(tab, { type: "turn_completed", status: "ok", authFailed: false, durationMs: 90_000 }));
  tabs.push(tab);
}

const info = (tab: Tab) => ({ sessionId: tab.sessionId, tabId: tab.tabId, title: tab.title, harness: tab.harness, status: tab.status, pendingPermissions: tab.pendingPermissions });
const announce = () => runtime?.encrypted({ event: "session.tabs", params: { tabs: tabs.map(info) } });

/** Makes the connection's socket: one runtime, answering as `fixtureStart` says. */
export function liveSocket(key: Uint8Array) {
  return (url: string) => {
    seed();
    const made = new Runtime();
    runtime = made;
    made.url = url;
    const state = scenario();
    made.you = state === "old" ? { userId: "u-me", role: "manager", canApprove: true } : { userId: "u-me", role: liveRole(), canApprove: true, canStart: liveRole() === "manager", listed: true };
    // A runtime without sharing: presence and notes stay out of these boards.
    made.withheld = ["collab/1"];
    const silent = state === "no-answer";
    made.methods = {
      "keys.get": () => ({ currentKeyId: "fixture-key-1", keys: [{ keyId: "fixture-key-1", key: b64(key), createdAt: NOW - 86_400_000, retiredAt: null }] }),
      "session.tabs": () => ({ tabs: tabs.map(info) }),
      "session.subscribe": (params) => {
        const tab = tabs.find((entry) => entry.tabId === params.tabId);
        return { subscriptionId: `sub-${String(params.tabId)}`, events: (tab?.events ?? []).map((entry) => ({ cursor: `c${entry.seq}`, event: entry })), cursor: `c${tab?.events.length ?? 0}` };
      },
      "session.unsubscribe": () => ({}),
      "session.nudge": () => ({}),
      "runtime.agents": () => (state === "unread" ? new Refusal("unavailable", "agents could not be read") : { agents: AGENTS }),
      "session.create": (params) => {
        if (silent) return SILENT;
        if (state === "refused") return new Refusal("forbidden", "session.create needs a workspace manager", { role: "driver" });
        const tab: Tab = { sessionId: `s-${tabs.length + 1}`, tabId: `t-${tabs.length + 1}`, title: typeof params.title === "string" ? params.title : null, harness: String(params.agent), status: "in_progress", pendingPermissions: [], events: [] };
        if (typeof params.prompt === "string") tab.events.push(event(tab, { type: "user_message", text: params.prompt, queued: false }));
        if (state === "prompt-failed") tab.status = "idle";
        else tab.events.push(event(tab, { type: "turn_started", model: typeof params.model === "string" ? params.model : undefined }));
        tabs.push(tab);
        setTimeout(announce, 50);
        return { sessionId: tab.sessionId, tabId: tab.tabId, tab: info(tab), startError: state === "prompt-failed" ? "The session was created, but its first prompt could not be sent: the agent exited" : null };
      },
      "session.addTab": (params) => {
        if (silent) return SILENT;
        const tab: Tab = { sessionId: String(params.sessionId), tabId: `t-${tabs.length + 1}`, title: null, harness: String(params.agent), status: "idle", pendingPermissions: [], events: [] };
        tabs.push(tab);
        setTimeout(announce, 50);
        return { sessionId: tab.sessionId, tabId: tab.tabId, tab: info(tab) };
      },
    };
    queueMicrotask(() => made.onopen?.());
    return made as never;
  };
}

/** The clock the link reads: the fake runtime's, so its tickets and leases are current. */
export const liveNow = () => NOW;

type Json = (status: number, body: unknown) => Response;
const commands = new Map<string, Record<string, unknown>>();

/** The service's side of the running workspace: the attachment, and the mailbox a message goes through. */
export function liveAnswer(method: string, path: string, body: unknown, json: Json): Response | null {
  const base = `/v1/mobile/orgs/org-acme/cloud-workspaces/${LIVE_ID}`;
  if (method === "POST" && path === `${base}/open`) {
    const relay = { v: 1, directorUrl: "https://relay.fixture.invalid", cellUrl: "https://cell.fixture.invalid", assignmentEpoch: 1, relayHostId, inviteToken: "i".repeat(43), inviteExpiresAt: NOW + 5 * 60_000, e2eeFraming: 2 };
    return json(200, { id: "attach-1", workspaceId: LIVE_ID, state: "ready", authority: "participate", expiresAt: NOW + 600_000, pairingCode: pairingCode({ relay }), attachTicket: { v: 1, token: "fixture-attach", expiresAt: NOW + 60_000, runtimeGeneration: 3, protocol: "terminalx-workspace-rpc/1" } });
  }
  if (method === "POST" && path === `${base}/agent-commands`) {
    const envelope = body as { clientCommandId: string; tabId: string; kind: string; keyId: string };
    const command = { clientCommandId: envelope.clientCommandId, tabId: envelope.tabId, kind: envelope.kind, state: "queued", keyId: envelope.keyId, createdAt: NOW, updatedAt: NOW };
    commands.set(envelope.clientCommandId, command);
    // `gone`: the conversation is closed elsewhere before the runtime takes the message, and its mailbox refuses it.
    if (scenario() === "gone") {
      setTimeout(() => {
        tabs.splice(0, tabs.length);
        announce();
        commands.set(envelope.clientCommandId, { ...command, state: "rejected", outcomeCategory: "tab-unknown", updatedAt: NOW + 1 });
      }, 400);
    }
    return json(200, { command, existing: false, wake: "not-needed" });
  }
  if (method === "POST" && path === `${base}/agent-commands/status`) {
    const ids = (body as { clientCommandIds?: string[] })?.clientCommandIds ?? [];
    return json(200, { commands: ids.flatMap((id) => (commands.has(id) ? [commands.get(id)] : [])) });
  }
  return null;
}
