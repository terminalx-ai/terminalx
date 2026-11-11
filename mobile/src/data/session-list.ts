import { projectHueByName } from "@terminalx/portable/botFace";
import { isPlaceholderBranch } from "@terminalx/portable/worktreeNames";
import { conversationLabel, providerName } from "./conversations";
import type { SessionSummary } from "./host-api";

/** What a chat asks of the reader: an answer, patience, or nothing. */
export type ChatState = "needs" | "working" | "done";

/** One chat in the list: a session on the Mac, as the desktop's chat list shows it. */
export interface ChatRow {
  key: string;
  session: SessionSummary;
  /** The conversation a tap opens: the one waiting on the reader, else the one working, else the first. */
  tabId: string;
  /** The chat's title, as the Mac names the conversation. */
  title: string;
  /** What the row is called, as the Mac's project list calls it: its branch, or its title when the branch has no real name. */
  name: string;
  /** Whether `name` is a branch. */
  branched: boolean;
  /** What was last said in it, on one line; else where it is. */
  preview: string;
  state: ChatState;
  /** Whether a conversation in it is unread: a finished turn not yet opened, or one marked unread on the Mac. */
  unread: boolean;
  /** Last activity, in ms; 0 when unknown. */
  time: number;
  /** The face's colour: its project's, or none for a quick chat, which takes its own. */
  color: string | null;
}

export interface ProjectGroup { project: string; color: string | null; rows: ChatRow[]; latest: number; needs: number }

export const QUICK_CHATS = "Quick chats";

export function chatState(session: SessionSummary): ChatState {
  if (session.tabs.some((tab) => tab.status === "waiting")) return "needs";
  if (session.tabs.some((tab) => tab.status === "in_progress")) return "working";
  return "done";
}

type SummaryTab = SessionSummary["tabs"][number];

/** A conversation the reader has not seen since it finished, or one they marked unread on the Mac (PRO-179). */
export const tabUnread = (tab: SummaryTab) => !!tab.markedUnread || tab.status === "completed";

const isQuick = (session: SessionSummary) => session.kind === "quick" || session.project === QUICK_CHATS;

/** A row's name by the Mac's rule: its branch, unless that is only a drawn worktree name. An older Mac sends no branch; its worktree's name stands in. */
export function rowName(session: SessionSummary, title: string): { name: string; branched: boolean } {
  if (isQuick(session)) return { name: title, branched: false };
  const branch = session.branch === undefined ? session.worktree || null : session.branch;
  return branch && !isPlaceholderBranch(branch) ? { name: branch, branched: true } : { name: title, branched: false };
}
const firstLine = (text?: string) => text?.replace(/\s+/g, " ").trim() || undefined;

function chatRow(session: SessionSummary): ChatRow {
  const state = chatState(session);
  const tab = session.tabs.find((item) => item.status === "waiting") ?? session.tabs.find((item) => item.status === "in_progress") ?? session.tabs[0];
  const said = firstLine(session.lastReply) ?? firstLine(session.lastPrompt);
  const place = isQuick(session) ? undefined : [session.project, session.worktree].filter(Boolean).join(" · ");
  const time = Date.parse(session.modified);
  const title = session.title?.trim() || (tab ? conversationLabel(tab, session.tabs) : "Untitled chat");
  return {
    key: session.id,
    session,
    tabId: tab?.id ?? "",
    title,
    ...rowName(session, title),
    preview: said ?? place ?? "",
    state,
    unread: session.tabs.some(tabUnread),
    time: Number.isFinite(time) ? time : 0,
    color: isQuick(session) ? null : projectHueByName(session.project),
  };
}

function matches(session: SessionSummary, words: string[]): boolean {
  if (!words.length) return true;
  const value = [session.title, session.branch, session.project, session.worktree, session.issueRef, session.lastPrompt, session.lastReply,
    ...session.tabs.map((tab) => conversationLabel(tab, session.tabs))].join(" ").toLowerCase();
  return words.every((word) => value.includes(word));
}

/** Every chat with a conversation to open, those waiting on the reader first, then the most recent. */
export function chatRows(sessions: SessionSummary[], query = ""): ChatRow[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return sessions.filter((session) => session.tabs.length > 0 && matches(session, words)).map(chatRow)
    .sort((left, right) => Number(right.state === "needs") - Number(left.state === "needs") || right.time - left.time);
}

/** The chats by project, as channels: the most recently active project first, quick chats last. */
export function projectGroups(rows: ChatRow[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const row of rows) {
    const project = isQuick(row.session) ? QUICK_CHATS : row.session.project || "Other";
    const group = groups.get(project) ?? { project, color: row.color, rows: [], latest: 0, needs: 0 };
    group.rows.push(row);
    group.latest = Math.max(group.latest, row.time);
    if (row.state === "needs") group.needs += 1;
    groups.set(project, group);
  }
  return [...groups.values()].sort((left, right) => Number(left.project === QUICK_CHATS) - Number(right.project === QUICK_CHATS) || right.latest - left.latest);
}

/** When, as a chat list says it: "now", "5m", "3h", a weekday, then a date. */
export function shortTime(time: number, now = Date.now()): string {
  if (!time) return "";
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const date = new Date(time);
  if (hours < 24 * 6) return date.toLocaleDateString(undefined, { weekday: "short" });
  if (date.getFullYear() === new Date(now).getFullYear()) return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return date.toLocaleDateString(undefined, { year: "2-digit", month: "numeric", day: "numeric" });
}

/** One of the chats a branch holds: a tab on the Mac. */
export interface BranchChat { id: string; name: string; harness: string; state: ChatState; unread: boolean }

/** The chats a branch holds, as the Mac's tab strip lists them: each by its own title, else its agent's name. */
export function branchChats(session: SessionSummary): BranchChat[] {
  return session.tabs.map((tab) => {
    const title = tab.title?.trim();
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
