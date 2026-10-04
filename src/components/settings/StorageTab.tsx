import { useCallback, useEffect, useMemo, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";
import { formatSize } from "@/lib/workspaceSizes";
import type { Leftover } from "@/types/session";

const KIND_LABEL: Record<Leftover["kind"], string> = {
  worktree: "Workspace with no session",
  agentData: "Agent conversations for a removed workspace",
  branch: "Branch with no worktree",
};

function describe(item: Leftover): string {
  if (item.kind === "agentData") return `${item.agent ?? "Agent"} data · ${item.name}`;
  return item.name;
}

/**
 * What earlier deletes left on disk, per project, with sizes. Nothing is
 * selected to begin with and nothing is deleted without the confirmation;
 * rows holding uncommitted or unpushed work cannot be selected at all.
 */
export function StorageTab() {
  const [items, setItems] = useState<Leftover[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [failures, setFailures] = useState<Record<string, string>>({});

  const scan = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const found = await api.scanLeftovers();
      setItems(found);
      const removable = new Set(found.filter((item) => !item.keptBecause).map((item) => item.id));
      setSelected((current) => new Set([...current].filter((id) => removable.has(id))));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void scan();
  }, [scan]);

  const removable = useMemo(() => (items ?? []).filter((item) => !item.keptBecause), [items]);
  const chosen = removable.filter((item) => selected.has(item.id));
  const chosenBytes = chosen.reduce((sum, item) => sum + item.sizeBytes, 0);
  const totalBytes = (items ?? []).reduce((sum, item) => sum + item.sizeBytes, 0);

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const remove = async () => {
    if (!chosen.length) return;
    const count = `${chosen.length} item${chosen.length === 1 ? "" : "s"}`;
    const yes = await ask(
      `Delete ${count} (${formatSize(chosenBytes)})?\n\n${chosen.map((item) => `• ${item.projectName}: ${describe(item)}`).join("\n")}\n\nThis deletes them from disk; they are not moved to the Trash. Each is checked again first: anything not clean and merged, or in use, is kept.`,
      { title: "Clean up leftovers", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" },
    ).catch(() => false);
    if (!yes) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const removal = await api.removeLeftovers(chosen.map((item) => item.id));
      setFailures(Object.fromEntries(removal.failed.map((failed) => [failed.id, failed.error])));
      const kept = removal.failed.length ? ` ${removal.failed.length} could not be deleted and ${removal.failed.length === 1 ? "was" : "were"} kept.` : "";
      setResult(`Deleted ${removal.removed.length} item${removal.removed.length === 1 ? "" : "s"} and freed ${formatSize(removal.freedBytes)}.${kept}`);
      setSelected(new Set());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
    await scan();
  };

  const projects = useMemo(() => {
    const groups = new Map<string, { name: string; items: Leftover[] }>();
    for (const item of items ?? []) {
      const group = groups.get(item.projectPath) ?? { name: item.projectName, items: [] };
      group.items.push(item);
      groups.set(item.projectPath, group);
    }
    return [...groups.entries()];
  }, [items]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Deleting a session or workspace can leave things behind: a workspace no session uses, an agent's conversations for a workspace that is gone, a
        branch with no workspace. They are listed here with what they take on disk. Only what is clean and merged into the default branch can be
        deleted from here; the rest says why it is kept, and can still be deleted from the sidebar, which asks a second time. Deleting is permanent;
        nothing is moved to the Trash.
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Agent conversations are matched to a removed workspace by the folder they say they were written in. If another install of the app (a
        development build, for example) still has a session from that workspace, its conversations are among them.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void scan()}>
          {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />} Scan again
        </Button>
        <Button variant="secondary" size="sm" disabled={busy || !removable.length} onClick={() => setSelected(new Set(removable.map((item) => item.id)))}>
          Select all removable
        </Button>
        <Button variant="destructive" size="sm" disabled={busy || !chosen.length} onClick={() => void remove()}>
          <Trash2 /> Delete selected{chosen.length ? ` (${formatSize(chosenBytes)})` : ""}
        </Button>
        {items && items.length > 0 && <span className="text-xs text-muted-foreground tabular-nums">{formatSize(totalBytes)} in total</span>}
      </div>

      {error && (
        <div role="alert" className="text-xs text-destructive">
          {error}
        </div>
      )}
      {result && (
        <div role="status" className="text-xs text-foreground">
          {result}
        </div>
      )}

      {items === null && !error && <div className="text-xs text-muted-foreground">Looking for leftovers…</div>}
      {items?.length === 0 && <div className="text-xs text-muted-foreground">Nothing left behind.</div>}

      {projects.map(([path, group]) => (
        <section key={path} aria-label={group.name} className="flex flex-col gap-1">
          <h3 className="text-[13px] font-medium">{group.name}</h3>
          <div className="truncate font-mono text-[11px] text-faint">{path}</div>
          <ul className="mt-1 flex flex-col divide-y divide-hairline rounded-lg bg-well">
            {group.items.map((item) => {
              const reason = failures[item.id] ?? item.keptBecause;
              const inputId = `leftover-${item.id}`;
              return (
                <li key={item.id} className="flex items-start gap-3 px-3 py-2">
                  <input
                    id={inputId}
                    type="checkbox"
                    className="mt-0.5 size-3.5 shrink-0 accent-foreground"
                    checked={selected.has(item.id)}
                    disabled={busy || !!item.keptBecause}
                    onChange={() => toggle(item.id)}
                  />
                  <label htmlFor={inputId} className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-foreground">{describe(item)}</span>
                    <span className="block text-[11px] text-muted-foreground">{KIND_LABEL[item.kind]}</span>
                    {item.paths[0] && item.kind !== "branch" && (
                      <span className="block truncate font-mono text-[11px] text-faint">
                        {item.paths[0]}
                        {item.paths.length > 1 ? ` and ${item.paths.length - 1} more` : ""}
                      </span>
                    )}
                    {reason && <span className="block text-[11px] text-warning">Kept: {reason}</span>}
                  </label>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{item.kind === "branch" ? "" : formatSize(item.sizeBytes)}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
