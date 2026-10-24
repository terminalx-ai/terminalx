import { useContext, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from "react";
import { Dialog as DialogPrimitive, DropdownMenu as MenuPrimitive } from "radix-ui";
import { StreamdownContext, extractTableDataFromElement, tableDataToCSV, tableDataToMarkdown, tableDataToTSV } from "streamdown";
import { ArrowsExpand, Copy, Download, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/menu";

type Format = "Markdown" | "CSV" | "TSV";

function TableActions({ table, disabled, children }: { table: RefObject<HTMLTableElement | null>; disabled: boolean; children?: ReactNode }) {
  const [error, setError] = useState<string>();
  async function exportTable(format: Format, download: boolean) {
    if (!table.current) return;
    try {
      const data = extractTableDataFromElement(table.current);
      const text = format === "CSV" ? tableDataToCSV(data) : format === "TSV" ? tableDataToTSV(data) : tableDataToMarkdown(data);
      if (download) {
        const blob = new Blob([text], { type: format === "CSV" ? "text/csv" : "text/markdown" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `table.${format === "CSV" ? "csv" : "md"}`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else {
        await navigator.clipboard.write([new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([table.current.outerHTML], { type: "text/html" }),
        })]);
      }
      setError(undefined);
    } catch {
      setError("Could not export table. Please try again.");
    }
  }
  return <div className="flex shrink-0 items-center justify-end gap-1" data-chat-table-toolbar>
    {error && <span role="alert" className="mr-auto text-xs text-destructive">{error}</span>}
    {([false, true] as const).map((download) => <DropdownMenu key={String(download)} modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" disabled={disabled} title={download ? "Download table" : "Copy table"} aria-label={download ? "Download table" : "Copy table"}>
          {download ? <Download /> : <Copy />}
        </Button>
      </DropdownMenuTrigger>
      <MenuPrimitive.Portal>
        {/* A viewport-sized containing block lets Floating UI account for CSS
            zoom as well as escaping transcript clipping. Use an opaque surface:
            this transform also isolates backdrop filters from the transcript. */}
        <div className="pointer-events-none fixed inset-0 z-(--z-menu) transform-gpu">
          <MenuPrimitive.Content align="end" sideOffset={4} collisionPadding={8} className="pointer-events-auto min-w-40 overflow-hidden rounded-lg bg-background p-1 text-popover-foreground shadow-surface hairline">
            {(download ? ["CSV", "Markdown"] as const : ["Markdown", "CSV", "TSV"] as const).map((format) => <DropdownMenuItem key={format} onSelect={() => { void exportTable(format, download); }}>{format}</DropdownMenuItem>)}
          </MenuPrimitive.Content>
        </div>
      </MenuPrimitive.Portal>
    </DropdownMenu>)}
    {children}
  </div>;
}

/** Portal both menus and the viewer out of clipped/contained transcript rows.
 * Keep Streamdown's serializers so exported cell data stays identical. */
export function MarkdownTable({ children, node: _node, ...props }: ComponentProps<"table"> & { node?: unknown }) {
  const { isAnimating } = useContext(StreamdownContext);
  const inline = useRef<HTMLTableElement>(null);
  const expanded = useRef<HTMLTableElement>(null);
  return <DialogPrimitive.Root>
    <div className="my-4 flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-well p-2" data-streamdown="table-wrapper">
      <TableActions table={inline} disabled={isAnimating}>
        <DialogPrimitive.Trigger asChild>
          <Button variant="ghost" size="icon-xs" disabled={isAnimating} title="View fullscreen" aria-label="View fullscreen"><ArrowsExpand /></Button>
        </DialogPrimitive.Trigger>
      </TableActions>
      <div className="overflow-auto" data-chat-table-scroll>
        <table {...props} ref={inline} data-streamdown="table">{children}</table>
      </div>
    </div>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-(--z-dialog-overlay) bg-background" />
      <DialogPrimitive.Content aria-describedby={undefined} className="prose-chat fixed inset-0 z-(--z-dialog) flex min-h-0 min-w-0 flex-col gap-2 bg-background p-4 outline-none" data-streamdown="table-fullscreen">
        <DialogPrimitive.Title className="sr-only">Table fullscreen</DialogPrimitive.Title>
        <TableActions table={expanded} disabled={isAnimating}>
          <DialogPrimitive.Close asChild>
            <Button variant="ghost" size="icon-sm" title="Exit fullscreen" aria-label="Exit fullscreen"><X /></Button>
          </DialogPrimitive.Close>
        </TableActions>
        <div className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain" tabIndex={0} role="region" aria-label="Table content" data-chat-table-scroll>
          <table {...props} ref={expanded} data-streamdown="table">{children}</table>
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}
