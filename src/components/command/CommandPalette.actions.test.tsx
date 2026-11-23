import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalSection, LocalSectionState } from "@/lib/localSections";
import type { SessionEntry } from "@/types/session";

// PRO-401: the Actions tab (design 07.04) and Move to section as a view of the palette (07.13, 07.14).
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(), openUrl: vi.fn() }));
vi.mock("@/components/layout/AppShell", () => ({ TITLEBAR_INSET: 78 }));

const { CommandPalette } = await import("./CommandPalette");
const store = await import("@/lib/sessions");
const local = await import("@/lib/localSections");

const session = (id: string, title: string, extra: Partial<SessionEntry> = {}): SessionEntry => ({ id, title, projectPath: "/alpha", cwd: "/alpha", created: "2026-11-01T00:00:00Z", modified: "2026-11-01T00:00:00Z", archived: false, pinned: false, worktreeRemoved: false, tabs: [], ...extra });
const section = (id: string, name: string, sessions: string[], emoji?: string): LocalSection => ({ id, name, sessions, emoji });

let saved: LocalSectionState;
let failEdit: string | null;

beforeEach(async () => {
  failEdit = null;
  saved = {
    revision: local.getLocalSections().revision + 1,
    sections: [section("release", "Release 0.9", ["other"], "🚀"), section("bugs", "Bugs", ["fix", "archived"], "🐛"), section("later", "Later", [])],
  };
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "list_projects") return { projects: [{ path: "/alpha", name: "Alpha", kind: "git" }], lastSelected: "/alpha" };
    if (command === "list_sessions") return [session("fix", "Fix duplicate permission cards"), session("other", "Other work"), session("archived", "Old work", { archived: true })];
    if (command === "list_workspaces" || command === "list_harnesses" || command === "session_summaries") return [];
    if (command === "local_sections") return saved;
    if (command === "edit_local_section") {
      if (failEdit) throw new Error(failEdit);
      saved = { ...saved, revision: saved.revision + 1 };
      return saved;
    }
    return null;
  });
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  await act(async () => {
    await store.refreshEverything();
    await local.bootLocalSections();
    await local.refreshLocalSections();
    store.selectSession("fix");
  });
});

afterEach(() => {
  cleanup();
  act(() => local.closeSectionDialog());
});

function palette() {
  const onOpenChange = vi.fn();
  render(<CommandPalette open onOpenChange={onOpenChange} onOpenSettings={vi.fn()} onCreated={vi.fn()} />);
  return { onOpenChange, input: screen.getByLabelText("Command palette search") as HTMLInputElement };
}

const optionNames = (group: HTMLElement) => within(group).getAllByRole("option").map((row) => row.textContent);
const edits = () => mocks.invoke.mock.calls.filter(([command]) => command === "edit_local_section").map(([, args]) => (args as { edit: unknown }).edit);

async function openMove(input: HTMLElement) {
  fireEvent.change(input, { target: { value: "Move to section" } });
  fireEvent.click(await screen.findByRole("option", { name: /^Move to section…/ }));
  await waitFor(() => expect(input.getAttribute("placeholder")).toBe("Search sections…"));
}

describe("the Actions tab (design 07.04)", () => {
  it("lists the open session's actions under its title, then the app's with the most used first", () => {
    const { input } = palette();
    fireEvent.click(screen.getByRole("tab", { name: "Actions" }));
    expect(input.getAttribute("placeholder")).toBe("Search actions…");
    expect(screen.getAllByRole("group").map((group) => group.getAttribute("aria-labelledby"))).toEqual(["palette-group-session-actions", "palette-group-commands"]);
    expect(document.getElementById("palette-group-session-actions")!.textContent).toBe("This session · Fix duplicate permission cards");
    const app = optionNames(screen.getByRole("group", { name: "App" }));
    expect(app.slice(0, 4).map((name) => name!.replace(/[⇧⌥⌃⌘]|Ctrl\+|Shift\+|Alt\+/g, ""))).toEqual(["New sessionN", "New section…Group sessions across local projects", "Add projectO", "AutomationsR"]);
    // Housekeeping ends the list; it no longer opens it.
    expect(app.at(-1)).toBe("About TerminalX");
    expect(app.indexOf("Check for updates")).toBeGreaterThan(app.length - 5);
    // The whole list, scrolled: nothing is behind a "more" button.
    expect(screen.queryByRole("button", { name: /^\d+ more$/ })).toBeNull();
    const own = optionNames(screen.getByRole("group", { name: /^This session/ }));
    expect(own).toContain("Set status…Backlog");
    expect(own).toContain("Move to section…In Bugs");
  });

  it("draws an action as one line: no generic subtitle, and its keys as one keycap", () => {
    palette();
    fireEvent.click(screen.getByRole("tab", { name: "Actions" }));
    expect(screen.queryByText(/ shortcut$/)).toBeNull();
    const row = document.getElementById("command:shortcut:app.closeWindow")!;
    expect(row.className).toContain("h-9");
    const caps = row.querySelectorAll("kbd");
    expect(caps).toHaveLength(1);
    expect(caps[0].className).toContain("text-xs");
    expect(row.textContent).toBe(`Close window${caps[0].textContent}`);
    // Still found by the group it used to name.
    fireEvent.change(screen.getByLabelText("Command palette search"), { target: { value: "composer shortcut" } });
    expect(document.getElementById("command:shortcut:composer.send")).toBeTruthy();
  });

  it("puts every action under App when no session is open", async () => {
    act(() => store.selectSession(null));
    palette();
    fireEvent.click(screen.getByRole("tab", { name: "Actions" }));
    expect(screen.getAllByRole("group").map((group) => group.getAttribute("aria-labelledby"))).toEqual(["palette-group-commands"]);
    expect(document.getElementById("command:shortcut:git.commitPush")).toBeTruthy();
    expect(document.getElementById("command:local-section:move")).toBeNull();
  });

  it("switches tabs with Tab and Shift+Tab, keeps the query, and says so in the footer", () => {
    const { input } = palette();
    const selected = () => screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")!.textContent;
    expect(screen.getByText("Tab switches tabs")).toBeTruthy();
    fireEvent.change(input, { target: { value: "new" } });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(selected()).toBe("Sessions");
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(selected()).toBe("Settings");
    expect(input.value).toBe("new");
    fireEvent.keyDown(input, { key: "Tab" });
    expect(selected()).toBe("All");
  });
});

