import { useId, useState } from "react";
import { Ellipsis, FolderInput, Link, RotateCcw } from "@/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import { showError } from "@/lib/errorToasts";
import { preferenceDefault } from "@/lib/prefs";
import { resetUserSetting, useSettingsFile } from "@/lib/settingsFile";
import { setUserKeys } from "@/lib/settingSources";
import { buildSettingLink } from "@/lib/settingsLinks";
import { showSettingLinkCopied, showSettingLinkCopyFailed } from "@/lib/settingsToasts";
import type { SettingId } from "./settingsRegistry";

/** A user-file value as the menu names it: On/Off, a word, a number. Nothing for values without a short form. */
export function settingValueLabel(value: unknown): string | undefined {
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value && value.length <= 24) return value.charAt(0).toUpperCase() + value.slice(1);
  return undefined;
}

/** The built-in value of a user-file key, when it is known here (preferences.*). */
export function userKeyDefault(key: string): unknown {
  return key.startsWith("preferences.") ? preferenceDefault(key.slice("preferences.".length)) : undefined;
}

/**
 * A setting row's one “…” menu, beside its title (PRO-127, PRO-140, PRO-374;
 * design 09.04 and 09.23). Every row has Copy setting link, with the row's id
 * on the same line. A row kept in the user file (`userKeys`) also has Reset to
 * default with the default value, a disabled Save for this project… (these
 * settings are per person), and where it is saved. Shown while the row is
 * hovered or has focus, and while the menu is open.
 *
 * `title` is the registry row's title, named in the toast; `label` is what
 * the row shows when one row id is rendered once per organization or tab.
 */
export function SettingRowActions({ id, title, label = title, userKeys, reset: ownReset }: {
  id: SettingId; title: string; label?: string; userKeys?: readonly string[];
  /** A row whose value lives outside the user file brings its own Reset to default (a layered value). */
  reset?: { value?: string; disabled?: boolean; onReset: () => void };
}) {
  const menu = useRowMenu();
  const idLabel = useId();
  const defaultLabel = useId();
  const { file } = useSettingsFile();
  const [busy, setBusy] = useState(false);
  const copy = async () => {
    try {
      await copyText(buildSettingLink(id));
      showSettingLinkCopied(id, title);
    } catch {
      showSettingLinkCopyFailed(id, title);
    }
  };
  const userFile = userKeys?.length && file ? file : null;
  const set = userFile ? setUserKeys(userKeys!, userFile.setKeys ?? []) : [];
  const fallback = ownReset ? ownReset.value : userKeys?.length === 1 ? settingValueLabel(userKeyDefault(userKeys[0])) : undefined;
  const reset = () => {
    setBusy(true);
    void set.reduce((chain, key) => chain.then(() => resetUserSetting(key)), Promise.resolve())
      .catch((error: unknown) => showError(`Couldn’t reset ${title}`, error))
      .finally(() => setBusy(false));
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
        {(userFile || ownReset) && <DropdownMenuItem aria-label="Reset to default" aria-describedby={fallback ? defaultLabel : undefined}
          disabled={ownReset ? ownReset.disabled : !set.length || busy} onSelect={ownReset ? ownReset.onReset : reset}>
          <RotateCcw /> <span>Reset to default</span>
          {fallback && <span id={defaultLabel} className="ml-auto whitespace-nowrap pl-3 text-xs font-normal text-faint">{fallback}</span>}
        </DropdownMenuItem>}
        <DropdownMenuItem aria-label="Copy setting link" aria-describedby={idLabel} onSelect={() => void copy()}>
          <Link /> <span>Copy setting link</span>
          <span id={idLabel} className="ml-auto whitespace-nowrap pl-3 text-xs font-normal text-faint">{id}</span>
        </DropdownMenuItem>
        {userFile && <>
          <DropdownMenuItem disabled className="items-start">
            <FolderInput className="mt-0.5" />
            <span className="flex flex-col"><span>Save for this project…</span><span className="text-xs font-normal text-faint">This setting is per person only</span></span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <div className="px-2 py-1.5 text-xs text-muted-foreground">Saved in <span className="font-mono">{userFile.displayPath || userFile.path}</span></div>
        </>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
