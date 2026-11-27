import { useId } from "react";
import { Button } from "@/components/ui/button";
import type { CloudWorkspaceGeneralAccess } from "@/lib/api";

type Mode = CloudWorkspaceGeneralAccess["mode"];

export function CloudGeneralAccessControls({ mode, pending, everyone, editable, disabled, onChoose, onSave }: {
  mode: Mode;
  pending: Mode | null;
  everyone: string;
  editable: boolean;
  disabled: boolean;
  onChoose: (mode: Mode) => void;
  /** Its own Save button; left out where the dialog's Save also saves General access. */
  onSave?: () => void;
}) {
  const heading = useId();
  const selected = pending ?? mode;
  return (
    <section className="flex flex-col gap-2 border-t border-hairline pt-3" aria-labelledby={heading}>
      <h3 id={heading} className="text-sm font-medium">General access</h3>
      <div className="flex flex-wrap items-center gap-2">
        {editable ? (
          <select aria-label="General access" className="max-w-full rounded-md border border-hairline bg-background px-2 py-1"
            value={selected} disabled={disabled} onChange={(event) => onChoose(event.target.value === "organisation" ? "organisation" : "invited_only")}>
            <option value="invited_only">Only people invited</option>
            <option value="organisation">{everyone}</option>
          </select>
        ) : <span>{mode === "organisation" ? everyone : "Only people invited"}</span>}
        {selected === "organisation" && <span>Read</span>}
        {onSave && editable && pending && pending !== mode && (
          <Button size="sm" className="ms-auto" disabled={disabled} onClick={onSave}>Save General access</Button>
        )}
      </div>
      {selected === "organisation" && <p className="text-muted-foreground">Any member can open and read this workspace.</p>}
    </section>
  );
}
