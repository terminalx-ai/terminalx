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
 * A setting row's “…” actions, beside its title (PRO-127, design 09.04 and
 * 09.23): Copy setting link, with the row's id on the same line. Shown while
 * the row is hovered or has focus, and while its menu is open.
 *
 * `title` is the registry row's title, named in the toast; `label` is what
 * the row shows when one row id is rendered once per organization or tab.
 */
export function SettingRowActions({ id, title, label = title }: { id: SettingId; title: string; label?: string }) {
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
        <button type="button" aria-label={`Actions for ${label}`}
          className={cn("grid size-5 shrink-0 place-items-center rounded text-faint outline-none transition-opacity hover:bg-veil-strong hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-veil-strong data-[state=open]:text-foreground",
            "opacity-0 focus-visible:opacity-100 group-hover/setting:opacity-100 group-focus-within/setting:opacity-100 data-[state=open]:opacity-100")}>
          <Ellipsis className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[270px]">
        <DropdownMenuItem aria-label="Copy setting link" aria-describedby={idLabel} onSelect={() => void copy()}>
          <Link /> <span>Copy setting link</span>
          <span id={idLabel} className="ml-auto whitespace-nowrap pl-3 text-xs font-normal text-faint">{id}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
