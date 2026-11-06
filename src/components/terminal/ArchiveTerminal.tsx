import { TerminalView } from "./TerminalView";

/** A lifecycle terminal has no session: its log survives a failed removal. */
export function ArchiveTerminal({ pane }: { pane: string }) {
  return <section aria-label="Archive script terminal" className="mt-3 overflow-hidden rounded-md border border-hairline">
    <div role="tablist" aria-label="Script terminals" className="border-b border-hairline px-3 py-1 text-xs">
      <button type="button" role="tab" aria-selected="true">Archive</button>
    </div>
    <div role="tabpanel" aria-label="Archive" className="h-48"><TerminalView id={pane} visible redraw={false} /></div>
  </section>;
}
