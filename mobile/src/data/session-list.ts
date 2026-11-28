import { SESSION_STATUSES, sessionStatus, statusText, type SessionStatusInput, type StatusDescription, type StatusTab } from "@terminalx/portable/sessionStatus";
import { isPlaceholderBranch } from "@terminalx/portable/worktreeNames";
import { conversationLabel, providerName, tabTitle } from "./conversations";
import type { SessionSummary } from "./host-api";
import type { CloudWorkspaceItem } from "../cloud/api";

/** What a chat asks of the reader: an answer, patience, or nothing. The session's tab strip marks its tabs by it. */
export type ChatState = "needs" | "working" | "done";

/**
 * A row's mark, as 22.04 draws it: a spinner, an amber question mark or
 * shield, a green tick, a red triangle, or a grey ring. Which one follows the
 * shared rule the row's status came from, never the words alone: three rules
 * read "Needs approval".
 */
export type RowMark = "working" | "answer" | "approval" | "done" | "failed" | "idle";

/** A row's status: the shared rule the desktop sidebar shows, the mark the phone draws for it, and the words it reads. */
export interface RowStatus {
  status: StatusDescription;
  mark: RowMark;
  /** The sidebar's label (with the PR it is about), except that a question reads "Needs your answer". */
  words: string;
}

/** The rules that wait on the person: an answer, an approval, or a tab waiting with nothing more said. */
const NEEDS_YOU = new Set(["needs_answer", "needs_permission", "review_plan", "needs_attention"]);
const MARKS: Record<string, RowMark> = {
  needs_answer: "answer", needs_attention: "answer",
  needs_permission: "approval", review_plan: "approval",
  setup_failed: "failed", merge_conflict: "failed", checks_failing: "failed",
  merged: "done", ready_to_merge: "done", in_merge_queue: "done",
};

export function rowStatus(status: StatusDescription): RowStatus {
  const mark = MARKS[status.id] ?? (status.icon === "working" ? "working" : "idle");
  return { status, mark, words: status.id === "needs_answer" ? "Needs your answer" : statusText(status) };
}

/** Whether a status waits on the person: what the "Needs you" section and filter hold. */
export const needsYou = (status: StatusDescription) => NEEDS_YOU.has(status.id);

/** One of a session's tabs, as its row lists them when it opens in place. */
export interface TabRow { id: string; name: string; status: RowStatus; /** Last activity, in ms; 0 when unknown. */ time: number }

/** One session in the list. */
export interface ChatRow {
  key: string;
  session: SessionSummary;
  /** The conversation a tap opens: the one waiting on the reader, else the one working, else the first. */
  tabId: string;
  /** The session's title, as the Mac names it: line 1 of the row, never cut for the branch. */
  title: string;
  /** What the Mac's project list calls the row: its branch, or its title when the branch has no real name. */
  name: string;
  /** Whether `name` is a branch. */
  branched: boolean;
  /** The branch, as line 3 of the row shows it; null for a quick chat or a drawn worktree name. */
  branch: string | null;
  /** The status the desktop sidebar shows for the session: its most urgent tab wins. */
  status: RowStatus;
  /** Whether it waits on the person for an answer or an approval. */
  needsYou: boolean;
  /** Pinned on the Mac (#1403); an older Mac sends nothing, which is not pinned. */
  pinned: boolean;
  /** Its place in the Mac's Pinned group while the sidebar is in its custom order; null otherwise. */
  pinnedRank: number | null;
  tabs: TabRow[];
  /** Last activity, in ms; 0 when unknown. */
  time: number;
}

export interface ProjectGroup { project: string; rows: ChatRow[]; latest: number }

export const QUICK_CHATS = "Quick chats";

type SummaryTab = SessionSummary["tabs"][number];

/** A conversation the reader has not seen since it finished, or one they marked unread on the Mac (PRO-179). */
export const tabUnread = (tab: SummaryTab) => !!tab.markedUnread || tab.status === "completed";

const isQuick = (session: SessionSummary) => session.kind === "quick" || session.project === QUICK_CHATS;
const parsedTime = (value?: string) => { const time = value ? Date.parse(value) : NaN; return Number.isFinite(time) ? time : 0; };

/** A row's name by the Mac's rule: its branch, unless that is only a drawn worktree name. An older Mac sends no branch; its worktree's name stands in. */
export function rowName(session: SessionSummary, title: string): { name: string; branched: boolean } {
  if (isQuick(session)) return { name: title, branched: false };
  const branch = session.branch === undefined ? session.worktree || null : session.branch;
  return branch && !isPlaceholderBranch(branch) ? { name: branch, branched: true } : { name: title, branched: false };
}

/**
 * The facts the shared rules read for the session, as the Mac decided them.
 * An older Mac sends none: the tabs' own lifecycle stands in, which the rules
 * read the same way (a waiting tab with no activity needs the person).
 */
const statusInput = (session: SessionSummary): SessionStatusInput => session.rowStatus ?? session;

