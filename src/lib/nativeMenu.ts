import { bindingProblem, bindingText, isMac, isTerminalReserved, normalizeBinding, SHORTCUT_ACTIONS, type Keymap, type NativeMenuSection } from "./shortcuts";
import type { Project } from "@/types/session";

export interface NativeMenuItem {
  id: string;
  text: string;
  accelerator: string | null;
  separator: boolean;
  children?: NativeMenuItem[];
}

export interface NativeMenuGroup {
  id: NativeMenuSection;
  items: NativeMenuItem[];
}

const SECTIONS: NativeMenuSection[] = ["app", "file", "view", "go", "help"];
const KEYS: Record<string, string> = {
  mod: "CmdOrCtrl", ctrl: "Control", meta: "Super", alt: "Alt", shift: "Shift",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  "=": "Equal", "-": "Minus", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash",
  ";": "Semicolon", "'": "Quote", ",": "Comma", ".": "Period", "/": "Slash", "`": "Backquote",
  enter: "Enter", escape: "Escape", space: "Space", tab: "Tab", backspace: "Backspace",
  delete: "Delete", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
};

/** Unknown or held keys remain visible as text; they must never prevent the menu from loading. */
export function nativeAccelerator(binding: string): string | null {
  const parts = normalizeBinding(binding).split("+").map((part) => KEYS[part] ?? (/^[a-z0-9]$/.test(part) || /^f([1-9]|1\d|2[0-4])$/.test(part) ? part.toUpperCase() : null));
  return parts.every(Boolean) ? parts.join("+") : null;
}

/** No second command list: menu placement, labels, and bindings all come from the action registry. */
export function buildNativeMenu(keymap: Keymap, projects: readonly Project[], suspended = false, mac = isMac): NativeMenuGroup[] {
  return SECTIONS.map((section) => ({
    id: section,
    items: SHORTCUT_ACTIONS.filter((action) => action.menu?.section === section)
      .sort((a, b) => a.menu!.order - b.menu!.order)
      .map((action): NativeMenuItem => {
        const menu = action.menu!;
        const bindings = keymap[action.id];
        const first = bindings[0];
        const accelerator = !suspended && first && first !== "escape" && !isTerminalReserved(first, mac) && !bindingProblem(action.id, first, mac) ? nativeAccelerator(first) : null;
        // Native menus have one key-equivalent column. Keep any alternative bindings visible too.
        const extra = bindings.slice(accelerator ? 1 : 0).map((binding) => bindingText(binding, mac));
        const item: NativeMenuItem = {
          id: `command:${menu.target ?? "main"}:${action.id}`,
          text: menu.label + (extra.length ? ` (${extra.join(", ")})` : ""),
          accelerator,
          separator: !!menu.separator,
        };
        if (action.id === "app.openRecent") {
          item.children = [
            ...projects.filter((project) => !project.archived)
              .slice().sort((a, b) => (b.lastOpened ?? "").localeCompare(a.lastOpened ?? "")).slice(0, 10)
              .map((project): NativeMenuItem => ({
                id: `recent:${project.path}`, text: `${project.name} — ${project.path}`, accelerator: null, separator: false,
              })),
            { ...item, text: "Show All…" + (extra.length ? ` (${extra.join(", ")})` : ""), separator: projects.some((project) => !project.archived) },
          ];
          item.accelerator = null;
          item.text = menu.label;
        }
        return item;
      }),
  }));
}
