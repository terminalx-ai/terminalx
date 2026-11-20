import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Bot } from "@/types/bots";
import type { SessionEntry } from "@/types/session";

const mocks = vi.hoisted(() => ({
  bots: { loaded: true, bots: [] as Bot[], revision: 1, unreadable: 0, error: null as string | null, templates: null },
  sessions: { sessions: [] as SessionEntry[], harnesses: [{ id: "claude", name: "Claude Code" }] },
  selectSession: vi.fn(),
  upsertSession: vi.fn(),
  pauseBot: vi.fn(async () => undefined),
  resumeBot: vi.fn(async () => undefined),
  homeChat: vi.fn(),
  newChat: vi.fn(),
  dismissResume: vi.fn(async () => undefined),
  spentToday: vi.fn(async () => ({ usd: 3.5, day: "2026-11-20" })),
}));

vi.mock("@/lib/bots", () => ({ useBotStore: () => mocks.bots, pauseBot: mocks.pauseBot, resumeBot: mocks.resumeBot }));
vi.mock("@/lib/sessions", () => ({
  useSessionStore: () => mocks.sessions,
  selectSession: mocks.selectSession,
  upsertSession: mocks.upsertSession,
  conversationTitle: (session: SessionEntry) => session.title,
}));
vi.mock("@/lib/api", () => ({ botsApi: { homeChat: mocks.homeChat, newChat: mocks.newChat, dismissResume: mocks.dismissResume, spentToday: mocks.spentToday }, errorMessage: (error: unknown) => String(error) }));
vi.mock("@/components/session/SessionView", () => ({ SessionView: ({ session }: { session: SessionEntry }) => <div data-testid="session-view">{session.id}</div> }));
vi.mock("@/components/bots/BotDuties", () => ({ BotDuties: ({ bot }: { bot: Bot }) => <div data-testid="bot-duties">{bot.name}'s duties</div> }));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: ReactNode }) => children }));

const { BotView } = await import("./BotView");

const atlas: Bot = {
  id: "b1", slug: "atlas", name: "Atlas", roleTitle: "CTO", roleTemplateId: "cto", harness: "claude", model: "", access: "full", runsOn: "thisMac",
  reportsTo: "owner", worksIn: ["personal"], created: "2026-11-20T10:00:00Z", modified: "2026-11-20T10:00:00Z",
};
const session = (id: string, extra: Partial<SessionEntry> = {}): SessionEntry => ({
  id, kind: "quick", projectPath: `/scratch/${id}`, cwd: "/bots/b1", title: id, created: "2026-11-20T09:00:00Z", modified: "2026-11-20T09:00:00Z",
  archived: false, pinned: false, tabs: [], activeTab: null, ...extra,
} as SessionEntry);
const home = session("home", { bot: { id: "b1", home: true }, title: "Home chat" });
const other = session("other", { bot: { id: "b1" }, title: "Chat with Atlas" });
const started = session("started", { kind: undefined, projectPath: "/repo", parent: { sessionId: "home" }, title: "Fix the relay log" });

const view = (chatId: string | null = null) => render(<BotView botId="b1" chatId={chatId} sidebarOpen onToggleSidebar={() => {}} titlebarInset={78} />);

beforeEach(() => {
  mocks.bots = { loaded: true, bots: [atlas], revision: 1, unreadable: 0, error: null, templates: null };
  mocks.sessions = { sessions: [home, other, started], harnesses: [{ id: "claude", name: "Claude Code" }] };
  for (const mock of [mocks.selectSession, mocks.upsertSession, mocks.pauseBot, mocks.resumeBot, mocks.homeChat, mocks.newChat, mocks.dismissResume]) mock.mockClear();
});
afterEach(cleanup);

describe("a bot's view (PRO-468)", () => {
  it("has the bot's header and its five tabs, with only Chat filled", async () => {
    view();
    expect(screen.getByRole("heading", { name: "Atlas" })).toBeTruthy();
    expect(screen.getByText("CTO")).toBeTruthy();
    for (const chip of ["Claude Code", "This Mac", "Full access"]) expect(screen.getByText(chip, { exact: false })).toBeTruthy();
    expect(await screen.findByText("$3.50 today")).toBeTruthy();
    expect(mocks.spentToday).toHaveBeenCalledWith("b1");
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(["Home", "Chat", "Duties", "Role and memory", "Settings"]);
    expect(screen.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Duties" }));
    // Duties are filled since PRO-471.
    expect(screen.getByTestId("bot-duties").textContent).toBe("Atlas's duties");
    expect(screen.queryByTestId("session-view")).toBeNull();
  });

  it("lists its chats and the sessions they started, and shows the home chat first", () => {
    view();
    const chats = screen.getByRole("region", { name: "Chats with Atlas" });
    expect(within(chats).getAllByRole("button").map((row) => row.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("Home chat"), expect.stringContaining("Chat with Atlas")]));
    expect(within(screen.getByRole("region", { name: "Started by Atlas" })).getByText("Fix the relay log")).toBeTruthy();
    expect(screen.getByTestId("session-view").textContent).toContain("home");
    expect(mocks.homeChat).not.toHaveBeenCalled();
  });

  it("selects a chat of the bot, and opens a session one started here", () => {
    const { rerender } = view();
    fireEvent.click(screen.getByText("Chat with Atlas"));
    expect(mocks.selectSession).toHaveBeenCalledWith("other");
    rerender(<BotView botId="b1" chatId="other" sidebarOpen onToggleSidebar={() => {}} titlebarInset={78} />);
    expect(screen.getByTestId("session-view").textContent).toContain("other");
    fireEvent.click(screen.getByText("Fix the relay log"));
    expect(screen.getByTestId("session-view").textContent).toContain("started");
    expect(mocks.selectSession).toHaveBeenCalledTimes(1);
  });

  it("makes the home chat when there is none", async () => {
    mocks.sessions = { ...mocks.sessions, sessions: [] };
    mocks.homeChat.mockResolvedValue(home);
    view();
    expect(screen.getByText(/Opening the home chat/)).toBeTruthy();
    await waitFor(() => expect(mocks.upsertSession).toHaveBeenCalledWith(home));
    expect(mocks.homeChat).toHaveBeenCalledWith("b1");
  });

  it("says so, and stops waiting, when the home chat cannot be opened", async () => {
    mocks.sessions = { ...mocks.sessions, sessions: [] };
    mocks.homeChat.mockRejectedValue("The bot's home folder cannot be read.");
    view();
    expect(await screen.findByText(/home folder cannot be read/)).toBeTruthy();
    expect(screen.getByText(/The home chat could not be opened/)).toBeTruthy();
    expect(screen.queryByText(/Opening the home chat/)).toBeNull();
  });

  it("starts another chat and selects it", async () => {
    mocks.newChat.mockResolvedValue(other);
    view();
    fireEvent.click(screen.getByRole("button", { name: "New chat with Atlas" }));
    await waitFor(() => expect(mocks.selectSession).toHaveBeenCalledWith("other"));
    expect(mocks.upsertSession).toHaveBeenCalledWith(other);
  });

  it("still answers while paused, says so, and offers Resume", async () => {
    mocks.bots = { ...mocks.bots, bots: [{ ...atlas, paused: { at: new Date().toISOString(), by: "owner" } }] };
    view();
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Paused. Atlas still answers you here, in plan mode: it changes nothing and starts no sessions or runs");
    expect(screen.getByTestId("session-view").textContent).toContain("home");
    fireEvent.click(within(banner).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(mocks.resumeBot).toHaveBeenCalledWith("b1"));
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });

  it("asks the owner about a resume the command line asked for, and only Resume here applies it", async () => {
    mocks.bots = { ...mocks.bots, bots: [{ ...atlas, paused: { at: new Date().toISOString(), by: "owner" }, resumeRequest: { at: new Date().toISOString(), by: "cli" } }] };
    view();
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Resume Atlas? The terminalx command line asked to resume it. Only you can, here.");
    fireEvent.click(within(banner).getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(mocks.dismissResume).toHaveBeenCalledWith("b1"));
    expect(mocks.resumeBot).not.toHaveBeenCalled();
    fireEvent.click(within(banner).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(mocks.resumeBot).toHaveBeenCalledWith("b1"));
  });

  it("pauses from the header", async () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(mocks.pauseBot).toHaveBeenCalledWith("b1"));
  });

  it("shows a level a newer app wrote as it is, and acts on it as read and report", () => {
    mocks.bots = { ...mocks.bots, bots: [{ ...atlas, access: "someday", runsOn: "cloud:w1" }] };
    view();
    expect(screen.getByText("someday (read and report here)", { exact: false })).toBeTruthy();
    expect(screen.getByText("cloud:w1", { exact: false })).toBeTruthy();
  });

  it("never says a bot is gone when bots exist that cannot be read", () => {
    mocks.bots = { ...mocks.bots, bots: [], unreadable: 1 };
    view();
    expect(screen.getByText("This bot cannot be read by this version of TerminalX.")).toBeTruthy();
    mocks.bots = { ...mocks.bots, unreadable: 0 };
    cleanup();
    view();
    expect(screen.getByText("This bot is no longer here.")).toBeTruthy();
  });
});
