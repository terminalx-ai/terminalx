import { useState } from "react";
import type { PrMergeMethods } from "@terminalx/portable/workspaceGit";
import { Check, GitCommitVertical, GitFork, GitMerge, Loader2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { cn } from "@/lib/cn";
import { currentMergeMethod, MERGE_METHODS, mergeMethodLabel, methodAllowed, repositoryDefault, type MergeMethod } from "@/lib/mergeMethods";
import { keycaps, useKeymap } from "@/lib/shortcuts";

/** What to do around the merge, chosen in the menu. */
export interface MergeChoices {
  /** Archive this session once merged: only offered for a workspace this app manages. */
  archive: boolean;
  /** Delete the head branch on GitHub once merged: only where the source can. */
  deleteBranch: boolean;
}

const ICON = { squash: GitMerge, rebase: GitCommitVertical, merge: GitFork } as const;

function description(method: MergeMethod, methods: PrMergeMethods | null | undefined, commits: number | null | undefined, base: string): string {
  if (!methodAllowed(methods, method)) return "Not allowed in this repository";
  if (repositoryDefault(methods) === method) return "Repository default";
  if (method === "squash") return `One commit on ${base}`;
  if (method === "rebase") return commits ? `Keeps all ${commits} ${commits === 1 ? "commit" : "commits"}` : "Keeps each commit";
  return "Adds a merge commit";
}

/**
 * The Merge button's menu (design 05.10): MERGE METHOD, each method with what it does and the current one ticked, the
 * one ⇧⌘M uses marked with its keys, then what to do once merged.
 */
export function MergeMenu({ url, base, methods, commits, disabled, working, size = "xs", archive, canDeleteBranch, shortcutMethod, onMerge }: {
  url: string;
  base: string;
  methods?: PrMergeMethods | null;
  commits?: number | null;
  disabled: boolean;
  working: boolean;
  size?: "xs" | "sm";
  /** The archive choice's starting value, or null where the session cannot be archived from here. */
  archive: boolean | null;
  canDeleteBranch: boolean;
  /** The method the Merge pull request shortcut uses (the project's pipeline setting), when known. */
  shortcutMethod?: MergeMethod | null;
  onMerge: (method: MergeMethod, choices: MergeChoices) => void;
}) {
  const current = currentMergeMethod(url, methods);
  const [archiveChoice, setArchive] = useState<boolean | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const archiving = archive === null ? false : archiveChoice ?? archive;
  const keys = useKeymap()["git.merge"]?.[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size={size} className="bg-merge text-merge-foreground hover:opacity-90" disabled={disabled}>
          {working ? <Loader2 className="animate-spin" /> : <GitMerge />} Merge
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[296px]" aria-label="Merge pull request">
        <DropdownMenuLabel className="px-2.5 pb-1 pt-2 font-normal tracking-[.08em]">Merge method</DropdownMenuLabel>
        {MERGE_METHODS.map((method) => {
          const Icon = ICON[method];
          const allowed = methodAllowed(methods, method);
          return (
            <DropdownMenuItem key={method} disabled={!allowed} onSelect={() => onMerge(method, { archive: archiving, deleteBranch })}
              className={cn("items-start gap-2.5 whitespace-normal px-2.5 py-1.5 text-[12.5px] [&_svg]:size-3.5", method === current && "bg-veil")}
              data-current={method === current || undefined}>
              <Icon className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="truncate">{mergeMethodLabel(method)}</div>
                <div className="mt-0.5 text-[11.5px] leading-4 text-faint">{description(method, methods, commits, base)}</div>
              </div>
              <span className="mt-0.5 ml-2 flex shrink-0 items-center gap-2">
                {keys && shortcutMethod === method && allowed && <kbd className="rounded border border-hairline px-1 font-sans text-[10.5px] leading-4 text-faint">{keycaps(keys).join("")}</kbd>}
                {method === current && <Check aria-label="Current choice" className="text-foreground!" />}
              </span>
            </DropdownMenuItem>
          );
        })}
        {(archive !== null || canDeleteBranch) && <DropdownMenuSeparator />}
        {archive !== null && (
          <DropdownMenuCheckboxItem indicator="box" checked={archiving} onSelect={(event) => event.preventDefault()} onCheckedChange={(value) => setArchive(value === true)} className="h-8 gap-2.5 px-2.5 text-[12.5px]">
            Archive this session after merge
          </DropdownMenuCheckboxItem>
        )}
        {canDeleteBranch && (
          <DropdownMenuCheckboxItem indicator="box" checked={deleteBranch} onSelect={(event) => event.preventDefault()} onCheckedChange={(value) => setDeleteBranch(value === true)} className="h-8 gap-2.5 px-2.5 text-[12.5px]">
            Delete the branch after merge
          </DropdownMenuCheckboxItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
