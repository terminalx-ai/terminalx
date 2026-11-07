import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { PrActivity, PrConversation as Conversation, PrConversationAccess, PrConversationAction } from "@terminalx/portable/workspaceGit";
import type { GitSource } from "@/lib/gitSource";
import type { SessionPr } from "@/lib/sessionPrs";
import { usePref } from "@/lib/prefs";
import { Markdown } from "@/components/chat/Markdown";
import { Button } from "@/components/ui/button";

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

/** Keyed by selection + PR identity by the caller, so drafts and requests cannot cross PRs. */
export function PrConversation({ source, row, active, refresh, onEdited }: {
  source: Pick<GitSource, "conversation" | "canWrite" | "errorMessage">; row: SessionPr; active: boolean; refresh: number;
  onEdited: (title: string, body: string) => void;
}) {
  const [data, setData] = useState<Conversation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState(false);
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
  const canRefresh = active && visible;
  const changed = useRef(onEdited);
  changed.current = onEdited;
  const access = useMemo((): { client?: PrConversationAccess; error?: string } => {
    try { return { client: source.conversation?.(row.pr!, row.association) }; }
    catch (error) { return { error: source.errorMessage(error) }; }
    // A refresh replaces row/pr objects, but the conversation transport stays put.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, row.identity, row.association?.scope.kind, row.association?.scope.kind === "cloud" ? row.association.scope.repo : "", row.association?.scope.kind === "cloud" ? row.association.scope.workspace : ""]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; sequence.current++; };
  }, []);

  useEffect(() => {
    if (!canRefresh || !access.client || working) return;
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      const request = ++sequence.current;
      setLoading(true);
      try {
        const next = await access.client!.read();
        if (cancelled || request !== sequence.current) return;
        setData(next);
        changed.current(next.title, next.body);
        setError(null);
      } catch (error) {
        if (!cancelled && request === sequence.current) setError(source.errorMessage(error));
      } finally {
        if (!cancelled && request === sequence.current) {
          setLoading(false);
          timer = window.setTimeout(() => void load(), 30_000);
        }
      }
    };
    void load();
    return () => { cancelled = true; sequence.current++; window.clearTimeout(timer); };
  }, [access, canRefresh, source, refresh, revision, working]);

  useEffect(() => {
    setResults([]);
    setSearchError(null);
    setSearching(false);
    if (!canRefresh || !access.client || !source.canWrite || query.trim().length < 2 || working) return;
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void access.client!.search(query.trim()).then((users) => {
        if (!cancelled) setResults(users);
      }, (error) => {
        if (!cancelled) setSearchError(source.errorMessage(error));
      }).finally(() => { if (!cancelled) setSearching(false); });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [access, canRefresh, source, query, working]);

  const act = async (action: PrConversationAction) => {
    if (!access.client || busy.current || !source.canWrite) return;
    busy.current = true;
    sequence.current++;
    setWorking(true);
    setActionError(null);
    try {
      await access.client.act(action);
      if (!alive.current) return;
      if (action.kind === "edit") {
        setData((value) => value && { ...value, title: action.title, body: action.body });
        changed.current(action.title, action.body);
        setEditing(false);
      }
      setQuery("");
      // Leaving the working state reads back just this conversation, preserving
      // the list and scroll position. A hidden tab waits until it is visible.
    } catch (error) {
      if (alive.current) setActionError(source.errorMessage(error));
    } finally {
      busy.current = false;
      if (alive.current) { setWorking(false); setRevision((value) => value + 1); }
    }
  };

  const editable = source.canWrite && !!access.client && !!data?.canEdit;
  const open = data?.state === "OPEN";
  const candidates = results.filter((login) => login.toLowerCase() !== data?.author.toLowerCase());
  const items = useMemo(() => order === "oldest" ? data?.activity ?? [] : [...(data?.activity ?? [])].reverse(), [data?.activity, order]);
  if (!source.conversation) return null;
  return <div className="mt-3 flex min-w-0 flex-col gap-4 text-xs" aria-label={`Conversation for PR #${row.pr!.number}`} aria-busy={loading || working}>
    {actionError && <div role="alert" className="rounded-md bg-destructive/10 p-2 text-destructive">{actionError}</div>}
    {(access.error || error) && <div role="alert" className="rounded-md bg-destructive/10 p-2 text-destructive">{access.error || error}<Button size="xs" variant="ghost" disabled={working || loading} onClick={() => setRevision((value) => value + 1)}>Retry</Button></div>}
    {!data && !error && !access.error && <p className="text-faint">Loading conversation…</p>}
    {data && <>
      <section aria-label="Reviewers">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-medium">Reviewers · {data.reviewers.length}</h3>
          {open && source.canWrite && access.client && data.viewer && data.viewer.toLowerCase() !== data.author.toLowerCase() && <Button size="xs" variant="secondary" disabled={working} onClick={() => void act({ kind: "approve" })}>Approve</Button>}
        </div>
        <p className="mt-1 text-faint">{["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "PENDING", ...(data.reviewers.some((reviewer) => reviewer.state === "DISMISSED") ? ["DISMISSED"] : [])].map((state) => `${data.reviewers.filter((reviewer) => reviewer.state === state).length} ${stateLabel(state).toLowerCase()}`).join(" · ")}</p>
        <p className="mt-1 text-muted-foreground">{data.unresolvedThreads} unresolved {data.unresolvedThreads === 1 ? "thread" : "threads"}</p>
        <ul className="mt-2 space-y-1">
          {data.reviewers.map((reviewer) => <li key={`${reviewer.kind}:${reviewer.login}`} className="flex flex-wrap items-center gap-1.5">
            <span className="min-w-0 break-all">{reviewer.login}</span>
            <span className="text-faint">{stateLabel(reviewer.state)}</span>
            {editable && open && reviewer.kind !== "bot" && <span className="ml-auto flex gap-1">
              {!reviewer.requested && reviewer.kind === "user" && <Button size="xs" variant="ghost" disabled={working} aria-label={`Re-request review from ${reviewer.login}`} onClick={() => void act({ kind: "request", login: reviewer.login, team: false })}>Re-request</Button>}
              {reviewer.requested && <Button size="xs" variant="ghost" disabled={working} aria-label={`Remove reviewer ${reviewer.login}`} onClick={() => void act({ kind: "remove", login: reviewer.login, team: reviewer.kind === "team" })}>Remove</Button>}
            </span>}
          </li>)}
        </ul>
        {editable && open && <div className="mt-2">
          <input aria-label="Search reviewers" placeholder="Request a reviewer…" value={query} onChange={(event) => setQuery(event.target.value)} disabled={working} className="h-8 w-full rounded-md border border-hairline bg-transparent px-2 outline-none focus:border-ring" />
          {searching && <p className="mt-1 text-faint">Searching…</p>}
          {searchError && <p role="alert" className="mt-1 text-destructive">{searchError}</p>}
          {query.trim().length >= 2 && !searching && !searchError && <ul aria-label="Reviewer search results" className="mt-1 space-y-1">
            {candidates.map((login) => <li key={login} className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 break-all">{login}</span><Button size="xs" variant="secondary" aria-label={`Request ${login}`} disabled={working || data.reviewers.some((reviewer) => reviewer.requested && reviewer.login.toLowerCase() === login.toLowerCase())} onClick={() => void act({ kind: "request", login, team: false })}>Request</Button>
            </li>)}
            {!candidates.length && <li className="text-faint">No matching users.</li>}
          </ul>}
        </div>}
      </section>
      <section aria-label="Description">
        <div className="mb-2 flex items-center justify-between gap-2"><h3 className="font-medium">Description</h3>
          {editable && !editing && <Button size="xs" variant="ghost" onClick={() => { setTitle(data.title); setBody(data.body); setEditing(true); }}>Edit title and description</Button>}
        </div>
        {editing ? <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void act({ kind: "edit", title: title.trim(), body }); }}>
          <input aria-label="Pull request title" value={title} onChange={(event) => setTitle(event.target.value)} disabled={working} className="h-8 rounded-md border border-hairline bg-transparent px-2" />
          <textarea aria-label="Pull request description" value={body} onChange={(event) => setBody(event.target.value)} disabled={working} rows={8} className="rounded-md border border-hairline bg-transparent p-2" />
          <div className="flex gap-1"><Button type="submit" size="xs" variant="accent" disabled={!title.trim() || working || !editable}>Save</Button><Button type="button" size="xs" variant="ghost" disabled={working} onClick={() => setEditing(false)}>Cancel</Button></div>
        </form> : data.body ? <Markdown text={data.body} /> : <p className="text-faint">No description.</p>}
      </section>
      <section aria-label="Activity">
        <div className="mb-2 flex items-center justify-between gap-2"><h3 className="font-medium">Activity · {items.length}</h3>
          <select aria-label="Activity order" value={order} onChange={(event) => setOrder(event.target.value === "oldest" ? "oldest" : "newest")} className="rounded border border-hairline bg-background p-1 text-xs"><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select>
        </div>
        <div className="max-h-[32rem] overflow-y-auto overscroll-contain scrollbar-thin" aria-label="Pull request activity" tabIndex={0}>
          {items.map((item) => <ActivityItem key={item.id} item={item} />)}
          {!items.length && <p className="text-faint">No activity yet.</p>}
        </div>
      </section>
    </>}
  </div>;
}

