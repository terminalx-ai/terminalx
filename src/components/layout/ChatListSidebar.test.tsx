import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Project, SessionEntry } from "@/types/session";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("./AppShell", () => ({ TITLEBAR_INSET: 78 }));
vi.mock("@/components/account/AccountSidebarEntry", () => ({ AccountSidebarEntry: () => null }));
vi.mock("@/lib/automations", () => ({ useAutomationStore: () => ({ automations: [] }) }));

const { ProjectRail } = await import("./ProjectRail");
const { chatPreview } = await import("./ChatListSidebar");
const store = await import("@/lib/sessions");
const prefs = await import("@/lib/prefs");

const chatsPath = "/store/Chats";
const projects: Project[] = [{ path: "/repos/web", name: "web", kind: "git", color: "blue" }];
const at = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();
const session = (id: string, projectPath: string, modified: string, extra: Partial<SessionEntry> = {}, status: SessionEntry["tabs"][number]["status"] = "idle"): SessionEntry => ({
  id, projectPath, cwd: projectPath, title: `Session ${id}`, created: modified, modified, pinned: false, archived: false, worktreeRemoved: false, activeTab: `${id}-tab`,
  tabs: [{ id: `${id}-tab`, title: `Talk ${id}`, harness: "claude", model: "", permissionMode: "auto", status, created: "", modified: "" }],
  ...extra,
});
let sessions: SessionEntry[];
let summaries: Record<string, { lastPrompt?: string; lastReply?: string; waitingOn?: string }>;

beforeEach(async () => {
  prefs.setPrefs({ sidebarLayout: "list", sidebarSections: {} });
  summaries = {};
  mocks.invoke.mockReset().mockImplementation(async (command: string, args?: { sessionIds?: string[] }) => {
    if (command === "list_projects") return { projects, lastSelected: null };
    if (command === "list_sessions") return sessions;
    if (command === "list_harnesses") return [];
    if (command === "chats_dir") return chatsPath;
    if (command === "list_workspaces") return [];
    if (command === "session_summaries") {
      return (args?.sessionIds ?? []).flatMap((sessionId) => (summaries[sessionId] ? [{ sessionId, tabId: `${sessionId}-tab`, lastPrompt: null, lastReply: null, waitingOn: null, updatedAt: at(1), ...summaries[sessionId] }] : []));
    }
    return undefined;
  });
});
afterEach(cleanup);

const mount = () => render(<TooltipProvider><ProjectRail onHide={() => {}} onOpenSettings={() => {}} onOpenAccount={() => {}} onOpenIssues={() => {}} onOpenAgents={() => {}} onOpenStats={() => {}} onOpenAutomations={() => {}} onOpenSkills={() => {}} onSearch={() => {}} /></TooltipProvider>);

async function boot(list: SessionEntry[]) {
  sessions = list;
  await act(async () => {
    await store.bootSessions();
    await store.refreshEverything();
  });
}

const rows = () => within(screen.getByTestId("conversation-list")).getAllByRole("listitem");
const titleOf = (row: HTMLElement) => within(row).getByRole("button", { name: /^(Talk|Session)/ }).getAttribute("aria-label");

