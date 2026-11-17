import { cloudAgentLabel } from "@/lib/cloudAgentLabel";
import type { CloudSessionRow, CloudSessionTab } from "@/lib/cloudSessions";
import type { SelectedSessionTab } from "@/lib/terminal";
import type { TabStatus } from "@/types/session";

/**
 * The agent tabs of a cloud session as the sidebar lists them under the
 * session's row (#1172). Agents added to a session with `session.addTab` are
 * tabs of it, so a session with several agents lists each one; a session with
 * one tab stays a single row.
 *
 * Built only from what is already known (`CloudSessionRow.tabs`, the
 * Dashboard's projection, this desktop's tab selection): nothing here
 * connects to, attaches or wakes a workspace.
 */

/** One agent tab of a cloud session, as its row under the session is drawn. */
export interface CloudTabRow {
  tabId: string;
  harness: string;
  /** The tab strip's label: the tab's own title, else the agent's cloud product name. */
  label: string;
  /**
   * The tab's own state: waiting on the person (a question or a pending
   * permission), working, an unread reply (`completed`), or idle. The
   * session row's mark is the most urgent of these.
   */
  status: TabStatus;
  /** The tab the session has in front. Its row is marked only while the session is the selected one. */
  front: boolean;
}

/** What decides the rows beyond the session itself. */
export interface CloudTabRowsInput {
  /**
   * The session's tabs as the Dashboard projects them
   * (`CloudDashboardSession.tabs`), the projection the session row's mark is
   * read from: a tab found here takes this status. Absent or null when the
   * Dashboard does not list the session; each tab then speaks for itself.
   */
  projected?: readonly { tabId: string; status: TabStatus }[] | null;
  /** The tab on screen in this session (`useVisibleSessionTab`), while its view is open. */
  shown?: SelectedSessionTab | null;
  /** The tab asked for in this session on this desktop (`useTerminals().selected[key]`). */
  asked?: SelectedSessionTab | null;
}

/** The props of the rows drawn under a cloud session's row. */
export interface CloudSessionTabRowsProps {
  /** The session's title, naming the group for assistive technology. */
  sessionTitle: string;
  /** The rows, in the session's tab order. Nothing is drawn for an empty list. */
  tabs: readonly CloudTabRow[];
  /** The session is the selected one: only then is its front tab drawn as selected. */
  sessionSelected: boolean;
  /** A row was chosen: open the session with that tab in front. */
  onOpen: (tabId: string) => void;
}

/** One tab's own state; the same rule `cloudSessionStatus` folds over a session's tabs. */
export function cloudTabStatus(tab: CloudSessionTab): TabStatus {
  if (tab.status === "waiting" || tab.pendingApprovals > 0) return "waiting";
  if (tab.status === "in_progress") return "in_progress";
  if (tab.status === "completed" && tab.unread) return "completed";
  return "idle";
}

/** The rows listed under a cloud session: none unless it holds two or more tabs. */
export function cloudTabRows(row: CloudSessionRow, input: CloudTabRowsInput = {}): CloudTabRow[] {
  if (row.tabs.length < 2) return [];
  const has = (id: string | null | undefined) => !!id && row.tabs.some((tab) => tab.tabId === id);
  const agentId = (tab: SelectedSessionTab | null | undefined) => (tab?.kind === "agent" ? tab.id : null);
  let frontId: string | null;
  if (input.shown) frontId = has(agentId(input.shown)) ? agentId(input.shown) : null;
  else if (has(agentId(input.asked))) frontId = agentId(input.asked);
  else if (has(row.activeTab)) frontId = row.activeTab ?? null;
  else frontId = row.tabs[0].tabId;
  const projected = new Map((input.projected ?? []).map((entry) => [entry.tabId, entry.status]));
  return row.tabs.map((tab) => ({
    tabId: tab.tabId,
    harness: tab.harness,
    label: tab.title?.trim() || cloudAgentLabel(tab.harness),
    status: projected.get(tab.tabId) ?? cloudTabStatus(tab),
    front: tab.tabId === frontId,
  }));
}
