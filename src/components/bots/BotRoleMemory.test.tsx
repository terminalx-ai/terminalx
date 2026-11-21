import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, BotList } from "@/types/bots";
import type { BotChange, BotMemoryPlace, BotRoleMemory } from "@/types/botMemory";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  api: { list: vi.fn(), update: vi.fn(), roleWrite: vi.fn(), pause: vi.fn(), resume: vi.fn() },
  openPath: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, invoke: mocks.invoke, botsApi: mocks.api, fs: { ...actual.fs, openPath: mocks.openPath } };
});
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler);
    return () => mocks.listeners.delete(event);
  }),
}));
vi.mock("@/lib/experimentalSettings", () => ({ useExperimentalSettings: () => ({ bots: true }), getExperimentalSettings: () => ({ bots: true }) }));

const { bootBots, resetBotsForTests } = await import("@/lib/bots");
const { resetBotsPageForTests, showBotsTeam } = await import("@/lib/botsPage");
const { BotsView } = await import("./BotsView");
const { BotRoleMemory: Screen, changeTime } = await import("./BotRoleMemory");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { changeHeadline, changeSource, placeLabel, resetRoleDraftsForTests } = await import("@/lib/botMemory");

const bot = (id: string, name: string, extra: Partial<Bot> = {}): Bot => ({
  id, slug: name.toLowerCase(), name, roleTitle: "CTO", roleTemplateId: "cto", harness: "claude", model: "", access: "full", runsOn: "thisMac",
  reportsTo: "owner", worksIn: ["personal"], created: "2026-11-20T10:00:00Z", modified: "2026-11-20T10:00:00Z", ...extra,
});
const ATLAS = bot("atlas-id", "Atlas");
const IRIS = bot("iris-id", "Iris", { roleTitle: "UX designer", roleTemplateId: "ux-designer", reportsTo: "atlas-id" });

const place = (key: string, lines: string[], extra: Partial<BotMemoryPlace> = {}): BotMemoryPlace => ({
  key, path: `/home/bots/atlas-id/${key === "bot" ? "" : `${key}/`}MEMORY.md`, lines, read: key === "bot" || key === "personal", readLines: lines.length, notRead: 0, archiveLines: 0, bytes: 100, overLimit: false, ...extra,
});
const change = (id: string, extra: Partial<BotChange> = {}): BotChange => ({
  id, at: new Date().toISOString(), kind: "learned", text: "Status updates go in a table.", source: { kind: "chat", session: "s1", title: "Home chat" },
  by: "atlas-id", undoneBy: null, notUndoable: null, ...extra,
});
const view = (extra: Partial<BotRoleMemory> = {}): BotRoleMemory => ({
  role: {
    path: "/home/bots/atlas-id/ROLE.md", text: "You are the CTO.\n", hash: "h-now", editable: true, limit: 32768, bytes: 17, overLimit: false, templateTitle: "CTO",
    versions: [
      { change: "c-role", at: "2026-11-18T10:00:00Z", by: "owner", kind: "role", source: { kind: "app" }, hash: "h-now" },
      { change: null, at: "2026-11-01T10:00:00Z", by: "owner", kind: "template", source: { kind: "template" }, hash: "h-template" },
    ],
  },
  memory: {
    off: false, budget: 200, readLimit: 65536, workingPlace: "personal", read: 5,
    places: [place("bot", ["# Memory", "", "- 2026-11-20 Status updates go in a table."]), place("personal", ["- 2026-11-19 Likes short answers"])],
    topics: [{ place: "bot", name: "phase-2.md", path: "/home/bots/atlas-id/memory/phase-2.md", lines: 34, modified: new Date().toISOString() }],
  },
  changes: [change("c1")],
  totalChanges: 1,
  unreadableChanges: 0,
  secrets: [],
  ...extra,
});

const TEXTS: Record<string, string> = { "h-now": "You are the CTO.\n", "h-template": "You are a CTO.\n" };
const DIFF = [{ kind: "removed", text: "You are a CTO." }, { kind: "added", text: "You are the CTO." }];

