import { invoke } from "@tauri-apps/api/core";
import { useMemo } from "react";
import { Menu } from "@/icons";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger, MenuShortcut } from "@/components/ui/menu";
import { inAppWindow, isCompactWindow } from "@/lib/appWindow";
import { keycaps } from "@/lib/hotkeys";
import { buildNativeMenu, type NativeMenuItem } from "@/lib/nativeMenu";
import { dispatchNativeMenu } from "@/lib/nativeMenuBridge";
import { isMac } from "@/lib/platform";
import { useSessionStore } from "@/lib/sessions";
import { useKeymap, type Keymap, type NativeMenuSection } from "@/lib/shortcuts";
import { setStatusSettings, useStatusSelector } from "@/lib/status";

const TITLES: Record<NativeMenuSection, string> = { app: "TerminalX", file: "File", view: "View", go: "Go", help: "Help" };

/**
 * The app's menu on Windows and Linux, where the window has no menu bar: the macOS menu bar's groups and items from
 * the same action registry (`buildNativeMenu`), under one button in the sidebar's top strip. An item runs its action as
 * its shortcut does; TerminalX ends with Stop all and quit, and Quit.
 */
export function AppMenu({ mac = isMac }: { mac?: boolean }) {
  const keymap = useKeymap();
  const { projects } = useSessionStore();
  const statusBarVisible = useStatusSelector((s) => s.settings.visible);
  const groups = useMemo(() => buildNativeMenu(keymap, projects, false, false), [keymap, projects]);
  if (mac || !inAppWindow() || isCompactWindow()) return null;
  return (
    <DropdownMenu>
      <WithTooltip label="Menu">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Menu" className="text-faint hover:text-foreground">
            <Menu />
          </Button>
        </DropdownMenuTrigger>
      </WithTooltip>
      <DropdownMenuContent align="start" className="min-w-48">
        {groups.filter((group) => group.items.length > 0 || group.id === "app").map((group) => (
          <DropdownMenuSub key={group.id}>
            <DropdownMenuSubTrigger>{TITLES[group.id]}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-56">
              <Items items={group.items} keymap={keymap} />
              {group.id === "view" && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuCheckboxItem
                    checked={statusBarVisible}
                    onCheckedChange={(checked) => { void setStatusSettings({ visible: checked === true }); }}
                  >
                    Status Bar
                  </DropdownMenuCheckboxItem>
                </>
              )}
              {group.id === "app" && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => quit("app-stop-all-and-quit")}>Stop all and quit</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => quit("app-quit")}>Quit</DropdownMenuItem>
                </>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Items({ items, keymap }: { items: NativeMenuItem[]; keymap: Keymap }) {
  return items.map((item) => (
    <MenuEntry key={item.id + item.text} item={item} keymap={keymap} />
  ));
}

function MenuEntry({ item, keymap }: { item: NativeMenuItem; keymap: Keymap }) {
  const separator = item.separator ? <DropdownMenuSeparator /> : null;
  if (item.children) {
    return (
      <>
        {separator}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{item.text}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-w-[28rem]">
            <Items items={item.children} keymap={keymap} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </>
    );
  }
  const action = menuAction(item.id);
  // The keys the menu bar shows as its key equivalent; any others are already in the item's text.
  const first = item.accelerator && action && action in keymap ? keymap[action as keyof Keymap][0] : undefined;
  return (
    <>
      {separator}
      <DropdownMenuItem onSelect={() => { if (action) dispatchNativeMenu(action); }}>
        <span className="min-w-0 truncate">{item.text}</span>
        {first && <MenuShortcut keys={keycaps(first)} />}
      </DropdownMenuItem>
    </>
  );
}

/** What an item of the menu bar sends: the action of `command:<owner>:<action>`, or a `recent:` project as it is. */
export function menuAction(id: string): string | null {
  const command = /^command:(?:main|focused):(.+)$/.exec(id);
  if (command) return command[1];
  return id.startsWith("recent:") ? id : null;
}

function quit(id: "app-quit" | "app-stop-all-and-quit") {
  void invoke("app_menu_item", { id }).catch((error) => console.error("Quit failed", error));
}
