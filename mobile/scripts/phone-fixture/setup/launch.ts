import { boat, boatQuote, boatSetup, claudeKey, codexLogin, operation, workspace } from "../../../src/cloud/testing/server";
import type { SetupHandler } from "./types";

/**
 * A launch with a first task (25.09), answered in memory. `fixtureLaunch:
 * <outcome>` gives Northwind (an owner's organization) a connected Boat and
 * two agent logins, and answers the form, the price and the launch. The
 * launch then moves on by the clock, as the server's operation and the
 * runtime's report would, and ends as `<outcome>` says:
 *
 * | `fixtureLaunch` | How the launch ends |
 * | --- | --- |
 * | `running` | The agent runs the task, in tab `tab-first-task` |
 * | `sign-in` | The agent's login failed (`agent-sign-in-required`) |
 * | `unsure` | The runtime could not tell whether the prompt arrived (`prompt-send-failed`) |
 * | `not-picked-up` | The runtime never claims the task |
 * | `hold` | Every phase holds 10 s, so each one can be shown |
 *
 * Cancel launch is answered too: the launch ends canceled.
 */

const ORG = "org-northwind";
const STEP_MS = 4_000;
const SLOW_STEP_MS = 10_000;
const NORTHWIND = { orgId: ORG, name: "Northwind", role: "owner" };

interface Held { createdAt: number; prompt: boolean; agent: string; mode?: string; canceledAt: number | null; name: string }
let held: Held | null = null;

/** The launch's operation, intent and workspace `elapsed` ms after it was asked for. */
function lifecycle(outcome: string, now: number) {
  const launch = held!;
  const step = outcome === "hold" ? SLOW_STEP_MS : STEP_MS;
  const at = (n: number) => launch.createdAt + n * step;
  const phase = Math.floor((now - launch.createdAt) / step);
  const timings: Record<string, number> = { requestedAt: launch.createdAt };
  const base = { launchId: "launch-first-task", workBranch: null, agent: launch.agent, ...(launch.mode ? { mode: launch.mode } : {}), hasPrompt: launch.prompt };
  const ws = (state: string, more: Record<string, unknown>) => workspace({ id: "ws-first-task", orgId: ORG, name: launch.name, state, launch: { ...base, timings, ...more } });
  if (launch.canceledAt) {
    return { workspace: ws("destroyed", { phase: "canceled", state: "canceled" }), operation: operation({ id: "op-first-task", workspaceId: "ws-first-task", state: "canceled", stage: "cleanup", cancelable: false, updatedAt: launch.canceledAt }) };
  }
  // The machine: queued, then creating it, then installing the runtime.
  if (phase < 2) return { workspace: ws("provisioning", { phase: "allocating", state: "pending" }), operation: operation({ id: "op-first-task", workspaceId: "ws-first-task", state: phase ? "running" : "queued", stage: phase ? "creating-machine" : "queued", cancelable: true, updatedAt: now }) };
  timings.bootingAt = at(2);
  if (phase < 3) return { workspace: ws("provisioning", { phase: "booting", state: "pending" }), operation: operation({ id: "op-first-task", workspaceId: "ws-first-task", state: "running", stage: "bootstrapping", cancelable: false, updatedAt: now, events: [{ code: "credentials-installing", occurredAt: now }] }) };
  timings.authenticatingAt = at(3);
  const ready = operation({ id: "op-first-task", workspaceId: "ws-first-task", state: "succeeded", stage: "ready", cancelable: false, updatedAt: at(3) });
  if (phase < 4 || outcome === "not-picked-up") return { workspace: ws("ready", { phase: "authenticating-runtime", state: "pending" }), operation: ready };
  timings.syncingAt = at(4);
  if (phase < 5) return { workspace: ws("ready", { phase: "syncing-repository", state: "claimed" }), operation: ready };
  timings.startingAgentAt = at(5);
  if (phase < 6) return { workspace: ws("ready", { phase: "starting-agent", state: "claimed" }), operation: ready };
  if (outcome === "sign-in") return { workspace: ws("ready", { phase: "failed", state: "failed", category: "agent-sign-in-required", timings: { ...timings, failedAt: at(6) } }), operation: ready };
  if (outcome === "unsure") return { workspace: ws("ready", { phase: "failed", state: "outcome-unknown", category: "prompt-send-failed", tabId: "tab-first-task", timings: { ...timings, failedAt: at(6) } }), operation: ready };
  return { workspace: ws("ready", { phase: "running", state: "started", sessionId: "session-first-task", tabId: "tab-first-task", timings: { ...timings, runningAt: at(6) } }), operation: ready };
}

export const handle: SetupHandler = ({ method, path, body, argument, json }) => {
  const outcome = argument("fixtureLaunch");
  if (!outcome) return undefined;
  if (path === "/v1/desktop/auth/capabilities") return json(200, { organizations: [NORTHWIND], capabilities: { flags: {} } });
  const scoped = new RegExp(`^/v1/mobile/orgs/${ORG}(/.*)$`).exec(path);
  if (!scoped) return undefined;
  const route = scoped[1]!;
  const now = Date.now();
  if (route === "/cloud-providers") return json(200, { providers: [boat] });
  if (route === "/cloud-workspace-credentials") return json(200, { credentials: [codexLogin, claudeKey] });
  if (route.startsWith("/cloud-workspaces/setup")) return json(200, boatSetup);
  if (route === "/cloud-workspaces/preflight") return json(200, { version: 1, ready: true, checks: [] });
  if (route === "/cloud-workspaces/quote") return json(200, boatQuote(now + 10 * 60_000));
  if (route === "/cloud-workspaces" && method === "POST") {
    const asked = body as { name?: string; launch?: { agent: string; mode?: string; prompt?: string } };
    held = { createdAt: now, name: asked.name ?? "Workspace", prompt: !!asked.launch?.prompt, agent: asked.launch?.agent ?? "claude", ...(asked.launch?.mode ? { mode: asked.launch.mode } : {}), canceledAt: null };
    return json(202, lifecycle(outcome, now));
  }
  if (route === "/cloud-workspaces") {
    if (!held) return json(200, { workspaces: [], tombstones: [] });
    const life = lifecycle(outcome, now);
    return json(200, { workspaces: life.workspace.state === "destroyed" ? [] : [{ workspace: life.workspace, latestOperation: life.operation }], tombstones: [] });
  }
  if (route === "/cloud-workspace-operations/op-first-task/cancel" && held) { held.canceledAt = now; return json(200, lifecycle(outcome, now)); }
  if (route === "/cloud-workspace-operations/op-first-task" && held) return json(200, lifecycle(outcome, now));
  return undefined;
};
