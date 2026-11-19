import { memo, useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { PrActivity, PrConversation as Conversation, PrConversationAccess, PrConversationAction, PrReviewer } from "@terminalx/portable/workspaceGit";
import { ArrowDownUp, ArrowUp, Check, CircleCheck, CircleX, Clock, GitMerge, MessageSquare, RefreshCw, UserPlus } from "@/icons";
import { cn } from "@/lib/cn";
import { checkCounts, checkSummary } from "@/lib/checks";
import { authorInitials, authorTint } from "@/lib/prLinks";
import { relativeTime } from "@/lib/time";
import { mergeMethodLabel, rememberedMergeMethod } from "@/lib/mergeMethods";
import type { GitSource } from "@/lib/gitSource";
import type { SessionPr } from "@/lib/sessionPrs";
import { usePref } from "@/lib/prefs";
import { Markdown } from "@/components/chat/Markdown";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** Shared with branch discovery: hidden windows never poll GitHub. */
export function useDocumentVisible() {
  const [visible, setVisible] = useState(document.visibilityState !== "hidden");
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  return visible;
}

const labels: Record<string, string> = { APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", COMMENTED: "Commented", PENDING: "Pending", DISMISSED: "Dismissed" };
const stateLabel = (state: string) => labels[state] ?? state.toLowerCase().replaceAll("_", " ");

type ConversationProps = {
  source: Pick<GitSource, "conversation" | "cloud" | "canWrite" | "errorMessage">; row: SessionPr; active: boolean; refresh: number;
  onEdited: (title: string, body: string) => void;
  /** Who reviews it and how many threads are open, for the PR's header line (PRO-394). */
  onSummary?: (summary: { reviewers: PrReviewer[]; unresolvedThreads: number }) => void;
  /** The CHECKS section, placed between REVIEW and DESCRIPTION (design 05.08). */
  checks?: ReactNode;
  /**
   * Once merged, the panel shows the merged card, what to do next and one-line CHECKS and REVIEW summaries, not the
   * whole conversation (design 05.12).
   */
  merged?: boolean;
  /** What to do next with the session, under WHAT NEXT once merged. */
  whatNext?: ReactNode;
  /** Each read, for what the panel shows outside the conversation (the merge menu's methods). */
  onRead?: (conversation: Conversation) => void;
};
type ConversationAccess = { client?: PrConversationAccess; error?: string };

/** A changed transport also changes which repository owns drafts and requests. */
export function PrConversation(props: ConversationProps) {
  const { source, row } = props;
  const access = useMemo((): { client?: PrConversationAccess; error?: string } => {
    try { return { client: source.conversation?.(row.pr!, row.association) }; }
    catch (error) { return { error: source.errorMessage(error) }; }
    // A refresh replaces row/pr objects, but the conversation transport stays put.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, row.identity, row.association?.scope.kind, row.association?.scope.kind === "cloud" ? row.association.scope.repo : "", row.association?.scope.kind === "cloud" ? row.association.scope.workspace : ""]);
  const selected = useRef({ access, generation: 0 });
  if (selected.current.access !== access) selected.current = { access, generation: selected.current.generation + 1 };
  return <ConversationContent key={selected.current.generation} {...props} access={access} />;
}

function ConversationContent({ source, row, active, refresh, onEdited, onSummary, access, checks, merged, whatNext, onRead }: ConversationProps & { access: ConversationAccess }) {
  const [data, setData] = useState<Conversation | null>(null);
  const summarise = useRef(onSummary);
  summarise.current = onSummary;
  useEffect(() => {
    if (data) summarise.current?.({ reviewers: data.reviewers, unresolvedThreads: data.unresolvedThreads });
  }, [data?.reviewers, data?.unresolvedThreads]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editBase, setEditBase] = useState<{ title: string; body: string } | null>(null);
  const [approval, setApproval] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [order, setOrder] = usePref("prActivityOrder");
  const visible = useDocumentVisible();
  const alive = useRef(true);
  const sequence = useRef(0);
  const busy = useRef(false);
  const completed = useRef<{ client: PrConversationAccess; state: string; rowState: string; refresh: number; revision: number } | null>(null);
  const rowState = row.pr!.state;
  const canRefresh = active && visible;
  const changed = useRef(onEdited);
  changed.current = onEdited;
  const read = useRef(onRead);
  read.current = onRead;
  const [requesting, setRequesting] = useState(false);
  useEffect(() => { if (data) read.current?.(data); }, [data]);


  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; sequence.current++; };
  }, []);

  useEffect(() => {
    if (!canRefresh || !access.client) return;
    const previous = completed.current;
    if (previous?.client === access.client && previous.state !== "OPEN" && previous.rowState === rowState && previous.refresh === refresh && previous.revision === revision) return;
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      // A timer is independent work; action completion never starts a read.
      if (busy.current) { timer = window.setTimeout(() => void load(), 60_000); return; }
      const request = ++sequence.current;
      let poll = rowState === "OPEN";
      setLoading(true);
      try {
        const next = await access.client!.read();
        if (cancelled || request !== sequence.current) return;
        completed.current = { client: access.client!, state: next.state, rowState, refresh, revision };
        poll = poll && next.state === "OPEN";
        setData(next);
        changed.current(next.title, next.body);
        setError(null);
      } catch (error) {
        if (!cancelled && request === sequence.current) setError(source.errorMessage(error));
      } finally {
        if (!cancelled) {
          if (request === sequence.current) setLoading(false);
          if (poll) timer = window.setTimeout(() => void load(), 60_000);
        }
      }
    };
    void load();
    return () => { cancelled = true; sequence.current++; window.clearTimeout(timer); };
  }, [access, canRefresh, source, refresh, revision, rowState]);

  useEffect(() => {
    setResults([]);
    setSearchError(null);
    setSearching(false);
    if (!canRefresh || !access.client || !source.canWrite || query.trim().length < 2 || busy.current) return;
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      if (busy.current) { setSearching(false); return; }
      void access.client!.search(query.trim()).then((users) => {
        if (!cancelled) setResults(users);
      }, (error) => {
        if (!cancelled) setSearchError(source.errorMessage(error));
      }).finally(() => { if (!cancelled) setSearching(false); });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [access, canRefresh, source, query]);

  const act = async (action: PrConversationAction) => {
    if (!access.client || busy.current || !source.canWrite) return;
    if (action.kind === "approve" ? (!canApprove || action.viewer !== data?.viewer) : (!editable || (action.kind !== "edit" && !open))) return;
    busy.current = true;
    sequence.current++;
    setWorking(true);
    setLoading(false);
    setActionError(null);
    try {
      const update = await access.client.act(action);
      if (!alive.current) return;
      if (action.kind === "edit") {
        setData((value) => value && { ...value, title: action.title, body: action.body });
        changed.current(action.title, action.body);
        setEditing(false);
      }
      setQuery("");
      // Native readback uses the mutation's original authority. A delayed reply
      // (or a legacy runtime's empty reply) must never create a fresh request.
      if (update?.conversation) {
        const next = update.conversation;
        completed.current = { client: access.client, state: next.state, rowState, refresh, revision };
        setData(next);
        changed.current(next.title, next.body);
        setError(null);
      } else if (update?.error) setError(update.error);
    } catch (error) {
      if (alive.current) setActionError(source.errorMessage(error));
    } finally {
      busy.current = false;
      if (alive.current) setWorking(false);
    }
  };

  const editable = source.canWrite && !!access.client && !!data?.canEdit;
  const open = data?.state === "OPEN";
  const canApprove = !!(open && source.canWrite && access.client && !source.cloud && row.association?.scope.kind !== "cloud" && data.viewer && !data.viewer.toLowerCase().endsWith("[bot]") && data.viewer.toLowerCase() !== data.author.toLowerCase());
  const candidates = results.filter((login) => login.toLowerCase() !== data?.author.toLowerCase());
  const items = useMemo(() => order === "oldest" ? data?.activity ?? [] : [...(data?.activity ?? [])].reverse(), [data?.activity, order]);
  if (!source.conversation) return null;
  const pr = row.pr!;
  const alerts = <>
    {actionError && <div role="alert" className="rounded-md bg-destructive/10 p-2 text-destructive">{actionError}</div>}
    {(access.error || error) && <div role="alert" className="rounded-md bg-destructive/10 p-2 text-destructive">{access.error || error}<Button size="xs" variant="ghost" disabled={working || loading} onClick={() => setRevision((value) => value + 1)}>Retry</Button></div>}
  </>;
  if (merged) return <div className="flex min-w-0 flex-col gap-3 text-xs" aria-label={`Conversation for PR #${pr.number}`} aria-busy={loading}>
    <MergedCard number={pr.number} base={data?.base || pr.base} url={pr.url} conversation={data} />
    {alerts}
    {whatNext && <section aria-label="What next" className="flex flex-col gap-2"><SectionHead title="What next" />{whatNext}</section>}
    <div className="flex flex-col gap-2.5">
      {pr.checks.length > 0 && <SectionHead title="Checks" summary={<span className={cn(checkCounts(pr.checks).failed ? "text-destructive" : "text-add")}>{checkSummary(pr.checks)}</span>} />}
      {data && <SectionHead title="Review" summary={reviewOutcome(data.reviewers)} />}
    </div>
  </div>;
  const approved = data?.reviewers.filter((reviewer) => reviewer.state === "APPROVED").length ?? 0;
  const changes = data?.reviewers.filter((reviewer) => reviewer.state === "CHANGES_REQUESTED").length ?? 0;
  const waiting = data?.reviewers.filter((reviewer) => reviewer.requested).length ?? 0;
  const canRequest = editable && open;
  return <div className="flex min-w-0 flex-col gap-4 text-xs" aria-label={`Conversation for PR #${pr.number}`} aria-busy={loading || working}>
    {alerts}
    {!data && !error && !access.error && <p className="text-faint">Loading conversation…</p>}
    {data && <section aria-label="Review">
      <SectionHead title="Review"
        summary={[`${approved} approved`, changes ? `${changes} changes requested` : null, `${waiting} waiting`, `${data.unresolvedThreads} unresolved`].filter(Boolean).join(" · ")}
        action={<>
          {canApprove && <SectionAction onClick={() => setApproval(data.viewer)} disabled={working}><Check className="size-3" />Approve</SectionAction>}
          {canRequest && <SectionAction aria-expanded={requesting} onClick={() => { setRequesting((value) => !value); setQuery(""); }} disabled={working}><UserPlus className="size-3" />Request</SectionAction>}
        </>} />
      <Dialog open={approval !== null && approval === data.viewer && canApprove} onOpenChange={(show) => { if (!show) setApproval(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Approve pull request #{pr.number}?</DialogTitle>
            <DialogDescription>This submits an approving review on GitHub as {approval}.</DialogDescription>
          </DialogHeader>
          <p className="text-sm">{data.title}</p>
          <DialogFooter><Button variant="ghost" onClick={() => setApproval(null)}>Cancel</Button><Button variant="accent" disabled={working} onClick={() => { const viewer = approval; setApproval(null); if (viewer) void act({ kind: "approve", viewer }); }}>Confirm approval</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <ul className="mt-1.5 flex flex-col gap-0.5">
        {data.reviewers.map((reviewer) => <li key={`${reviewer.kind}:${reviewer.login}`} className="flex h-7 min-w-0 items-center gap-2" data-testid="pr-reviewer">
          <Avatar login={reviewer.login} />
          <span className="min-w-0 truncate text-[12.5px] text-foreground" title={reviewer.login}>{reviewer.name ?? reviewer.login}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <ReviewerState reviewer={reviewer} />
            {editable && open && reviewer.kind !== "bot" && <>
              {!reviewer.requested && reviewer.kind === "user" && <TextAction disabled={working} aria-label={`Re-request review from ${reviewer.login}`} onClick={() => void act({ kind: "request", login: reviewer.login, team: false })}>Re-request</TextAction>}
              {reviewer.requested && <TextAction disabled={working} aria-label={`Remove reviewer ${reviewer.login}`} onClick={() => void act({ kind: "remove", login: reviewer.login, team: reviewer.kind === "team" })}>Remove</TextAction>}
            </>}
          </span>
        </li>)}
        {!data.reviewers.length && <li className="text-[12px] text-faint">No reviewers yet.</li>}
      </ul>
      {canRequest && requesting && <div className="mt-1.5">
        <input autoFocus aria-label="Search reviewers" placeholder="Request a reviewer…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setRequesting(false); setQuery(""); } }} disabled={working} className="h-7 w-full rounded-md border border-hairline bg-transparent px-2 text-[12px] outline-none focus:border-ring" />
        {searching && <p className="mt-1 text-faint">Searching…</p>}
        {searchError && <p role="alert" className="mt-1 text-destructive">{searchError}</p>}
        {query.trim().length >= 2 && !searching && !searchError && <ul aria-label="Reviewer search results" className="mt-1 flex flex-col gap-0.5">
          {candidates.map((login) => <li key={login} className="flex h-7 min-w-0 items-center gap-2">
            <Avatar login={login} /><span className="min-w-0 flex-1 truncate text-[12.5px]">{login}</span>
            <Button size="xs" variant="secondary" aria-label={`Request ${login}`} disabled={working || data.reviewers.some((reviewer) => reviewer.requested && reviewer.login.toLowerCase() === login.toLowerCase())} onClick={() => void act({ kind: "request", login, team: false })}>Request</Button>
          </li>)}
          {!candidates.length && <li className="text-faint">No matching users.</li>}
        </ul>}
      </div>}
    </section>}
    {checks}
    {data && <section aria-label="Description">
      <SectionHead title="Description" action={editable && !editing && <SectionAction aria-label="Edit title and description" onClick={() => { setTitle(data.title); setBody(data.body); setEditBase({ title: data.title, body: data.body }); setEditing(true); }}>Edit</SectionAction>} />
      <div className="mt-1">
        {editing ? <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); if (editBase) void act({ kind: "edit", title: title.trim(), body, expectedTitle: editBase.title, expectedBody: editBase.body }); }}>
          <input aria-label="Pull request title" value={title} onChange={(event) => setTitle(event.target.value)} disabled={working} className="h-8 rounded-md border border-hairline bg-transparent px-2 text-[12.5px]" />
          <textarea aria-label="Pull request description" value={body} onChange={(event) => setBody(event.target.value)} disabled={working} rows={8} className="rounded-md border border-hairline bg-transparent p-2 text-[12.5px]" />
          <div className="flex gap-1"><Button type="submit" size="xs" variant="accent" disabled={!title.trim() || working || !editable}>Save</Button><Button type="button" size="xs" variant="ghost" disabled={working} onClick={() => setEditing(false)}>Cancel</Button></div>
        </form> : data.body ? <div className="prose-pr" data-testid="pr-description"><Markdown text={data.body} remoteImages={false} webLinksOnly /></div> : <p className="text-[12.5px] text-faint">No description.</p>}
      </div>
    </section>}
    {data && <section aria-label="Activity">
      <SectionHead title="Activity" summary={`${items.length}`} action={<SectionAction aria-label="Activity order" title={order === "oldest" ? "Showing oldest first" : "Showing newest first"} onClick={() => setOrder(order === "oldest" ? "newest" : "oldest")}>{order === "oldest" ? "Oldest first" : "Newest first"}<ArrowDownUp className="size-3" /></SectionAction>} />
      <div className="mt-1.5 max-h-[32rem] overflow-y-auto overscroll-contain scrollbar-thin" aria-label="Pull request activity" tabIndex={0}>
        {items.map((item) => <ActivityItem key={item.id} item={item} />)}
        {!items.length && <p className="text-[12px] text-faint">No activity yet.</p>}
      </div>
    </section>}
  </div>;
}

/** A section's small uppercase heading, a summary after it and its action at the right (design 05.08). */
export function SectionHead({ title, summary, action }: { title: string; summary?: ReactNode; action?: ReactNode }) {
  return <div className="flex min-h-5 min-w-0 items-center gap-2">
    <h3 className="shrink-0 text-xs font-normal uppercase tracking-[.08em] text-faint">{title}</h3>
    {summary != null && summary !== "" && <span className="min-w-0 truncate text-xs text-muted-foreground">{summary}</span>}
    {action && <span className="ml-auto flex shrink-0 items-center gap-2.5">{action}</span>}
  </div>;
}

export function SectionAction({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={cn("flex items-center gap-1 rounded text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50", className)} {...props} />;
}

function TextAction({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={cn("rounded text-[12px] text-faint outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50", className)} {...props} />;
}

const TINT = { info: "bg-info/15 text-info", accent: "bg-accent/15 text-accent", merged: "bg-merged/15 text-merged", add: "bg-add/15 text-add" } as const;

function Avatar({ login }: { login: string }) {
  return <span aria-hidden className={cn("grid size-5 shrink-0 place-items-center rounded-full text-[9px] font-semibold", TINT[authorTint(login)])}>{authorInitials(login.split("/").pop() ?? login)}</span>;
}

/** "2h", "18h", "Nov 3": an age at the end of a row. */
const age = (at: string | null | undefined) => at ? relativeTime(at) : "";

function ReviewerState({ reviewer }: { reviewer: PrReviewer }) {
  const when = age(reviewer.at);
  const [Icon, label, tone] = reviewer.requested ? [Clock, "Requested", "text-muted-foreground"]
    : reviewer.state === "APPROVED" ? [CircleCheck, "Approved", "text-add"]
    : reviewer.state === "CHANGES_REQUESTED" ? [CircleX, "Changes requested", "text-destructive"]
    : reviewer.state === "DISMISSED" ? [CircleX, "Dismissed", "text-faint"]
    : [MessageSquare, stateLabel(reviewer.state), "text-muted-foreground"];
  return <span className={cn("flex items-center gap-1 text-[12px]", tone)} title={reviewer.at ? new Date(reviewer.at).toLocaleString() : undefined}>
    <Icon aria-hidden className="size-3.25" />{label}{when && ` · ${when}`}
  </span>;
}

/** The REVIEW line once merged: who approved, else what review there was. */
function reviewOutcome(reviewers: PrReviewer[]): string {
  const names = (state: string) => reviewers.filter((reviewer) => reviewer.state === state).map((reviewer) => reviewer.name ?? reviewer.login);
  const approved = names("APPROVED");
  if (approved.length) return `Approved by ${approved.slice(0, 2).join(", ")}${approved.length > 2 ? ` and ${approved.length - 2} more` : ""}`;
  if (names("CHANGES_REQUESTED").length) return "Merged with changes requested";
  return reviewers.length ? "Commented, not approved" : "Merged without review";
}

/** "12 min ago", "3 h ago", "on Nov 3". */
function ago(at: string): string {
  const label = relativeTime(at);
  if (!label) return "";
  if (label === "now") return "just now";
  const unit = /^(\d+)([mhd])$/.exec(label);
  return unit ? `${unit[1]} ${{ m: "min", h: "h", d: "d" }[unit[2] as "m" | "h" | "d"]} ago` : `on ${label}`;
}

/**
 * "Merged into main #14 · Squash and merge by Alex · a91c3e0 · 12 min ago · Remote branch deleted on GitHub" (design
 * 05.12). The method is only said when it is known: chosen here, or a merge commit GitHub shows with two parents.
 */
function MergedCard({ number, base, url, conversation }: { number: number; base: string; url: string; conversation: Conversation | null }) {
  const merged = conversation?.merged ?? null;
  const method = rememberedMergeMethod(url) ?? (merged?.mergeCommit ? "merge" : null);
  const by = merged?.by ?? null;
  const line = [
    method ? `${mergeMethodLabel(method)}${by ? ` by ${by}` : ""}` : by ? `Merged by ${by}` : null,
    merged?.commit ? merged.commit.slice(0, 7) : null,
    merged?.at ? ago(merged.at) : null,
  ].filter(Boolean).join(" · ");
  return <section aria-label="Merged pull request" data-testid="pr-merged-card" className="grid gap-1 rounded-lg border border-merged/30 bg-merged/5 px-3 py-3">
    <div className="flex min-w-0 items-center gap-2">
      <GitMerge aria-hidden className="size-4 shrink-0 text-merged" />
      <span className="min-w-0 truncate text-[13px] font-medium text-foreground">Merged into <span className="font-mono text-[12.5px]">{base || "its base"}</span></span>
      <span className="ml-auto shrink-0 font-mono text-[12px] text-faint">#{number}</span>
    </div>
    {line && <div className="pl-6 text-[12px] text-muted-foreground" data-testid="pr-merged-by">{line}</div>}
    {merged?.branchDeleted && <div className="pl-6 text-[12px] text-muted-foreground">Remote branch deleted on GitHub</div>}
  </section>;
}

const ACTIVITY_ICON = { commit: ArrowUp, force_push: RefreshCw, comment: MessageSquare } as const;

function activityVerb(item: PrActivity): string {
  if (item.kind === "commit") return "pushed";
  if (item.kind === "force_push") return "force-pushed";
  if (item.kind === "comment") return "commented";
  return item.state === "APPROVED" ? "approved" : item.state === "CHANGES_REQUESTED" ? "requested changes" : item.state === "DISMISSED" ? "dismissed a review" : "reviewed";
}

/**
 * One line per event: icon, who did what, its age at the right (design 05.08). A comment or review with text opens
 * under its line, at the panel's 12.5px, never chat size.
 */
const ActivityItem = memo(function ActivityItem({ item }: { item: PrActivity }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const text = item.kind === "commit" || item.kind === "force_push" ? "" : item.body.trim();
  const long = text.length > 700 || text.split("\n").length > 12;
  const preview = text.slice(0, 700).split("\n").slice(0, 12).join("\n");
  const Icon = item.kind === "review" ? (item.state === "APPROVED" ? CircleCheck : item.state === "CHANGES_REQUESTED" ? CircleX : MessageSquare) : ACTIVITY_ICON[item.kind];
  const tone = item.kind === "review" && item.state === "APPROVED" ? "text-add" : item.kind === "review" && item.state === "CHANGES_REQUESTED" ? "text-destructive" : "text-faint";
  const line = <>
    <Icon aria-hidden className={cn("size-3 shrink-0", tone)} />
    <span className="min-w-0 truncate text-foreground">
      {item.author} {activityVerb(item)}
      {item.kind === "commit" && item.after && <> <span className="font-mono" title={item.body}>{item.after.slice(0, 7)}</span></>}
      {item.kind === "force_push" && <> <span className="font-mono">{item.before?.slice(0, 7) ?? "unknown"} → {item.after?.slice(0, 7) ?? "unknown"}</span></>}
      {text && !open && <span className="text-faint"> · {text.split("\n").find((part) => part.trim())?.slice(0, 120)}</span>}
    </span>
    <time dateTime={item.at} title={new Date(item.at).toLocaleString()} className="ml-auto shrink-0 pl-2 text-faint">{age(item.at)}</time>
  </>;
  return <div data-testid="pr-activity-item" className="py-0.5 pr-2 text-[12px]">
    {text ? <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex h-6 w-full min-w-0 items-center gap-2 rounded text-left outline-none hover:bg-veil focus-visible:ring-1 focus-visible:ring-ring">{line}</button>
      : <div className="flex h-6 min-w-0 items-center gap-2">{line}</div>}
    {open && <div className="prose-pr mb-1.5 ml-5 mt-0.5">
      <Markdown text={long && !expanded ? `${preview}\n\n…` : text} remoteImages={false} webLinksOnly />
      {long && <Button size="xs" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "Show less" : "Show more"}</Button>}
    </div>}
  </div>;
});
