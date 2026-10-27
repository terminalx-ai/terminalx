import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/api";
import { renameBranch, updateProject } from "@/lib/sessions";

/** The branch a label would make: spaces become hyphens, as git allows no spaces. */
export function branchFromLabel(label: string): string {
  return label.trim().replace(/\s+/g, "-");
}

/**
 * Rename a branch's row: its label in the sidebar, and its git branch too when
 * asked. Its worktree keeps its folder and name; neither is shown anywhere.
 */
export function RenameBranchDialog({
  projectPath,
  branch,
  label,
  canRenameBranch,
  onClose,
}: {
  projectPath: string;
  branch: string;
  /** Its label now, if it has one. */
  label: string | undefined;
  /** The project's own checkout keeps its branch name; any other branch may be renamed. */
  canRenameBranch: boolean;
  onClose: () => void;
}) {
  const shown = label ?? branch;
  const [name, setName] = useState(shown);
  const [alsoBranch, setAlsoBranch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.select();
  }, []);
  const wanted = name.trim();
  const nextBranch = branchFromLabel(wanted);
  const renamingBranch = canRenameBranch && alsoBranch && nextBranch !== branch;
  const save = async () => {
    if (!wanted || saving) return;
    if (wanted === shown && !renamingBranch) return onClose();
    setSaving(true);
    setError(null);
    try {
      // The label is stored by branch name, so the branch is renamed first and the label set under its new name.
      const target = renamingBranch ? await renameBranch(projectPath, branch, nextBranch) : branch;
      await updateProject(projectPath, { branchLabel: { branch: target, label: wanted } });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent width="max-w-[26rem]" onEscapeKeyDown={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Rename</DialogTitle>
          <DialogDescription className="sr-only">Give the branch another name in the sidebar.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            ref={input}
            aria-label="Name"
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-border bg-well px-2.5 py-1.5 text-sm outline-none focus:border-ring"
          />
          {canRenameBranch && (
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={alsoBranch} onChange={(e) => setAlsoBranch(e.target.checked)} />
              Also rename branch
            </label>
          )}
          {renamingBranch && wanted && (
            <p className="mt-1.5 truncate pl-6 font-mono text-[11px] text-faint" title={`${branch} → ${nextBranch}`}>
              {branch} → {nextBranch}
            </p>
          )}
          {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!wanted || saving}>Rename</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