/** Each tab's agent facts, in the session's tab order; the Mac's when it sent one per tab. */
function tabInputs(session: SessionSummary): StatusTab[] {
  const sent = session.rowStatus?.tabs;
  return session.tabs.map((tab, index) => sent && sent.length === session.tabs.length ? sent[index] : { status: tab.status });
}

/**
 * A tab alone: only its agent's state, as the rules read one tab with nothing
 * about the branch. A tab whose turn has finished shows Done's tick (22.04),
 * where the rules, which read the branch for that, would leave it idle.
 */
function tabRowStatus(fact: StatusTab): RowStatus {
  const status = rowStatus(sessionStatus({ tabs: [fact] }));
  return status.mark === "idle" && fact.status === "completed" ? { ...status, mark: "done" } : status;
}

function chatRow(session: SessionSummary): ChatRow {
  const status = rowStatus(sessionStatus(statusInput(session)));
  const facts = tabInputs(session);
  const chats = branchChats(session);
  const tabs = session.tabs.map((tab, index): TabRow => ({
    id: tab.id,
    name: chats[index].name,
    status: tabRowStatus(facts[index]),
    time: parsedTime(tab.modified),
  }));
  // The tab a tap opens: the most urgent by the same rules, else the first.
  const urgent = facts.map((fact) => sessionStatus({ tabs: [fact] }).id);
  const order = SESSION_STATUSES.map((rule) => rule.id);
  const first = urgent.reduce((best, id, index) => order.indexOf(id) < order.indexOf(urgent[best]) ? index : best, 0);
  const title = session.title?.trim() || (session.tabs[first] ? conversationLabel(session.tabs[first], session.tabs) : "Untitled chat");
  const named = rowName(session, title);
  return {
    key: session.id,
    session,
    tabId: session.tabs[first]?.id ?? "",
    title,
    ...named,
    branch: named.branched ? named.name : null,
    status,
    needsYou: needsYou(status.status),
    pinned: session.pinned === true,
    pinnedRank: session.pinned === true && typeof session.pinnedRank === "number" && Number.isFinite(session.pinnedRank) ? session.pinnedRank : null,
    tabs,
    time: parsedTime(session.modified),
  };
}

function matches(session: SessionSummary, words: string[]): boolean {
  if (!words.length) return true;
  const value = [session.title, session.branch, session.project, session.worktree, session.issueRef, session.lastPrompt, session.lastReply,
    ...session.tabs.map((tab) => conversationLabel(tab, session.tabs))].join(" ").toLowerCase();
  return words.every((word) => value.includes(word));
}

/** Every session with a conversation to open, those waiting on the person first, then by last activity. */
export function chatRows(sessions: SessionSummary[], query = ""): ChatRow[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return sessions.filter((session) => session.tabs.length > 0 && matches(session, words)).map(chatRow)
    .sort((left, right) => Number(right.needsYou) - Number(left.needsYou) || right.time - left.time);
}

/** The sessions by project: the most recently active project first, quick chats last. */
export function projectGroups(rows: ChatRow[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const row of rows) {
    const project = isQuick(row.session) ? QUICK_CHATS : row.session.project || "Other";
    const group = groups.get(project) ?? { project, rows: [], latest: 0 };
    group.rows.push(row);
    group.latest = Math.max(group.latest, row.time);
    groups.set(project, group);
  }
  return [...groups.values()].sort((left, right) => Number(left.project === QUICK_CHATS) - Number(right.project === QUICK_CHATS) || right.latest - left.latest);
}

/** The list's filters: every session, those waiting on the person, those whose agent works. */
export type ListFilter = "all" | "needs" | "working";
export const LIST_FILTERS: readonly { id: ListFilter; label: string }[] = [{ id: "all", label: "All" }, { id: "needs", label: "Needs you" }, { id: "working", label: "Working" }];

const inFilter = (row: ChatRow, filter: ListFilter) => filter === "all" || (filter === "needs" ? row.needsYou : row.status.mark === "working");

export function filterCounts(rows: ChatRow[]): Record<ListFilter, number> {
  return { all: rows.length, needs: rows.filter((row) => inFilter(row, "needs")).length, working: rows.filter((row) => inFilter(row, "working")).length };
}

/** A run of rows under a heading; an empty title has none. */
export interface RowSection<Row = ChatRow> { key: string; title: string; data: Row[] }

/** The Pinned section's key: the screen draws its header with a pin. */
export const PINNED_SECTION = "pinned";

/**
 * The Pinned section's order, as the Mac's Pinned group has it: its custom
 * order while the sidebar is in one (rows the Mac has not placed yet first,
 * newest first, as it places them), else the newest activity first.
 */
export function pinnedOrder(rows: ChatRow[]): ChatRow[] {
  const custom = rows.some((row) => row.pinnedRank !== null);
  return [...rows].sort((left, right) => custom
    ? (left.pinnedRank ?? -1) - (right.pinnedRank ?? -1) || right.time - left.time
    : right.time - left.time);
}

/**
 * The list as 22.04 lays it out. Under All, what waits on the person comes
 * first in its own section, across projects; then what the Mac pinned, out
 * of its project as on the Mac's sidebar (#1403); and the rest stay by
 * project. A pinned session waiting on the person is in "Needs you" only, so
 * no session is listed twice. "Needs you" is that section alone; "Working"
 * and a search keep their rows by project, pinned ones among them.
 */
