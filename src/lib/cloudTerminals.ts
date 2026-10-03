import { useSyncExternalStore } from "react";
import { agentPtyId, type PtyAttachment, type PtyControl, type PtyCursor, type PtyInfo, type WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { disposeInstance, getInstance, peekInstance, type TerminalInstance } from "@/lib/terminal";
import { countTerminalData } from "@/lib/terminalCounters";

/**
 * Shell tabs of cloud workspaces (PRO-26). The shells run on the workspace
 * runtime; this keeps, per workspace, the tabs this window shows and, per
 * tab, a live xterm and the byte offset it has shown. Leaving the page or
 * losing the connection detaches the stream but keeps both, so coming back
 * resumes after the last byte instead of replaying or losing output, and
 * the shell process itself never restarts.
 *
 * Input goes through the workspace client's ordered queue: a refusal (the
 * terminal exited, another device controls it, its runtime restarted) is
 * shown on the tab, never dropped quietly.
 *
 * An agent tab's own terminal (PRO-86, `agent-pty/1`) is kept here too, apart
 * from the shells (`agents`): the same xterm, stream, cursor, input queue and
 * controller, but it belongs to its tab, is never listed by the runtime, and
 * is attached only while its terminal view shows.
 */
export interface CloudTerminal {
  /** Also the xterm instance id; distinct from every local pane id. */
  id: string;
  ptyId: string;
  number: number;
  title: string;
  epoch: string;
  pid: number | null;
  exited: boolean;
  exitCode: number | null;
  control: PtyControl;
  /** The person controlling it on a shared workspace (PRO-30); null when nobody or unknown. */
  controllerId: string | null;
  /** Whether the controlling device is still attached; null when the runtime does not say. */
  controllerPresent: boolean | null;
  /** The controller's size, which a viewer shows. */
  cols: number;
  rows: number;
  /** Set once the terminal can never be reached again. */
  gone: "closed" | "runtime-restarted" | null;
  /** The last input refusal or failure, until the next accepted input. */
  inputError: string | null;
  /** The runtime session it was opened for (`pty/2`); null for a workspace terminal or an older runtime. */
  sessionId: string | null;
  /** The agent tab whose own terminal this is (PRO-86); null for a shell. */
  tabId: string | null;
  /** Its output is streaming to this window now, so `control` and the size are the runtime's word. */
  live: boolean;
}

interface WorkspaceTerminals {
  terminals: CloudTerminal[];
  /** Agent tabs' own terminals this window has shown, by tab: never shell tabs, never synced from `pty.list`. */
  agents?: CloudTerminal[];
  selected: string | null;
  /** The workspace view is showing the selected terminal (not its agent, files or Git view). */
  shown?: boolean;
  /** Counts each request to show the selected terminal there. */
  reveal?: number;
}

let state: Record<string, WorkspaceTerminals> = {};
const listeners = new Set<() => void>();
const EMPTY: WorkspaceTerminals = { terminals: [], selected: null };

function publish(next: Record<string, WorkspaceTerminals>) {
  state = next;
  for (const listener of listeners) listener();
}

function update(workspace: string, change: (current: WorkspaceTerminals) => WorkspaceTerminals) {
  const current = state[workspace] ?? EMPTY;
  const next = change(current);
  // Unchanged (a poll that found nothing new): nobody re-renders.
  if (next !== current) publish({ ...state, [workspace]: next });
}

function patch(workspace: string, id: string, fields: Partial<CloudTerminal>) {
  update(workspace, (current) => {
    const apply = (terminal: CloudTerminal) => (terminal.id === id ? { ...terminal, ...fields } : terminal);
    if (current.terminals.some((terminal) => terminal.id === id)) return { ...current, terminals: current.terminals.map(apply) };
    if (current.agents?.some((terminal) => terminal.id === id)) return { ...current, agents: current.agents.map(apply) };
    return current;
  });
}

/** A terminal by its id: a shell, or an agent tab's own terminal. */
function terminalOf(workspace: string, id: string): CloudTerminal | undefined {
  const current = state[workspace];
  return current?.terminals.find((item) => item.id === id) ?? current?.agents?.find((item) => item.id === id);
}

export function useCloudTerminals(workspace: string): WorkspaceTerminals {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state[workspace] ?? EMPTY,
    () => state[workspace] ?? EMPTY,
  );
}

