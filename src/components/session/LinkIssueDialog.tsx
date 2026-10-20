import { useEffect, useState } from "react";
import { LoaderCircle, Search } from "@/icons";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { IssueListItem } from "@/components/issues/IssueListItem";
import { errorMessage, issues as issuesApi, type Issue } from "@/lib/api";
import { usePrefs } from "@/lib/prefs";
import { linkSessionIssue } from "@/lib/sessions";
import type { SessionEntry } from "@/types/session";

type Provider = "github" | "linear";

/**
 * "Link to issue…" (#441): pick, from the session's project, the issue it
 * works on. The link is the reader's own, shown as made by hand; it can be
 * unlinked again from the same menu.
 */
export function LinkIssueDialog({ session, onClose }: { session: SessionEntry; onClose: () => void }) {
  const prefs = usePrefs();
  const [provider, setProvider] = useState<Provider>(prefs.issueProvider);
  const [search, setSearch] = useState("");
  const [list, setList] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linking, setLinking] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      issuesApi
        .list(session.projectPath, provider, { search })
        .then((found) => live && setList(found))
        .catch((e) => {
          if (!live) return;
          setList([]);
          setError(errorMessage(e));
        })
        .finally(() => live && setLoading(false));
    }, provider === "github" ? 250 : 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [session.projectPath, provider, search]);

  const link = async (issue: Issue) => {
    if (linking) return;
    setLinking(`${issue.provider}:${issue.id}`);
    setError(null);
    try {
      await linkSessionIssue(session.id, { provider: issue.provider, id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setLinking(null);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !linking && onClose()}>
      <DialogContent width="max-w-[32rem]" className="max-h-[calc(100vh-2rem)]" onEscapeKeyDown={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Link to issue</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            “{session.title}” works on the issue you pick. Your other machines, and teammates who can see the repository, are shown it in their Issues list.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Segmented<Provider>
            aria-label="Provider"
            value={provider}
            onChange={setProvider}
            options={[
              { value: "github", label: "GitHub" },
              { value: "linear", label: "Linear" },
            ]}
          />
          <div className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md bg-well px-2">
            <Search className="size-3.5 shrink-0 text-faint" />
            <input
              autoFocus
              aria-label="Search issues"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search"
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-faint"
            />
            {loading && <LoaderCircle className="size-3.5 shrink-0 animate-spin text-faint" />}
          </div>
        </div>
        <ul className="mt-2 max-h-80 min-h-24 overflow-y-auto rounded-lg bg-well p-1" aria-label="Issues">
          {list.map((issue) => (
            <li key={`${issue.provider}:${issue.id}`} className={linking === `${issue.provider}:${issue.id}` ? "opacity-60" : undefined}>
              <IssueListItem issue={issue} onSelect={() => void link(issue)} />
            </li>
          ))}
          {!loading && !error && list.length === 0 && <li className="px-2 py-3 text-xs text-muted-foreground">No open issues match.</li>}
        </ul>
        {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={!!linking}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