/** Answer the screen's calls: the view, kept texts by hash, the template's changes; a change for anything else. */
function serve(shown: BotRoleMemory) {
  mocks.invoke.mockImplementation(async (_command: string, args: { operation: string; params: { hash?: string } }) => {
    switch (args.operation) {
      case "memoryView":
        return shown;
      case "memoryText":
        return TEXTS[args.params.hash ?? ""] ?? null;
      case "roleDiff":
        return DIFF;
      case "memoryLook":
        return { found: 0 };
      default:
        return [];
    }
  });
}

const asked = (operation: string) => mocks.invoke.mock.calls.filter(([command, args]) => command === "bot_memory" && args.operation === operation).map(([, args]) => args.params);

async function boot(list: BotList) {
  mocks.api.list.mockResolvedValue(list);
  await act(async () => {
    await bootBots();
  });
}

function show(bots: Bot[] = [ATLAS, IRIS], target = ATLAS) {
  return render(<TooltipProvider><Screen bot={target} bots={bots} /></TooltipProvider>);
}

beforeEach(() => {
  mocks.invoke.mockReset();
  for (const mock of Object.values(mocks.api)) mock.mockReset();
  mocks.openPath.mockReset().mockResolvedValue(undefined);
  mocks.listeners.clear();
  resetBotsPageForTests();
  resetRoleDraftsForTests();
});
afterEach(() => {
  cleanup();
  resetBotsForTests();
});