export function cloudTerminalsOf(workspace: string): WorkspaceTerminals {
  return state[workspace] ?? EMPTY;
}

/** The live stream and the client its xterm types into, per terminal. */
interface Binding {
  client: WorkspaceRpcClient;
  /** Null while the attach call is on its way. */
  attachment: PtyAttachment | null;
  attaching: boolean;
}
const bindings = new Map<string, Binding>();
/** Where each terminal's view left off, kept across connections. */
const cursors = new Map<string, PtyCursor>();
/**
 * Orders list reads against terminals this window opened: a list asked for
 * before a terminal existed says nothing about it, whenever its answer lands.
 */
let clock = 0;
const openedAt = new Map<string, number>();

function terminalId(workspace: string, ptyId: string) {
  return `cloud:${workspace}:${ptyId}`;
}

function fromInfo(workspace: string, info: PtyInfo): CloudTerminal {
  return {
    id: terminalId(workspace, info.ptyId),
    ptyId: info.ptyId,
    number: info.number,
    title: `Terminal ${info.number}`,
    epoch: info.epoch,
    pid: info.pid,
    exited: info.exited,
    exitCode: info.exitCode,
    control: info.control,
    controllerId: info.controllerId ?? null,
    controllerPresent: info.controllerPresent ?? null,
    cols: info.cols,
    rows: info.rows,
    gone: null,
    inputError: null,
    sessionId: info.sessionId ?? null,
    tabId: null,
    live: false,
  };
}

/** A refusal's code, or the error's message. */
export function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) return String((error as { code: unknown }).code);
  return error instanceof Error ? error.message : String(error);
}

/**
 * Makes the xterm for a cloud terminal from `base`, wired so input and size
 * go to whichever client is bound now: a view survives the connection it
 * was made on. Pass it to `getInstance` (directly or through TerminalView).
 */
export function cloudTerminalFactory(workspace: string, terminal: CloudTerminal, base: () => TerminalInstance): () => TerminalInstance {
  return () => {
    const instance = base();
    const current = () => terminalOf(workspace, terminal.id);
    // xterm's `onData` carries two different things: what a person typed
    // (keys, paste, IME), and what the emulator says by itself (focus in and
    // out, answers to cursor, device and colour queries, mouse reports).
    // Only the first is input: a report must never wake a workspace, take
    // control, start an agent or hold its tab.
    const core = (instance.term as unknown as { _core?: { coreService?: { onUserInput?: (listener: () => void) => unknown } } })._core?.coreService;
    const marksInput = typeof core?.onUserInput === "function";
    let typed = false;
    // xterm raises this right before the `onData` of anything a person did.
    if (marksInput) core!.onUserInput!(() => void (typed = true));
    const send = (data: string) => {
      const user = (marksInput ? typed : !isTerminalReport(data)) && !isMouseReport(data);
      typed = false;
      if (user) void typeIntoCloudTerminal(workspace, terminal.id, data);
      else sendTerminalReport(workspace, terminal.id, data);
    };
    instance.term.onData(send);
    // Binary events are legacy mouse reports only.
    instance.term.onBinary((data) => sendTerminalReport(workspace, terminal.id, data));
    instance.term.onResize(({ cols, rows }) => {
      const binding = bindings.get(terminal.id);
      const now = current();
      // Only the controller's size reaches the program.
      if (!binding || now?.control !== "you" || now.gone || now.exited) return;
      void binding.client.resizePty(terminal.ptyId, cols, rows).catch(() => undefined);
    });
    return instance;
  };
}

/**
 * Asked before a terminal's input is sent. False drops it; the gate says why
 * elsewhere. An agent tab's terminal view uses it to wake a stopped workspace
 * instead of typing blind, to refuse a viewer, and to take control first.
 */
export type CloudTerminalInputGate = (data: string) => boolean | Promise<boolean>;
const inputGates = new Map<string, CloudTerminalInputGate>();
/** Keeps gated input in the order it was typed. */
const inputChains = new Map<string, Promise<void>>();