const ActivityItem = memo(function ActivityItem({ item }: { item: PrActivity }) {
  const [expanded, setExpanded] = useState(false);
  const [nearby, setNearby] = useState(typeof IntersectionObserver === "undefined");
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!element.current || typeof IntersectionObserver === "undefined") return;
    // Markdown is parsed only as a row approaches the viewport. CSS skips layout
    // and paint offscreen; memoization keeps scrolling a 200-item feed cheap.
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setNearby(true); observer.disconnect(); }
    }, { root: element.current.parentElement, rootMargin: "300px" });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  const long = item.body.length > 700 || item.body.split("\n").length > 12;
  const preview = item.body.slice(0, 700).split("\n").slice(0, 12).join("\n");
  return <div ref={element} data-testid="pr-activity-item" className="border-t border-hairline py-3 pr-2" style={{ contentVisibility: "auto", containIntrinsicSize: "auto 100px" }}>
    <div className="mb-1 flex flex-wrap gap-x-1 text-faint"><span className="font-medium text-foreground">{item.author}</span>
      <span>{item.kind === "review" ? stateLabel(item.state ?? "COMMENTED").toLowerCase() : item.kind === "commit" ? "committed" : item.kind === "force_push" ? "force pushed" : "commented"}</span>
      <time dateTime={item.at} title={item.at}>{new Date(item.at).toLocaleString()}</time>
    </div>
    {item.kind === "force_push" ? <p className="font-mono text-faint">{item.before?.slice(0, 7) ?? "unknown"} → {item.after?.slice(0, 7) ?? "unknown"}</p>
      : nearby ? <Markdown text={long && !expanded ? `${preview}\n\n…` : item.body} /> : <div className="h-16" />}
    {long && <Button size="xs" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "Show less" : "Show more"}</Button>}
  </div>;
});
