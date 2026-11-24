/**
 * The phone fixture's cloud (22.06): the real CloudCatalog and CloudApi, as
 * `src/cloud/CloudProvider.tsx` makes them, with only `fetch` answered here
 * by an in-memory server. It holds placeholder organizations and workspaces,
 * and one stopped workspace's conversation, sealed with the app's own crypto
 * exactly as the runtime seals a checkpoint. The real key store and checkpoint
 * reader open it on the phone.
 *
 * `fixtureCloud: loading` (a launch argument) holds the first read of the
 * list, so the Cloud tab shows what it draws while the list is read.
 * `fixtureCloudRole: driver` makes this person a driver of "Warm-up run", so
 * its screen shows the composer (sending would start it) instead of Start.
 */
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type PropsWithChildren } from "react";
import { Settings } from "react-native";
import { gzipSync, strToU8 } from "fflate";
import type { AgentEvent, Payload } from "@terminalx/portable/events";
import { CloudApi } from "../../src/cloud/api";
import { CloudCatalog, type CatalogSnapshot, type CatalogStorage } from "../../src/cloud/catalog";
import { b64, CHECKPOINT_SCHEMA, checkpointAad, seal, sha256Hex, unb64 } from "../../src/cloud/crypto";
import { keyItemName, type SecretStorage } from "../../src/cloud/keys";
import { useApp } from "../../src/state/AppProvider";
import { LIVE_ID, liveAnswer, liveNow, liveRole, liveSocket } from "./live-workspace";
import { handle as launch } from "./setup/launch";
import { handle as organization } from "./setup/organization";
import type { SetupHandler } from "./setup/types";

/** The cloud setup areas (25.01–25.06), asked in this order before the answers below. */
const SETUP: readonly SetupHandler[] = [launch, organization];

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const ORIGIN = "https://cloud.fixture.invalid";
const KEY_ID = "fixture-key-1";
/** The workspace key: fixed bytes, as a placeholder; never a real one. */
const KEY = Uint8Array.from({ length: 32 }, (_, index) => (index * 37 + 11) % 256);

const ACME = "org-acme";
const NORTHWIND = "org-northwind";
const ORGS = [
  { orgId: ACME, name: "Acme", role: "admin" },
  { orgId: NORTHWIND, name: "Northwind", role: "member" },
  // Organizations with nothing in them fold into one row.
  ...["Globex", "Initech", "Umbrella", "Hooli", "Vandelay"].map((name) => ({ orgId: `org-${name.toLowerCase()}`, name, role: "member" })),
];

function workspace(orgId: string, id: string, name: string, state: string, idleMinutes: number, repository: string, branch: string, role: "manager" | "driver", activity: { activeTurns?: number; pendingApprovals?: number } = {}, provider = "machine0") {
  const now = Date.now();
  return {
    workspace: {
      id, orgId, name, provider, state, accessMode: "organization",
      you: { role, canApprove: true, canManageShares: role === "manager" },
      sharedWith: 0, createdBy: "fixture", lastActivityAt: now - idleMinutes * MINUTE,
      runtimeActivity: state === "ready" ? { online: true, activeTurns: activity.activeTurns ?? 0, pendingApprovals: activity.pendingApprovals ?? 0, reportedAt: now, stale: false } : null,
      repositories: [{ identity: repository, fullName: repository, primary: true }],
      launch: { workBranch: branch, sessionId: `${id}-session`, tabId: `${id}-tab`, phase: "ready" },
    },
    latestOperation: null,
  };
}

const WORKSPACES: Record<string, ReturnType<typeof workspace>[]> = {
  [ACME]: [
    workspace(ACME, "ws-checkout", "Checkout redesign", "ready", 0, "acme/app", "checkout-redesign", "manager", { activeTurns: 1 }, "fixture-compute"),
    // `fixtureCloudRole: driver` (a launch argument): its saved conversation with the composer a driver keeps, in place of Start.
    workspace(ACME, "ws-warm-up", "Warm-up run", "suspended", 2 * 24 * 60, "acme/app", "warm-up", Settings.get("fixtureCloudRole") === "driver" ? "driver" : "manager", {}, "fixture-compute"),
    workspace(ACME, "ws-warm-up-five", "Warm-up run, five issues", "suspended", 3 * 24 * 60, "acme/app", "warm-up-five", "manager"),
    // 25.10: running, and connected to over the fixture's own runtime (`live-workspace.ts`).
    workspace(ACME, LIVE_ID, "Search filters", "ready", 4, "acme/app", "search-filters", liveRole(), {}, "fixture-compute"),
  ],
  [NORTHWIND]: [workspace(NORTHWIND, "ws-billing", "Billing export", "ready", 6, "northwind/api", "billing-export", "driver", { pendingApprovals: 1 })],
};

