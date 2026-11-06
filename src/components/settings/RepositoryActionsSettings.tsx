import { useId, useState } from "react";
import { Plus, Trash2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { SettingRow, Switch } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { IconPicker, RepositoryIcon } from "@/components/ui/IconPicker";
import { moveRepositoryEntry, validateAction, type RepositoryAction } from "@/lib/repositoryActions";
import { RepositoryFieldError, RepositoryOrderButtons, repositoryInputClass, useRepositoryMutation } from "./repositoryEditor";

/** Controlled editor: its parent owns persistence and publishes a successful save through `actions`. */
export function RepositoryActionsSettings({ actions, onChange, onReset }: {
  actions: readonly RepositoryAction[];
  onChange: (actions: RepositoryAction[]) => Promise<void>;
  /** Clear local overrides, then reread the repository file. Absent until that source is available. */
  onReset?: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<{ action: RepositoryAction; isNew: boolean } | null>(null);
  const mutation = useRepositoryMutation();
  const errorId = useId();
  const change = (next: RepositoryAction[]) => mutation.run(() => onChange(next));
  return (
    <section aria-label="Actions" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Actions</h3>
        <Button variant="outline" size="sm" disabled={mutation.busy} onClick={() => {
          mutation.clearError();
          setEditing({ isNew: true, action: { id: crypto.randomUUID(), name: "", icon: "terminal", command: "", runAfterSetup: false, concurrent: false, hidden: false } });
        }}><Plus />Add action</Button>
      </div>
      {!actions.length && <p className="text-sm text-muted-foreground">Add commands for this repository, such as a dev server, tests or lint.</p>}
      <ol aria-label="Saved actions" className="divide-y divide-hairline">
        {actions.map((action, index) => (
          <li key={action.id} className="flex flex-wrap items-center gap-1 py-2">
            <RepositoryIcon value={action.icon} className="mr-1 size-4 shrink-0 text-muted-foreground" />
            <button type="button" aria-label={`Edit ${action.name}`} disabled={mutation.busy} className="min-w-0 flex-1 rounded-md px-1 py-1 text-left outline-none hover:bg-veil-raised focus-visible:ring-2 focus-visible:ring-ring/40" onClick={() => {
              mutation.clearError();
              setEditing({ action, isNew: false });
            }}>
              <span className="block truncate text-sm">{action.name}{action.hidden && <span className="ml-2 text-xs text-muted-foreground">Hidden</span>}</span>
              <span className="block truncate font-mono text-xs text-muted-foreground">{action.command}</span>
            </button>
            <RepositoryOrderButtons name={action.name} index={index} count={actions.length} disabled={mutation.busy} onMove={(direction) => void change(moveRepositoryEntry(actions, action.id, direction))} />
            <Button variant="ghost" size="sm" aria-label={`${action.hidden ? "Show" : "Hide"} ${action.name}`} disabled={mutation.busy} onClick={() => void change(actions.map((entry) => entry.id === action.id ? { ...entry, hidden: !entry.hidden } : entry))}>{action.hidden ? "Show" : "Hide"}</Button>
            <Button variant="ghost" size="icon-sm" aria-label={`Delete ${action.name}`} disabled={mutation.busy} onClick={() => void change(actions.filter((entry) => entry.id !== action.id))}><Trash2 /></Button>
          </li>
        ))}
      </ol>
      {onReset && <Button variant="outline" size="sm" disabled={mutation.busy} onClick={() => void mutation.run(onReset)}>Reset to repository file</Button>}
      {!editing && <RepositoryFieldError id={errorId} error={mutation.error} />}
      {editing && <ActionDialog
        key={editing.action.id}
        action={editing.action}
        actions={actions}
        isNew={editing.isNew}
        busy={mutation.busy}
        error={mutation.error}
        onClose={() => setEditing(null)}
        onSave={async (action) => {
          // Visibility is edited in the list, not this dialog. Keep a change
          // received from another window while this command was being edited.
          const next = editing.isNew ? [...actions, action] : actions.map((entry) => entry.id === action.id ? { ...action, hidden: entry.hidden } : entry);
          // A concurrent deletion must not turn a successful save into a silent no-op.
          if (!editing.isNew && !actions.some((entry) => entry.id === action.id)) return mutation.run(async () => { throw new Error("This action was removed. Close the dialog and add it again."); });
          return change(next);
        }}
      />}
    </section>
  );
}

function ActionDialog({ action, actions, isNew, busy, error, onClose, onSave }: {
  action: RepositoryAction;
  actions: readonly RepositoryAction[];
  isNew: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (action: RepositoryAction) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(action);
  const [attempted, setAttempted] = useState(false);
  const id = useId();
  const errors = attempted ? validateAction(draft, actions) : { name: undefined, command: undefined };
  const submit = async () => {
    if (busy) return;
    setAttempted(true);
    if (Object.values(validateAction(draft, actions)).some(Boolean)) return;
    if (await onSave({ ...draft, name: draft.name.trim() })) onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent showClose={!busy}>
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">{isNew ? "Add action" : "Edit action"}</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">Name a command for this repository. Save with ⌘↵.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }} onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) void submit();
          }
        }}>
          <fieldset disabled={busy} className="min-w-0 space-y-4">
            <div>
              <label htmlFor={`${id}-name`} className="mb-1 block text-xs font-medium">Name</label>
              <input id={`${id}-name`} autoFocus value={draft.name} aria-invalid={!!errors.name} aria-describedby={errors.name ? `${id}-name-error` : undefined} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className={repositoryInputClass} />
              <RepositoryFieldError id={`${id}-name-error`} error={errors.name} />
            </div>
            <IconPicker value={draft.icon} onChange={(icon) => setDraft({ ...draft, icon })} />
            <div>
              <label htmlFor={`${id}-command`} className="mb-1 block text-xs font-medium">Command</label>
              <textarea id={`${id}-command`} rows={5} spellCheck={false} autoCapitalize="off" autoCorrect="off" value={draft.command} aria-invalid={!!errors.command} aria-describedby={errors.command ? `${id}-command-error` : undefined} onChange={(event) => setDraft({ ...draft, command: event.target.value })} className={`${repositoryInputClass} resize-y font-mono`} />
              <RepositoryFieldError id={`${id}-command-error`} error={errors.command} />
            </div>
            <SettingRow label="Run after setup" control={<Switch aria-label="Run after setup" checked={draft.runAfterSetup} onCheckedChange={(runAfterSetup) => setDraft({ ...draft, runAfterSetup })} />} />
            <SettingRow label="Allow several at once" control={<Switch aria-label="Allow several at once" checked={draft.concurrent} onCheckedChange={(concurrent) => setDraft({ ...draft, concurrent })} />} />
          </fieldset>
          <RepositoryFieldError id={`${id}-save-error`} error={error} />
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save action"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
