import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Popover } from "radix-ui";
import { Check, ChevronDown, GitBranch, Search } from "@/icons";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useSessionStore } from "@/lib/sessions";
import type { BranchInfo } from "@/types/session";
import { branchByline, updatedLine } from "./StartFromPicker";

/**
 * The header's `from main` chip: the branch a new worktree's branch is made
 * from. The session still gets a branch of its own, so a branch another
 * session has checked out can be chosen too; the row says who has it.
 */
export function BaseBranchMenu({
  projectPath,
  value,
  defaultBranch,
  onChange,
  disabled,
}: {
  projectPath: string;
  /** The branch the worktree starts from now. */
  value: string;
  defaultBranch: string;
  onChange: (branch: string) => void;
  disabled: boolean;
}) {
  const store = useSessionStore();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [branches, setBranches] = useState<BranchInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    let live = true;
    setQuery("");
    setError(null);
    setBranches(null);
    api.listBranches(projectPath).then(
      (items) => live && setBranches(items),
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [open, projectPath]);
  useEffect(() => setHighlight(0), [query, open]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const titles = new Map<string, string>();
    for (const ws of store.workspaces[projectPath] ?? []) {
      if (!ws.branch || ws.isMain) continue;
      const session = (store.sessions ?? [])
        .filter((s) => s.projectPath === projectPath && s.cwd === ws.path && !s.archived && !s.worktreeRemoved)
        .sort((a, b) => b.modified.localeCompare(a.modified))[0];
      titles.set(ws.branch, session?.title ? `In use by “${session.title}”` : `Checked out in ${ws.name}`);
    }
    const isDefault = (branch: BranchInfo) => branch.name === defaultBranch || branch.name === `origin/${defaultBranch}`;
    return (branches ?? [])
      .filter((branch) => branch.name.toLowerCase().includes(q))
      // The default branch first, then the newest tips.
      .sort((a, b) => Number(isDefault(b)) - Number(isDefault(a)) || (b.updated ?? "").localeCompare(a.updated ?? "") || a.name.localeCompare(b.name))
      .slice(0, 100)
      .map((branch) => ({
        branch,
        second: isDefault(branch) ? ["default branch", updatedLine(branch.updated)].filter(Boolean).join(" · ") : (titles.get(branch.name) ?? null),
        byline: branchByline(branch),
      }));
  }, [branches, query, store.workspaces, store.sessions, projectPath, defaultBranch]);
  const active = Math.min(highlight, Math.max(0, rows.length - 1));
  const choose = (name: string) => {
    onChange(name);
    setOpen(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Base branch: ${value}`}
          title={`Works on a new branch of its own, made from ${value}, so it never touches your other work.`}
          data-testid="base-branch-chip"
          className={cn("flex h-7 min-w-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-veil-raised hover:text-foreground disabled:opacity-50", open && "bg-veil-raised text-foreground")}
        >
          <GitBranch className="size-[13px] shrink-0" aria-hidden />
          <span className="min-w-0 truncate">from {value}</span>
          <ChevronDown className="size-3 shrink-0 text-faint" aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={8}
          collisionPadding={8}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            input.current?.focus();
          }}
          data-testid="base-branch-menu"
          className="z-(--z-menu) w-[330px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg bg-popover text-[12.5px] text-popover-foreground shadow-surface hairline animate-fade-in"
        >
          <div className="flex h-9 items-center gap-2 border-b border-hairline px-2.5">
            <Search className="size-[13px] shrink-0 text-faint" aria-hidden />
            <input
              ref={input}
              role="combobox"
              aria-label="Search branches"
              aria-autocomplete="list"
              aria-expanded
              aria-controls={`${id}-list`}
              aria-activedescendant={rows.length ? `${id}-${active}` : undefined}
              value={query}
              placeholder="Search branches"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setHighlight(rows.length ? (active + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length : 0);
                }
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (rows[active]) choose(rows[active].branch.name);
                }
              }}
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint"
            />
          </div>
          <div className="p-1">
            <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-[.08em] text-faint">Start the worktree from</div>
            <div ref={list} id={`${id}-list`} role="listbox" aria-label="Base branch" className="max-h-64 overflow-y-auto scrollbar-thin">
              {rows.map(({ branch, second, byline }, index) => (
                <button
                  key={branch.name}
                  id={`${id}-${index}`}
                  type="button"
                  role="option"
                  aria-label={[branch.name, second].filter(Boolean).join(" ")}
                  aria-selected={index === active}
                  onMouseMove={() => setHighlight(index)}
                  onClick={() => choose(branch.name)}
                  className={cn("flex min-h-8 w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left", index === active && "bg-veil-strong")}
                >
                  <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs">{branch.name}</span>
                    {second && <span className="block truncate text-[11.5px] leading-4 text-faint">{second}</span>}
                  </span>
                  {branch.name === value ? <Check className="size-3.5 shrink-0 text-foreground" aria-label="Chosen" /> : byline ? <span className="shrink-0 whitespace-nowrap text-[11px] text-faint">{byline}</span> : null}
                </button>
              ))}
            </div>
            {!branches && !error && (
              <p role="status" className="px-2.5 py-2 text-xs text-faint">
                Loading…
              </p>
            )}
            {branches && !rows.length && (
              <p role="status" className="px-2.5 py-2 text-xs text-muted-foreground">
                No branch matches “{query.trim()}”.
              </p>
            )}
            {error && (
              <p role="alert" className="break-words px-2.5 py-2 text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
