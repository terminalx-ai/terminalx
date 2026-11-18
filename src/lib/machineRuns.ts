import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { MachineSessionActions, MachineSetupRun } from "@terminalx/portable/workspace";
import { browser as browserApi } from "@/lib/api";
import type { ActionRun } from "@/lib/actionRunner";
import { latestByAction } from "@/lib/actionRunner";
import { openBrowserPage } from "@/lib/browser";
import type { CloudSessionModel } from "@/lib/cloudSession";
import { cloudTerminalsOf, selectCloudTerminal, syncCloudTerminals, type CloudTerminal } from "@/lib/cloudTerminals";
import { showError } from "@/lib/errorToasts";
import { machineFeature, machineFeatureMessage } from "@/lib/machineFeatures";
import { forwardPort, forwardsBrowserWorkspace, portForwardsOf, usePortForwards } from "@/lib/portForwards";
import { setPrefs } from "@/lib/prefs";
import { visibleActions, type RepositoryAction, type RepositoryPreviewUrl } from "@/lib/repositoryActions";
import { dismissRestartOffer, offerRestart, previewTarget, type RunSource } from "@/components/session/RunMenu";
import { parseMachineKey } from "@/types/target";

/**
 * A machine session's Setup and Run (PRO-403, docs/MACHINES.md "As built
 * (PRO-403)"). Everything is the machine's: the project's saved actions,
 * preview URLs and setup script are read there (`machine.sessionActions`),
 * each run is a terminal of the session's runtime on the machine, in the
 * session's folder there, listed by `pty.list` with its `run`, and a
 * preview's $PORT is the machine's port, opened here only through a forward.
 * Nothing runs on this computer, and no path of the machine is opened here.
 */

export const MACHINE_RUNS = "machine/7";
/** How often a setup that is still going is read again: its status is not pushed. */
export const SETUP_POLL_MS = 2_000;

interface Entry {
  info: MachineSessionActions | null;
  error: string | null;
}

let entries: Record<string, Entry> = {};
const inflight = new Map<string, Promise<MachineSessionActions | null>>();
const listeners = new Set<() => void>();
const EMPTY: Entry = { info: null, error: null };

