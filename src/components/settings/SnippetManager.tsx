import { useState } from "react";
import { Pencil, Trash2 } from "@/icons";
import { SaveSnippetDialog } from "@/components/chat/SaveSnippetDialog";
import { Button } from "@/components/ui/button";
import { setPrefs, usePrefs, type PromptSnippet } from "@/lib/prefs";
import { RegisteredSetting } from "./settingsRegistry";

/** The saved prompts offered under `/` in the composer. */
export function SnippetManager() {
  const prefs = usePrefs();
  const [editing, setEditing] = useState<PromptSnippet | "new" | null>(null);
  const remove = (id: string) => setPrefs({ promptSnippets: prefs.promptSnippets.filter((snippet) => snippet.id !== id) });
  return <RegisteredSetting setting="general.snippets">
    <section className="flex min-w-0 flex-col gap-2 py-3 outline-none">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[13px] font-medium">Prompt snippets</h3>
          <p className="text-xs leading-relaxed text-muted-foreground">Type / and a name in the composer to insert one. Use {"{{name}}"} for a value to fill in each time.</p>
        </div>
        <Button variant="secondary" size="sm" className="shrink-0" onClick={() => setEditing("new")}>New snippet</Button>
      </div>
      {prefs.promptSnippets.length > 0 && (
        <ul className="flex flex-col">
          {prefs.promptSnippets.map((snippet) => (
            <li key={snippet.id} className="flex min-w-0 items-center gap-2 py-1">
              <span className="shrink-0 font-mono text-xs">/{snippet.name}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{snippet.text.split("\n")[0]}</span>
              <Button variant="ghost" size="icon-xs" aria-label={`Edit /${snippet.name}`} onClick={() => setEditing(snippet)}><Pencil aria-hidden /></Button>
              <Button variant="ghost" size="icon-xs" aria-label={`Delete /${snippet.name}`} onClick={() => remove(snippet.id)}><Trash2 aria-hidden /></Button>
            </li>
          ))}
        </ul>
      )}
      {editing && <SaveSnippetDialog prompt={editing === "new" ? "" : editing.text} editing={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </section>
  </RegisteredSetting>;
}
