import { useEffect, useMemo, useRef, useState } from "react";
import { GitPullRequest, Link, LoaderCircle, Search, TriangleAlert } from "@/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { errorMessage, gh, type OpenPr, type PrLinkCandidates } from "@/lib/api";
import { cn } from "@/lib/cn";
import { showPanelTab } from "@/lib/panelTab";
import { authorInitials, authorTint, checkBadge, filterOpenPrs, linkPr, onAnotherBranch } from "@/lib/prLinks";
import { prIdentity } from "@/lib/sessionPrs";
import type { SessionEntry } from "@/types/session";

type Row = OpenPr & { taken: "here" | "elsewhere" | null };

const TINT = {
  info: "bg-info/15 text-info",
  accent: "bg-accent/15 text-accent",
  merged: "bg-merged/15 text-merged",
  add: "bg-add/15 text-add",
} as const;

const BADGE = {
  passed: "text-add",
  running: "text-accent",
  failed: "text-destructive",
  draft: "text-muted-foreground",
  none: "text-faint",
} as const;

/**
 * "Link a pull request" (PRO-294, design 05.19): pick one of the repository's
 * open pull requests for this session to show, its checks and its review,
 * whichever branch it is on. Push still goes to the session's own branch.
 * One session shows a pull request at a time: one another session shows
 * already is listed, dimmed, and cannot be picked.
 */