/** The stopped "Warm-up run": a reply, the reader's question, and two commands, as 22.06 draws it. */
function conversation(sessionId: string, tabId: string): AgentEvent[] {
  let seq = 0;
  const at = (minutes: number) => new Date(Date.now() - 2 * DAY - minutes * MINUTE).toISOString();
  const event = (minutes: number, payload: Payload): AgentEvent => ({ id: `${tabId}-${++seq}`, sessionId, tabId, harness: "claude", seq, ts: at(minutes), messageTs: at(minutes), payload });
  const call = (minutes: number, callId: string, title: string, command: string): AgentEvent[] => [
    event(minutes, { type: "tool_call_started", callId, name: "Bash", toolType: "shell", title, input: { command, description: title } }),
    event(minutes, { type: "tool_call_completed", callId, result: { text: "ok", isError: false, exitCode: 0 } }),
  ];
  return [
    event(9, { type: "user_message", text: "Fix the review comments and push.", queued: false }),
    event(9, { type: "turn_started", model: "claude-opus-5-5" }),
    event(6, { type: "assistant_text", text: "The review is fixed and pushed. Two checks are still running; I will merge when they pass." }),
    event(6, { type: "turn_completed", status: "ok", authFailed: false, durationMs: 180_000 }),
    event(3, { type: "user_message", text: "What's the latest status?", queued: false }),
    event(3, { type: "turn_started", model: "claude-opus-5-5" }),
    ...call(2, "c1", "Check each ticket's state", "for p in PRO-341 PRO-128; do tx issue view \"$p\" --json state; done"),
    ...call(2, "c2", "Read the last lines of the task log", "tail -6 tasks/build.log"),
    event(1, { type: "turn_completed", status: "aborted", authFailed: false, durationMs: 120_000 }),
  ];
}

/** A checkpoint as `cloud_agents/checkpoints.rs` writes one: gzip, then AES-256-GCM bound to where it belongs. */
function checkpoint(orgId: string, workspaceId: string, tabId: string) {
  const meta = { tabId, epoch: 1, version: 1, schemaVersion: CHECKPOINT_SCHEMA, keyId: KEY_ID };
  const sessionId = `${workspaceId}-session`;
  const events = conversation(sessionId, tabId);
  const body = { v: 1, sessionId, tabId, title: "Warm-up run", harness: "claude", status: "idle", lastSeq: events.length, events, truncated: false, pendingPermissions: [], session: { title: "Warm-up run", branch: "warm-up" } };
  const iv = Uint8Array.from({ length: 12 }, (_, index) => index + 1);
  const sealed = seal(KEY, iv, gzipSync(strToU8(JSON.stringify(body))), checkpointAad(orgId, workspaceId, tabId, meta.epoch, meta.version, meta.schemaVersion, meta.keyId));
  return { ...meta, ...sealed, sha256: sha256Hex(unb64(sealed.ciphertext)) };
}

const never = new Promise<never>(() => undefined);