describe("the chat list", () => {
  it("lists every conversation in one list, pinned first then newest, whatever project it is in", async () => {
    await boot([
      session("chat", chatsPath, at(3)),
      session("work", "/repos/web", at(2), { worktreeName: "fix-login", branch: "raccoon/fix-login" }),
      session("old", "/repos/web", at(1), { pinned: true }),
      session("gone", chatsPath, at(4), { archived: true }),
    ]);
    mount();
    expect(rows().map(titleOf)).toEqual(["Talk old", "Talk chat", "Talk work"]);
    // No project level: the project view is one click away.
    expect(screen.queryByRole("group", { name: "web" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(screen.getByRole("menuitemradio", { name: "One list of chats" }).getAttribute("aria-checked")).toBe("true");
  });

  it("names the project and branch under each chat, says what a chat in no project last said, and marks the unread and waiting ones", async () => {
    summaries = {
      said: { lastReply: "Done: the tests pass\nand the build is green." },
      asks: { waitingOn: "Allow rm -rf dist?" },
      alone: { waitingOn: "Which file?" },
    };
    await boot([
      session("asks", "/repos/web", at(4), { worktreeName: "fix-login", branch: "raccoon/fix-login" }, "waiting"),
      session("said", chatsPath, at(3), {}, "completed"),
      session("alone", chatsPath, at(2), {}, "waiting"),
      session("quiet", "/repos/web", at(1), { branch: "main" }),
    ]);
    mount();
    // The summaries arrive after the first paint.
    await act(async () => {});
    const [asks, said, alone, quiet] = rows();
    expect(within(asks!).getByTestId("chat-preview").textContent).toBe("web · raccoon/fix-login");
    expect(within(asks!).getByRole("img", { name: "Needs you" })).toBeTruthy();
    // What it waits on is still there, on hover.
    expect(asks!.querySelector("[title]")?.getAttribute("title")).toBe("Talk asks\nweb · raccoon/fix-login\nAllow rm -rf dist?");
    expect(within(said!).getByTestId("chat-preview").textContent).toBe("Done: the tests pass and the build is green.");
    expect(within(said!).getByRole("img", { name: "Unread" })).toBeTruthy();
    expect(within(alone!).getByTestId("chat-preview").textContent).toBe("Which file?");
    expect(within(quiet!).getByTestId("chat-preview").textContent).toBe("web · main");
    expect(within(quiet!).queryByRole("img")).toBeNull();
  });

  it("opens a chat on click, and switches back to the project view from the View menu", async () => {
    await boot([session("one", chatsPath, at(1))]);
    mount();
    fireEvent.click(within(rows()[0]!).getByRole("button", { name: "Talk one" }));
    expect(store.getSessionStore().selectedSessionId).toBe("one");
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Group by project" }));
    expect(prefs.getPrefs().sidebarLayout).toBe("simple");
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(screen.getByRole("menuitemradio", { name: "Group by project" }).getAttribute("aria-checked")).toBe("true");
  });
});

describe("chatPreview", () => {
  const chat = session("x", chatsPath, at(1));
  it("names the place first; a chat in none says what the agent waits on, then the last thing said", () => {
    expect(chatPreview(chat, { sessionId: "x", tabId: "t", lastPrompt: "hi", lastReply: "hello", waitingOn: "ok?", updatedAt: "" }, { name: "web", branch: "main" })).toEqual({ text: "web · main", tone: "place" });
    expect(chatPreview(chat, { sessionId: "x", tabId: "t", lastPrompt: "hi", lastReply: "hello", waitingOn: "ok?", updatedAt: "" }, null)).toEqual({ text: "ok?", tone: "waiting" });
    expect(chatPreview(chat, { sessionId: "x", tabId: "t", lastPrompt: "hi", lastReply: null, waitingOn: null, updatedAt: "" }, null)).toEqual({ text: "hi", tone: "said" });
    expect(chatPreview(chat, undefined, { name: "web", branch: null })).toEqual({ text: "web", tone: "place" });
    expect(chatPreview(chat, undefined, null)).toEqual({ text: "New chat", tone: "place" });
  });
});

describe("a project's mark", () => {
  it("shows the project's initial on a colour of its own, the same colour every time, and the chosen colour when there is one", async () => {
    const { projectHue } = await import("./ChatListSidebar");
    const { PROJECT_COLORS } = await import("./PixelMascot");
    expect(projectHue({ name: "web", color: null })).toBe(projectHue({ name: "web", color: null }));
    expect(projectHue({ name: "web", color: null })).not.toBe("var(--ink-muted)");
    expect(projectHue({ name: "web", color: "pink" })).toBe(PROJECT_COLORS.find((c) => c.id === "pink")!.css);
    await boot([session("one", "/repos/web", at(1)), session("two", chatsPath, at(2), {}, "in_progress")]);
    mount();
    const [chat, work] = rows();
    // Only a busy bot's face moves.
    expect(within(chat!).getByTestId("bot-face").querySelector("animate")).toBeTruthy();
    expect(within(work!).getByTestId("bot-face").querySelector("animate")).toBeNull();
    // Each chat has a face of its own; a project chat's is in the project's colour.
    expect(within(work!).getByTestId("bot-face").getAttribute("data-seed")).toBe("one");
    expect(within(work!).getByTestId("bot-face").querySelector("path")?.getAttribute("fill")).toBe(projectHue({ name: "web", color: "blue" }));
    expect(within(chat!).getByTestId("bot-face").getAttribute("data-seed")).toBe("two");
  });
});

describe("a bot's face", () => {
  it("is the same for the same seed, differs between seeds, and is a closed blob with two eyes", async () => {
    const { faceOf, botColor } = await import("./BotFace");
    expect(faceOf("one")).toEqual(faceOf("one"));
    expect(faceOf("one").path).not.toBe(faceOf("two").path);
    expect(faceOf("one").path).toMatch(/^M [\d.]+ [\d.]+( Q [\d.]+ [\d.]+ [\d.]+ [\d.]+){5,8} Z$/);
    expect(faceOf("one").eyes).toHaveLength(2);
    // The shapes it morphs through share the first one's structure and come back round to it.
    const commands = (path: string) => path.replace(/[\d.]+/g, "n");
    expect(faceOf("one").morph.length).toBeGreaterThan(2);
    expect(new Set(faceOf("one").morph.map(commands)).size).toBe(1);
    expect(faceOf("one").morph[0]).toBe(faceOf("one").path);
    expect(faceOf("one").morph.at(-1)).toBe(faceOf("one").path);
    expect(faceOf("one").morph[1]).not.toBe(faceOf("one").path);
    expect(botColor("one")).toBe(botColor("one"));
  });
});


it("offers conversation-preserving cleanup in the list view and marks kept history", async () => {
  await boot([
    session("live", "/repos/web", at(2), { worktreeName: "live", cwd: "/repos/web/.raccoon/worktrees/live" }),
    session("kept", "/repos/web", at(1), { worktreeRemoved: true, removedWorkspace: { name: "old", path: "/repos/web/.raccoon/worktrees/old", branch: "topic" } }),
  ]);
  mount();
  const kept = screen.getByRole("button", { name: "Talk kept" });
  expect(within(kept).getByText("removed")).toBeTruthy();
  expect(kept.closest("div[title]")?.getAttribute("title")).toContain("/repos/web/.raccoon/worktrees/old · workspace removed · resumes in /repos/web");
  fireEvent.pointerDown(screen.getByRole("button", { name: "Menu for Talk live" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
  expect(await screen.findByRole("menuitem", { name: "Remove workspace, keep conversations…" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Delete…" })).toBeTruthy();
});

describe("renaming a chat in the list", () => {
  it("opens Rename from a double-click, a right-click or the row's menu, with the developer's few actions beside it", async () => {
    await boot([session("a", "/repos/web", at(1), { branch: "dc/payments" })]);
    const { useDialogs, closeRenameSession } = await import("@/lib/dialogs");
    let opened: string | null = null;
    const Probe = () => {
      opened = useDialogs().renameSession;
      return null;
    };
    render(<Probe />);
    mount();
    const row = screen.getByRole("button", { name: "Talk a" });
    fireEvent.doubleClick(row);
    expect(opened).toBe("a");
    act(() => closeRenameSession());

    fireEvent.contextMenu(row);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual(["Rename…", "Pin", "Reveal in Finder", "Copy path", "Copy branch name", "Copy link", "Archive", "Delete…"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Rename/ }));
    expect(opened).toBe("a");
  });

  it("shows a branch by the label it was given", async () => {
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args?: { sessionIds?: string[] }) =>
      command === "list_projects" ? { projects: [{ ...projects[0], branchLabels: { "dc/payments": "Payments" } }], lastSelected: null } : base(command, args),
    );
    await boot([session("a", "/repos/web", at(1), { branch: "dc/payments" })]);
    mount();
    expect(screen.getByTestId("chat-preview").textContent).toBe("web · Payments");
  });
});
