import { agent37, agent37Setup, boat, boatQuote, boatSetup, claudeKey, codexLogin, operation, workspace } from "../../../src/cloud/testing/server";
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
 *
 * `fixtureLaunchAccount: several` puts a personal organization with nothing
 * connected before Northwind, as an account that set up its team's
 * organization has them. `fixtureLaunchProvider: agent37` connects Agent37 in
 * place of Boat: its sizes are named by their machine, with a rate.
 */

const ORG = "org-northwind";
const STEP_MS = 4_000;
const SLOW_STEP_MS = 10_000;
const NORTHWIND = { orgId: ORG, name: "Northwind", role: "owner" };
const PERSONAL = { orgId: "org-personal", name: "Personal (alex@example.com)", role: "owner", isPersonal: true };
// Agent37's sizes as its catalog writes them (terminalx-saas `agent37Catalog.ts`, `shapeLabel`), with their hourly rate.
const AGENT37_SIZES = [{ id: "2x4", label: "2 vCPU · 4 GB RAM · 20 GB disk", vcpu: 2, memoryMiB: 4096, diskGiB: 20, activeHourlyMicros: 14_000 }, { id: "4x8", label: "4 vCPU · 8 GB RAM · 40 GB disk", vcpu: 4, memoryMiB: 8192, diskGiB: 40, activeHourlyMicros: 28_000 }];
const AGENT37_SETUP = { ...agent37Setup, machineClasses: AGENT37_SIZES };

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
  const several = argument("fixtureLaunchAccount") === "several";
  const onAgent37 = argument("fixtureLaunchProvider") === "agent37";
  if (path === "/v1/desktop/auth/capabilities") return json(200, { organizations: several ? [PERSONAL, NORTHWIND] : [NORTHWIND], capabilities: { flags: {} } });
  // The personal organization: every provider still to connect, no login, no workspace.
  const own = several ? new RegExp(`^/v1/mobile/orgs/${PERSONAL.orgId}/(cloud-providers|cloud-workspace-credentials|cloud-workspaces)$`).exec(path) : null;
  if (own && method === "GET") {
    const offered = ({ connection: _connection, ...provider }: typeof boat) => ({ ...provider, availability: "not-connected" });
    return json(200, own[1] === "cloud-providers" ? { providers: [offered(boat), offered(agent37)] } : own[1] === "cloud-workspace-credentials" ? { credentials: [] } : { workspaces: [], tombstones: [] });
  }
  const scoped = new RegExp(`^/v1/mobile/orgs/${ORG}(/.*)$`).exec(path);
  if (!scoped) return undefined;
  const route = scoped[1]!;
  const now = Date.now();
  if (route === "/cloud-providers") return json(200, { providers: [onAgent37 ? agent37 : boat] });
  if (route === "/cloud-workspace-credentials") return json(200, { credentials: [codexLogin, claudeKey] });
  if (route.startsWith("/cloud-workspaces/setup")) return json(200, onAgent37 ? AGENT37_SETUP : boatSetup);
  if (route === "/cloud-workspaces/preflight") return json(200, { version: 1, ready: true, checks: [] });
  if (route === "/cloud-workspaces/quote") {
    if (!onAgent37) return json(200, boatQuote(now + 10 * 60_000));
    const asked = body as { machineClassId?: string; locationId?: string; idleSuspendMinutes?: number };
    const size = AGENT37_SIZES.find((entry) => entry.id === asked.machineClassId) ?? AGENT37_SIZES[0]!;
    const place = agent37Setup.locations.find((entry) => entry.id === asked.locationId) ?? agent37Setup.locations[0]!;
    return json(200, boatQuote(now + 10 * 60_000, { provider: "agent37", activeHourlyMicros: size.activeHourlyMicros, alwaysOnThirtyDayMicros: size.activeHourlyMicros * 720,
      configuration: { ...agent37Setup.defaults, machineClassId: size.id, locationId: place.id, idleSuspendMinutes: asked.idleSuspendMinutes ?? agent37Setup.defaults.idleSuspendMinutes, sourceLabel: "Base image", locationLabel: place.label, machineClassLabel: size.label, vcpu: size.vcpu, memoryMiB: size.memoryMiB, diskGiB: size.diskGiB, architecture: "x86_64" } }));
  }
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
