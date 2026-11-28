import { useEffect, useRef, useState } from "react";
import { Popover } from "radix-ui";
import { Check, ChevronDown, ChevronsUpDown, CircleDot, GitBranch, GitCommitHorizontal, History, Layers, MessageSquare } from "@/icons";
import { cn } from "@/lib/cn";
import type { ChangesChoice, TurnCheckpoint } from "@/lib/changesScope";
import type { GitSource } from "@/lib/gitSource";
import type { BranchInfo, ChangedFile, CommitInfo } from "@/types/session";
import { sumChanges } from "./FileList";

/** "3 min ago", "2 hours ago": the age a turn row carries. */
export function ago(iso: string | null, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "";
  const minutes = Math.round(Math.max(0, now - t) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} ${days === 1 ? "day" : "days"} ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;
const short = (sha: string) => sha.slice(0, 7);

/** The scope's name on its button: "All changes", "Turn 3", "Commit 5be01f4". */
export function scopeName(choice: ChangesChoice, checkpoint: TurnCheckpoint | undefined, live: boolean): string {
  switch (choice.scope) {
    case "all": return "All changes";
    case "uncommitted": return "Uncommitted changes";
    case "turn": return live ? "This turn" : "Latest turn";
    case "checkpoint": return checkpoint ? checkpoint.label.split(" · ")[0] : "Unavailable turn";
    case "commit": return choice.commit ? `Commit ${short(choice.commit)}` : "Single commit";
    case "history": return "History";
  }
}

const triggerClass = "flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-hairline px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-selected";
const panelClass = "z-(--z-menu) max-h-[min(560px,var(--radix-popover-content-available-height))] overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-surface hairline animate-fade-in scrollbar-thin";

type Summary = { count: number; additions: number; deletions: number };
const summary = (list: ChangedFile[]): Summary => ({ count: list.length, ...sumChanges(list) });

function Heading({ children }: { children: React.ReactNode }) {
  return <div className="px-2.5 pb-1 pt-2 text-[11px] uppercase tracking-[.08em] text-faint">{children}</div>;
}

/** One choice: icon, name, a second line, a check on the chosen one. */
function Option({ icon, name, detail, chosen, onSelect, title, disabled }: { icon: React.ReactNode; name: React.ReactNode; detail?: React.ReactNode; chosen: boolean; onSelect: () => void; title?: string; disabled?: boolean }) {
  return <button type="button" aria-current={chosen || undefined} title={title} disabled={disabled} onClick={onSelect}
    className={cn("flex w-full items-start gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-foreground outline-none hover:bg-veil-strong focus-visible:bg-veil-strong focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50", chosen && "bg-selected")}>
    <span aria-hidden className="mt-[2px] shrink-0 text-muted-foreground [&_svg]:size-3.5">{icon}</span>
    <span className="min-w-0 flex-1">
      <span className="block truncate">{name}</span>
      {detail && <span className="mt-0.5 block truncate text-[11.5px] leading-4 text-faint">{detail}</span>}
    </span>
    {chosen && <Check aria-hidden className="mt-[2px] size-3.5 shrink-0" />}
  </button>;
}

function Totals({ value }: { value: Summary }) {
  return <>{files(value.count)}{(value.additions > 0 || value.deletions > 0) && " · "}
    {value.additions > 0 && <span className="text-add">+{value.additions}</span>}{value.additions > 0 && value.deletions > 0 && " "}
    {value.deletions > 0 && <span className="text-destructive">−{value.deletions}</span>}</>;
}

/**
 * Changes' scope (design 05.03): "All changes ▾" opens the branches compared,
 * the live scopes, the session's numbered turns and the branch's commits.
 * Counts are read when it opens, so a closed picker costs nothing.
 */
export function ScopePicker({ source, choice, onChoose, checkpoints, showTurn, live, currentBranch, target, onPickTarget, hideWhitespace, open, onOpenChange: setOpen }: {
  source: GitSource;
  choice: ChangesChoice;
  onChoose: (next: ChangesChoice) => void;
  checkpoints: TurnCheckpoint[];
  /** The live "turn" scope has a snapshot to show. */
  showTurn: boolean;
  live: boolean;
  currentBranch: string | null;
  /** What All changes compares against, as last read ("main"), when known. */
  target: string | null;
  /** Open the comparison branch picker. */
  onPickTarget: () => void;
  hideWhitespace: boolean;
  /** Open from outside too: an empty commit's "Pick another commit". */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [all, setAll] = useState<Summary | null>(null);
  const [uncommitted, setUncommitted] = useState<Summary | null>(null);
  const [turns, setTurns] = useState<Record<string, number>>({});
  const [commits, setCommits] = useState<CommitInfo[] | null>(null);
  const [commitsFailed, setCommitsFailed] = useState(false);
  const checkpoint = checkpoints.find((entry) => entry.id === choice.checkpoint);
  const latest = useRef({ checkpoints }); latest.current = { checkpoints };
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const quietly = <T,>(work: Promise<T>, done: (value: T) => void) => void work.then((value) => { if (!cancelled) done(value); }, () => {});
    const review = source.reviewRange(choice.target, false);
    quietly(review.then((range) => source.changesBetween(range.base, range.head, hideWhitespace)), (list) => setAll(summary(list)));
    quietly(source.reviewRange(null, true).then((range) => source.changesBetween(range.base, range.head, hideWhitespace)), (list) => setUncommitted(summary(list)));
    setCommits(null);
    setCommitsFailed(false);
    // reviewRange's base/head are trees, not commits. Exclude the resolved
    // target's ancestry from HEAD so shared history cannot fill the list.
    void review.then((range) => source.logCommits(`${range.target}..HEAD`, 8)).then(
      (list) => { if (!cancelled) setCommits(list); },
      () => { if (!cancelled) setCommitsFailed(true); },
    );
    for (const entry of latest.current.checkpoints.slice(0, 8)) {
      quietly(source.changesBetween(entry.base, entry.head, hideWhitespace), (list) => setTurns((was) => ({ ...was, [entry.id]: list.length })));
    }
    return () => { cancelled = true; };
  }, [open, source, choice.target, hideWhitespace]);
  const pick = (next: ChangesChoice) => { setOpen(false); onChoose(next); };
  const against = target ?? choice.target ?? "the base branch";
  const turnDetail = (entry: TurnCheckpoint) => [turns[entry.id] === undefined ? null : files(turns[entry.id]), ago(entry.at)].filter(Boolean).join(" · ") || undefined;

  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild>
      <button type="button" aria-label="Changes scope" className={cn(triggerClass, "bg-selected text-foreground")}>
        <span className="truncate">{scopeName(choice, checkpoint, live)}</span>
        <ChevronDown aria-hidden className="size-3 shrink-0 text-faint" />
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content align="start" sideOffset={4} collisionPadding={8} className={cn(panelClass, "w-[min(380px,calc(100vw-16px))]")} aria-label="Scopes to review">
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 px-2.5 py-2 text-xs">
          <span className="text-faint">Current branch</span>
          <span className="truncate font-mono" title={currentBranch ?? undefined}>{currentBranch ?? "—"}</span>
          <span className="text-faint">Target branch</span>
          <button type="button" aria-label="Change target branch" onClick={() => { setOpen(false); onPickTarget(); }}
            className="flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-hairline bg-veil-raised px-2 text-left font-mono outline-none hover:bg-veil-strong focus-visible:ring-2 focus-visible:ring-ring/40">
            <GitBranch aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{choice.target ?? target ?? "Automatic"}</span>
            <ChevronsUpDown aria-hidden className="size-3 shrink-0 text-faint" />
          </button>
        </div>
        <div className="my-1 border-t border-hairline" />
        <Option icon={<Layers />} name="All changes" chosen={choice.scope === "all"} onSelect={() => pick({ ...choice, scope: "all" })}
          detail={all ? <><Totals value={all} /> against {against}</> : `Against ${against}`} />
        <Option icon={<CircleDot />} name="Uncommitted changes" chosen={choice.scope === "uncommitted"} onSelect={() => pick({ ...choice, scope: "uncommitted" })}
          detail={uncommitted ? `${files(uncommitted.count)} changed` : "Against the last commit"} />
        {(showTurn || checkpoints.length > 0 || (choice.scope === "checkpoint" && !checkpoint)) && <Heading>Turns in this session</Heading>}
        {showTurn && <Option icon={<MessageSquare />} name={live ? "This turn" : "Latest turn"} detail={live ? "In progress" : undefined}
          chosen={choice.scope === "turn"} onSelect={() => pick({ ...choice, scope: "turn" })} />}
        {choice.scope === "checkpoint" && !checkpoint && <Option icon={<MessageSquare />} name="Unavailable turn checkpoint" chosen disabled onSelect={() => {}} />}
        {checkpoints.map((entry) => <Option key={entry.id} icon={<MessageSquare />} name={entry.label} title={entry.prompt || undefined} detail={turnDetail(entry)}
          chosen={choice.scope === "checkpoint" && choice.checkpoint === entry.id} onSelect={() => pick({ ...choice, scope: "checkpoint", checkpoint: entry.id })} />)}
        <Heading>{commits?.length === 8 ? "Latest 8 commits" : "Commits"}</Heading>
        {choice.scope === "commit" && choice.commit && !commits?.some((commit) => commit.sha.startsWith(choice.commit!)) && <CommitOption sha={choice.commit} subject="" chosen onSelect={() => setOpen(false)} />}
        {commitsFailed ? <p className="px-2.5 py-1.5 text-[12px] text-faint">Could not load branch commits.</p>
          : commits === null ? <p className="px-2.5 py-1.5 text-[12px] text-faint">Loading commits…</p>
          : commits.length === 0 ? <p className="px-2.5 py-1.5 text-[12px] text-faint">No commits ahead of {against}.</p>
          : commits.map((commit) => <CommitOption key={commit.sha} sha={commit.shortSha || short(commit.sha)} subject={commit.subject}
            chosen={choice.scope === "commit" && !!choice.commit && commit.sha.startsWith(choice.commit)} onSelect={() => pick({ ...choice, scope: "commit", commit: commit.sha })} />)}
        <Option icon={<History />} name="All commits…" detail="Browse the history and review any commit" chosen={choice.scope === "history"} onSelect={() => pick({ ...choice, scope: "history" })} />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

function CommitOption({ sha, subject, chosen, onSelect }: { sha: string; subject: string; chosen: boolean; onSelect: () => void }) {
  return <button type="button" aria-current={chosen || undefined} title={subject || undefined} onClick={onSelect}
    className={cn("flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-[12.5px] outline-none hover:bg-veil-strong focus-visible:bg-veil-strong focus-visible:ring-2 focus-visible:ring-ring/40", chosen && "bg-selected")}>
    <GitCommitHorizontal aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    <span className="shrink-0 font-mono text-[12px]">{short(sha)}</span>
    <span className="min-w-0 flex-1 truncate text-muted-foreground">{subject}</span>
    {chosen && <Check aria-hidden className="size-3.5 shrink-0" />}
  </button>;
}

/**
 * "vs main ▾": what All changes compares against. A branch is picked from
 * the list, or a name typed and taken with Enter; Automatic goes back to the
 * branch the workspace was started from.
 */
export function TargetPicker({ open, onOpenChange, label, value, branches, busy, onApply, inputRef }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The branch compared against now, as last read. */
  label: string;
  /** The chosen target; null is the automatic base branch. */
  value: string | null;
  branches: BranchInfo[];
  busy: boolean;
  onApply: (target: string | null) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  // Kept between openings: a name that could not be used is still there to fix (PRO-295).
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = branches.filter((branch) => !branch.current && (!q || branch.name.toLowerCase().includes(q)));
  const apply = (target: string | null) => { onOpenChange(false); onApply(target); };
  return <Popover.Root open={open} onOpenChange={onOpenChange}>
    <Popover.Trigger asChild>
      <button type="button" aria-label="Comparison target" aria-busy={busy || undefined} title={`Compare against ${value ?? label}`} className={cn(triggerClass, "text-muted-foreground")}>
        <span className="truncate">vs {label}</span>
        <ChevronDown aria-hidden className="size-3 shrink-0 text-faint" />
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content align="start" sideOffset={4} collisionPadding={8} className={cn(panelClass, "w-[min(300px,calc(100vw-16px))]")} aria-label="Branches to compare against"
        onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); inputRef.current?.select(); }}>
        <form className="p-1" onSubmit={(event) => { event.preventDefault(); if (!busy) apply(query.trim() || null); }}>
          <input ref={inputRef} aria-label="Branch to compare against" placeholder="Branch or commit…" value={query} onChange={(event) => setQuery(event.target.value)}
            className="h-7 w-full rounded-md bg-well px-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40" />
        </form>
        <div className="mt-1">
          <BranchOption name="Automatic" detail="The branch this one started from" chosen={value === null} onSelect={() => apply(null)} disabled={busy} />
          {shown.map((branch) => <BranchOption key={branch.name} name={branch.name} mono detail={branch.remote ? "Remote branch" : "Local branch"} chosen={value === branch.name} onSelect={() => apply(branch.name)} disabled={busy} />)}
          {q && !shown.some((branch) => branch.name.toLowerCase() === q) && <BranchOption name={`Compare against ${query.trim()}`} chosen={false} onSelect={() => apply(query.trim())} disabled={busy} />}
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

function BranchOption({ name, detail, chosen, onSelect, mono, disabled }: { name: string; detail?: string; chosen: boolean; onSelect: () => void; mono?: boolean; disabled?: boolean }) {
  return <button type="button" aria-current={chosen || undefined} disabled={disabled} onClick={onSelect}
    className={cn("flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2.5 text-left text-[12.5px] outline-none hover:bg-veil-strong focus-visible:bg-veil-strong focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50", chosen && "bg-selected")}>
    <GitBranch aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    <span className={cn("min-w-0 truncate", mono && "font-mono text-[12px]")}>{name}</span>
    {detail && <span className="ml-auto shrink-0 pl-2 text-[11px] text-faint">{detail}</span>}
    {chosen && <Check aria-hidden className="size-3.5 shrink-0" />}
  </button>;
}
