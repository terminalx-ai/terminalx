import { CheckCircle2, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { dismissProjectAdded, requestProjectSettings, useProjectAdded } from "@/lib/projectAdded";
import { shortPath } from "@/lib/paths";

/** Confirms an added project with where it lives, and links to its settings. */
export function ProjectAddedNotice() {
  const added = useProjectAdded();
  if (!added) return null;
  return (
    <div role="status" aria-label="Project added" className="pointer-events-auto flex items-start gap-2.5 rounded-xl bg-popover p-3 text-sm shadow-surface hairline animate-fade-in">
      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-add" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">Project added</div>
        <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={added.path}>{shortPath(added.path)}</div>
        <Button size="xs" variant="outline" className="mt-2.5" onClick={() => { requestProjectSettings(added.path); dismissProjectAdded(); }}>Project settings</Button>
      </div>
      <button type="button" aria-label="Dismiss" onClick={dismissProjectAdded} className="rounded-sm p-0.5 text-faint hover:bg-veil-strong hover:text-foreground">
        <X className="size-3.5" />
      </button>
    </div>
  );
}
