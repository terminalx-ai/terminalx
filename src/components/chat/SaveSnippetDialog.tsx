import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { usePromptTextProps } from "@/lib/autocorrect";
import { getPrefs, setPrefs, type PromptSnippet } from "@/lib/prefs";

/** A snippet's name as it is typed after "/": lower case, words joined by dashes. */
export function snippetName(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/** A name from the prompt's first words, for the field to start with. */
function suggestedName(text: string): string {
  return snippetName(text.split(/\s+/).slice(0, 4).join(" ")) || "snippet";
}

/**
 * Keep a turn's prompt as a snippet (PRO-379): named, and offered as
 * `/name` in the composer, where choosing it puts the text in.
 */
export function SaveSnippetDialog({ prompt, editing, onClose }: { prompt: string; /** The saved snippet being changed, which may be renamed. */ editing?: PromptSnippet; onClose: () => void }) {
  const [name, setName] = useState(() => editing?.name ?? (prompt ? suggestedName(prompt) : ""));
  const [text, setText] = useState(prompt);
  const textProps = usePromptTextProps();
  const key = snippetName(name);
  const taken = getPrefs().promptSnippets.find((snippet) => snippet.name === key && snippet.id !== editing?.id);
  const save = () => {
    if (!key || !text.trim()) return;
    const others = getPrefs().promptSnippets.filter((snippet) => snippet.name !== key && snippet.id !== editing?.id);
    setPrefs({ promptSnippets: [...others, { id: editing?.id ?? taken?.id ?? crypto.randomUUID(), name: key, text: text.trim() }] });
    onClose();
  };
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Save the prompt as a snippet</DialogTitle>
        <DialogDescription>Type / and its name in the composer to put this text in again.</DialogDescription>
      </DialogHeader>
      <form className="my-4 space-y-3 text-sm" onSubmit={(event) => { event.preventDefault(); save(); }}>
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Name</span>
          <div className="flex items-center rounded-md border border-hairline bg-background px-3 focus-within:outline focus-within:outline-ring">
            <span className="font-mono text-muted-foreground">/</span>
            <input autoFocus className="w-full bg-transparent py-2 font-mono outline-none" value={name} maxLength={40} autoComplete="off" spellCheck={false}
              onChange={(event) => setName(event.target.value)} aria-describedby="snippet-name-hint" />
          </div>
          <span id="snippet-name-hint" className="block text-xs text-muted-foreground">{!key ? "Give it a name." : taken ? `Replaces the snippet /${key}.` : `Saved as /${key}.`}</span>
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Text</span>
          <textarea {...textProps} className="max-h-60 min-h-24 w-full resize-y rounded-md border border-hairline bg-background px-3 py-2" value={text} onChange={(event) => setText(event.target.value)} />
        </label>
        <button type="submit" hidden />
      </form>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={!key || !text.trim()} onClick={save}>{taken ? "Replace snippet" : "Save snippet"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
