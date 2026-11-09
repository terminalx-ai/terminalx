import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Check } from "@/icons";
import { api, errorMessage } from "@/lib/api";
import { bytesText } from "@/lib/cloudResources";
import type { Leftover } from "@/types/session";

/** Why what is offered is safe to remove: each one a check the backend makes before it deletes (`cleanup.rs`). */
const SAFE = [
  "No session uses them anymore",
  "Everything in them is already in main",
  "Nothing uncommitted, unpushed or stashed",
];

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 workspace folders, 1 old agent history and 3 branches". */
function summary(items: Leftover[]): string {
  const parts = [
    [items.filter((item) => item.kind === "worktree").length, "workspace folder", "workspace folders"],
    [items.filter((item) => item.kind === "agentData").length, "old agent history", "old agent histories"],
    [items.filter((item) => item.kind === "branch").length, "branch", "branches"],
  ] as const;
  const said = parts.filter(([n]) => n > 0).map(([n, one, many]) => count(n, one, many));
  return said.length > 1 ? `${said.slice(0, -1).join(", ")} and ${said.at(-1)}` : (said[0] ?? "");
}

/**
 * On a project's page: what earlier sessions left behind in this project (workspace folders no session uses, old
 * agent conversation data for workspaces that are gone, stray branches), and a way to remove it. Build output is
 * not counted here; that is the Files tab's.
 *
 * Only what the leftovers scan calls removable is offered: unused, and everything in it merged into the default
 * branch, verified against the remote. Removing scans again and deletes only what is still removable. Deletes are
 * direct, not to the Trash, and the confirm step says so.
 */
export function ProjectLeftovers({ path }: { path: string }) {
  const [items, setItems] = useState<Leftover[] | null>(null);
  const [kept, setKept] = useState(0);
  const [step, setStep] = useState<"offer" | "confirm" | "removing" | "done">("offer");
  const [freed, setFreed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Not now: until this page is opened again.
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let live = true;
    api.scanLeftovers()
      .then((all) => {
        if (!live) return;
        const mine = all.filter((item) => item.projectPath === path);
        setItems(mine.filter((item) => !item.keptBecause));
        setKept(mine.filter((item) => item.keptBecause).length);
      })
      .catch(() => { if (live) setItems(null); });
    return () => { live = false; };
  }, [path]);

  if (step === "done") {
    return (
      <div role="status" className="rounded-xl bg-well px-4 py-3 text-xs text-muted-foreground" data-testid="project-leftovers">
        Cleaned up {freed ? bytesText(freed) : "the leftovers"}.
      </div>
    );
  }
  if (!items?.length || hidden) return null;
  const bytes = items.reduce((sum, item) => sum + item.sizeBytes, 0);
  const remove = () => {
    setStep("removing");
    setError(null);
    api.removeLeftovers(items.map((item) => item.id))
      .then((result) => {
        setFreed(result.freedBytes);
        setStep("done");
      })
      .catch((cause: unknown) => {
        setError(errorMessage(cause));
        setStep("offer");
      });
  };

  return (
    <section aria-label="Leftovers from earlier sessions" className="flex flex-col gap-2 rounded-xl bg-well p-4" data-testid="project-leftovers">
      {step === "offer" ? (
        <>
          <p className="text-sm font-medium text-foreground">{bytes ? `${bytesText(bytes)} left over from earlier sessions` : "Left over from earlier sessions"}</p>
          <ul className="flex flex-col gap-1 text-xs text-muted-foreground" aria-label="Why they are safe to remove">
            {SAFE.map((reason) => (
              <li key={reason} className="flex items-start gap-2">
                <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-add" />
                <span>{reason}</span>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-faint">
            {summary(items)}
            {kept ? `. ${count(kept, "more is", "more are")} kept because it has work not in main.` : ""}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => setStep("confirm")}>{bytes ? `Clean up ${bytesText(bytes)}` : "Clean up"}</Button>
            <Button size="sm" variant="ghost" onClick={() => setHidden(true)}>Not now</Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm font-medium text-foreground">Delete them for good?</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {summary(items)}. They are deleted, not moved to the Trash. Everything is checked again first, and anything used or
            changed since is left alone.
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="secondary" disabled={step === "removing"} onClick={remove}>{step === "removing" ? "Cleaning up…" : "Delete"}</Button>
            <Button size="sm" variant="ghost" disabled={step === "removing"} onClick={() => setStep("offer")}>Cancel</Button>
          </div>
        </>
      )}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </section>
  );
}