export function setCloudTerminalInputGate(id: string, gate: CloudTerminalInputGate | null) {
  if (gate) inputGates.set(id, gate);
  else inputGates.delete(id);
}

// A whole chunk of nothing but reports. Only the fallback where xterm does not mark user input: Shift+F3 is `ESC[1;2R` too.
const REPORTS = /^(?:\x1b\[[IO]|\x1b\[\??[\d;]*R|\x1b\[[?>]?[\d;]*c|\x1b\[\??[\d;]*\$y|\x1b\[[\d;]*t|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/;
const MOUSE_REPORTS = /^(?:\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[\d+;\d+;\d+M|\x1b\[M[\s\S]{3})+$/;

/** Focus in or out, or the answer to a cursor, device, mode, window or colour query. */
export function isTerminalReport(data: string): boolean {
  return REPORTS.test(data);
}

/** A mouse report: xterm calls it user input, but moving the pointer over a view is not typing. */
export function isMouseReport(data: string): boolean {
  return MOUSE_REPORTS.test(data);
}

/** Terminals whose xterm is being fed output from before the attach: what it answers to that is stale. */
const replaying = new Map<string, number>();

/**
 * Something the terminal emulator said by itself. The program may be waiting
 * for it, so it is forwarded, marked as a report (the runtime then counts it
 * neither as use of the workspace nor as driving a tab), but only for a
 * terminal this view controls and is streaming. Anything else drops it,
 * quietly: it is never typed blind, never an error, and never a reason to
 * wake, take control or start anything.
 */
function sendTerminalReport(workspace: string, id: string, data: string) {
  if ((replaying.get(id) ?? 0) > 0) return;
  const binding = bindings.get(id);
  const now = terminalOf(workspace, id);
  if (!binding?.attachment || !now || now.gone || now.exited || now.control !== "you") return;
  void binding.client.write(now.ptyId, data, { report: true }).catch(() => undefined);
}

/** Write output to a terminal's xterm; while `replay` is being parsed its answers are not sent. */
function show(id: string, instance: TerminalInstance, bytes: Uint8Array, replay: boolean) {
  if (!replay) {
    instance.term.write(bytes);
    return;
  }
  replaying.set(id, (replaying.get(id) ?? 0) + 1);
  instance.term.write(bytes, () => {
    const left = (replaying.get(id) ?? 1) - 1;
    if (left > 0) replaying.set(id, left);
    else replaying.delete(id);
  });
}

/** Focus reporting, mouse reporting and bracketed paste off: what a program asked of a terminal that no longer has a program. */
const MODES_OFF = "\x1b[?1004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l\x1b[?2004l";

/**
 * The workspace stopped: nothing is listening to its terminals. Their xterms
 * forget the modes the programs set, so a view of a stopped workspace is an
 * inert picture: focusing or clicking it produces nothing at all.
 */
export function quietCloudTerminals(workspace: string) {
  const current = state[workspace];
  for (const terminal of [...(current?.terminals ?? []), ...(current?.agents ?? [])]) peekInstance(terminal.id)?.term.write(MODES_OFF);
}

function deliver(workspace: string, id: string, data: string) {
  const binding = bindings.get(id);
  const now = terminalOf(workspace, id);
  if (!now || now.gone || now.exited) return;
  if (!binding) {
    patch(workspace, id, { inputError: "not connected" });
    return;
  }
  binding.client
    .write(now.ptyId, data)
    .then(() => {
      if (terminalOf(workspace, id)?.inputError) patch(workspace, id, { inputError: null });
    })
    .catch((error: unknown) => patch(workspace, id, { inputError: errorCode(error) }));
}

/**
 * What a terminal's xterm calls with every keystroke or paste. It goes to the
 * runtime over the workspace connection (`pty.write`, end-to-end encrypted,
 * the same call for a shell and for an agent's terminal) and nowhere else:
 * nothing typed is queued in the API mailbox or kept on this desktop.
 */
export function typeIntoCloudTerminal(workspace: string, id: string, data: string): Promise<void> {
  const gate = inputGates.get(id);
  if (!gate) {
    deliver(workspace, id, data);
    return Promise.resolve();
  }
  const run = async () => {
    // The gate of now: the view may have changed while earlier input waited.
    const allow = inputGates.get(id);
    if (allow && !(await allow(data))) return;
    deliver(workspace, id, data);
  };
  const next = (inputChains.get(id) ?? Promise.resolve()).then(run).catch(() => undefined);
  inputChains.set(id, next);
  return next;
}

/** Start (or resume) the output stream of one terminal on `client`. */
async function attach(workspace: string, client: WorkspaceRpcClient, terminal: CloudTerminal, create: () => TerminalInstance) {
  const existing = bindings.get(terminal.id);
  // Streaming on this client already, or about to: a second attach (the list
  // is read again every few seconds) would print the same output twice.
  if (existing?.client === client && (existing.attachment || existing.attaching)) return;
  existing?.attachment?.detach();
  const binding: Binding = { client, attachment: null, attaching: true };
  bindings.set(terminal.id, binding);
  const instance = getInstance(terminal.id, cloudTerminalFactory(workspace, terminal, create));
  const attachment = await client
    .attachPty(terminal.ptyId, {
    since: cursors.get(terminal.id),
    onData: (bytes, _offset, replay) => {
      countTerminalData("cloud", bytes.length);
      show(terminal.id, instance, bytes, replay);
    },
    onTruncated: () => instance.term.write("\r\n\x1b[2m[earlier output was dropped while this view was away]\x1b[0m\r\n"),
    onExit: (code) => {
      const current = terminalOf(workspace, terminal.id);
      if (current && !current.exited) patch(workspace, terminal.id, { exited: true, exitCode: code });
    },
    onControl: (control, controllerId, controllerPresent) => {
      patch(workspace, terminal.id, { control, ...(controllerId !== undefined ? { controllerId } : {}), ...(controllerPresent !== undefined ? { controllerPresent } : {}) });
      // A viewer shows the program at the controller's size.
      const current = terminalOf(workspace, terminal.id);
      if (control !== "you" && current && (instance.term.cols !== current.cols || instance.term.rows !== current.rows)) {
        instance.term.resize(current.cols, current.rows);
      }
    },
    onResize: (cols, rows) => {
      patch(workspace, terminal.id, { cols, rows });
      const current = terminalOf(workspace, terminal.id);
      if (current?.control !== "you" && (instance.term.cols !== cols || instance.term.rows !== rows)) instance.term.resize(cols, rows);
    },
    onGone: (gone) => {
      cursors.delete(terminal.id);
      if (terminal.tabId && gone === "runtime-restarted") {
        // A tab outlives its runtime process: its terminal starts over on the
        // new one (nothing of the old screen is there), instead of ending.
        if (bindings.get(terminal.id) === binding) bindings.delete(terminal.id);
        instance.term.reset();
        patch(workspace, terminal.id, { control: "none", controllerId: null, inputError: null, live: false });
        if (wantedAgents.has(terminal.id)) queueMicrotask(() => void attach(workspace, client, terminal, create).catch(() => undefined));
        return;
      }
      patch(workspace, terminal.id, { gone, live: false });
    },
  })
    .catch((error: unknown) => {
      // Not streaming: the next sync attaches again.
      binding.attaching = false;
      throw error;
    });
  binding.attaching = false;
  if (bindings.get(terminal.id) !== binding) {
    attachment.detach();
    return;
  }
  binding.attachment = attachment;
  // Attached: who controls it and its size are now the runtime's word.
  if (terminal.tabId && !terminalOf(workspace, terminal.id)?.gone) patch(workspace, terminal.id, { live: true });
}

// ---- an agent tab's own terminal (PRO-86) --------------------------------------

/** Agent terminals whose view is showing: only these stream. */
const wantedAgents = new Set<string>();

export function agentTerminalId(workspace: string, tabId: string): string {
  return terminalId(workspace, agentPtyId(tabId));
}

export function agentTerminalOf(workspace: string, tabId: string): CloudTerminal | undefined {
  return state[workspace]?.agents?.find((item) => item.tabId === tabId);
}

/**
 * The view record of an agent tab's terminal, made here without asking the
 * runtime anything: a stopped workspace's terminal view has one too. Until it
 * is attached nobody is known to control it, at the size every CLI starts at.
 */
export function ensureAgentTerminal(workspace: string, tabId: string): CloudTerminal {
  const known = agentTerminalOf(workspace, tabId);
  if (known) return known;
  const terminal: CloudTerminal = {
    id: agentTerminalId(workspace, tabId),
    ptyId: agentPtyId(tabId),
    number: 0,
    title: "Agent",
    epoch: "",
    pid: null,
    exited: false,
    exitCode: null,
    control: "none",
    controllerId: null,
    cols: 120,
    rows: 30,
    gone: null,
    inputError: null,
    sessionId: null,
    tabId,
    live: false,
  };
  update(workspace, (current) => ({ ...current, agents: [...(current.agents ?? []), terminal] }));
  return terminal;
}

/**
 * Stream an agent tab's terminal on `client` while its view shows: recent
 * output is replayed (from where this view left off, when it was here
 * before), then it is live. Attaching starts nothing and takes nothing over.
 */
export async function attachAgentTerminal(workspace: string, client: WorkspaceRpcClient, tabId: string, create: () => TerminalInstance): Promise<void> {
  const terminal = ensureAgentTerminal(workspace, tabId);
  wantedAgents.add(terminal.id);
  if (terminal.gone) patch(workspace, terminal.id, { gone: null });
  await attach(workspace, client, terminal, create);
}

/** The terminal view went away: stop streaming, keeping the view and where it left off. */
export function detachAgentTerminal(workspace: string, tabId: string) {
  const id = agentTerminalId(workspace, tabId);
  wantedAgents.delete(id);
  const binding = bindings.get(id);
  if (binding) {
    const cursor = binding.attachment?.cursor();
    if (cursor) cursors.set(id, cursor);
    binding.attachment?.detach();
    bindings.delete(id);
  }
  if (agentTerminalOf(workspace, tabId)?.live) patch(workspace, id, { live: false });
}

/**
 * A restarted runtime numbers its terminals from 1 again, while the tabs of
 * the one before stay open (ended) until they are closed. A new terminal
 * whose name another tab still shows takes the next free number, so the strip
 * never reads "Terminal 1 (ended)" next to "Terminal 1".
 */
function named(terminal: CloudTerminal, shown: readonly CloudTerminal[]): CloudTerminal {
  const taken = new Set(shown.filter((other) => other.id !== terminal.id).map((other) => other.title));
  if (!taken.has(terminal.title)) return terminal;
  let number = terminal.number;
  while (taken.has(`Terminal ${number}`)) number++;
  return { ...terminal, title: `Terminal ${number}` };
}

/** `next` when it says something new about the terminal, else the object the views already hold. */
function unchanged(current: CloudTerminal, next: CloudTerminal): CloudTerminal {
  return (Object.keys(next) as (keyof CloudTerminal)[]).every((field) => current[field] === next[field]) ? current : next;
}

/**
 * Reconcile with the runtime's terminals and stream each one on `client`.
 * Call on every connect: terminals opened elsewhere appear, closed ones go,
 * and those of a runtime that restarted are marked, not re-created.
 */
export async function syncCloudTerminals(
  workspace: string,
  client: WorkspaceRpcClient,
  create: () => TerminalInstance,
): Promise<CloudTerminal[]> {
  const asked = ++clock;
  const listed = await client.listPtys();
  const byPty = new Map(listed.terminals.map((info) => [info.ptyId, info]));
  update(workspace, (current) => {
    const known = new Set(current.terminals.map((terminal) => terminal.ptyId));
    const terminals = current.terminals.map((terminal): CloudTerminal => {
      const info = byPty.get(terminal.ptyId);
      if (info) return unchanged(terminal, { ...fromInfo(workspace, info), title: terminal.title, inputError: terminal.inputError, live: terminal.live });
      // Gone already, or opened here after this list was asked for.
      if (terminal.gone || (openedAt.get(terminal.id) ?? 0) > asked) return terminal;
      return { ...terminal, gone: terminal.epoch === listed.epoch ? "closed" : "runtime-restarted" };
    });
    for (const info of listed.terminals) if (!known.has(info.ptyId)) terminals.push(named(fromInfo(workspace, info), terminals));
    const selected = current.selected && terminals.some((terminal) => terminal.id === current.selected) ? current.selected : (terminals[0]?.id ?? null);
    if (selected === current.selected && terminals.length === current.terminals.length && terminals.every((terminal, index) => terminal === current.terminals[index])) return current;
    return { ...current, terminals, selected };
  });
  const live = cloudTerminalsOf(workspace).terminals.filter((terminal) => !terminal.gone);
  await Promise.all(live.map((terminal) => attach(workspace, client, terminal, create).catch(() => undefined)));
  return live;
}

export async function createCloudTerminal(
  workspace: string,
  client: WorkspaceRpcClient,
  size: { cols: number; rows: number },
  create: () => TerminalInstance,
  options: { sessionId?: string } = {},
): Promise<CloudTerminal> {
  const info = await client.createPty(options.sessionId ? { ...size, sessionId: options.sessionId } : size);
  const terminal = named(fromInfo(workspace, info), cloudTerminalsOf(workspace).terminals);
  openedAt.set(terminal.id, ++clock);
  update(workspace, (current) => ({
    ...current,
    terminals: current.terminals.some((item) => item.ptyId === info.ptyId) ? current.terminals : [...current.terminals, terminal],
    selected: terminal.id,
  }));
  await attach(workspace, client, terminal, create);
  return terminal;
}

export function selectCloudTerminal(workspace: string, id: string | null) {
  update(workspace, (current) => (current.selected === id ? current : { ...current, selected: id }));
}

/** Select a terminal and ask the workspace view to show it (a sidebar row was chosen). */
export function revealCloudTerminal(workspace: string, id: string) {
  update(workspace, (current) => ({ ...current, selected: id, reveal: (current.reveal ?? 0) + 1 }));
}

/** The workspace view says whether it is showing its selected terminal, so the sidebar marks the right row. */
export function setCloudTerminalShown(workspace: string, shown: boolean) {
  update(workspace, (current) => (!!current.shown === shown ? current : { ...current, shown }));
}

/** How often a connected workspace's terminal list is read again. */
export const TERMINAL_POLL_MS = 3_000;

/**
 * Keep a connected workspace's terminals current. The runtime has no
 * notification for a terminal that someone else opens or closes, so the list
 * is read again every few seconds: a terminal one person creates appears for
 * everyone connected, without reopening the session. It reads only while
 * connected and while the window is visible, and a read is not activity:
 * it never wakes a workspace or keeps one from idling. Returns what stops it.
 */
export function followCloudTerminals(workspace: string, client: WorkspaceRpcClient, create: () => TerminalInstance, intervalMs = TERMINAL_POLL_MS): () => void {
  let stopped = false;
  let reading = false;
  const read = async () => {
    if (stopped || reading || document.visibilityState === "hidden" || client.connection.state !== "connected") return;
    reading = true;
    try {
      await syncCloudTerminals(workspace, client, create);
    } catch {
      // The next read tries again; a dropped connection re-syncs on connect.
    } finally {
      reading = false;
    }
  };
  const timer = setInterval(() => void read(), intervalMs);
  const onVisible = () => void read();
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/** The terminals of one session (`pty/2` names it), in the order they were opened. */
export function sessionTerminals(terminals: readonly CloudTerminal[], sessionId: string): CloudTerminal[] {
  return terminals.filter((terminal) => terminal.sessionId === sessionId);
}

/**
 * Terminals that belong to no session shown here: every terminal of a runtime
 * older than `pty/2`, one opened for the workspace itself, or one whose
 * session is gone. The sidebar lists them once, as "Workspace terminals".
 */
export function workspaceTerminals(terminals: readonly CloudTerminal[], sessionIds: readonly string[]): CloudTerminal[] {
  return terminals.filter((terminal) => !terminal.sessionId || !sessionIds.includes(terminal.sessionId));
}

/** Close the tab; a live shell is ended on the runtime too. */
export async function closeCloudTerminal(workspace: string, client: WorkspaceRpcClient | null, id: string) {
  const terminal = cloudTerminalsOf(workspace).terminals.find((item) => item.id === id);
  if (!terminal) return;
  if (!terminal.gone) {
    if (!client) throw new Error("Not connected to the workspace");
    try {
      await client.killPty(terminal.ptyId);
    } catch (error) {
      // Already closed elsewhere: closing the tab is all that is left.
      if (errorCode(error) !== "not_found") throw error;
    }
  }
  bindings.get(id)?.attachment?.detach();
  bindings.delete(id);
  cursors.delete(id);
  openedAt.delete(id);
  disposeInstance(id);
  update(workspace, (current) => {
    const index = current.terminals.findIndex((item) => item.id === id);
    const terminals = current.terminals.filter((item) => item.id !== id);
    const selected = current.selected === id ? (terminals[Math.min(index, terminals.length - 1)]?.id ?? null) : current.selected;
    return { ...current, terminals, selected };
  });
}

/**
 * Take over input and size, at this view's size. `start` (an agent tab's
 * terminal) also starts the tab's CLI when it is not running.
 */
export async function takeControl(
  workspace: string,
  client: WorkspaceRpcClient,
  id: string,
  size: { cols: number; rows: number } | null,
  options: { start?: boolean } = {},
) {
  const terminal = terminalOf(workspace, id);
  if (!terminal) return;
  // A shell is taken exactly as before; only an agent's terminal is ever asked to start.
  const info = options.start ? await client.controlPty(terminal.ptyId, size?.cols, size?.rows, { start: true }) : await client.controlPty(terminal.ptyId, size?.cols, size?.rows);
  patch(workspace, id, { control: info.control, controllerId: info.controllerId ?? null, cols: info.cols, rows: info.rows, inputError: null });
}

/**
 * Stop streaming this workspace's terminals (the page closed or the
 * connection is going away), keeping each view and where it left off.
 */
export function detachCloudTerminals(workspace: string) {
  const prefix = `cloud:${workspace}:`;
  for (const [id, binding] of bindings) {
    if (!id.startsWith(prefix)) continue;
    const cursor = binding.attachment?.cursor();
    if (cursor) cursors.set(id, cursor);
    binding.attachment?.detach();
    bindings.delete(id);
  }
  // Nothing streams any more; an agent terminal's view attaches again when it next shows over a connection.
  if (state[workspace]?.agents?.some((terminal) => terminal.live)) {
    update(workspace, (current) => ({ ...current, agents: current.agents?.map((terminal) => (terminal.live ? { ...terminal, live: false } : terminal)) }));
  }
}

/** Forget one workspace's terminals and views: it was deleted. */
export function dropCloudTerminals(workspace: string) {
  const prefix = `cloud:${workspace}:`;
  for (const [id, binding] of bindings) {
    if (!id.startsWith(prefix)) continue;
    binding.attachment?.detach();
    bindings.delete(id);
  }
  for (const id of [...cursors.keys()]) if (id.startsWith(prefix)) cursors.delete(id);
  for (const terminal of [...(state[workspace]?.terminals ?? []), ...(state[workspace]?.agents ?? [])]) {
    disposeInstance(terminal.id);
    wantedAgents.delete(terminal.id);
    inputChains.delete(terminal.id);
  }
  if (!(workspace in state)) return;
  const next = { ...state };
  delete next[workspace];
  publish(next);
}

/** Forget one organization's terminals and views: the user left it (CS-18). */
export function dropCloudTerminalsIn(orgId: string) {
  // Workspaces are keyed `cloud:<orgId>:<workspaceId>`, and their terminals `cloud:<workspace>:<ptyId>`.
  const prefix = `cloud:${orgId}:`;
  const workspaces = new Set(Object.keys(state).filter((workspace) => workspace.startsWith(prefix)));
  for (const id of [...bindings.keys(), ...cursors.keys()]) {
    if (id.startsWith(`cloud:${prefix}`)) workspaces.add(id.split(":").slice(1, 4).join(":"));
  }
  for (const workspace of workspaces) dropCloudTerminals(workspace);
}

/** Forget every workspace's terminals and views (sign-out, organization switch). */
export function resetCloudTerminals() {
  for (const binding of bindings.values()) binding.attachment?.detach();
  for (const workspace of Object.values(state)) for (const terminal of [...workspace.terminals, ...(workspace.agents ?? [])]) disposeInstance(terminal.id);
  bindings.clear();
  cursors.clear();
  openedAt.clear();
  wantedAgents.clear();
  replaying.clear();
  inputGates.clear();
  inputChains.clear();
  publish({});
}
