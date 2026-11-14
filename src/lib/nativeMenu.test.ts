import { describe, expect, it } from "vitest";
import { buildNativeMenu, nativeAccelerator, type NativeMenuItem } from "./nativeMenu";
import { bindingText, resolveKeymap, SHORTCUT_ACTIONS } from "./shortcuts";

function leaves(items: NativeMenuItem[]): NativeMenuItem[] {
  return items.flatMap((item) => item.children ? leaves(item.children) : [item]);
}

describe("native menus and the action registry", () => {
  it("routes New Window to main even when no window has focus", () => {
    const items = leaves(buildNativeMenu(resolveKeymap({}, true), []).flatMap((group) => group.items));
    expect(items.find((item) => item.id.endsWith(":app.newWindow"))).toMatchObject({
      id: "command:main:app.newWindow",
      accelerator: null,
    });
    expect(items.find((item) => item.id.endsWith(":app.startFrom"))).toMatchObject({
      id: "command:main:app.startFrom",
      accelerator: "CmdOrCtrl+Shift+N",
    });
  });

  it("contains the requested menu tree, with each registered menu action exactly once", () => {
    const groups = buildNativeMenu(resolveKeymap({}, true), []);
    expect(groups.map((group) => [group.id, group.items.map((item) => item.id.split(":").at(-1))])).toEqual([
      ["app", ["app.about", "app.settings", "app.checkUpdates"]],
      ["file", ["app.newSession", "app.newWindow", "app.startFrom", "app.addProject", "app.openRecent", "session.closeTab", "app.closeWindow"]],
      ["view", ["app.toggleSidebar", "app.togglePanel", "session.latestShell", "session.toggleTerminalView", "app.zoomIn", "app.zoomOut", "app.zoomReset", "app.fullscreen"]],
      ["go", ["app.agentDashboard", "app.issues", "app.automations", "app.runView", "app.nextSession", "app.previousSession", "app.nextAttention"]],
      ["help", ["app.docs", "app.shortcuts", "app.reportIssue"]],
    ]);
    const ids = leaves(groups.flatMap((group) => group.items)).map((item) => item.id.split(":").at(-1));
    expect(ids.slice().sort()).toEqual(SHORTCUT_ACTIONS.filter((action) => action.menu).map((action) => action.id).sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each([true, false])("shows every effective binding, including alternatives, on mac=%s", (mac) => {
    const keymap = resolveKeymap({}, mac);
    const items = leaves(buildNativeMenu(keymap, [], false, mac).flatMap((group) => group.items));
    for (const action of SHORTCUT_ACTIONS.filter((action) => action.menu)) {
      const item = items.find((item) => item.id.endsWith(`:${action.id}`))!;
      const bindings = keymap[action.id];
      expect(item.accelerator).toBe(bindings[0] ? nativeAccelerator(bindings[0]) : null);
      for (const alternative of bindings.slice(1)) expect(item.text).toContain(bindingText(alternative, mac));
    }
  });

  it("puts Run View in the Go menu on keys no other menu item has", () => {
    for (const mac of [true, false]) {
      const items = leaves(buildNativeMenu(resolveKeymap({}, mac), [], false, mac).flatMap((group) => group.items));
      expect(items.find((item) => item.id.endsWith(":app.runView"))).toMatchObject({ id: "command:main:app.runView", text: "Run View", accelerator: "CmdOrCtrl+Shift+O" });
      expect(items.find((item) => item.id.endsWith(":app.automations"))?.accelerator).toBe("CmdOrCtrl+Shift+R");
      const accelerators = items.map((item) => item.accelerator).filter(Boolean);
      expect(new Set(accelerators).size).toBe(accelerators.length);
      // The system's own menu keys (Quit, Hide, Minimize, the Edit menu) are not it either.
      expect(["CmdOrCtrl+Q", "CmdOrCtrl+H", "CmdOrCtrl+Alt+H", "CmdOrCtrl+M", "CmdOrCtrl+Z", "CmdOrCtrl+Shift+Z", "CmdOrCtrl+X", "CmdOrCtrl+C", "CmdOrCtrl+V", "CmdOrCtrl+A"]).not.toContain("CmdOrCtrl+Shift+O");
    }
  });

  it("follows rebinding, removing keys, and transferring an existing binding", () => {
    const keymap = resolveKeymap({ "app.settings": ["mod+b"], "session.closeTab": [] }, true);
    const items = leaves(buildNativeMenu(keymap, [], false, true).flatMap((group) => group.items));
    const accelerator = (id: string) => items.find((item) => item.id.endsWith(`:${id}`))!.accelerator;
    expect(accelerator("app.settings")).toBe("CmdOrCtrl+B");
    expect(accelerator("app.toggleSidebar")).toBeNull();
    expect(accelerator("session.closeTab")).toBeNull();
    expect(accelerator("app.closeWindow")).toBe("CmdOrCtrl+Shift+W");
  });

  it("lists up to ten recent projects in recency order, excluding archives, with an always-available Show All action", () => {
    const projects = Array.from({ length: 12 }, (_, n) => ({ path: `/repo/${n}`, name: `Project ${n}`, lastOpened: `2026-11-${String(n + 1).padStart(2, "0")}`, archived: n === 11 }));
    const recent = buildNativeMenu(resolveKeymap({}), projects)[1].items.find((item) => item.id.endsWith(":app.openRecent"))!;
    expect(recent.children?.map((item) => item.id)).toEqual([
      ...Array.from({ length: 10 }, (_, n) => `recent:/repo/${10 - n}`), "command:main:app.openRecent",
    ]);
    expect(buildNativeMenu(resolveKeymap({}), [])[1].items.find((item) => item.id.endsWith(":app.openRecent"))!.children).toEqual([
      expect.objectContaining({ id: "command:main:app.openRecent", text: "Show All…", separator: false }),
    ]);
  });

  it("removes native accelerators during recording without hiding their bindings", () => {
    const items = leaves(buildNativeMenu(resolveKeymap({}, true), [], true, true).flatMap((group) => group.items));
    expect(items.every((item) => item.accelerator === null)).toBe(true);
    expect(items.find((item) => item.id.endsWith(":app.settings"))?.text).toBe("Settings… (⌘,)");
  });

  it("leaves terminal keys and unsupported stored bindings to the frontend dispatcher", () => {
    const keymap = resolveKeymap({ "app.settings": ["ctrl+c"], "app.toggleSidebar": ["escape"], "app.togglePanel": ["mod+ø"] }, true);
    const items = leaves(buildNativeMenu(keymap, [], false, true).flatMap((group) => group.items));
    for (const id of ["app.settings", "app.toggleSidebar", "app.togglePanel"]) {
      expect(items.find((item) => item.id.endsWith(`:${id}`))?.accelerator).toBeNull();
    }
  });

  it.each([
    ["mod+,", "CmdOrCtrl+Comma"], ["mod+shift+[", "CmdOrCtrl+Shift+BracketLeft"],
    ["mod+ctrl+f", "CmdOrCtrl+Control+F"], ["mod+=", "CmdOrCtrl+Equal"],
    ["alt+f12", "Alt+F12"], ["mod+plus", null], ["hold:AltRight", null], ["mod+ø", null],
  ])("translates %s to the native accelerator %s", (binding, expected) => {
    expect(nativeAccelerator(binding)).toBe(expected);
  });
});