export function listSections(rows: ChatRow[], filter: ListFilter, searching = false): RowSection[] {
  const shown = rows.filter((row) => inFilter(row, filter));
  if (filter === "needs") return shown.length ? [{ key: "needs", title: "", data: shown }] : [];
  const all = filter === "all";
  const waiting = all ? shown.filter((row) => row.needsYou) : [];
  const pinned = all && !searching ? pinnedOrder(shown.filter((row) => !row.needsYou && row.pinned)) : [];
  const rest = all ? shown.filter((row) => !row.needsYou && !(row.pinned && !searching)) : shown;
  return [
    ...(waiting.length ? [{ key: "needs", title: "Needs you", data: waiting }] : []),
    ...(pinned.length ? [{ key: PINNED_SECTION, title: "Pinned", data: pinned }] : []),
    ...projectGroups(rest).map((group) => ({ key: `project:${group.project}`, title: group.project, data: group.rows })),
  ];
}

/** A cloud workspace of a project the Mac pinned, as the Pinned section lists it beside the Mac's own sessions. */
export interface CloudPinRow {
  kind: "cloud";
  key: string;
  orgId: string;
  /** The pinned project's repository identity, as the Mac names it. */
  identity: string;
  item: CloudWorkspaceItem;
  title: string;
  /** Last activity, in ms; 0 when unknown. */
  time: number;
}

export type ListRow = ChatRow | CloudPinRow;
export const isCloudRow = (row: ListRow): row is CloudPinRow => "kind" in row && row.kind === "cloud";

/**
 * The sections with the pinned cloud workspaces added to Pinned (#1403),
 * which is made for them after "Needs you" when nothing of the Mac's own is
 * pinned. In the Mac's custom order its own sessions keep their places and
 * the cloud ones follow; otherwise all go by their latest activity. Only the
 * All list, out of a search, has a Pinned section.
 */
export function withPinnedCloud(sections: RowSection[], cloud: CloudPinRow[], filter: ListFilter, searching = false): RowSection<ListRow>[] {
  if (filter !== "all" || searching || !cloud.length) return sections;
  const byTime = [...cloud].sort((left, right) => right.time - left.time);
  const at = sections.findIndex((section) => section.key === PINNED_SECTION);
  if (at < 0) {
    const after = sections[0]?.key === "needs" ? 1 : 0;
    return [...sections.slice(0, after), { key: PINNED_SECTION, title: "Pinned", data: byTime }, ...sections.slice(after)];
  }
  const own = sections[at].data;
  const custom = own.some((row) => row.pinnedRank !== null);
  const data: ListRow[] = custom ? [...own, ...byTime] : [...own, ...byTime].sort((left, right) => right.time - left.time);
  return sections.map((section, index) => index === at ? { ...section, data } : section);
}

const WEEKDAY_SHORT_FMT = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const MONTH_DAY_FMT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const SHORT_DATE_FMT = new Intl.DateTimeFormat(undefined, { year: "2-digit", month: "numeric", day: "numeric" });
const SPOKEN_DATE_FMT = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });

/** When, as a chat list says it: "now", "5m", "3h", a weekday, then a date. */
export function shortTime(time: number, now = Date.now()): string {
  if (!time) return "";
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const date = new Date(time);
  if (hours < 24 * 6) return WEEKDAY_SHORT_FMT.format(date);
  if (date.getFullYear() === new Date(now).getFullYear()) return MONTH_DAY_FMT.format(date);
  return SHORT_DATE_FMT.format(date);
}

/**
 * When, said after a status where there is room (the Cloud list, 22.06):
 * as `shortTime` within the day, then "2 days ago" for the week, then the date.
 */
export function agoTime(time: number, now = Date.now()): string {
  if (!time) return "";
  const days = Math.floor((now - time) / 86_400_000);
  if (days < 1 || days >= 7) return shortTime(time, now);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** When, as VoiceOver should say it: "active now", "active 5 minutes ago", then the day. */
export function spokenTime(time: number, now = Date.now()): string {
  if (!time) return "";
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return "active now";
  if (minutes < 60) return `active ${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `active ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  return `active ${SPOKEN_DATE_FMT.format(new Date(time))}`;
}

/** One of the chats a branch holds: a tab on the Mac. */
export interface BranchChat { id: string; name: string; harness: string; state: ChatState; unread: boolean }

/**
 * The chats a branch holds, as the Mac's tab strip lists them: each by the
 * name made for it, else its own title, else its agent's name.
 */
export function branchChats(session: SessionSummary): BranchChat[] {
  return session.tabs.map((tab) => {
    const title = tabTitle(tab);
    const own = title && title !== providerName(tab.harness);
    return {
      id: tab.id,
      name: own ? title : conversationLabel(tab, session.tabs),
      harness: tab.harness,
      state: tab.status === "waiting" ? "needs" : tab.status === "in_progress" ? "working" : "done",
      unread: tabUnread(tab),
    };
  });
}
