import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SessionEntry } from "@/types/session";
import type { LocalSection, LocalSectionState } from "@/lib/localSections";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), copyText: vi.fn(), listeners: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, cb) => { mocks.listeners.set(name, cb); return () => {}; }) }));
vi.mock("@/lib/clipboard", () => ({ copyText: mocks.copyText }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("./AppShell", () => ({ TITLEBAR_INSET: 78 }));
vi.mock("@/components/account/AccountSidebarEntry", () => ({ AccountSidebarEntry: () => null }));
vi.mock("@/lib/automations", () => ({ useAutomationStore: () => ({ automations: [] }) }));

const { ProjectRail } = await import("./ProjectRail");
const { LocalSectionDialogs } = await import("@/components/session/LocalSectionDialogs");
const { CommandPalette } = await import("@/components/command/CommandPalette");
const local = await import("@/lib/localSections");
const store = await import("@/lib/sessions");
const prefs = await import("@/lib/prefs");
const filter = await import("@/lib/sidebarFilter");

const session = (id: string, projectPath: string, extra: Partial<SessionEntry> = {}): SessionEntry => ({ id, projectPath, cwd: projectPath, title: `Session ${id}`, created: "2026-11-01T00:00:00Z", modified: "2026-11-01T00:00:00Z", archived: false, pinned: false, worktreeRemoved: false, activeTab: `${id}-tab`, tabs: [{ id: `${id}-tab`, harness: "claude", model: "", permissionMode: "manual", status: "idle", created: "", modified: "" }], ...extra });
let saved: LocalSectionState;
let nextSections: LocalSection[];
let entries: SessionEntry[];
const section = (id: string, sessions: string[] = [], name = id): LocalSection => ({ id, name, sessions });

beforeEach(async () => {
  entries = [session("one", "/web"), session("two", "/api"), session("old", "/web", { archived: true })];
  saved = { revision: local.getLocalSections().revision + 1, sections: [] };
  nextSections = [];
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "local_sections") return saved;
    if (command === "edit_local_section") { saved = { revision: saved.revision + 1, sections: nextSections }; return saved; }
    if (command === "list_projects") return { projects: [{ path: "/web", name: "Web", kind: "git" }, { path: "/api", name: "API", kind: "git" }], lastSelected: null };
    if (command === "list_sessions") return entries;
    if (["list_harnesses", "list_workspaces", "session_summaries"].includes(command)) return [];
    if (command === "chats_dir") return "/Chats";
    return null;
  });
  prefs.setPrefs({ sidebarLayout: "simple", sidebarSections: {}, branchSessions: "sidebar" });
  filter.setSidebarFilter("all");
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  await act(async () => { await store.bootSessions(); await store.refreshEverything(); await local.bootLocalSections(); await local.refreshLocalSections(); local.closeSectionDialog(); store.setShowArchived(false); store.openHome(); });
});
afterEach(cleanup);

const mount = () => render(<TooltipProvider><ProjectRail onHide={() => {}} onOpenSettings={() => {}} onOpenAccount={() => {}} onOpenHome={() => {}} onOpenIssues={() => {}} onOpenAgents={() => {}} onOpenStats={() => {}} onOpenAutomations={() => {}} onOpenSkills={() => {}} onSearch={() => {}} /><LocalSectionDialogs /></TooltipProvider>);
async function seed(sections: LocalSection[]) { saved = { revision: saved.revision + 1, sections }; await act(() => local.refreshLocalSections()); }
async function menu(name: string, action: string) { fireEvent.click(screen.getByRole("button", { name: `Menu for section ${name}` })); fireEvent.click(await screen.findByRole("menuitem", { name: action })); }
async function submit(name: string) { fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name })); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); }