/** The cloud service, answered in memory: the requests the list and a stopped workspace make. */
function server(holdList: boolean): typeof fetch {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", date: new Date().toUTCString() } });
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname;
    const argument = (name: string) => { const value: unknown = Settings.get(name); return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : undefined; };
    const sent = typeof init?.body === "string" ? init.body : null;
    let body: unknown = null;
    try { body = sent ? JSON.parse(sent) : null; } catch { body = null; }
    const live = liveAnswer((init?.method ?? "GET").toUpperCase(), path, body, json);
    if (live) return live;
    // `fixtureResume: hold` keeps a start under way; `fail` has the provider not answering (25.10's "did not start").
    if (/\/resume$/.test(path) && argument("fixtureResume") === "hold") await never;
    if (/\/resume$/.test(path) && argument("fixtureResume") === "fail") return json(503, { error: "cloud_provider_unavailable" });
    for (const area of SETUP) {
      const answer = await area({ method: (init?.method ?? "GET").toUpperCase(), path, query: url.searchParams, headers: new Headers(init?.headers), body, argument, json });
      if (answer) return answer;
    }
    if (path === "/v1/desktop/auth/capabilities") {
      if (holdList) await never;
      return json(200, { organizations: ORGS, capabilities: { flags: {} } });
    }
    const list = /^\/v1\/mobile\/orgs\/([^/]+)\/cloud-workspaces$/.exec(path);
    if (list) {
      const headers = new Headers(init?.headers);
      const providers = headers.get("X-TerminalX-Cloud-Workspace-Contract") === "providers-v1"
        ? (headers.get("X-TerminalX-Cloud-Workspace-Providers") ?? "").split(",").map((value) => value.trim())
        : ["machine0"];
      const rows = WORKSPACES[decodeURIComponent(list[1]!)] ?? [];
      const workspaces = providers.includes("described") ? rows : rows.filter(({ workspace }) => providers.includes(workspace.provider));
      return json(200, { workspaces, tombstones: [] });
    }
    const match = /^\/v1\/mobile\/orgs\/([^/]+)\/cloud-workspaces\/([^/]+)\/transcript-checkpoints(?:\/([^/]+))?$/.exec(path);
    if (match) {
      const [orgId, workspaceId, tabId] = [decodeURIComponent(match[1]!), decodeURIComponent(match[2]!), match[3] ? decodeURIComponent(match[3]) : null];
      // Only "Warm-up run" said anything before it stopped.
      const saved = workspaceId === "ws-warm-up" ? checkpoint(orgId, workspaceId, `${workspaceId}-tab`) : null;
      if (tabId === null) return json(200, { checkpoints: saved ? [{ tabId: saved.tabId, epoch: saved.epoch, version: saved.version, schemaVersion: saved.schemaVersion, keyId: saved.keyId, sha256: saved.sha256 }] : [] });
      return json(200, { checkpoint: saved && saved.tabId === tabId ? saved : null });
    }
    if (/\/agent-commands$/.test(path)) return json(200, { commands: [] });
    if (/\/members$/.test(path)) return json(200, { members: [] });
    if (/\/shares$/.test(path)) return json(200, { shares: [], you: { role: "manager", canApprove: true, canManageShares: true } });
    // Anything else (attaching to a running workspace, starting one) is not part of the fixture.
    return json(404, { error: "cloud_workspace_not_found" });
  };
}

function memory(): CatalogStorage & SecretStorage {
  const items = new Map<string, string>();
  return {
    getItem: async (name) => items.get(name) ?? null,
    setItem: async (name, value) => void items.set(name, value),
    removeItem: async (name) => void items.delete(name),
    getAllKeys: async () => [...items.keys()],
    get: async (name) => items.get(name) ?? null,
    set: async (name, value) => void items.set(name, value),
    delete: async (name) => void items.delete(name),
  };
}

const EMPTY: CatalogSnapshot = { organizations: [], loading: false, error: null, refreshedAt: null, saved: false, titles: {} };
const CloudContext = createContext<CloudCatalog | null>(null);

export function CloudProvider({ children }: PropsWithChildren) {
  const app = useApp();
  const userId = app.session?.user.userId ?? null;
  const [catalog, setCatalog] = useState<CloudCatalog | null>(null);
  useEffect(() => {
    if (!app.ready || !userId) return;
    let made: CloudCatalog | null = null;
    let current = true;
    void (async () => {
      const secrets = memory();
      // This phone has been connected to "Warm-up run" before, so it holds the workspace's key, as the keychain would.
      const held = { v: 1, currentKeyId: KEY_ID, keys: [{ keyId: KEY_ID, key: b64(KEY), createdAt: Date.now() - 30 * DAY, retiredAt: null }] };
      await secrets.set(keyItemName({ organizationId: ACME, workspaceId: "ws-warm-up" }), JSON.stringify(held));
      if (!current) return;
      const api = new CloudApi({ origin: ORIGIN, accessToken: async () => "fixture", fetch: server(Settings.get("fixtureCloud") === "loading") });
      // The phone has been connected to "Search filters" before too.
      await secrets.set(keyItemName({ organizationId: ACME, workspaceId: LIVE_ID }), JSON.stringify(held));
      made = new CloudCatalog({ api, secrets, storage: memory(), clientInstallationId: "mobile-fixture", appVersion: "fixture", link: { createSocket: liveSocket(KEY), now: liveNow } });
      setCatalog(made);
      void made.refresh();
    })();
    return () => { current = false; setCatalog(null); made?.close(); };
  }, [app.ready, userId]);
  return <CloudContext.Provider value={catalog}>{children}</CloudContext.Provider>;
}

export function useCloudCatalog(): CloudCatalog | null {
  return useContext(CloudContext);
}

const noop = () => () => undefined;
export function useCatalogSnapshot(catalog: CloudCatalog | null): CatalogSnapshot {
  return useSyncExternalStore(catalog?.subscribe ?? noop, catalog?.getSnapshot ?? (() => EMPTY), catalog?.getSnapshot ?? (() => EMPTY));
}