export function LinkPrDialog({ session, onClose }: { session: SessionEntry; onClose: () => void }) {
  const [found, setFound] = useState<PrLinkCandidates | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<number | null>(null);
  const [linking, setLinking] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    gh.linkCandidates(session.cwd, session.id)
      .then((candidates) => live && setFound(candidates))
      .catch((e) => live && setError(errorMessage(e)));
    return () => { live = false; };
  }, [session.cwd, session.id]);

  const rows: Row[] = useMemo(() => {
    if (!found) return [];
    const here = new Set(found.here.map(prIdentity));
    const elsewhere = new Set(found.elsewhere.map(prIdentity));
    return filterOpenPrs(found.prs, query).map((pr) => {
      const id = prIdentity(pr.url);
      return { ...pr, taken: here.has(id) ? "here" : elsewhere.has(id) ? "elsewhere" : null };
    });
  }, [found, query]);
  const choosable = rows.filter((row) => !row.taken);
  // The pick follows the search: the first row that can be linked, unless the reader chose one still listed.
  const selected = choosable.find((row) => row.number === picked) ?? choosable[0] ?? null;

  useEffect(() => {
    if (!selected) return;
    list.current?.querySelector(`[data-pr="${selected.number}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  const move = (step: 1 | -1) => {
    if (choosable.length === 0) return;
    const at = selected ? choosable.indexOf(selected) : -1;
    setPicked(choosable[(at + step + choosable.length) % choosable.length].number);
  };

  const link = async () => {
    if (!selected || linking) return;
    setLinking(true);
    setLinkError(null);
    try {
      await linkPr(session.id, session.cwd, selected);
      // Its checks and review are in the Branch tab's pull request section.
      showPanelTab("branch");
      onClose();
    } catch (e) {
      setLinkError(errorMessage(e));
      setLinking(false);
    }
  };

  const count = found ? `${found.total} open PR${found.total === 1 ? "" : "s"} in ${found.repository}.` : "";
  const shown = found && found.total > found.prs.length ? ` The ${found.prs.length} most recent are listed.` : "";

  return (
    <Dialog open onOpenChange={(open) => !open && !linking && onClose()}>
      <DialogContent width="max-w-[600px]" showClose={false} className="p-0" onEscapeKeyDown={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 px-5 pt-5">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted">
            <Link className="size-4 text-muted-foreground" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-[15px] font-semibold leading-6">Link a pull request</DialogTitle>
            <DialogDescription className="mt-1 text-[13px] text-muted-foreground">
              Show an open PR’s checks and review in this session.{found && ` ${count}${shown}`}
            </DialogDescription>
          </div>
        </div>
        <form
          className="px-5"
          onSubmit={(e) => {
            e.preventDefault();
            void link();
          }}
        >
          <label className="mt-3 flex h-9 items-center gap-2 rounded-md border border-border bg-raised px-3 text-[13px] focus-within:border-accent/60">
            <Search className="size-3.5 shrink-0 text-faint" />
            <input
              autoFocus
              aria-label="Search open PRs"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  move(e.key === "ArrowDown" ? 1 : -1);
                }
              }}
              placeholder="Search open PRs by number, title or branch"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint"
            />
            {!found && !error && <LoaderCircle className="size-3.5 shrink-0 animate-spin text-faint" aria-label="Loading open pull requests" />}
          </label>
          {error ? (
            <div role="alert" className="mt-2 rounded-md bg-well px-3 py-3 text-[12.5px]" data-testid="link-pr-unreachable">
              <div className="font-medium text-foreground">Can’t reach GitHub</div>
              <div className="mt-0.5 text-muted-foreground">Open pull requests could not be listed. Check this repository’s GitHub connection and try again.</div>
              <div className="mt-1 break-words font-mono text-[11.5px] text-faint">{error}</div>
            </div>
          ) : found && found.prs.length === 0 ? (
            <p className="mt-2 rounded-md bg-well px-3 py-3 text-[12.5px] text-muted-foreground" data-testid="link-pr-none">
              {found.repository} has no open pull requests.
            </p>
          ) : found && rows.length === 0 ? (
            <p className="mt-2 px-1 py-3 text-[12.5px] text-muted-foreground">No open PRs match “{query.trim()}”.</p>
          ) : (
            <div ref={list} role="listbox" aria-label="Open pull requests" className="-mx-1 mt-2 grid max-h-80 gap-0.5 overflow-y-auto scrollbar-thin">
              {rows.map((pr) => {
                const badge = checkBadge(pr);
                const isSelected = pr === selected;
                return (
                  <div
                    key={pr.url}
                    data-pr={pr.number}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={!!pr.taken}
                    onClick={() => !pr.taken && setPicked(pr.number)}
                    onDoubleClick={() => { if (!pr.taken) { setPicked(pr.number); void link(); } }}
                    className={cn(
                      "flex items-center gap-2.5 rounded-md px-2.5 py-2",
                      pr.taken ? "opacity-50" : "cursor-default hover:bg-veil-raised",
                      isSelected && "bg-selected ring-1 ring-inset ring-accent/40 hover:bg-selected",
                    )}
                  >
                    <GitPullRequest className="size-3.5 shrink-0 text-info" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-[12.5px]">
                        <span className="font-mono text-faint">#{pr.number}</span>
                        <span className="truncate text-foreground">{pr.title}</span>
                        {pr.taken && (
                          <span className="whitespace-nowrap rounded bg-muted px-1.5 text-[10.5px] text-muted-foreground">
                            {pr.taken === "here" ? "Shown in this session" : "Linked to another session"}
                          </span>
                        )}
                      </div>
                      <div className="truncate font-mono text-[11.5px] text-faint">{pr.headLabel} → {pr.base}</div>
                    </div>
                    <span className={cn("whitespace-nowrap text-[11.5px]", BADGE[badge.tone])}>{badge.text}</span>
                    {pr.author && (
                      <span title={pr.author} className={cn("grid size-5 shrink-0 place-items-center rounded-full text-[9px] font-semibold", TINT[authorTint(pr.author)])}>
                        {authorInitials(pr.author)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {selected && onAnotherBranch(selected, session.branch) && (
            <div role="note" className="mt-3 flex gap-2.5 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5 text-[12.5px]" data-testid="link-pr-different-branch">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <div>
                <div className="font-medium text-foreground">Different branch</div>
                <div className="text-muted-foreground">
                  #{selected.number} is on <span className="font-mono text-[12px]">{selected.headLabel}</span>;{" "}
                  {session.branch ? <>this session is on <span className="font-mono text-[12px]">{session.branch}</span>.</> : "this session is not on a branch."}{" "}
                  Checks and review will come from #{selected.number}, and Push still goes to this session’s branch.
                </div>
              </div>
            </div>
          )}
          {linkError && <p role="alert" className="mt-2 text-xs text-destructive">{linkError}</p>}
          <div className="flex items-center justify-end gap-2 pb-4 pt-4">
            <Button type="button" variant="outline" className="h-8 rounded-md px-3 text-[12.5px] text-muted-foreground" onClick={onClose} disabled={linking}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" className="h-8 rounded-md px-3 text-[12.5px] font-semibold" disabled={!selected || linking}>
              {linking && <LoaderCircle className="animate-spin" />}
              {selected ? `Link #${selected.number}` : "Link"}
              <kbd className="ml-1.5 rounded-[5px] border border-accent-foreground/30 px-1 py-0.5 font-mono text-[10.5px] leading-none text-accent-foreground">↵</kbd>
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
