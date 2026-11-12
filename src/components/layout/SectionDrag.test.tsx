import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SessionEntry } from "@/types/session";
import type { LocalSection, LocalSectionState } from "@/lib/localSections";

// PRO-174: sessions dragged between local sections and the main list, and section headers reordered,
// through the real dnd-kit sensors in the list-layout sidebar.
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, cb) => { mocks.listeners.set(name, cb); return () => {}; }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("./AppShell", () => ({ TITLEBAR_INSET: 78 }));
vi.mock("@/components/account/AccountSidebarEntry", () => ({ AccountSidebarEntry: () => null }));
vi.mock("@/lib/automations", () => ({ useAutomationStore: () => ({ automations: [] }) }));

const { ProjectRail } = await import("./ProjectRail");
const local = await import("@/lib/localSections");
const store = await import("@/lib/sessions");
const prefs = await import("@/lib/prefs");
const filter = await import("@/lib/sidebarFilter");
const sidebarOrder = await import("@/lib/sidebarOrder");
const toasts = await import("@/lib/errorToasts");

const session = (id: string): SessionEntry => ({ id, projectPath: "/web", cwd: "/web", title: `Session ${id}`, created: "2026-11-01T00:00:00Z", modified: "2026-11-01T00:00:00Z", archived: false, pinned: false, worktreeRemoved: false, activeTab: `${id}-tab`, tabs: [{ id: `${id}-tab`, harness: "claude", model: "", permissionMode: "manual", status: "idle", created: "", modified: "" }] });
const section = (id: string, sessions: string[] = []): LocalSection => ({ id, name: id, sessions });
let saved: LocalSectionState;
let failMove = false;

