import { cn } from "@/lib/cn";
import { bindingText, holdCode } from "@/lib/shortcuts";

/** One keycap for a whole chord, ⇧⌘] (design 09.13, PRO-377). */
export const KEYCAP = "inline-flex h-5 items-center rounded-[5px] bg-veil-raised px-1.5 font-mono text-xs leading-none text-muted-foreground hairline";

/** The keys of one binding as a single keycap; a held key reads "Hold" before it. */
export function ChordCap({ binding, className }: { binding: string; className?: string }) {
  return (
    <span className="flex items-center gap-1">
      {holdCode(binding) != null && <span className="text-xs text-faint">Hold</span>}
      <kbd className={cn(KEYCAP, className)}>{bindingText(binding)}</kbd>
    </span>
  );
}

/** Settings → Shortcuts: a group's title above its bordered card of rows. */
export const SHORTCUT_GROUP_TITLE = "mb-2 text-[13px] font-medium text-foreground";
export const SHORTCUT_CARD = "flex flex-col overflow-hidden rounded-lg border border-hairline [&>*+*]:border-t [&>*+*]:border-hairline";
