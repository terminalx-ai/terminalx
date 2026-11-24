import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/cn";

const MAX_SHOWN = 50;

/** Newest first; every typed word must appear, in any case and order. */
export function searchHistory(history: readonly string[], query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const found: string[] = [];
  const seen = new Set<string>();
  for (let index = history.length - 1; index >= 0 && found.length < MAX_SHOWN; index--) {
    const text = history[index].toLowerCase();
    if (seen.has(history[index]) || !words.every((word) => text.includes(word))) continue;
    seen.add(history[index]);
    found.push(history[index]);
  }
  return found;
}

/** Find an earlier message of this tab and put it back in the composer. */
export function ComposerHistorySearch({ history, onPick, onClose }: { history: readonly string[]; onPick: (text: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [row, setRow] = useState(0);
  const results = useMemo(() => searchHistory(history, query), [history, query]);
  const active = Math.min(row, Math.max(results.length - 1, 0));
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" && results.length) {
      event.preventDefault();
      setRow((active + 1) % results.length);
    } else if (event.key === "ArrowUp" && results.length) {
      event.preventDefault();
      setRow((active - 1 + results.length) % results.length);
    } else if (event.key === "Enter" && results[active]) {
      event.preventDefault();
      onPick(results[active]);
    }
  };
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent>
      <DialogTitle>Search this chat's messages</DialogTitle>
      <DialogDescription className="sr-only">Type to filter, use the arrows to choose, and Enter to put a message in the composer.</DialogDescription>
      <input
        autoFocus
        role="combobox"
        aria-expanded
        aria-controls="composer-history-results"
        aria-activedescendant={results[active] ? `composer-history-${active}` : undefined}
        aria-label="Search messages"
        placeholder="Search messages"
        spellCheck={false}
        className="mt-3 w-full rounded-md border border-hairline bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        value={query}
        onChange={(event) => { setQuery(event.target.value); setRow(0); }}
        onKeyDown={onKeyDown}
      />
      <ul id="composer-history-results" role="listbox" aria-label="Messages" className="mt-2 max-h-72 overflow-y-auto">
        {results.map((text, index) => (
          <li key={text} id={`composer-history-${index}`} role="option" aria-selected={index === active}>
            <button
              type="button"
              tabIndex={-1}
              className={cn("w-full truncate rounded-md px-2 py-1.5 text-left text-[13px]", index === active ? "bg-veil-strong text-foreground" : "text-muted-foreground hover:bg-veil-raised")}
              onMouseEnter={() => setRow(index)}
              onClick={() => onPick(text)}
            >
              {text.replace(/\s+/g, " ")}
            </button>
          </li>
        ))}
      </ul>
      {!results.length && <p role="status" className="px-2 py-3 text-xs text-muted-foreground">{history.length ? "No message matches." : "No messages in this chat yet."}</p>}
    </DialogContent>
  </Dialog>;
}
