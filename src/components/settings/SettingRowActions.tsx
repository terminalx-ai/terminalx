import { useId } from "react";
import { Ellipsis, Link } from "@/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import { buildSettingLink } from "@/lib/settingsLinks";
import { showSettingLinkCopied, showSettingLinkCopyFailed } from "@/lib/settingsToasts";
import type { SettingId } from "./settingsRegistry";

/**
 * A setting row's “…” actions (PRO-127, design 09.04 and 09.23): Copy setting
 * link, with the row's id beside it. Shown while the row is hovered or has
 * focus, and while its menu is open.
 */
export function SettingRowActions({ id, title }: { id: SettingId; title: string }) {
  const menu = useRowMenu();
  const idLabel = useId();
  const copy = async () => {
    try {
      await copyText(buildSettingLink(id));
      showSettingLinkCopied(id, title);
    } catch {
      showSettingLinkCopyFailed(id, title);
    }
  };
  return (
    <DropdownMenu {...menu.root}>
      <DropdownMenuTrigger asChild {...menu.trigger}>
        <button type="button" aria-label={`Actions for ${title}`}
          className={cn("mt-2 shrink-0 rounded-sm p-1 text-faint outline-none transition-opacity hover:bg-veil-strong hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring",
            "opacity-0 group-hover/setting:opacity-100 group-focus-within/setting:opacity-100 data-[state=open]:opacity-100")}>
          <Ellipsis className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuItem aria-label="Copy setting link" aria-describedby={idLabel} onSelect={() => void copy()}>
          <Link /> <span>Copy setting link</span>
          <span id={idLabel} className="ml-auto pl-3 font-mono text-xs text-muted-foreground">{id}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