describe("Move to section (design 07.13)", () => {
  it("is a view of the palette that opens on the session's own section, so Enter moves nothing", async () => {
    const { input, onOpenChange } = palette();
    await openMove(input);
    expect(local.getLocalSections().dialog).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("button", { name: "Back to actions" }).parentElement!.textContent).toBe("Back to actionsMoveFix duplicate permission cardsto a section");
    // Counts are of listed sessions: Bugs holds an archived one too.
    expect(optionNames(screen.getByRole("group", { name: "Sections" }))).toEqual(["🚀Release 0.91 session", "🐛Bugs1 session", "Later0 sessions"]);
    const bugs = screen.getByRole("option", { name: /Bugs/ });
    expect(bugs.getAttribute("aria-selected")).toBe("true");
    expect(within(bugs).getByLabelText("Current section")).toBeTruthy();
    expect(screen.getAllByLabelText("Current section")).toHaveLength(1);
    expect(optionNames(screen.getByRole("group", { name: "More" }))).toEqual(["New section…", "Remove from sectionBack under Alpha"]);
    expect(screen.getByText("↵ move")).toBeTruthy();
    expect(screen.getByText("⌫ on an empty query goes back")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(edits()).toEqual([]);
  });

  it("moves the session to the section chosen, and out of its section only by Remove from section", async () => {
    const first = palette();
    await openMove(first.input);
    fireEvent.click(screen.getByRole("option", { name: /Release 0\.9/ }));
    await waitFor(() => expect(first.onOpenChange).toHaveBeenCalledWith(false));
    expect(edits()).toEqual([{ kind: "move", sessionIds: ["fix"], sectionId: "release" }]);
    cleanup();
    const second = palette();
    await openMove(second.input);
    fireEvent.click(screen.getByRole("option", { name: /^Remove from section/ }));
    await waitFor(() => expect(second.onOpenChange).toHaveBeenCalledWith(false));
    expect(edits().at(-1)).toEqual({ kind: "move", sessionIds: ["fix"], sectionId: null });
  });

  it("offers no Remove from section, and marks nothing, for a session in no section", async () => {
    act(() => store.selectSession("archived"));
    saved = { ...saved, revision: saved.revision + 1, sections: saved.sections.map((entry) => ({ ...entry, sessions: entry.sessions.filter((id) => id !== "archived") })) };
    await act(() => local.refreshLocalSections());
    const { input } = palette();
    await openMove(input);
    expect(screen.queryByLabelText("Current section")).toBeNull();
    expect(screen.queryByRole("option", { name: /^Remove from section/ })).toBeNull();
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
  });

  it("narrows as typed and creates a section from the query when none matches (design 07.14)", async () => {
    const { input, onOpenChange } = palette();
    await openMove(input);
    fireEvent.change(input, { target: { value: "la" } });
    expect(optionNames(screen.getByRole("group", { name: "Sections" }))).toEqual(["Later0 sessions"]);
    fireEvent.change(input, { target: { value: "docs site" } });
    expect(screen.getByRole("status").textContent).toBe("No matching sections3 local sections");
    const create = screen.getByRole("option", { name: /^New section “docs site”/ });
    expect(create.getAttribute("aria-selected")).toBe("true");
    expect(create.textContent).toBe("New section “docs site”and move Fix duplicate permission cards into it↵");
    expect(screen.getByText("↵ create and move")).toBeTruthy();
    expect(screen.getByText("⌫ edits the query")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(edits()).toEqual([{ kind: "create", name: "docs site", emoji: null, sessionIds: ["fix"] }]);
  });

  it("does not offer to create a section whose name is taken", async () => {
    const { input } = palette();
    await openMove(input);
    fireEvent.change(input, { target: { value: "bugs" } });
    expect(screen.getAllByRole("option").map((row) => row.id)).toEqual(["palette:section:bugs"]);
  });

  it("stays open and says why when the move is refused", async () => {
    const { input, onOpenChange } = palette();
    await openMove(input);
    failEdit = "The sidebar changed on another device";
    fireEvent.click(screen.getByRole("option", { name: /Later/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("The sidebar changed on another device");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(input.getAttribute("placeholder")).toBe("Search sections…");
  });

  it("goes back to the actions by its button or Backspace on an empty query", async () => {
    const { input } = palette();
    await openMove(input);
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(input.getAttribute("placeholder")).toBe("Search sections…");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(input.getAttribute("placeholder")).toBe("Search actions…");
    expect(screen.getByRole("tab", { name: "Actions" }).getAttribute("aria-selected")).toBe("true");
    await openMove(input);
    fireEvent.click(screen.getByRole("button", { name: "Back to actions" }));
    expect(input.getAttribute("placeholder")).toBe("Search actions…");
  });

  it("hands New section… to the section dialog with the session to move into it", async () => {
    const { input, onOpenChange } = palette();
    await openMove(input);
    fireEvent.click(screen.getByRole("option", { name: "New section…" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(local.getLocalSections().dialog).toEqual({ kind: "create", sessionIds: ["fix"] }));
  });
});
