import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/api";
import { closeSectionDialog, editLocalSection, useLocalSections, type LocalSectionEdit } from "@/lib/localSections";
import { freeSectionName } from "@/lib/sidebarSections";

export function LocalSectionDialogs() {
  const { dialog } = useLocalSections();
  return dialog ? <SectionDialog key={dialog.kind + ("section" in dialog ? dialog.section.id : "")} dialog={dialog} /> : null;
}

function SectionDialog({ dialog }: { dialog: NonNullable<ReturnType<typeof useLocalSections>["dialog"]> }) {
  const { sections } = useLocalSections();
  const section = "section" in dialog ? dialog.section : null;
  const [name, setName] = useState(section?.name ?? freeSectionName(sections));
  const [emoji, setEmoji] = useState(section?.emoji ?? "");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const kind = dialog.kind;
  const title = kind === "create" ? "Create section" : kind === "rename" ? "Rename section" : kind === "emoji" ? "Change emoji" : kind === "move" ? "Move to section" : "Delete section";
  const close = () => { if (!pending.current) closeSectionDialog(); };
  const save = async () => {
    if (pending.current) return;
    const edit: LocalSectionEdit = kind === "create" ? { kind, name, emoji: emoji || null, sessionIds: dialog.sessionIds }
      : kind === "move" ? { kind, sessionIds: dialog.sessionIds, sectionId: target || null }
      : kind === "rename" ? { kind, id: dialog.section.id, name }
      : kind === "emoji" ? { kind, id: dialog.section.id, emoji: emoji || null }
      : { kind, id: dialog.section.id };
    pending.current = true;
    setBusy(true);
    setError(null);
    try { await editLocalSection(edit); closeSectionDialog(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { pending.current = false; setBusy(false); }
  };
  const inputClass = "mt-1 w-full rounded-md border border-border bg-well px-2.5 py-1.5 text-sm outline-none focus:border-ring";
  return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
    <DialogContent width="max-w-[26rem]" onEscapeKeyDown={(event) => event.stopPropagation()}>
      <DialogHeader>
        <DialogTitle className="text-base font-semibold">{title}</DialogTitle>
        <DialogDescription>{kind === "delete" ? `Delete “${section?.name}”? Its sessions return to the main list. No sessions are deleted or archived.` : kind === "move" ? "Choose a section for the selected session." : "Organize local sessions across your projects."}</DialogDescription>
      </DialogHeader>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        {(kind === "create" || kind === "rename") && <label className="block text-sm">Section name<input autoFocus onFocus={(event) => event.target.select()} value={name} maxLength={60} disabled={busy} onChange={(event) => setName(event.target.value)} className={inputClass} /></label>}
        {(kind === "create" || kind === "emoji") && <label className="mt-3 block text-sm">Emoji (optional)<input autoFocus={kind === "emoji"} value={emoji} maxLength={32} disabled={busy} onChange={(event) => setEmoji(event.target.value)} className={inputClass} /><span className="text-xs text-faint">Leave empty to remove the emoji.</span></label>}
        {kind === "move" && <label className="block text-sm">Section<select autoFocus value={target} disabled={busy} onChange={(event) => setTarget(event.target.value)} className={inputClass}><option value="">Main list</option>{sections.map((entry) => <option key={entry.id} value={entry.id}>{entry.emoji} {entry.name}</option>)}</select></label>}
        {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
        <DialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={close}>Cancel</Button><Button type="submit" variant={kind === "delete" ? "destructive" : "default"} disabled={busy || ((kind === "create" || kind === "rename") && !name.trim())}>{kind === "create" ? "Create" : kind === "delete" ? "Delete section" : kind === "move" ? "Move" : "Save"}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
