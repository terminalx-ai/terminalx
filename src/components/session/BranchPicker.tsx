import { useEffect, useMemo, useState } from "react";
import { Popover } from "radix-ui";
import { Check, ChevronDown, GitBranch, LoaderCircle, Plus, Search } from "@/icons";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { refreshWorkspaces, useSessionStore } from "@/lib/sessions";
import type { BranchInfo, Workspace } from "@/types/session";

/** Where the new session works: a new branch, a branch already open here, or another existing branch. */
export type BranchTarget = { kind: "new" } | { kind: "open"; cwd: string } | { kind: "existing"; branch: string };

/**
 * The branch a new session starts on, searched as you type. A new branch is
 * the default. A branch already open in a workspace gets the session as one
 * more tab beside its others; any other branch is checked out in a worktree
 * of its own.
 */
export function BranchPicker({
  projectPath,
  defaultBranch,
  target,
  onChange,
}: {
  projectPath: string;
  defaultBranch: string;
  target: BranchTarget;
  onChange: (target: BranchTarget) => void;
}) {
  const store = useSessionStore();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [branches, setBranches] = useState<BranchInfo[] | null>(null);
  const workspaces: Workspace[] = store.workspaces[projectPath] ?? [];

  useEffect(() => {
    if (!open) return;
    setQuery("");
    void refreshWorkspaces(projectPath).catch(() => {});
    let live = true;
    api
      .listBranches(projectPath)
      .then((list) => live && setBranches(list))
      .catch(() => live && setBranches([]));
    return () => {
      live = false;
    };
  }, [open, projectPath]);

  const openBranches = workspaces.filter((ws) => ws.branch);
  const taken = new Set(openBranches.map((ws) => ws.branch!));
  const others = useMemo(() => {
    const seen = new Set<string>();
    const out: BranchInfo[] = [];
    // Local branches first; a remote one only when no local branch has its name.
    for (const branch of [...(branches ?? [])].sort((a, b) => Number(a.remote) - Number(b.remote))) {
      const local = branch.remote ? branch.name.split("/").slice(1).join("/") : branch.name;
      if (!local || taken.has(local) || seen.has(local)) continue;
      seen.add(local);
      out.push(branch);
    }
    return out;
  }, [branches, workspaces]); // eslint-disable-line react-hooks/exhaustive-deps

  const q = query.trim().toLowerCase();
  const matches = (text: string) => !q || text.toLowerCase().includes(q);
  const shownOpen = openBranches.filter((ws) => matches(ws.branch!) || matches(ws.name));
  const shownOthers = others.filter((branch) => matches(branch.name)).slice(0, 50);

  const label =
    target.kind === "new"
      ? "New branch"
      : target.kind === "existing"
        ? target.branch
        : (workspaces.find((ws) => ws.path === target.cwd)?.branch ?? "Workspace");
  const pick = (next: BranchTarget) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <Popover.Root modal open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Branch"
          title="Where the session works"
          className={cn(
            "flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-veil-raised hover:text-foreground",
            open && "bg-veil-raised text-foreground",
          )}
        >
          <GitBranch className="size-3.5 shrink-0" />
          <span className={cn("max-w-48 truncate", target.kind !== "new" && "font-mono")}>{label}</span>
          <ChevronDown className="size-3 shrink-0 text-faint" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-(--z-menu) flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl bg-popover glass text-popover-foreground shadow-surface hairline animate-fade-in"
        >
          <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
            <Search className="size-3.5 shrink-0 text-faint" />
            <input
              autoFocus
              aria-label="Search branches"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search branches…"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
            />
            {branches === null && <LoaderCircle className="size-3.5 shrink-0 animate-spin text-faint" />}
          </div>
          <div className="max-h-80 overflow-y-auto p-1 scrollbar-thin" role="listbox" aria-label="Branches">
            <Row selected={target.kind === "new"} onSelect={() => pick({ kind: "new" })} icon={<Plus className="size-3.5" />} name="New branch" note={`from ${defaultBranch}`} />
            {shownOpen.length > 0 && <Heading>Open here · adds a chat to it</Heading>}
            {shownOpen.map((ws) => (
              <Row
                key={ws.path}
                mono
                selected={target.kind === "open" && target.cwd === ws.path}
                onSelect={() => pick({ kind: "open", cwd: ws.path })}
                name={ws.branch!}
                note={ws.isMain ? "main checkout" : undefined}
              />
            ))}
            {shownOthers.length > 0 && <Heading>Other branches · checked out in a new worktree</Heading>}
            {shownOthers.map((branch) => (
              <Row
                key={branch.name}
                mono
                selected={target.kind === "existing" && target.branch === branch.name}
                onSelect={() => pick({ kind: "existing", branch: branch.name })}
                name={branch.name}
                note={branch.remote ? "remote" : undefined}
              />
            ))}
            {q && !shownOpen.length && !shownOthers.length && <p className="px-3 py-3 text-xs text-muted-foreground">No branch matches “{query.trim()}”.</p>}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Heading({ children }: { children: string }) {
  return <div className="px-2.5 pb-1 pt-2.5 text-[11px] text-faint">{children}</div>;
}

function Row({ name, note, icon, selected, mono = false, onSelect }: { name: string; note?: string; icon?: React.ReactNode; selected: boolean; mono?: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-veil-raised focus-visible:bg-veil-raised focus-visible:outline-none"
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">{selected ? <Check className="size-3.5 text-foreground" /> : icon}</span>
      <span className={cn("min-w-0 flex-1 truncate", mono && "font-mono text-[12.5px]")}>{name}</span>
      {note && <span className="shrink-0 text-[11px] text-faint">{note}</span>}
    </button>
  );
}
