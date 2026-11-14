import { listen } from "@tauri-apps/api/event";
import { actions, type ActionRun, type ActionRunOutcome } from "@/lib/api";

export type { ActionRun, ActionRunOutcome };

/** Sent as `{ sessionId, paneId }` once a run's exit code is known. */
export const ACTION_STATE_EVENT = "action_state_changed";

/** Whether `paneId` is a terminal tab that runs one of `sessionId`'s saved actions. */
export function isActionPane(sessionId: string, paneId: string): boolean {
  return paneId.startsWith(`${sessionId}:action-`);
}

/**
 * Start a saved action in a terminal tab of a local session. For an action
 * without "Allow several at once" that is already running, nothing starts:
 * the outcome's `started` is false and its `run` is the tab to focus, unless
 * `restart` is set, which stops that run and starts a new one.
 */
export function runAction(sessionId: string, actionId: string, options: { restart?: boolean } = {}): Promise<ActionRunOutcome> {
  return actions.run(sessionId, actionId, options.restart ?? false);
}

/** The session's runs, oldest first: one per action tab still open, running or exited. */
export function actionStates(sessionId: string): Promise<ActionRun[]> {
  return actions.states(sessionId);
}

/** The run to show per action: its running one, else its latest exited one. */
export function latestByAction(runs: readonly ActionRun[]): Map<string, ActionRun> {
  const latest = new Map<string, ActionRun>();
  for (const run of runs) {
    const known = latest.get(run.actionId);
    if (!known || run.state === "running" || known.state !== "running") latest.set(run.actionId, run);
  }
  return latest;
}

/**
 * Follow one session's runs: `onChange` gets the full list once it is read,
 * then again after each change to one of its action tabs (opened, exited,
 * closed). Changes that arrive during a read are read again after it, so the
 * last list handed on is never older than the last change. Returns a stop
 * function.
 */
export async function watchActionStates(sessionId: string, onChange: (runs: ActionRun[]) => void): Promise<() => void> {
  let stopped = false;
  let reading: Promise<void> | null = null;
  let again = false;
  const read = (): Promise<void> => {
    if (reading) { again = true; return reading; }
    reading = (async () => {
      try {
        do {
          again = false;
          const runs = await actionStates(sessionId);
          if (!stopped && !again) onChange(runs);
        } while (again && !stopped);
      } finally {
        reading = null;
      }
    })();
    return reading;
  };
  const changed = (paneId: unknown) => {
    if (!stopped && typeof paneId === "string" && isActionPane(sessionId, paneId)) void read().catch(() => {});
  };
  const stops = await Promise.all([
    listen<{ paneId: string }>(ACTION_STATE_EVENT, ({ payload }) => changed(payload?.paneId)),
    listen<{ id: string }>("pty_opened", ({ payload }) => changed(payload?.id)),
    listen<{ id: string }>("pty_exit", ({ payload }) => changed(payload?.id)),
    listen<string>("pty_closed", ({ payload }) => changed(payload)),
    // Events were missed: whatever changed meanwhile is read afresh.
    listen("local_runtime_reattached", () => { if (!stopped) void read().catch(() => {}); }),
  ]);
  const stop = () => { stopped = true; for (const unlisten of stops) unlisten(); };
  try {
    await read();
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}
