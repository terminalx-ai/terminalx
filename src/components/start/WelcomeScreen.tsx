import { useState } from "react";
import { FolderOpen, Plus } from "@/icons";
import { Button } from "@/components/ui/button";
import { EmptyView } from "./EmptyView";
import { openLocalProject } from "@/lib/projectStart";
import { errorMessage } from "@/lib/api";
import { openNewSession, useSessionStore } from "@/lib/sessions";
import { keycaps, shortcutAction, useKeymap, type ShortcutId } from "@/lib/shortcuts";

const SHORTCUTS: ShortcutId[] = ["app.newSession", "app.commandPalette", "app.toggleSidebar", "app.quickChat"];

export function WelcomeScreen() {
  const store = useSessionStore();
  const keymap = useKeymap();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const addProject = async () => {
    setError(null);
    setBusy(true);
    try { await openLocalProject(); } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  return (
    <EmptyView branded guidance={store.sessions.length ? "Select a session from the sidebar to begin." : "Add a project to begin."}>
      <div className="mx-auto mt-8 flex max-w-sm flex-col justify-center gap-3 @sm:flex-row">
        <Button variant="secondary" disabled={busy} onClick={() => void addProject()}><FolderOpen aria-hidden /> Add Project</Button>
        <Button variant="accent" onClick={() => openNewSession()}><Plus aria-hidden /> New session</Button>
      </div>
      {error && <p role="alert" className="mt-3 text-center text-sm text-destructive">{error}</p>}
      <dl aria-label="Keyboard shortcuts" className="mx-auto mt-8 grid max-w-sm grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 text-xs text-muted-foreground">
        {SHORTCUTS.filter((id) => keymap[id].length).map((id) => (
          <ShortcutRow key={id} id={id} bindings={keymap[id]} />
        ))}
      </dl>
    </EmptyView>
  );
}

function ShortcutRow({ id, bindings }: { id: ShortcutId; bindings: string[] }) {
  return <>
    <dt>{shortcutAction(id).label}</dt>
    <dd className="flex flex-col items-end gap-1">
      {bindings.map((binding) => <span key={binding} className="flex gap-1">{keycaps(binding).map((cap, index) => (
        <kbd key={index} className="rounded border border-hairline bg-veil-card px-1.5 py-0.5 font-sans">{cap}</kbd>
      ))}</span>)}
    </dd>
  </>;
}