// Release 0-150 (row one at 30), Bugs 200-350, main-list rows from 400; the main zone is the whole scope.
const rowTop: Record<string, number> = { one: 30, two: 400, three: 440 };
function rect(this: HTMLElement): DOMRect {
  const box = (top: number, height: number) => ({ x: 0, y: top, top, bottom: top + height, left: 0, right: 200, width: 200, height, toJSON() {} }) as DOMRect;
  const sectionId = this.getAttribute("data-local-section");
  if (sectionId) return box(saved.sections.findIndex((entry) => entry.id === sectionId) * 200, 150);
  if (this.hasAttribute("data-main-drop-zone")) return box(0, 1000);
  const row = this.tagName === "LI" ? this.querySelector("[data-row-sessions]")?.getAttribute("data-row-sessions") : null;
  if (row && row in rowTop) return box(rowTop[row]!, 32);
  // dnd-kit's DragOverlay (it measures its only child): fixed at the picked-up node's rect, moved by its transform.
  const overlay = [this, this.parentElement].find((node) => node?.style.position === "fixed" && node.style.zIndex === "999");
  if (overlay) return box((parseFloat(overlay.style.top) || 0) + Number(/translate3d\([^,]+,\s*(-?[\d.]+)px/.exec(overlay.style.transform)?.[1] ?? 0), parseFloat(overlay.style.height) || 0);
  return box(0, 0);
}

beforeEach(async () => {
  failMove = false;
  saved = { revision: local.getLocalSections().revision + 1, sections: [section("Release", ["one"]), section("Bugs")] };
  mocks.invoke.mockReset().mockImplementation(async (command: string, args) => {
    if (command === "sidebar_order") return { custom: false, sessions: [], projects: [], revision: sidebarOrder.getSidebarOrder().revision + 1 };
    if (command === "local_sections") return saved;
    if (command === "edit_local_section") {
      const { edit } = args;
      if (edit.kind === "move" && failMove) throw new Error("The sidebar changed on another device");
      const sections = saved.sections.map((entry) => ({ ...entry, sessions: [...entry.sessions] }));
      if (edit.kind === "move") for (const entry of sections) { entry.sessions = entry.sessions.filter((id) => !edit.sessionIds.includes(id)); if (entry.id === edit.sectionId) entry.sessions.push(...edit.sessionIds); }
      if (edit.kind === "reorder") { const at = sections.findIndex((entry) => entry.id === edit.id); [sections[at], sections[at + edit.by]] = [sections[at + edit.by]!, sections[at]!]; }
      saved = { revision: saved.revision + 1, sections };
      return saved;
    }
    if (command === "list_projects") return { projects: [{ path: "/web", name: "Web", kind: "git" }], lastSelected: null };
    if (command === "list_sessions") return [session("one"), session("two"), session("three")];
    if (["list_harnesses", "list_workspaces", "session_summaries"].includes(command)) return [];
    if (command === "chats_dir") return "/Chats";
    return null;
  });
  prefs.setPrefs({ sidebarLayout: "list", sidebarSections: {}, sidebarProject: null, sidebarSort: "updated", animations: false });
  filter.setSidebarFilter("all");
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(rect);
  for (const toast of toasts.getErrorToasts()) toasts.dismissError(toast.id);
  await act(async () => { await store.bootSessions(); await store.refreshEverything(); await local.bootLocalSections(); await local.refreshLocalSections(); await sidebarOrder.bootSidebarOrder(); store.openHome(); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const mount = () => render(<TooltipProvider><ProjectRail onHide={() => {}} onOpenSettings={() => {}} onOpenAccount={() => {}} onOpenHome={() => {}} onOpenIssues={() => {}} onOpenAgents={() => {}} onOpenStats={() => {}} onOpenAutomations={() => {}} onOpenSkills={() => {}} onSearch={() => {}} /></TooltipProvider>);
const region = (name: string) => screen.getByRole("region", { name: `${name} section` });
const rowItem = (id: string) => document.querySelector(`[data-row-sessions="${id}"]`)!.closest("li")!;
const moves = () => mocks.invoke.mock.calls.filter(([command, args]) => command === "edit_local_section" && args.edit.kind === "move").map(([, args]) => args.edit);
const pointer = { isPrimary: true, button: 0, pointerId: 1 };
async function drag(from: Element, y: number) {
  const top = from.getBoundingClientRect().top + 10;
  await act(async () => { fireEvent.pointerDown(from, { ...pointer, clientX: 50, clientY: top }); });
  await act(async () => { fireEvent.pointerMove(document, { ...pointer, clientX: 50, clientY: top + 10 }); });
  await act(async () => { fireEvent.pointerMove(document, { ...pointer, clientX: 50, clientY: y }); });
  await act(async () => { fireEvent.pointerUp(document, { ...pointer, clientX: 50, clientY: y }); });
}
const key = (target: Element | Document, code: string) => act(async () => { fireEvent.keyDown(target, { code, key: code === "Space" ? " " : code }); });
const announced = () => [...document.querySelectorAll('[role="status"]')].map((node) => node.textContent).join(" ");

describe("dragging sessions between local sections", () => {
  it("shows an empty section as a drop target and gives headers a grip", () => {
    mount();
    expect(within(region("Bugs")).getByText("Drag sessions here")).toBeTruthy();
    expect(screen.queryByText(/Move sessions here/)).toBeNull();
    expect(within(region("Release")).getByRole("button", { name: "Reorder section Release" })).toBeTruthy();
  });

  it("moves a main-list session into a section and a sectioned one back to the main list", async () => {
    mount();
    await drag(rowItem("two"), 275);
    await waitFor(() => expect(moves()).toEqual([{ kind: "move", sessionIds: ["two"], sectionId: "Bugs" }]));
    await waitFor(() => expect(within(region("Bugs")).getByText("Session two")).toBeTruthy());
    await drag(rowItem("one"), 700);
    await waitFor(() => expect(moves()).toContainEqual({ kind: "move", sessionIds: ["one"], sectionId: null }));
    await waitFor(() => expect(within(region("Release")).getByText("Drag sessions here")).toBeTruthy());
  });

  it("moves between sections and leaves a drop within the same section alone", async () => {
    mount();
    await drag(rowItem("one"), 100);
    expect(moves()).toEqual([]);
    await drag(rowItem("one"), 230);
    await waitFor(() => expect(moves()).toEqual([{ kind: "move", sessionIds: ["one"], sectionId: "Bugs" }]));
  });

  it("raises the error toast when a move fails", async () => {
    failMove = true;
    mount();
    await drag(rowItem("two"), 275);
    await waitFor(() => expect(toasts.getErrorToasts().map((toast) => toast.action)).toContain("Couldn't move “Session two” to Bugs"));
    expect(toasts.getErrorToasts()[0]!.cause).toContain("another device");
    expect(within(region("Bugs")).getByText("Drag sessions here")).toBeTruthy();
  });

  it("reorders sections from the header grip with the keyboard", async () => {
    mount();
    const grip = within(region("Bugs")).getByRole("button", { name: "Reorder section Bugs" });
    grip.focus();
    await key(grip, "Space");
    await waitFor(() => expect(announced()).toContain("Picked up section Bugs. Position 2 of 2."));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await key(document, "ArrowUp");
    await waitFor(() => expect(announced()).toContain("Moved section Bugs. Position 1 of 2."));
    await key(document, "Space");
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("edit_local_section", { edit: { kind: "reorder", id: "Bugs", by: -1 } }));
    await waitFor(() => expect(document.querySelector("[data-local-section]")?.getAttribute("data-local-section")).toBe("Bugs"));
  });
});
