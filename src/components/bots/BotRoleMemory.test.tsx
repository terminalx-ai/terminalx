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
const { changeHeadline, changeSource } = await import("@/lib/botMemory");

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
  id, at: new Date().toISOString(), kind: "learned", text: "Status updates go in a table.", edits: [], source: { kind: "chat", session: "s1", title: "Home chat" },
  by: "atlas-id", undoneBy: null, notUndoable: null, ...extra,
});
const view = (extra: Partial<BotRoleMemory> = {}): BotRoleMemory => ({
  role: {
    path: "/home/bots/atlas-id/ROLE.md", text: "You are the CTO.\n", editable: true, bytes: 17, overLimit: false, templateTitle: "CTO",
    templateDiff: [{ kind: "removed", text: "You are a CTO." }, { kind: "added", text: "You are the CTO." }],
    versions: [
      { change: "c-role", at: "2026-11-18T10:00:00Z", by: "owner", kind: "role", source: { kind: "app" }, text: "You are the CTO.\n" },
      { change: null, at: "2026-11-01T10:00:00Z", by: "owner", kind: "template", source: { kind: "template" }, text: "You are a CTO.\n" },
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
  ...extra,
});

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
});
afterEach(() => {
  cleanup();
  resetBotsForTests();
});

describe("Role and memory (PRO-470)", () => {
  it("shows the role with its saved state, who it reports to and whom it leads", async () => {
    mocks.invoke.mockResolvedValue(view());
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
    mocks.invoke.mockResolvedValue(view());
    mocks.api.roleWrite.mockResolvedValue(ATLAS);
    show();
    const editor = await screen.findByTestId("bot-role-text");
    fireEvent.change(editor, { target: { value: "You are the CTO. Keep main green.\n" } });
    expect(screen.getByTestId("bot-role-state").textContent).toBe("Unsaved changes");
    fireEvent.click(screen.getByTestId("bot-role-save"));
    await waitFor(() => expect(mocks.api.roleWrite).toHaveBeenCalledWith("atlas-id", "You are the CTO. Keep main green.\n"));
    await waitFor(() => expect(screen.getByTestId("bot-role-state").textContent).toBe("Saved"));

    // Edited outside the app while there is unsaved work here: say so, keep the draft.
    fireEvent.change(editor, { target: { value: "My draft\n" } });
    const edited = view();
    edited.role = { ...edited.role, text: "Atlas edited its own role.\n" };
    mocks.invoke.mockResolvedValue(edited);
    await act(async () => mocks.listeners.get("bot_memory_changed")!({ payload: { id: "atlas-id" } }));
    expect(await screen.findByTestId("bot-role-conflict")).toBeTruthy();
    expect((editor as HTMLTextAreaElement).value).toBe("My draft\n");
  });

  it("shows a role too large to save read-only, so a save never cuts it short", async () => {
    const shown = view();
    shown.role = { ...shown.role, editable: false, overLimit: true, bytes: 300_000 };
    mocks.invoke.mockResolvedValue(shown);
    show();
    const editor = (await screen.findByTestId("bot-role-text")) as HTMLTextAreaElement;
    expect(editor.readOnly).toBe(true);
    expect(screen.getByTestId("bot-role-read-only").textContent).toContain("293 KB");
    expect((screen.getByTestId("bot-role-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the role's history: versions can be put back, and the template's changes shown", async () => {
    mocks.invoke.mockResolvedValue(view());
    show();
    fireEvent.click(await screen.findByTestId("bot-role-history-toggle"));
    const versions = screen.getAllByTestId("bot-role-version");
    expect(versions).toHaveLength(2);
    expect(versions[0].textContent).toContain("Current");
    fireEvent.click(within(versions[1]).getByTestId("bot-role-restore"));
    await waitFor(() => expect(asked("roleRestore")).toEqual([{ id: "atlas-id", change: null }]));
    fireEvent.click(screen.getByTestId("bot-role-template-toggle"));
    expect(screen.getByTestId("bot-role-template-diff").textContent).toContain("2 lines differ");
  });

  it("shows the lines read, where memory is kept, and adds and forgets notes", async () => {
    mocks.invoke.mockResolvedValue(view());
    show();
    expect((await screen.findByTestId("bot-memory-read")).textContent).toBe("5 of 200 lines read at the start of each conversation in Personal");
    expect(screen.getAllByTestId("bot-memory-place").map((card) => card.dataset.place)).toEqual(["bot", "personal"]);
    expect(screen.getByRole("radio", { name: /Stays in Personal/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: /Goes with Atlas/ }));
    expect(screen.getByTestId("bot-memory-topics").textContent).toContain("phase-2.md");

    fireEvent.change(screen.getByTestId("bot-memory-add-text"), { target: { value: "Deploys are on Fridays" } });
    mocks.invoke.mockResolvedValueOnce([change("c2")]);
    fireEvent.click(screen.getByTestId("bot-memory-add"));
    await waitFor(() => expect(asked("memoryAdd")).toEqual([{ id: "atlas-id", place: "bot", text: "Deploys are on Fridays" }]));
    fireEvent.click(screen.getByRole("button", { name: "Forget “Status updates go in a table.”" }));
    await waitFor(() => expect(asked("memoryForget")).toEqual([{ id: "atlas-id", place: "bot", line: "- 2026-11-20 Status updates go in a table." }]));
  });

  it("names an organisation's notes and personal ones that are not read there", async () => {
    const atWork = bot("atlas-id", "Atlas", { worksIn: ["Acme", "personal"] });
    const shown = view();
    shown.memory = { ...shown.memory, workingPlace: "Acme", places: [place("bot", []), place("Acme", ["- 2026-11-20 Kestrel ships on Tuesdays"]), place("personal", [], { read: false, readLines: 0 })] };
    mocks.invoke.mockResolvedValue(shown);
    show([atWork], atWork);
    expect((await screen.findByTestId("bot-memory-read")).textContent).toContain("in Acme");
    expect(screen.getByRole("radio", { name: /Stays in Acme/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: /Stays in Personal/ }).textContent).toContain("Not read while Atlas works in an organisation");
  });

  it("says what is not read: past the line budget, or over the size limit", async () => {
    const shown = view();
    shown.memory = { ...shown.memory, places: [place("bot", ["- 2026-11-20 a"], { notRead: 12, overLimit: true, bytes: 70_000 }), place("personal", [])] };
    shown.role = { ...shown.role, overLimit: true, bytes: 80_000 };
    mocks.invoke.mockResolvedValue(shown);
    show();
    expect((await screen.findByTestId("bot-memory-not-read")).textContent).toContain("12 lines are past the 200-line budget");
    expect(screen.getByTestId("bot-memory-over-limit").textContent).toContain("only the first 64 KB is read");
    expect(screen.getByTestId("bot-role-over-limit").textContent).toContain("ROLE.md is 79 KB");
  });

  it("turns memory off and says what that means", async () => {
    mocks.invoke.mockResolvedValue(view());
    mocks.api.update.mockResolvedValue({ ...ATLAS, memoryOff: true });
    show();
    fireEvent.click(await screen.findByTestId("bot-memory-switch"));
    await waitFor(() => expect(mocks.api.update).toHaveBeenCalledWith("atlas-id", { memoryOff: true }));
    cleanup();
    const off = view();
    off.memory = { ...off.memory, off: true };
    mocks.invoke.mockResolvedValue(off);
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
    mocks.invoke.mockResolvedValue(shown);
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
    mocks.invoke.mockRejectedValueOnce("the log cannot be read").mockResolvedValue(view());
    show();
    expect((await screen.findByRole("alert")).textContent).toContain("the log cannot be read");
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByTestId("bot-role-text")).toBeTruthy();
  });

  it("opens from a bot's row on the team page, and goes back", async () => {
    mocks.invoke.mockResolvedValue(view());
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
