import type { WorkspaceConnectionState } from "@terminalx/portable/workspace";
import type { CloudWorkspaceListItem } from "@/lib/api";
import { phaseOf, PHASES, settled } from "@/lib/cloudCreate";
import { archiving, deletion, isArchived, isOpen } from "@/lib/cloudLifecycle";
import type { TabStatus } from "@/types/session";

/**
 * The one place a cloud row's state is decided (PRO-23 row-state table).
 * The first matching condition wins:
 *
 * 1. archived, being deleted or archived → Archived, Deleting, Archiving
 * 2. attention required, a failed launch or delete, a runtime update → Needs attention
 * 3. an operation running → Stopping, Resuming
 * 4. provisioning → Starting: <launch phase>
 * 5. suspended → Stopped, even if the cache says a tab was working
 * 6. the connection opening or reconnecting → Connecting
 * 7. tab states: waiting or pending approvals → Needs you; in progress while
 *    connected, or the server's `activeTurns > 0` → Working; completed and
 *    unread → Done; else → Idle (a workspace with no tab state reads Ready)
 *
 * A state known only from the cache is marked `lastKnown`.
 */

export type RowTone = "ready" | "stopped" | "changing" | "attention" | "archived" | "needs-you" | "working" | "done" | "idle";

export interface CloudActivity {
  label: string;
  tone: RowTone;
  /** The status a session row's stripe shows; never `in_progress` for a stopped workspace. */
  status: TabStatus;
  /** Derived only from cached data. */
  lastKnown: boolean;
}

export interface ActivityInput {
  /** The live connection's state, when one is held. */
  connection?: WorkspaceConnectionState["state"] | null;
  /** The tabs to judge (one session's, or every session's for a workspace row). */
  tabs?: readonly { status: TabStatus; unread?: boolean; pendingApprovals?: number; live?: boolean }[];
  /** The tab states come from the cache or a checkpoint, not the live runtime. */
  fromCache?: boolean;
}

const idle = (label: string, tone: RowTone, lastKnown = false): CloudActivity => ({ label, tone, status: "idle", lastKnown });

export function deriveCloudActivity(item: CloudWorkspaceListItem, input: ActivityInput = {}): CloudActivity {
  const { state, launch } = item.workspace;
  const operation = item.latestOperation;
  // 1
  if (deletion(item) === "running") return idle("Deleting", "changing");
  if (archiving(item)) return idle("Archiving", "changing");
  if (state === "archived" || state === "destroyed") return idle("Archived", "archived");
  // 2
  const phase = phaseOf(item);
  if (state === "attention-required" || (launch && phase === "failed") || deletion(item) === "failed" || input.connection === "updateRequired") {
    return idle("Needs attention", "attention");
  }
  // 3
  if (isOpen(operation) && operation?.action === "suspend") return idle("Stopping", "changing");
  if (isOpen(operation) && operation?.action === "resume") return idle("Resuming", "changing");
  // 4
  if (state === "provisioning" || (launch && !settled(phase))) {
    const label = PHASES.find((p) => p.id === phase)?.label ?? phase;
    return idle(`Starting: ${label.replace(/…$/, "").toLowerCase()}`, "changing");
  }
  // 5
  if (state === "suspended") return idle("Stopped", "stopped", !!input.fromCache);
  if (isArchived(item.workspace)) return idle("Archived", "archived");
  // 6
  if (input.connection === "opening" || input.connection === "connecting" || input.connection === "reconnecting" || input.connection === "waitingForRuntime") {
    return idle("Connecting", "changing");
  }
  // 7
  const tabs = input.tabs ?? [];
  const connected = input.connection === "connected";
  const runtime = item.workspace.runtimeActivity;
  const lastKnown = !connected && !!input.fromCache;
  if (tabs.some((tab) => tab.status === "waiting" || (tab.pendingApprovals ?? 0) > 0) || (runtime?.online && runtime.pendingApprovals > 0)) {
    return { label: "Needs you", tone: "needs-you", status: "waiting", lastKnown };
  }
  const working = tabs.some((tab) => tab.status === "in_progress" && (connected || tab.live || !input.fromCache));
  if (working || (runtime?.online && runtime.activeTurns > 0)) return { label: "Working", tone: "working", status: "in_progress", lastKnown: false };
  if (tabs.some((tab) => tab.status === "completed" && tab.unread !== false)) return { label: "Done", tone: "done", status: "completed", lastKnown };
  if (tabs.length) return { label: "Idle", tone: "idle", status: "idle", lastKnown };
  return idle("Ready", "ready");
}

/** Most urgent first, for a workspace or project that shows the state of what is under it. */
const URGENCY: RowTone[] = ["attention", "needs-you", "working", "changing", "done", "idle", "ready", "stopped", "archived"];

export function mostUrgent(activities: readonly CloudActivity[]): CloudActivity | null {
  let best: CloudActivity | null = null;
  for (const activity of activities) {
    if (!best || URGENCY.indexOf(activity.tone) < URGENCY.indexOf(best.tone)) best = activity;
  }
  return best;
}