function publish(key: string, entry: Entry) {
  entries = { ...entries, [key]: entry };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The runtime session a machine session key names. */
function runtimeSessionId(cloud: CloudSessionModel): string | null {
  return parseMachineKey(cloud.session.id)?.sessionId ?? null;
}

/** The session's actions, previews and setup on the machine are served: it is connected and granted `machine/7`. */
export function machineRunsServed(cloud: CloudSessionModel | null): cloud is CloudSessionModel & { client: NonNullable<CloudSessionModel["client"]> } {
  return !!cloud?.machine && cloud.connected && !!cloud.client && cloud.client.hasCapability(MACHINE_RUNS);
}

/** Read the session's Setup and Run as the machine has them; one read at a time per session. */
export function refreshMachineRuns(cloud: CloudSessionModel): Promise<MachineSessionActions | null> {
  const key = cloud.session.id;
  const sessionId = runtimeSessionId(cloud);
  if (!machineRunsServed(cloud) || !sessionId) return Promise.resolve(entries[key]?.info ?? null);
  const running = inflight.get(key);
  if (running) return running;
  const read = cloud.client
    .sessionActions(sessionId)
    .then((info) => {
      publish(key, { info, error: null });
      return info;
    })
    .catch((cause: unknown) => {
      publish(key, { info: entries[key]?.info ?? null, error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, read);
  return read;
}

/** Forget what was read (tests). */
export function resetMachineRuns() {
  entries = {};
  inflight.clear();
}

const settling = (setup: MachineSetupRun | null | undefined) => !!setup && (setup.status === "pending" || setup.status === "running" || setup.status === "stopping");

/** The session's script-run terminals on the machine: its actions' runs and its setup, oldest first. */
export function runTerminals(terminals: readonly CloudTerminal[]): { actions: CloudTerminal[]; setup: CloudTerminal[] } {
  const live = terminals.filter((terminal) => terminal.run && !terminal.gone);
  const byAge = (a: CloudTerminal, b: CloudTerminal) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.number - b.number;
  return {
    actions: live.filter((terminal) => terminal.run?.kind === "action").sort(byAge),
    setup: live.filter((terminal) => terminal.run?.kind === "setup").sort(byAge),
  };
}

/** A run's terminal as the Run menu and the dock's Run tab show runs. `paneId` is the terminal's id here, which selects it in the dock. */
export function actionRunOf(sessionKey: string, terminal: CloudTerminal): ActionRun | null {
  if (terminal.run?.kind !== "action") return null;
  const started = new Date(terminal.createdAt ?? 0).toISOString();
  return {
    sessionId: sessionKey,
    actionId: terminal.run.actionId,
    name: terminal.run.name,
    paneId: terminal.id,
    state: terminal.exited ? "exited" : "running",
    exitCode: terminal.exited ? terminal.exitCode : null,
    started,
    ended: null,
  };
}

/** Show the run's terminal in the side panel's dock (21.08): a machine's terminals are never a tab of the main area. */
function showRun(workspaceKey: string, ptyId: string) {
  const terminal = cloudTerminalsOf(workspaceKey).terminals.find((candidate) => candidate.ptyId === ptyId);
  if (terminal) selectCloudTerminal(workspaceKey, terminal.id);
  setPrefs({ panelOpen: true, panelTerminalOpen: true });
}

function blockedReason(cloud: CloudSessionModel): string | null {
  const name = cloud.machine?.name ?? "the machine";
  if (!cloud.connected || !cloud.client) return `Can't run until ${name} is back`;
  if (!cloud.manage) return `Only a computer paired with ${name} runs its scripts`;
  return null;
}

/**
 * Run `action` in a terminal of the session on the machine and show it. A
 * non-concurrent action already running there is shown instead, with the
 * offer to restart it; `restart` replaces that run, on the machine.
 */
export async function startMachineAction(cloud: CloudSessionModel, action: RepositoryAction, options: { restart?: boolean } = {}): Promise<void> {
  const key = cloud.session.id;
  dismissRestartOffer(key);
  const sessionId = runtimeSessionId(cloud);
  const blocked = blockedReason(cloud);
  if (blocked || !cloud.client || !sessionId) {
    showError(`Couldn't run ${action.name}`, blocked ?? "This session is not on a machine.", { key: `action:${key}:${action.id}` });
    return;
  }
  try {
    const outcome = await cloud.client.runAction(sessionId, action.id, options.restart ?? false);
    // The run is listed now: show it at once rather than at the next poll.
    await syncCloudTerminals(cloud.workspaceKey, cloud.client, cloud.terminalBase).catch(() => undefined);
    showRun(cloud.workspaceKey, outcome.run.ptyId);
    if (!outcome.started) offerRestart(key, action, outcome.run.ptyId, () => startMachineAction(cloud, action, { restart: true }));
  } catch (cause) {
    showError(`Couldn't run ${action.name}`, cause, { key: `action:${key}:${action.id}` });
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

/** The machine's port a preview URL points at, when it names the machine itself (a loopback host); null for any other host. */
export function machinePortOf(url: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!LOOPBACK.has(parsed.hostname)) return null;
  if (parsed.port) return Number(parsed.port);
  return parsed.protocol === "https:" ? 443 : parsed.protocol === "http:" ? 80 : null;
}

/** `url` with its machine port replaced by this computer's end of the forward. 127.0.0.1, never `localhost` (`forwardAddress`). */
export function forwardedUrl(url: string, localPort: number): string {
  const parsed = new URL(url);
  parsed.hostname = "127.0.0.1";
  parsed.port = String(localPort);
  return parsed.toString();
}

/** Why a preview at `url` on the machine cannot be opened here now; null when it can. */
export function machinePreviewBlocked(cloud: CloudSessionModel, url: string): string | null {
  if (machinePortOf(url) === null) return null;
  const name = cloud.machine?.name ?? "the machine";
  if (!cloud.ports.offered || !cloud.ports.connectionId) {
    const feature = machineFeature("ports/1");
    const version = cloud.machine?.record?.version ?? null;
    return feature && version ? machineFeatureMessage(name, version, feature) : `${name}'s ports are not forwarded to this computer.`;
  }
  if (!portForwardsOf(cloud.ports.connectionId).settings.enabled) return `Forwarding is off for ${name}. Turn it on in its Ports tab.`;
  return null;
}

/**
 * Open a preview of the session in TerminalX's built-in browser. Its $PORT is
 * the machine's; a URL on the machine itself opens through a forward of that
 * port to this computer (made here when there is none), any other URL as it is.
 */
export async function openMachinePreview(cloud: CloudSessionModel, preview: RepositoryPreviewUrl, ports: readonly number[] | null): Promise<void> {
  const key = `preview:${cloud.session.id}:${preview.id}`;
  const target = previewTarget(preview, ports);
  if (!target.url) {
    showError(`Couldn't open ${preview.name}`, target.error, { key });
    return;
  }
  const blocked = machinePreviewBlocked(cloud, target.url);
  if (blocked) {
    showError(`Couldn't open ${preview.name}`, blocked, { key });
    return;
  }
  try {
    const port = machinePortOf(target.url);
    let url = target.url;
    if (port !== null && cloud.ports.connectionId) {
      const known = portForwardsOf(cloud.ports.connectionId).forwards.find((forward) => forward.port === port && forward.state !== "waiting");
      const forward = known ?? (await forwardPort(cloud.ports.connectionId, port, false));
      url = forwardedUrl(target.url, forward.localPort);
    }
    // The built-in browser groups pages by a local folder; a machine session's is not this computer's.
    const pageId = await openBrowserPage(await forwardsBrowserWorkspace(), url);
    await browserApi.activatePage(pageId, true);
  } catch (cause) {
    showError(`Couldn't open ${preview.name}`, cause, { key });
  }
}

export interface MachineSessionRuns {
  /** The machine granted `machine/7` on this connection. */
  served: boolean;
  info: MachineSessionActions | null;
  error: string | null;
  source: RunSource;
  /** The latest setup attempt's terminal, while the machine keeps it. */
  setupTerminal: CloudTerminal | undefined;
  /** Every action run's terminal, oldest first: each is a tab of the dock. */
  actionTerminals: CloudTerminal[];
  rerunSetup: () => Promise<void>;
  stopSetup: () => Promise<void>;
  /** Why nothing can be started now; null when it can. */
  blocked: string | null;
}

/**
 * A machine session's Setup and Run, kept up to date while shown: read on
 * each connect, again whenever one of its runs starts or ends, and every
 * {@link SETUP_POLL_MS} while its setup is going.
 */
export function useMachineSessionRuns(cloud: CloudSessionModel | null): MachineSessionRuns | null {
  const key = cloud?.session.id ?? "";
  const entry = useSyncExternalStore(subscribe, () => entries[key] ?? EMPTY, () => entries[key] ?? EMPTY);
  const served = machineRunsServed(cloud);
  const terminals = cloud?.terminals;
  const { actions: actionTerminals, setup: setupTerminals } = useMemo(() => runTerminals(terminals ?? []), [terminals]);
  // What the runs are now: a run started, ended or closed is a reason to read setup and actions again.
  const signature = [...actionTerminals, ...setupTerminals].map((terminal) => `${terminal.ptyId}:${terminal.exited ? 1 : 0}`).join(",");
  const client = cloud?.client ?? null;
  usePortForwards(cloud?.ports.connectionId ?? null, !!cloud?.ports.offered);
  useEffect(() => {
    if (!cloud || !served) return;
    void refreshMachineRuns(cloud);
    // Not `cloud`, a new object each render: the connection, its client and the runs are what matter.
  }, [served, client, key, signature]);
  const setupGoing = settling(entry.info?.setup);
  useEffect(() => {
    if (!cloud || !served || !setupGoing) return;
    const timer = setInterval(() => void refreshMachineRuns(cloud), SETUP_POLL_MS);
    return () => clearInterval(timer);
  }, [served, client, key, setupGoing]);

  if (!cloud?.machine) return null;
  const info = entry.info;
  const runs = latestByAction(actionTerminals.map((terminal) => actionRunOf(key, terminal)).filter((run): run is ActionRun => !!run));
  const setupPane = info?.setup?.paneId;
  const setupTerminal = setupTerminals.find((terminal) => terminal.ptyId === setupPane) ?? (setupPane ? undefined : setupTerminals.at(-1));
  const blocked = blockedReason(cloud);
  const sessionId = runtimeSessionId(cloud);
  const source: RunSource = {
    actions: served && info?.available !== false ? visibleActions(info?.actions ?? []) : [],
    previews: served ? (info?.previewUrls ?? []) : [],
    runs,
    ports: info?.ports ?? null,
    start: (action) => startMachineAction(cloud, action),
    openPreview: (preview) => openMachinePreview(cloud, preview, info?.ports ?? null),
    previewBlocked: (url) => machinePreviewBlocked(cloud, url),
  };
  const setupCall = async (call: (sessionId: string) => Promise<unknown>, what: string) => {
    if (blocked || !sessionId) throw new Error(blocked ?? `Couldn't ${what}`);
    await call(sessionId);
    await refreshMachineRuns(cloud);
    if (cloud.client) await syncCloudTerminals(cloud.workspaceKey, cloud.client, cloud.terminalBase).catch(() => undefined);
  };
  return {
    served,
    info,
    error: entry.error,
    source,
    setupTerminal,
    actionTerminals,
    blocked,
    rerunSetup: () => setupCall((id) => cloud.client!.rerunSetup(id), "rerun setup"),
    stopSetup: () => {
      const pane = info?.setup?.paneId;
      if (!pane) return Promise.resolve();
      return setupCall((id) => cloud.client!.stopSetup(id, pane), "stop setup");
    },
  };
}