describe("Role and memory (PRO-470)", () => {
  it("shows the role with its saved state, who it reports to and whom it leads", async () => {
    serve(view());
    show();
    expect(await screen.findByTestId("bot-role-text")).toHaveProperty("value", "You are the CTO.\n");
    expect(screen.getByText("/home/bots/atlas-id/ROLE.md")).toBeTruthy();
    expect(screen.getByTestId("bot-role-state").textContent).toBe("Saved");
    expect((screen.getByTestId("bot-job-title") as HTMLInputElement).value).toBe("CTO");
    expect((screen.getByTestId("bot-reports-to") as HTMLSelectElement).value).toBe("owner");
    expect(screen.getByTestId("bot-leads").textContent).toContain("Iris");
    expect(screen.getByTestId("bot-role-footer").textContent).toMatch(/Changed .* by you/);
    fireEvent.click(screen.getByTestId("bot-role-open"));
    expect(mocks.openPath).toHaveBeenCalledWith("/home/bots/atlas-id/ROLE.md");
  });

  it("saves an edited role and says so; a change made meanwhile is not written over silently", async () => {
    serve(view());
    mocks.api.roleWrite.mockResolvedValue(ATLAS);
    show();
    const editor = await screen.findByTestId("bot-role-text");
    fireEvent.change(editor, { target: { value: "You are the CTO. Keep main green.\n" } });
    expect(screen.getByTestId("bot-role-state").textContent).toBe("Unsaved changes");
    fireEvent.click(screen.getByTestId("bot-role-save"));
    // The save names the role it started from.
    await waitFor(() => expect(mocks.api.roleWrite).toHaveBeenCalledWith("atlas-id", "You are the CTO. Keep main green.\n", "h-now"));
    await waitFor(() => expect(screen.getByTestId("bot-role-state").textContent).toBe("Saved"));
    const saved = view();
    saved.role = { ...saved.role, text: "You are the CTO. Keep main green.\n", hash: "h-saved" };
    serve(saved);
    await act(async () => mocks.listeners.get("bot_memory_changed")!({ payload: { id: "atlas-id" } }));

    // Edited outside the app while there is unsaved work here: say so, keep the draft, and save only once asked to.
    fireEvent.change(editor, { target: { value: "My draft\n" } });
    const edited = view();
    edited.role = { ...edited.role, text: "Atlas edited its own role.\n", hash: "h-atlas" };
    serve(edited);
    await act(async () => mocks.listeners.get("bot_memory_changed")!({ payload: { id: "atlas-id" } }));
    expect(await screen.findByTestId("bot-role-conflict")).toBeTruthy();
    expect((editor as HTMLTextAreaElement).value).toBe("My draft\n");
    expect((screen.getByTestId("bot-role-save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("bot-role-keep-mine"));
    expect(screen.queryByTestId("bot-role-conflict")).toBeNull();
    fireEvent.click(screen.getByTestId("bot-role-save"));
    await waitFor(() => expect(mocks.api.roleWrite).toHaveBeenLastCalledWith("atlas-id", "My draft\n", "h-atlas"));
  });

  it("offers Restart runtime when the runtime cannot verify the window, and saves again after it, keeping the draft", async () => {
    const RESTART = "runtime_restart_required:e7: TerminalX must restart its runtime to confirm that you asked. That stops Atlas's chat.";
    serve(view());
    const restarted = vi.fn(async () => undefined);
    const served = mocks.invoke.getMockImplementation()!;
    let adds = 0;
    mocks.invoke.mockImplementation(async (command: string, args: { operation: string }) => {
      if (command === "local_runtime_restart_for_window") return restarted();
      if (args?.operation === "memoryAdd" && adds++ === 0) throw RESTART;
      return served(command, args);
    });
    mocks.api.roleWrite.mockRejectedValueOnce(RESTART).mockResolvedValue(ATLAS);
    show();
    const editor = await screen.findByTestId("bot-role-text");
    fireEvent.change(editor, { target: { value: "Keep main green.\n" } });
    fireEvent.click(screen.getByTestId("bot-role-save"));
    // Said as the other Bots screens say it, never as the raw code; the draft is still there.
    const editorBox = screen.getByTestId("bot-role-editor");
    expect(await within(editorBox).findByText(/must restart its runtime to confirm that you asked/)).toBeTruthy();
    expect(editorBox.textContent).not.toContain("runtime_restart_required");
    expect((editor as HTMLTextAreaElement).value).toBe("Keep main green.\n");
    expect(screen.getByTestId("bot-role-state").textContent).toBe("Unsaved changes");
    // Gone and back before the restart: the draft is kept, and the save fails the same way again.
    mocks.api.roleWrite.mockRejectedValueOnce(RESTART);
    cleanup();
    show();
    expect(((await screen.findByTestId("bot-role-text")) as HTMLTextAreaElement).value).toBe("Keep main green.\n");
    fireEvent.click(screen.getByTestId("bot-role-save"));
    // Restart runtime, and the same draft is saved over the role it started from.
    fireEvent.click(await within(screen.getByTestId("bot-role-editor")).findByRole("button", { name: /Restart runtime/ }));
    await waitFor(() => expect(mocks.api.roleWrite).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByTestId("bot-role-state").textContent).toBe("Saved"));
    expect(mocks.api.roleWrite).toHaveBeenLastCalledWith("atlas-id", "Keep main green.\n", "h-now");
    expect(restarted).toHaveBeenCalledTimes(1);

    // A note added meanwhile fails the same way; Restart runtime, then it is added.
    fireEvent.change(screen.getByTestId("bot-memory-add-text"), { target: { value: "Ship on Tuesdays" } });
    fireEvent.click(screen.getByTestId("bot-memory-add"));
    const notes = screen.getByTestId("bot-memory-notes");
    fireEvent.click(await within(notes).findByRole("button", { name: /Restart runtime/ }));
    await waitFor(() => expect(restarted).toHaveBeenCalledTimes(2));
    expect(mocks.invoke).toHaveBeenCalledWith("local_runtime_restart_for_window", { epoch: "e7" });
    await waitFor(() => expect(asked("memoryAdd")).toHaveLength(2));
    expect(asked("memoryAdd")[1]).toEqual({ id: "atlas-id", place: "personal", text: "Ship on Tuesdays" });
    await waitFor(() => expect(within(notes).queryByRole("alert")).toBeNull());
  });

  it("keeps an unsaved role across leaving the page, and asks before going back to the team", async () => {
    serve(view());
    await boot({ revision: 1, bots: [ATLAS, IRIS], unreadable: 0 });
    showBotsTeam();
    render(<TooltipProvider><BotsView /></TooltipProvider>);
    await waitFor(() => expect(asked("memoryLook")).toEqual([{}]));
    const row = (await screen.findAllByTestId("bots-table-row")).find((value) => value.dataset.bot === "atlas-id")!;
    fireEvent.click(within(row).getByTestId("bot-role-memory-open"));
    fireEvent.change(await screen.findByTestId("bot-role-text"), { target: { value: "Half written\n" } });

    fireEvent.click(screen.getByTestId("bot-role-memory-back"));
    expect(screen.getByTestId("bot-role-leave")).toBeTruthy();
    fireEvent.click(screen.getByTestId("bot-role-leave-stay"));
    expect(screen.queryByTestId("bot-role-leave")).toBeNull();
    expect((screen.getByTestId("bot-role-text") as HTMLTextAreaElement).value).toBe("Half written\n");

    // Gone and back (another view, or the bot missing from the list a moment): the edit is still there.
    cleanup();
    show();
    expect(((await screen.findByTestId("bot-role-text")) as HTMLTextAreaElement).value).toBe("Half written\n");
    expect(screen.getByTestId("bot-role-state").textContent).toBe("Unsaved changes");
    fireEvent.click(screen.getByTestId("bot-role-discard"));
    expect((screen.getByTestId("bot-role-text") as HTMLTextAreaElement).value).toBe("You are the CTO.\n");
  });

  it("shows a role too large to save read-only, so a save never cuts it short", async () => {
    const shown = view();
    shown.role = { ...shown.role, editable: false, overLimit: true, bytes: 300_000 };
    serve(shown);
    show();
    const editor = (await screen.findByTestId("bot-role-text")) as HTMLTextAreaElement;
    expect(editor.readOnly).toBe(true);
    expect(screen.getByTestId("bot-role-read-only").textContent).toContain("ROLE.md is 293 KB, more than the 32 KB a role may be");
    expect((screen.getByTestId("bot-role-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the role's history: versions can be put back, and the template's changes shown", async () => {
    serve(view());
    show();
    fireEvent.click(await screen.findByTestId("bot-role-history-toggle"));
    const versions = screen.getAllByTestId("bot-role-version");
    expect(versions).toHaveLength(2);
    expect(versions[0].textContent).toContain("Current");
    // A version's text is read when it is shown, not sent with the view.
    expect(asked("memoryText")).toEqual([]);
    fireEvent.click(within(versions[1]).getByTestId("bot-role-version-show"));
    expect((await within(versions[1]).findByTestId("bot-role-version-text")).textContent).toBe("You are a CTO.\n");
    expect(asked("memoryText")).toEqual([{ id: "atlas-id", hash: "h-template" }]);
    fireEvent.click(within(versions[1]).getByTestId("bot-role-restore"));
    await waitFor(() => expect(asked("roleRestore")).toEqual([{ id: "atlas-id", change: null }]));
    fireEvent.click(screen.getByTestId("bot-role-template-toggle"));
    expect((await screen.findByTestId("bot-role-template-diff")).textContent).toContain("2 lines differ");
    expect(asked("roleDiff")).toEqual([{ id: "atlas-id" }]);
  });

  it("shows the lines read, where memory is kept, and adds and forgets notes", async () => {
    serve(view());
    show();
    expect((await screen.findByTestId("bot-memory-read")).textContent).toBe("5 of 200 lines read at the start of each conversation in Personal");
    expect(screen.getAllByTestId("bot-memory-place").map((card) => card.dataset.place)).toEqual(["bot", "personal"]);
    expect(screen.getByRole("radio", { name: /Stays in Personal/ }).getAttribute("aria-checked")).toBe("true");
    // The arrow keys move between the places.
    fireEvent.keyDown(screen.getByRole("radio", { name: /Stays in Personal/ }), { key: "ArrowUp" });
    expect(screen.getByRole("radio", { name: /Goes with Atlas/ }).getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /Goes with Atlas/ }));
    fireEvent.keyDown(screen.getByRole("radio", { name: /Goes with Atlas/ }), { key: "ArrowDown" });
    expect(screen.getByRole("radio", { name: /Stays in Personal/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: /Goes with Atlas/ }));
    expect(screen.getByTestId("bot-memory-topics").textContent).toContain("phase-2.md");

    fireEvent.change(screen.getByTestId("bot-memory-add-text"), { target: { value: "Deploys are on Fridays" } });
    mocks.invoke.mockResolvedValueOnce([change("c2")]);
    fireEvent.click(screen.getByTestId("bot-memory-add"));
    await waitFor(() => expect(asked("memoryAdd")).toEqual([{ id: "atlas-id", place: "bot", text: "Deploys are on Fridays" }]));
    fireEvent.click(screen.getByRole("button", { name: "Forget “Status updates go in a table.”" }));
    // The line is named with where it is, so one of two equal notes is the one forgotten.
    await waitFor(() => expect(asked("memoryForget")).toEqual([{ id: "atlas-id", place: "bot", line: "- 2026-11-20 Status updates go in a table.", index: 2 }]));
  });

  it("dims the oldest lines a conversation does not read, and flags files that look like they hold a secret", async () => {
    const shown = view({ secrets: ["/home/bots/atlas-id/memory/deploy.md"] });
    shown.memory = { ...shown.memory, workingPlace: "bot", places: [place("bot", ["- 2026-10-01 Old", "- 2026-11-01 Newer", "- 2026-11-20 Newest"], { readLines: 2, notRead: 1 }), place("personal", [])] };
    serve(shown);
    show();
    const lines = await screen.findAllByTestId("bot-memory-line");
    expect(lines.map((line) => line.className.includes("opacity-60"))).toEqual([true, false, false]);
    expect(screen.getByTestId("bot-memory-secrets").textContent).toContain("/home/bots/atlas-id/memory/deploy.md");
  });

  it("names an organisation's place by its name when the account knows it, else by its id", () => {
    const names = new Map([["org_1", "Kestrel Studio"]]);
    expect(placeLabel("org_1", "Atlas", names)).toBe("Stays in Kestrel Studio");
    expect(placeLabel("org_2", "Atlas", names)).toBe("Stays in org_2");
    expect(placeLabel("personal", "Atlas")).toBe("Stays in Personal");
  });

  it("names an organisation's notes and personal ones that are not read there", async () => {
    const atWork = bot("atlas-id", "Atlas", { worksIn: ["Acme", "personal"] });
    const shown = view();
    shown.memory = { ...shown.memory, workingPlace: "Acme", places: [place("bot", []), place("Acme", ["- 2026-11-20 Kestrel ships on Tuesdays"]), place("personal", [], { read: false, readLines: 0 })] };
    serve(shown);
    show([atWork], atWork);
    expect((await screen.findByTestId("bot-memory-read")).textContent).toContain("in Acme");
    expect(screen.getByRole("radio", { name: /Stays in Acme/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: /Stays in Personal/ }).textContent).toContain("Not read while Atlas works in an organisation");
  });

  it("says what is not read: past the line budget, or over the size limit", async () => {
    const shown = view();
    shown.memory = { ...shown.memory, places: [place("bot", ["- 2026-11-20 a"], { notRead: 12, overLimit: true, bytes: 70_000 }), place("personal", [])] };
    shown.role = { ...shown.role, overLimit: true, bytes: 80_000 };
    serve(shown);
    show();
    expect((await screen.findByTestId("bot-memory-not-read")).textContent).toContain("12 older lines are past the 200-line budget");
    expect(screen.getByTestId("bot-memory-over-limit").textContent).toContain("only its last 64 KB, the newest notes, is read");
    expect(screen.getByTestId("bot-role-over-limit").textContent).toContain("ROLE.md is 79 KB");
  });

  it("turns memory off and says what that means", async () => {
    serve(view());
    mocks.api.update.mockResolvedValue({ ...ATLAS, memoryOff: true });
    show();
    fireEvent.click(await screen.findByTestId("bot-memory-switch"));
    await waitFor(() => expect(mocks.api.update).toHaveBeenCalledWith("atlas-id", { memoryOff: true }));
    cleanup();
    const off = view();
    off.memory = { ...off.memory, off: true };
    serve(off);
    show([{ ...ATLAS, memoryOff: true }], { ...ATLAS, memoryOff: true });
    expect((await screen.findByTestId("bot-memory-off")).textContent).toContain("Conversations with Atlas start with none of its notes");
  });

  it("lists every change with its source, and Undo undoes it", async () => {
    const shown = view({
      changes: [
        change("c3", { kind: "standup", text: "Something new", source: { kind: "meeting" }, notUndoable: "A newer version of TerminalX made this change; it cannot be undone here." }),
        change("c2", { kind: "outside", text: "1 line added to MEMORY.md", source: { kind: "outside" }, by: "outside" }),
        change("c1"),
        change("c0", { kind: "forgot", text: "Windows CI must pass", source: { kind: "app" }, by: "owner", undoneBy: "c4", notUndoable: "This change was already undone." }),
      ],
      totalChanges: 9,
      unreadableChanges: 2,
    });
    serve(shown);
    show();
    const rows = await screen.findAllByTestId("bot-change");
    expect(rows.map((row) => row.dataset.kind)).toEqual(["standup", "outside", "learned", "forgot"]);
    expect(rows[0].textContent).toContain("standup: Something new");
    expect(rows[0].textContent).toContain("Can't undo");
    expect(rows[1].textContent).toContain("Edited outside the app");
    expect(rows[2].textContent).toContain("Learned: “Status updates go in a table.”");
    expect(rows[2].textContent).toContain("From Atlas's chat · Home chat");
    expect(rows[3].textContent).toContain("Undone");
    expect(screen.getByText(/2 recorded changes cannot be read by this version/)).toBeTruthy();
    expect(screen.getByText("Showing the newest 4 of 9 changes.")).toBeTruthy();

    mocks.invoke.mockResolvedValueOnce(change("c5", { kind: "undo", undoes: "c1" }));
    fireEvent.click(within(rows[2]).getByTestId("bot-change-undo"));
    await waitFor(() => expect(asked("memoryUndo")).toEqual([{ id: "atlas-id", change: "c1" }]));
  });

  it("says why it could not read, and tries again", async () => {
    serve(view());
    mocks.invoke.mockRejectedValueOnce("the log cannot be read");
    show();
    expect((await screen.findByRole("alert")).textContent).toContain("the log cannot be read");
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByTestId("bot-role-text")).toBeTruthy();
  });

  it("opens from a bot's row on the team page, and goes back", async () => {
    serve(view());
    await boot({ revision: 1, bots: [ATLAS, IRIS], unreadable: 0 });
    showBotsTeam();
    render(<TooltipProvider><BotsView /></TooltipProvider>);
    const row = (await screen.findAllByTestId("bots-table-row")).find((value) => value.dataset.bot === "atlas-id")!;
    fireEvent.click(within(row).getByTestId("bot-role-memory-open"));
    expect(await screen.findByText("Atlas · Role and memory")).toBeTruthy();
    expect(await screen.findByTestId("bot-role-text")).toBeTruthy();
    fireEvent.click(screen.getByTestId("bot-role-memory-back"));
    expect(await screen.findByTestId("bots-team")).toBeTruthy();
  });

  it("words changes and their times plainly", () => {
    const now = new Date(2026, 10, 20, 15, 0);
    expect(changeTime(new Date(2026, 10, 20, 13, 2).toISOString(), now)).toMatch(/13:02|1:02/);
    expect(changeTime("not a time", now)).toBe("");
    expect(changeHeadline(change("x", { kind: "archived", text: "Moved 3 older notes to the archive" }))).toBe("Moved 3 older notes to the archive");
    expect(changeSource(change("x", { source: { kind: "duty", duty: "nightly-tidy" } }), [ATLAS])).toBe("From a duty · nightly-tidy");
    expect(changeSource(change("x", { by: "gone", source: { kind: "chat" } }), [ATLAS])).toBe("From a removed bot's chat");
    expect(changeSource(change("x", { by: "owner", source: { kind: "cli" } }), [])).toBe("By you from the terminal");
  });
});
