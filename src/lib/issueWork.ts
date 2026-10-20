import { useEffect, useMemo, useRef, useState } from "react";
import { workStatus, type Issue, type WorkClaim, type WorkClaimsAnswer } from "@/lib/api";
import { sessionStatus, type IssueLinkSource, type IssueRef, type SessionEntry } from "@/types/session";

/**
 * Who is working on an issue (#441): this Mac's own sessions linked to it,
 * the reader's other machines and cloud sessions, and teammates, as the
 * account service shows them (`work_claims.rs`).
 *
 * Work ages. While its machine still refreshes it, a claim whose agent is
 * working or waiting, or that was active in the last half hour, is someone
 * working on the issue *now*. Otherwise it fades to "was working on this,
 * <age> ago", and after a day it is gone. A machine that went offline keeps
 * its last state with its age; it never shows as working now.
 */

/** Active this recently, an idle claim still counts as working. */
export const RECENT_MS = 30 * 60 * 1000;
/** Idle this long, a claim is not shown at all. */
export const FORGET_MS = 24 * 60 * 60 * 1000;
/** How often the Issues list reads the claims again while it is open. */
export const POLL_MS = 20 * 1000;

export type WorkState = "working" | "waiting" | "idle" | "pull_request";
/** `now`: working on it now; `faded`: was, a while ago. */
export type WorkPhase = "now" | "faded";
/** This Mac, another of the reader's machines, the reader's cloud session, a teammate. */
export type WorkPlace = "this" | "machine" | "cloud" | "team";

export interface IssueWorker {
  key: string;
  place: WorkPlace;
  you: boolean;
  /** "You", or the teammate's name. */
  person: string;
  /** The reader's own machine's name; never a teammate's. */
  machine: string | null;
  /** A teammate's session in a cloud workspace. */
  cloud: boolean;
  title: string;
  branch: string | null;
  state: WorkState;
  phase: WorkPhase;
  /** Local clock, epoch milliseconds. */
  since: number;
  lastActive: number;
  /** The session on this Mac, which can be opened. */
  sessionId: string | null;
  /** How this Mac's session got its link, when not started on the issue. */
  link: IssueLinkSource | null;
}

/**
 * Where an issue lives, from its URL, as the claims name it
 * (`work_claims::claims::issue_scope`): `github.com/<owner>/<repo>` or
 * `linear.app/<workspace>`, lower case. Null for any other address.
 */
