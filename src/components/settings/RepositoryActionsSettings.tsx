import { useId, useState, type ReactNode } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Eye, EyeOff, FolderGit2, Gripper, Plus, RotateCcw, Trash2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { IconPicker, RepositoryIcon } from "@/components/ui/IconPicker";
import { KbdGroup } from "@/components/ui/tooltip";
import { useShortcutKeys } from "@/lib/hotkeys";
import { cn } from "@/lib/cn";
import { moveRepositoryEntry, validateAction, visibleActions, type RepositoryAction } from "@/lib/repositoryActions";
import { RepositoryFieldError, repositoryInputClass, useRepositoryMutation } from "./repositoryEditor";
import { ScriptEditor } from "./ScriptEditor";

const chipClass = "inline-flex h-[18px] shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 text-[11px] leading-none [&_svg]:size-3";

/** Controlled editor: its parent owns persistence and publishes a successful save through `actions`. */
export function RepositoryActionsSettings({ actions, onChange, onReset, sourceFile }: {
  actions: readonly RepositoryAction[];
  onChange: (actions: RepositoryAction[]) => Promise<void>;
  /** Replace the entire local action list with repository-file actions. Absent until that source is available. */
  onReset?: () => Promise<void>;
  /** The repository file the actions were read from, for the chips and the dialog; absent while they are kept on this computer. */
  sourceFile?: string;
}) {
  const [editing, setEditing] = useState<{ action: RepositoryAction; isNew: boolean } | null>(null);
  const mutation = useRepositoryMutation();
  const errorId = useId();
  const runKeys = useShortcutKeys("session.runAction");
  const change = (next: RepositoryAction[]) => mutation.run(() => onChange(next));
  const firstVisible = visibleActions(actions)[0]?.id;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = actions.findIndex((entry) => entry.id === active.id);
    const to = actions.findIndex((entry) => entry.id === over.id);
    if (from < 0 || to < 0) return;
    const next = [...actions];
    next.splice(to, 0, ...next.splice(from, 1));
    void change(next);
  };
  return (
    <section aria-labelledby={`${errorId}-title`} className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h4 id={`${errorId}-title`} className="text-[15px] font-semibold">Run actions</h4>
          <p className="mt-1 text-[13px] text-muted-foreground">Shortcuts for quick commands such as the dev server or the test suite. The first visible one runs with {runKeys.join("") || "the Run shortcut"}; with several, it opens the Run menu.</p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0" aria-label="Add action" disabled={mutation.busy} onClick={() => {
          mutation.clearError();
          setEditing({ isNew: true, action: { id: crypto.randomUUID(), name: "", icon: "terminal", command: "", runAfterSetup: false, concurrent: false, hidden: false } });
        }}><Plus />Add</Button>
      </div>
      {!actions.length ? <p className="rounded-lg border border-hairline-strong px-4 py-3 text-[13px] text-muted-foreground">Add commands for this project, such as a dev server, tests or lint.</p> : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={actions.map((action) => action.id)} strategy={verticalListSortingStrategy}>
            <ol aria-label="Saved actions" className="divide-y divide-hairline overflow-hidden rounded-lg border border-hairline-strong">
              {actions.map((action, index) => (
                <ActionRow key={action.id} action={action} disabled={mutation.busy}
                  keys={action.id === firstVisible ? runKeys : []} sourceFile={sourceFile}
                  onMove={(direction) => {
                    if (index + direction < 0 || index + direction >= actions.length) return;
                    void change(moveRepositoryEntry(actions, action.id, direction));
                  }}
                  onEdit={() => { mutation.clearError(); setEditing({ action, isNew: false }); }} />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
      {onReset && <div className="flex flex-col items-start gap-1">
        <Button variant="outline" size="sm" disabled={mutation.busy || !!editing} onClick={() => void mutation.run(onReset)}>
          <RotateCcw />Reset all actions to {sourceFile ?? "terminalx.json"}
        </Button>
        <p className="text-xs text-muted-foreground">Replaces the entire action list with the repository file's actions, discarding local changes.</p>
      </div>}
      {!editing && <RepositoryFieldError id={errorId} error={mutation.error} />}
      {editing && <ActionDialog
        key={editing.action.id}
        action={editing.action}
        actions={actions}
        isNew={editing.isNew}
        busy={mutation.busy}
        error={mutation.error}
        sourceFile={sourceFile}
        onClose={() => setEditing(null)}
        onDelete={() => change(actions.filter((entry) => entry.id !== editing.action.id))}
        onToggleHidden={() => change(actions.map((entry) => entry.id === editing.action.id ? { ...entry, hidden: !entry.hidden } : entry))}
        onSave={async (action) => {
          // Visibility is changed with Hide action, not the draft. Keep a change
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

/** One 48px row (design 11.06): drag handle, icon tile, name with its notes, the command beneath, and Edit. */
function ActionRow({ action, keys, sourceFile, disabled, onMove, onEdit }: {
  action: RepositoryAction;
  keys: string[];
  sourceFile?: string;
  disabled: boolean;
  onMove: (direction: -1 | 1) => void;
  onEdit: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: action.id, disabled });
  const notes: ReactNode[] = [];
  if (keys.length) notes.push(<KbdGroup key="keys" keys={keys} />);
  if (action.runAfterSetup) notes.push(<span key="setup" className={cn(chipClass, "bg-veil-strong text-muted-foreground")}>runs after setup</span>);
  if (action.concurrent) notes.push(<span key="concurrent" className={cn(chipClass, "bg-veil-strong text-muted-foreground")}>several at once</span>);
  if (sourceFile) notes.push(<span key="file" className={cn(chipClass, "bg-info/10 font-mono text-info")}><FolderGit2 aria-hidden />{sourceFile}</span>);
  if (action.hidden) notes.push(<span key="hidden" className={cn(chipClass, "bg-warning/10 text-warning")}><EyeOff aria-hidden />Hidden</span>);
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} data-action-row={action.id}
      className={cn("relative flex min-h-12 items-center gap-2.5 bg-background py-1.5 pl-2 pr-3", isDragging && "z-10 shadow-surface")}>
      <button type="button" ref={setActivatorNodeRef} {...attributes} {...listeners} aria-roledescription="sortable" aria-label={`Reorder ${action.name}`}
        title="Drag to reorder, or press ↑ ↓" disabled={disabled}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          onMove(event.key === "ArrowUp" ? -1 : 1);
        }}
        className="flex h-7 w-4 shrink-0 cursor-grab touch-none items-center justify-center rounded text-faint outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40 active:cursor-grabbing disabled:cursor-default [&_svg]:size-3.5">
        <Gripper aria-hidden />
      </button>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-veil-strong text-muted-foreground"><RepositoryIcon value={action.icon} className="size-3.5" /></span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn("truncate text-[13px] font-medium", action.hidden && "text-muted-foreground")}>{action.name}</span>
          {notes}
        </span>
        <span className="block truncate font-mono text-xs text-faint">{action.command}</span>
      </span>
      <Button variant="outline" size="sm" aria-label={`Edit ${action.name}`} disabled={disabled} className="shrink-0" onClick={onEdit}>Edit</Button>
    </li>
  );
}

function ActionDialog({ action, actions, isNew, busy, error, sourceFile, onClose, onSave, onDelete, onToggleHidden }: {
  action: RepositoryAction;
  actions: readonly RepositoryAction[];
  isNew: boolean;
  busy: boolean;
  error: string | null;
  sourceFile?: string;
  onClose: () => void;
  onSave: (action: RepositoryAction) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  onToggleHidden: () => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(action);
  const [attempted, setAttempted] = useState(false);
  const [picking, setPicking] = useState(false);
  const id = useId();
  const stored = actions.find((entry) => entry.id === action.id);
  const hidden = stored?.hidden ?? action.hidden;
  const errors = attempted ? validateAction(draft, actions) : { name: undefined, command: undefined };
  const submit = async () => {
    if (busy) return;
    setAttempted(true);
    if (Object.values(validateAction(draft, actions)).some(Boolean)) return;
    if (await onSave({ ...draft, name: draft.name.trim() })) onClose();
  };
  const then = (run: () => Promise<boolean>) => async () => { if (!busy && await run()) onClose(); };
  const description = isNew
    ? "A command for this project's Run menu, kept on this computer for this project."
    : sourceFile
      ? `${action.name} · from ${sourceFile}. Saving keeps your change on this computer.`
      : `${action.name} · kept on this computer for this project.`;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent showClose={!busy} className="gap-0 p-0">
        <DialogHeader className="mb-0 px-5 pt-5">
          <DialogTitle className="text-base font-semibold">{isNew ? "Add action" : "Edit action"}</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">{description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }} onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) void submit();
          }
        }}>
          <fieldset disabled={busy} className="min-w-0 space-y-4 px-5 pb-5 pt-4">
            <div>
              <div className="flex items-center gap-2">
                <PopoverPrimitive.Root open={picking} onOpenChange={setPicking}>
                  <PopoverPrimitive.Trigger asChild>
                    <button type="button" aria-label={`Icon: ${draft.icon}. Change icon`} aria-haspopup="dialog"
                      className="flex size-8 shrink-0 items-center justify-center rounded-md bg-veil-strong text-foreground outline-none ring-1 ring-accent/70 hover:bg-veil-raised focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:ring-2 data-[state=open]:ring-accent">
                      <RepositoryIcon value={draft.icon} className="size-4" />
                    </button>
                  </PopoverPrimitive.Trigger>
                  <PopoverPrimitive.Portal>
                    <PopoverPrimitive.Content side="bottom" align="start" sideOffset={6} aria-label="Choose an icon"
                      className="z-(--z-menu) w-72 max-w-[calc(100vw-2rem)] rounded-lg bg-popover p-3 text-popover-foreground shadow-surface hairline outline-none data-[state=open]:animate-fade-in">
                      <IconPicker value={draft.icon} onChange={(icon) => { setDraft({ ...draft, icon }); setPicking(false); }} />
                    </PopoverPrimitive.Content>
                  </PopoverPrimitive.Portal>
                </PopoverPrimitive.Root>
                <label htmlFor={`${id}-name`} className="sr-only">Name</label>
                <input id={`${id}-name`} autoFocus placeholder="Name" value={draft.name} aria-invalid={!!errors.name} aria-describedby={errors.name ? `${id}-name-error` : undefined} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className={cn(repositoryInputClass, "h-8 py-0 text-[13px]")} />
              </div>
              <RepositoryFieldError id={`${id}-name-error`} error={errors.name} />
            </div>
            <div>
              <label htmlFor={`${id}-command`} className="mb-1.5 block text-xs font-medium">Command</label>
              <div className="rounded-md border border-hairline-strong bg-well">
                <ScriptEditor id={`${id}-command`} label="Command" value={draft.command} minLines={3} invalid={!!errors.command}
                  describedBy={errors.command ? `${id}-command-error` : `${id}-command-hint`} onChange={(command) => setDraft({ ...draft, command })} />
              </div>
              {errors.command ? <RepositoryFieldError id={`${id}-command-error`} error={errors.command} />
                : <p id={`${id}-command-hint`} className="mt-1.5 text-xs text-faint">Runs in the workspace folder with your and the project's variables. ⌘↵ saves.</p>}
            </div>
            <ActionSwitch id={`${id}-run-after-setup`} label="Run after setup" description="Starts once a new workspace finishes its setup script." checked={draft.runAfterSetup} onCheckedChange={(runAfterSetup) => setDraft({ ...draft, runAfterSetup })} />
            <ActionSwitch id={`${id}-concurrent`} label="Allow several at once" description="Off stops the running one before starting again." checked={draft.concurrent} onCheckedChange={(concurrent) => setDraft({ ...draft, concurrent })} />
            <RepositoryFieldError id={`${id}-save-error`} error={error} />
          </fieldset>
          <DialogFooter className="mt-0 items-center justify-between border-t border-hairline px-4 py-3">
            {!isNew && <div className="flex flex-wrap items-center gap-1">
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void then(onToggleHidden)()}>{hidden ? <Eye /> : <EyeOff />}{hidden ? "Show action" : "Hide action"}</Button>
              <Button variant="ghost" size="sm" disabled={busy} aria-label={`Delete ${action.name}`} className="text-muted-foreground hover:text-destructive" onClick={() => void then(onDelete)()}><Trash2 />Delete</Button>
            </div>}
            <div className="ml-auto flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>Cancel</Button>
              <Button type="submit" size="sm" disabled={busy} aria-label={busy ? "Saving…" : "Save action"}>{busy ? "Saving…" : <>Save <kbd className="font-sans text-[11px] opacity-60">⌘↵</kbd></>}</Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A field of the action being edited, laid out like a settings row. It is not a setting of its
 * own: it is saved with the action, so it stays out of the settings registry and its search. */
function ActionSwitch({ id, label, description, checked, onCheckedChange }: { id: string; label: string; description: string; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="block text-[13px] font-medium">{label}</label>
        <p id={`${id}-description`} className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} aria-describedby={`${id}-description`} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}
