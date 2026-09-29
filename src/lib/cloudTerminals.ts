import { useSyncExternalStore } from "react";
import type { PtyAttachment, PtyControl, PtyCursor, PtyInfo, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { disposeInstance, getInstance, type TerminalInstance } from "@/lib/terminal";

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
  /** The controller's size, which a viewer shows. */
  cols: number;
  rows: number;
  /** Set once the terminal can never be reached again. */
  gone: "closed" | "runtime-restarted" | null;
  /** The last input refusal or failure, until the next accepted input. */
  inputError: string | null;
}

interface WorkspaceTerminals {
  terminals: CloudTerminal[];
  selected: string | null;
}

let state: Record<string, WorkspaceTerminals> = {};
const listeners = new Set<() => void>();
const EMPTY: WorkspaceTerminals = { terminals: [], selected: null };

function publish(next: Record<string, WorkspaceTerminals>) {
  state = next;
  for (const listener of listeners) listener();
}

function update(workspace: string, change: (current: WorkspaceTerminals) => WorkspaceTerminals) {
  publish({ ...state, [workspace]: change(state[workspace] ?? EMPTY) });
}

function patch(workspace: string, id: string, fields: Partial<CloudTerminal>) {
  update(workspace, (current) => ({
    ...current,
    terminals: current.terminals.map((terminal) => (terminal.id === id ? { ...terminal, ...fields } : terminal)),
  }));
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
  attachment: PtyAttachment | null;
}
const bindings = new Map<string, Binding>();
/** Where each terminal's view left off, kept across connections. */
const cursors = new Map<string, PtyCursor>();

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
    cols: info.cols,
    rows: info.rows,
    gone: null,
    inputError: null,
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
    const current = () => cloudTerminalsOf(workspace).terminals.find((item) => item.id === terminal.id);
    const send = (data: string) => {
      const binding = bindings.get(terminal.id);
      const now = current();
      if (!now || now.gone || now.exited) return;
      if (!binding) {
        patch(workspace, terminal.id, { inputError: "not connected" });
        return;
      }
      binding.client
        .write(terminal.ptyId, data)
        .then(() => {
          if (current()?.inputError) patch(workspace, terminal.id, { inputError: null });
        })
        .catch((error: unknown) => patch(workspace, terminal.id, { inputError: errorCode(error) }));
    };
    instance.term.onData(send);
    instance.term.onBinary(send);
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

/** Start (or resume) the output stream of one terminal on `client`. */
async function attach(workspace: string, client: WorkspaceRpcClient, terminal: CloudTerminal, create: () => TerminalInstance) {
  const existing = bindings.get(terminal.id);
  if (existing?.client === client && existing.attachment) return;
  existing?.attachment?.detach();
  const binding: Binding = { client, attachment: null };
  bindings.set(terminal.id, binding);
  const instance = getInstance(terminal.id, cloudTerminalFactory(workspace, terminal, create));
  const attachment = await client.attachPty(terminal.ptyId, {
    since: cursors.get(terminal.id),
    onData: (bytes) => instance.term.write(bytes),
    onTruncated: () => instance.term.write("\r\n\x1b[2m[earlier output was dropped while this view was away]\x1b[0m\r\n"),
    onExit: (code) => {
      const current = cloudTerminalsOf(workspace).terminals.find((item) => item.id === terminal.id);
      if (current && !current.exited) patch(workspace, terminal.id, { exited: true, exitCode: code });
    },
    onControl: (control, controllerId) => {
      patch(workspace, terminal.id, { control, ...(controllerId !== undefined ? { controllerId } : {}) });
      // A viewer shows the program at the controller's size.
      const current = cloudTerminalsOf(workspace).terminals.find((item) => item.id === terminal.id);
      if (control !== "you" && current && (instance.term.cols !== current.cols || instance.term.rows !== current.rows)) {
        instance.term.resize(current.cols, current.rows);
      }
    },
    onResize: (cols, rows) => {
      patch(workspace, terminal.id, { cols, rows });
      const current = cloudTerminalsOf(workspace).terminals.find((item) => item.id === terminal.id);
      if (current?.control !== "you" && (instance.term.cols !== cols || instance.term.rows !== rows)) instance.term.resize(cols, rows);
    },
    onGone: (gone) => {
      cursors.delete(terminal.id);
      patch(workspace, terminal.id, { gone });
    },
  });
  if (bindings.get(terminal.id) !== binding) {
    attachment.detach();
    return;
  }
  binding.attachment = attachment;
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
  const listed = await client.listPtys();
  const byPty = new Map(listed.terminals.map((info) => [info.ptyId, info]));
  update(workspace, (current) => {
    const known = new Set(current.terminals.map((terminal) => terminal.ptyId));
    const terminals = current.terminals.map((terminal): CloudTerminal => {
      const info = byPty.get(terminal.ptyId);
      if (info) return { ...fromInfo(workspace, info), title: terminal.title, inputError: terminal.inputError };
      if (terminal.gone) return terminal;
      return { ...terminal, gone: terminal.epoch === listed.epoch ? "closed" : "runtime-restarted" };
    });
    for (const info of listed.terminals) if (!known.has(info.ptyId)) terminals.push(fromInfo(workspace, info));
    const selected = current.selected && terminals.some((terminal) => terminal.id === current.selected) ? current.selected : (terminals[0]?.id ?? null);
    return { terminals, selected };
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
): Promise<CloudTerminal> {
  const info = await client.createPty(size);
  const terminal = fromInfo(workspace, info);
  update(workspace, (current) => ({
    terminals: current.terminals.some((item) => item.ptyId === info.ptyId) ? current.terminals : [...current.terminals, terminal],
    selected: terminal.id,
  }));
  await attach(workspace, client, terminal, create);
  return terminal;
}

export function selectCloudTerminal(workspace: string, id: string | null) {
  update(workspace, (current) => ({ ...current, selected: id }));
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
  disposeInstance(id);
  update(workspace, (current) => {
    const index = current.terminals.findIndex((item) => item.id === id);
    const terminals = current.terminals.filter((item) => item.id !== id);
    const selected = current.selected === id ? (terminals[Math.min(index, terminals.length - 1)]?.id ?? null) : current.selected;
    return { terminals, selected };
  });
}

/** Take over input and size, at this view's size. */
export async function takeControl(workspace: string, client: WorkspaceRpcClient, id: string, size: { cols: number; rows: number } | null) {
  const terminal = cloudTerminalsOf(workspace).terminals.find((item) => item.id === id);
  if (!terminal) return;
  const info = await client.controlPty(terminal.ptyId, size?.cols, size?.rows);
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
  for (const terminal of state[workspace]?.terminals ?? []) disposeInstance(terminal.id);
  if (!(workspace in state)) return;
  const next = { ...state };
  delete next[workspace];
  publish(next);
}

/** Forget every workspace's terminals and views (sign-out, organization switch). */
export function resetCloudTerminals() {
  for (const binding of bindings.values()) binding.attachment?.detach();
  for (const workspace of Object.values(state)) for (const terminal of workspace.terminals) disposeInstance(terminal.id);
  bindings.clear();
  cursors.clear();
  publish({});
}
