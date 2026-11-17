import { Columns2, Copy, EllipsisVertical, EyeOff, Rows2, Trash2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { setFileWrap, useDiffOptions, type DiffMode } from "@/lib/diffOptions";
import { setPrefs } from "@/lib/prefs";

/** Unified and split as two icon toggles (rows / columns) in the diff header. */
export function DiffModeToggle() {
  const { mode } = useDiffOptions();
  return <Segmented<DiffMode> aria-label="Diff layout" value={mode} onChange={(next) => setPrefs({ diffMode: next })} className="h-7"
    options={[
      { value: "unified", "aria-label": "Unified", title: "Unified", label: <Rows2 aria-hidden className="size-3.5" /> },
      { value: "split", "aria-label": "Split", title: "Split", label: <Columns2 aria-hidden className="size-3.5" /> },
    ]} />;
}

const item = "h-8 gap-2.5 px-2.5 text-[12.5px] [&_svg]:size-3.5";

/**
 * The diff's ⋮ View options (design 05.05): hide whitespace changes and wrap
 * lines, both app-wide so the next diff opens the same way, then what can be
 * done with the file. Wrap shows what this file does; changing it sets the
 * default and drops any override this file had.
 */
export function DiffViewOptionsMenu({ fileKey, onCopy, onDiscard, discardLabel }: {
  fileKey?: string;
  /** Absent while there is nothing to copy (loading, media, too large). */
  onCopy?: () => void;
  onDiscard?: () => void;
  discardLabel?: string;
}) {
  const { hideWhitespace, wrap } = useDiffOptions(fileKey);
  return <DropdownMenu modal={false}>
    <DropdownMenuTrigger asChild>
      <Button variant="ghost" size="icon-xs" aria-label="View options" title="View options" className="data-[state=open]:bg-veil-strong data-[state=open]:text-foreground">
        <EllipsisVertical />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-[262px]" data-testid="diff-view-options">
      <DropdownMenuLabel className="px-2.5 pt-2 pb-1">View options</DropdownMenuLabel>
      <DropdownMenuCheckboxItem indicator="box" className={item} checked={hideWhitespace} onSelect={(e) => e.preventDefault()}
        onCheckedChange={(on) => setPrefs({ diffHideWhitespace: on })}>Hide whitespace changes</DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem indicator="box" className={item} checked={wrap} onSelect={(e) => e.preventDefault()}
        onCheckedChange={(on) => { setPrefs({ diffWrap: on }); if (fileKey) setFileWrap(fileKey, undefined); }}>Wrap lines</DropdownMenuCheckboxItem>
      {(onCopy || onDiscard) && <DropdownMenuSeparator />}
      {onCopy && <DropdownMenuItem className={item} onSelect={onCopy}><Copy /> Copy file contents</DropdownMenuItem>}
      {onDiscard && <DropdownMenuItem className={item} destructive onSelect={onDiscard} aria-label={discardLabel}><Trash2 /> Discard changes…</DropdownMenuItem>}
    </DropdownMenuContent>
  </DropdownMenu>;
}

/** The review tab's one toolbar (PRO-392): Unified | Split and Hide whitespace, the same global defaults. */
export function DiffViewToggles() {
  const { mode, hideWhitespace } = useDiffOptions();
  return <div aria-label="Diff options" role="group" className="flex shrink-0 items-center gap-1">
    <Button size="sm" variant={mode === "unified" ? "secondary" : "ghost"} aria-pressed={mode === "unified"} onClick={() => setPrefs({ diffMode: "unified" })}>Unified</Button>
    <Button size="sm" variant={mode === "split" ? "secondary" : "ghost"} aria-pressed={mode === "split"} onClick={() => setPrefs({ diffMode: "split" })}>Split</Button>
    <Button size="sm" variant={hideWhitespace ? "secondary" : "ghost"} aria-pressed={hideWhitespace} onClick={() => setPrefs({ diffHideWhitespace: !hideWhitespace })}><EyeOff />Hide whitespace</Button>
  </div>;
}