export function issueScope(provider: string, url: string): string | null {
  const rest = url.trim().split("://")[1];
  if (!rest) return null;
  const [host, ...parts] = rest.split(/[/?#]/);
  const name = (part: string | undefined, max: number, extra = "") => !!part && part.length <= max && new RegExp(`^[a-z0-9-${extra}]+$`).test(part);
  if (provider === "github") {
    const [owner, repo, kind] = parts.map((part) => part.toLowerCase());
    return host.toLowerCase() === "github.com" && kind === parts[2] && kind === "issues" && name(owner, 39) && name(repo, 100, "._") ? `github.com/${owner}/${repo}` : null;
  }
  if (provider === "linear") {
    const workspace = parts[0]?.toLowerCase();
    return host.toLowerCase() === "linear.app" && parts[1] === "issue" && name(workspace, 64) ? `linear.app/${workspace}` : null;
  }
  return null;
}

/**
 * How an issue is named across machines: its provider, where it lives, and
 * `#441` or `ENG-42`. Two repositories' `#12` are two issues; an address no
 * scope can be read from names only itself.
 */
export function issueWorkKey(provider: string, scope: string, identifier: string): string {
  const id = identifier.trim().toUpperCase();
  return `${provider}:${scope.toLowerCase()}:${provider === "github" && !id.startsWith("#") ? `#${id}` : id}`;
}

/** The key of an issue (or a session's issue reference) as its tracker lists it. */
export function workKeyOf(issue: Pick<IssueRef, "provider" | "identifier" | "url">): string {
  return issueWorkKey(issue.provider, issueScope(issue.provider, issue.url) ?? `url:${issue.url}`, issue.identifier);
}

function workState(state: string): WorkState {
  return state === "working" || state === "waiting" || state === "pull_request" ? state : "idle";
}

function phaseOf(state: WorkState, lastActive: number, now: number, live: boolean): WorkPhase | null {
  if (now - lastActive >= FORGET_MS && !(live && (state === "working" || state === "waiting"))) return null;
  if (!live) return "faded";
  if (state === "working" || state === "waiting") return "now";
  return now - lastActive < RECENT_MS ? "now" : "faded";
}

function localState(session: SessionEntry): WorkState {
  const status = sessionStatus(session);
  return status === "in_progress" ? "working" : status === "waiting" ? "waiting" : "idle";
}

function lastActiveOf(session: SessionEntry): number {
  const times = [session.modified, ...session.tabs.map((tab) => tab.modified)].map((time) => Date.parse(time)).filter((time) => !Number.isNaN(time));
  return times.length ? Math.max(...times) : 0;
}

/**
 * This Mac's sessions working on `issue`. They are shown however long ago
 * they were active, as the "Session" chip always was: they can be opened.
 */
export function localWorkers(sessions: SessionEntry[], issue: Pick<IssueRef, "provider" | "identifier" | "url">, now = Date.now()): IssueWorker[] {
  const key = workKeyOf(issue);
  return sessions
    .filter((session) => !session.archived && session.kind !== "quick" && !!session.issue && workKeyOf(session.issue) === key)
    .map((session) => {
      const state = localState(session);
      const lastActive = lastActiveOf(session);
      return {
        key: `this:${session.id}`,
        place: "this" as const,
        you: true,
        person: "You",
        machine: "this Mac",
        cloud: false,
        title: session.title,
        branch: session.branch ?? null,
        state,
        phase: phaseOf(state, lastActive, now, true) ?? "faded",
        since: Date.parse(session.created) || lastActive,
        lastActive,
        sessionId: session.id,
        link: session.issueWork?.link ?? null,
      };
    });
}

/** The claims of an answer, on the local clock. `receivedAt` is when it came. */
export function remoteWorkers(answer: WorkClaimsAnswer | null, receivedAt: number, now = Date.now()): Map<string, IssueWorker[]> {
  const out = new Map<string, IssueWorker[]>();
  if (!answer?.available) return out;
  const offset = receivedAt - answer.now;
  const seen = new Map<string, { issue: string; worker: IssueWorker }>();
  for (const claim of answer.claims) {
    const worker = remoteWorker(claim, offset, now);
    if (!worker) continue;
    // Each of the reader's machines publishes the cloud sessions it knows: one is enough.
    const known = seen.get(worker.key);
    if (known && known.worker.lastActive >= worker.lastActive) continue;
    seen.set(worker.key, { issue: issueWorkKey(claim.issue.provider, claim.scope, claim.issue.identifier), worker });
  }
  for (const { issue, worker } of seen.values()) out.set(issue, [...(out.get(issue) ?? []), worker]);
  return out;
}

function remoteWorker(claim: WorkClaim, offset: number, now: number): IssueWorker | null {
  const state = workState(claim.state);
  const lastActive = claim.lastActiveAt + offset;
  const phase = phaseOf(state, lastActive, now, claim.live);
  if (!phase) return null;
  const you = claim.person.you;
  const place: WorkPlace = !you ? "team" : claim.cloud ? "cloud" : "machine";
  // The server's key names a person's session, the same from each of their Macs; an older server sends none.
  const id = claim.key
    ? `key:${claim.key}`
    : you && claim.cloud
      ? `cloud:${claim.sessionId}`
      : you
        ? `machine:${claim.device?.id}:${claim.sessionId}`
        : `team:${claim.person.name}:${claim.since}:${claim.branch ?? ""}:${claim.title}`;
  return {
    key: id,
    place,
    you,
    person: you ? "You" : claim.person.name,
    machine: place === "machine" ? (claim.device?.label ?? "another machine") : null,
    cloud: claim.cloud,
    title: claim.title,
    branch: claim.branch ?? null,
    state,
    phase,
    since: claim.since + offset,
    lastActive,
    sessionId: null,
    link: null,
  };
}

const PLACE_ORDER: Record<WorkPlace, number> = { team: 0, machine: 1, cloud: 2, this: 3 };

/** Who works on an issue, the most telling first: now before a while ago, others before this Mac. */
export function sortWorkers(workers: IssueWorker[]): IssueWorker[] {
  return [...workers].sort((a, b) => (a.phase === b.phase ? 0 : a.phase === "now" ? -1 : 1) || PLACE_ORDER[a.place] - PLACE_ORDER[b.place] || b.lastActive - a.lastActive);
}

/** Closed issues show nobody: the work on them is over. */
export function issueClosed(issue: Pick<Issue, "stateType" | "state">): boolean {
  return !!issue.state && (issue.stateType === "completed" || issue.stateType === "canceled");
}

/** Everyone working on each issue, by `workKeyOf`. */
export function workersByIssue(issues: Issue[], sessions: SessionEntry[], remote: Map<string, IssueWorker[]>, now = Date.now()): Map<string, IssueWorker[]> {
  const out = new Map<string, IssueWorker[]>();
  for (const issue of issues) {
    if (issueClosed(issue)) continue;
    const key = workKeyOf(issue);
    const workers = sortWorkers([...localWorkers(sessions, issue, now), ...(remote.get(key) ?? [])]);
    if (workers.length) out.set(key, workers);
  }
  return out;
}

/** Someone works on it now, this Mac included. */
export function taken(workers: IssueWorker[] | undefined): boolean {
  return !!workers?.some((worker) => worker.phase === "now");
}

/** The reader works on it, on any machine. */
export function mine(workers: IssueWorker[] | undefined): boolean {
  return !!workers?.some((worker) => worker.you);
}

/** Work elsewhere to warn about before another session starts on the issue: anyone working on it now. */
export function workToWarnAbout(workers: IssueWorker[] | undefined): IssueWorker[] {
  return sortWorkers((workers ?? []).filter((worker) => worker.phase === "now"));
}

/** "5 minutes ago", "2 hours ago", "3 days ago". */
export function ago(time: number, now = Date.now()): string {
  const minutes = Math.round(Math.max(0, now - time) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** A moment as "10:42" today, else "Oct 12, 10:42". */
export function at(time: number, now = Date.now()): string {
  const date = new Date(time);
  const clock = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === new Date(now).toDateString() ? clock : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${clock}`;
}

/** Where, for the reader: "this Mac", "Studio", "the cloud"; nothing of a teammate's machine. */
function where(worker: IssueWorker): string | null {
  if (worker.place === "this") return "this Mac";
  if (worker.place === "machine") return worker.machine;
  if (worker.place === "cloud" || worker.cloud) return "the cloud";
  return null;
}

/** The chip: "You · this Mac", "You · on Studio", "Alice · working", or a faded "Alice · 2 hours ago". */
export function workerLabel(worker: IssueWorker, now = Date.now()): string {
  if (worker.phase === "faded" && worker.place !== "this") return `${worker.person} · ${ago(worker.lastActive, now)}`;
  if (worker.place === "this") return "You · this Mac";
  if (worker.place === "machine") return `You · on ${worker.machine}`;
  if (worker.place === "cloud") return "You · in the cloud";
  return `${worker.person} · ${worker.cloud ? "working in the cloud" : "working"}`;
}

const STATE_TEXT: Record<WorkState, string> = {
  working: "Agent working",
  waiting: "Waiting for an answer",
  idle: "Idle",
  pull_request: "Has an open pull request",
};

export function stateText(state: WorkState): string {
  return STATE_TEXT[state];
}

const LINK_TEXT: Record<IssueLinkSource, string> = {
  branch: "Linked from its branch name",
  pull_request: "Linked from its pull request",
  prompt: "Linked from its first prompt",
  manual: "Linked by hand",
};

export function linkText(link: IssueLinkSource): string {
  return LINK_TEXT[link];
}

/** The warning before starting on a taken issue: "Alice has been working on this since 10:42, on branch alice/12." */
export function warningText(worker: IssueWorker, now = Date.now()): string {
  const who = worker.you ? "You have" : `${worker.person} has`;
  const place = where(worker);
  const on = place ? ` on ${place}` : "";
  const branch = worker.branch ? `, on branch ${worker.branch}` : "";
  return `${who} been working on this${on} since ${at(worker.since, now)}${branch}.`;
}

/** Why the shared status cannot be shown, or null when it can. */
export function unavailableText(answer: WorkClaimsAnswer | null): string | null {
  if (!answer || answer.available) return null;
  switch (answer.reason) {
    case "signed_out":
      return "Sign in to see work on your other machines and your team’s. Showing this Mac only.";
    case "offline":
      return "Shared work status is unavailable offline. Showing this Mac only.";
    default:
      return "Shared work status is unavailable. Showing this Mac only.";
  }
}

/**
 * The claims on `issueUrls` in a project, read now and every `POLL_MS` while
 * mounted and the window is visible, so work elsewhere appears without a
 * refresh. `refreshKey` reads again at once.
 */
export function useWorkClaims(projectPath: string | null | undefined, provider: string, issueUrls: string[], refreshKey: unknown = 0, every = POLL_MS): { answer: WorkClaimsAnswer | null; receivedAt: number } {
  const [read, setRead] = useState<{ answer: WorkClaimsAnswer | null; receivedAt: number; of: string }>({ answer: null, receivedAt: 0, of: "" });
  const urls = useMemo(() => [...new Set(issueUrls)].sort(), [issueUrls]);
  const urlsKey = urls.join("\n");
  const of = `${projectPath}\n${provider}\n${urlsKey}`;
  const asking = useRef(0);
  useEffect(() => {
    if (!projectPath || urls.length === 0) return;
    let live = true;
    const ask = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const n = ++asking.current;
      // Through a promise of its own: a stand-in backend may answer nothing at all.
      Promise.resolve()
        .then(() => workStatus.claims(projectPath, provider, urls))
        .then((answer) => live && n === asking.current && setRead({ answer, receivedAt: Date.now(), of }))
        .catch(() => live && n === asking.current && setRead({ answer: { available: false, reason: "unavailable", now: Date.now(), liveForSeconds: 300, claims: [] }, receivedAt: Date.now(), of }));
    };
    ask();
    const timer = window.setInterval(ask, every);
    const visible = () => document.visibilityState === "visible" && ask();
    document.addEventListener("visibilitychange", visible);
    return () => {
      live = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
    // `urls` is named by `urlsKey`.
  }, [projectPath, provider, urlsKey, refreshKey, every]);
  return read.of === of ? read : { answer: null, receivedAt: 0 };
}

/** Everyone working on the issues shown, this Mac's sessions included, refreshed as both change. */
export function useIssueWork(projectPath: string | null | undefined, provider: string, issues: Issue[], sessions: SessionEntry[], refreshKey: unknown = 0) {
  const urls = useMemo(() => issues.filter((issue) => !issueClosed(issue)).map((issue) => issue.url), [issues]);
  const { answer, receivedAt } = useWorkClaims(projectPath, provider, urls, refreshKey);
  // Ages move on with the clock, not only when something is read.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => window.clearInterval(timer);
  }, []);
  const remote = useMemo(() => remoteWorkers(answer, receivedAt, now), [answer, receivedAt, now]);
  const byIssue = useMemo(() => workersByIssue(issues, sessions, remote, now), [issues, sessions, remote, now]);
  return { byIssue, answer, now };
}

/**
 * Who else works on a session's issue now: the reader's other sessions and
 * machines, and teammates. For the issue chip in the session's title bar.
 */
export function useOthersOnIssue(session: SessionEntry | null | undefined, sessions: SessionEntry[]): { workers: IssueWorker[]; now: number } {
  const issue = session?.issue ?? null;
  const urls = useMemo(() => (issue ? [issue.url] : []), [issue?.url]);
  const { answer, receivedAt } = useWorkClaims(issue ? session?.projectPath : null, issue?.provider ?? "github", urls, 0, 60 * 1000);
  const now = receivedAt || Date.now();
  const workers = useMemo(() => {
    if (!issue || !session) return [];
    const key = workKeyOf(issue);
    const local = localWorkers(sessions, issue, now).filter((worker) => worker.sessionId !== session.id);
    return sortWorkers([...local, ...(remoteWorkers(answer, receivedAt, now).get(key) ?? [])]).filter((worker) => worker.phase === "now");
  }, [issue, session, sessions, answer, receivedAt, now]);
  return { workers, now };
}