describe("personal local sections", () => {
  it.each(["simple", "list"] as const)("creates, renames, changes emoji and deletes without changing sessions in %s layout", async (sidebarLayout) => {
    prefs.setPrefs({ sidebarLayout }); mount();
    // The sidebar has no standing New section row; a section is made from the command palette or a chat's menu.
    expect(screen.queryByRole("button", { name: "New section…" })).toBeNull();
    act(() => local.openSectionDialog({ kind: "create" }));
    fireEvent.change(screen.getByLabelText("Section name"), { target: { value: "Release" } });
    fireEvent.change(screen.getByLabelText(/Emoji/), { target: { value: "🚀" } });
    nextSections = [{ ...section("release", [], "Release"), emoji: "🚀" }];
    await submit("Create");
    expect(mocks.invoke).toHaveBeenCalledWith("edit_local_section", { edit: { kind: "create", name: "Release", emoji: "🚀", sessionIds: undefined } });
    expect(within(screen.getByRole("region", { name: "Release section" })).getByText(/Move sessions here/)).toBeTruthy();
    await menu("Release", "Rename section…");
    fireEvent.change(screen.getByLabelText("Section name"), { target: { value: "Ship it" } });
    nextSections = [{ ...nextSections[0]!, name: "Ship it" }]; await submit("Save");
    expect(mocks.invoke).toHaveBeenCalledWith("edit_local_section", { edit: { kind: "rename", id: "release", name: "Ship it" } });
    await menu("Ship it", "Change emoji…");
    fireEvent.change(screen.getByLabelText(/Emoji/), { target: { value: "" } });
    nextSections = [{ ...nextSections[0]!, emoji: null }]; await submit("Save");
    expect(mocks.invoke).toHaveBeenCalledWith("edit_local_section", { edit: { kind: "emoji", id: "release", emoji: null } });
    await seed([section("release", ["one", "two", "old"], "Ship it")]);
    expect(within(screen.getByRole("region", { name: "Ship it section" })).getAllByRole("listitem")).toHaveLength(2);
    await menu("Ship it", "Delete section…");
    expect(screen.getByRole("dialog").textContent).toContain("No sessions are deleted or archived");
    nextSections = []; await submit("Delete section");
    expect(screen.queryByRole("region", { name: "Ship it section" })).toBeNull();
    expect(store.getSessionStore().sessions).toEqual(entries);
    expect(screen.getAllByRole("button", { name: /^(No branch, )?Session one$/ })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^(No branch, )?Session two$/ })).toHaveLength(1);
    expect(mocks.invoke.mock.calls.some(([command]) => /archive|delete_session/.test(command))).toBe(false);
  });

  it.each(["simple", "list"] as const)("moves by the row menu and keeps memberships on remount in %s layout", async (sidebarLayout) => {
    prefs.setPrefs({ sidebarLayout });
    await seed([section("Release"), section("Bugs", ["two"])]);
    const view = mount();
    fireEvent.contextMenu(screen.getByRole("button", { name: /^(No branch, )?Session one$/ }));
    const trigger = await screen.findByRole("menuitem", { name: "Move to section" });
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    nextSections = [section("Release", ["one"]), section("Bugs", ["two"])];
    fireEvent.click(await screen.findByRole("menuitem", { name: "Release" }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Release section" })).getByText("Session one")).toBeTruthy());
    expect(mocks.invoke).toHaveBeenCalledWith("edit_local_section", { edit: { kind: "move", sessionIds: ["one"], sectionId: "Release" } });
    fireEvent.click(within(screen.getByRole("region", { name: "Release section" })).getByRole("button", { name: "Release" }));
    expect(screen.queryByText("Session one")).toBeNull();
    view.unmount(); mount();
    expect(within(screen.getByRole("region", { name: "Release section" })).getByRole("button", { name: "Release" }).getAttribute("aria-expanded")).toBe("false");
    await menu("Bugs", "Move section up");
    expect(mocks.invoke).toHaveBeenCalledWith("edit_local_section", { edit: { kind: "reorder", id: "Bugs", by: -1 } });
  });

  it("moves the selected local session from the command palette and starts a new session in its section", async () => {
    await seed([section("Release", ["one"])]);
    mount();
    act(() => store.selectSession("one"));
    const palette = render(<CommandPalette open onOpenChange={() => {}} onOpenSettings={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText("Command palette search"), { target: { value: "Move to section" } });
    fireEvent.click(await screen.findByRole("option", { name: /Move to section/ }));
    await waitFor(() => expect(local.getLocalSections().dialog?.kind).toBe("move"));
    palette.unmount();
    nextSections = [section("Release")]; await submit("Move");
    expect(mocks.invoke).toHaveBeenCalledWith("edit_local_section", { edit: { kind: "move", sessionIds: ["one"], sectionId: null } });
    fireEvent.click(screen.getByRole("button", { name: "New session in Release" }));
    expect(store.getSessionStore()).toMatchObject({ view: "new", newSessionQuick: true, newSessionSectionId: "Release" });
    act(() => store.closeNewSession());
    expect(store.getSessionStore().newSessionSectionId).toBeNull();
    await act(() => store.startChat());
    expect(store.getSessionStore().newSessionSectionId).toBeNull();
  });

  it.each(["simple", "list"] as const)("keeps archived membership and narrows sections with filters in %s layout", async (sidebarLayout) => {
    prefs.setPrefs({ sidebarLayout });
    entries[0]!.tabs[0]!.status = "waiting";
    await act(() => store.refreshEverything());
    await seed([section("Release", ["one", "old"]), section("Bugs", ["two"])]);
    mount();
    expect(screen.queryByText("Session old")).toBeNull();
    act(() => store.setShowArchived(true));
    expect(within(screen.getByRole("region", { name: "Release section" })).getByText("Session old")).toBeTruthy();
    act(() => filter.setSidebarFilter("needs"));
    expect(screen.queryByRole("region", { name: "Bugs section" })).toBeNull();
    expect(screen.queryByText("Session old")).toBeNull();
    expect(within(screen.getByRole("region", { name: "Release section" })).getByText("Session one")).toBeTruthy();
  });

  it("copies the real branch while a cross-project section row also names its project", async () => {
    entries[0]!.branch = "release";
    await act(() => store.refreshEverything());
    await seed([section("Release", ["one"])]);
    mocks.copyText.mockResolvedValue(undefined);
    mount();
    expect(within(screen.getByRole("region", { name: "Release section" })).getByText("Web · release")).toBeTruthy();
    fireEvent.contextMenu(screen.getByText("Session one"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy branch name" }));
    expect(mocks.copyText).toHaveBeenCalledWith("release");
  });

  it("keeps a failed rename open and ignores an older window event", async () => {
    await seed([section("Release", ["one"])]); mount();
    await menu("Release", "Rename section…");
    fireEvent.change(screen.getByLabelText("Section name"), { target: { value: "Ship it" } });
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "edit_local_section" ? Promise.reject(new Error("Disk is full")) : base(command, args));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Disk is full");
    expect(local.getLocalSections().sections[0]!.name).toBe("Release");
    act(() => mocks.listeners.get("local_sections_changed")?.({ payload: { revision: saved.revision - 1, sections: [] } }));
    expect(local.getLocalSections().sections[0]!.name).toBe("Release");
  });
});
