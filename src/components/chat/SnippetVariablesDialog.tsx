import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { usePromptTextProps } from "@/lib/autocorrect";
import { fillSnippet, snippetVariables } from "@/lib/snippetVariables";

/** Ask for a snippet's `{{placeholders}}` before it goes in the composer. */
export function SnippetVariablesDialog({ text, onInsert, onClose }: { text: string; onInsert: (filled: string) => void; onClose: () => void }) {
  const names = snippetVariables(text);
  const [values, setValues] = useState<Record<string, string>>({});
  const textProps = usePromptTextProps();
  const insert = () => onInsert(fillSnippet(text, values));
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Fill in the snippet</DialogTitle>
        <DialogDescription>Anything left empty stays as its placeholder.</DialogDescription>
      </DialogHeader>
      <form className="my-4 space-y-3 text-sm" onSubmit={(event) => { event.preventDefault(); insert(); }}>
        {names.map((name, index) => (
          <label key={name} className="block space-y-1">
            <span className="font-mono text-xs text-muted-foreground">{name}</span>
            <input
              {...textProps}
              autoFocus={index === 0}
              className="w-full rounded-md border border-hairline bg-background px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              value={values[name] ?? ""}
              onChange={(event) => setValues((was) => ({ ...was, [name]: event.target.value }))}
            />
          </label>
        ))}
        <button type="submit" hidden />
      </form>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={insert}>Insert</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
