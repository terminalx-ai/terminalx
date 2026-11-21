import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/types/bots";
import type { BotItem, BotItemList, NeedsYou } from "@/types/botItems";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  answerQuestions: vi.fn(async () => undefined),
  confirm: vi.fn(async () => true),
  selectSession: vi.fn(),
  openBot: vi.fn(),
  sessions: [] as unknown[],
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  invoke: mocks.invoke,
  agent: { answerQuestions: mocks.answerQuestions },
  errorMessage: (error: unknown) => String(error),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, handler);
    return () => mocks.listeners.delete(name);
  }),
}));
vi.mock("@/lib/confirm", () => ({ confirmInApp: mocks.confirm }));
vi.mock("@/lib/sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sessions")>()),
  selectSession: mocks.selectSession,
  openBot: mocks.openBot,
  useSessionStore: () => ({ sessions: mocks.sessions, view: "bots", selectedBotId: null, selectedSessionId: null }),
}));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: ReactNode }) => children }));

const items = await import("@/lib/botItems");
const { BotHome } = await import("./BotHome");
const { BotItemPage, mayDoHere } = await import("./BotItemPage");
const { NeedsYouQueue, needsYouNote } = await import("./NeedsYouQueue");
const { waited, deliveryNote } = await import("./NeedsYou");

const atlas: Bot = {
  id: "b1", slug: "atlas", name: "Atlas", roleTitle: "CTO", roleTemplateId: "cto", harness: "claude", model: "", access: "full", runsOn: "thisMac",
  reportsTo: "owner", worksIn: ["personal"], created: "2026-11-20T10:00:00Z", modified: "2026-11-20T10:00:00Z",
};
const iris: Bot = { ...atlas, id: "b2", slug: "iris", name: "Iris", roleTitle: "UX designer", roleTemplateId: "ux-designer" };
const now = new Date().toISOString();

const item = (number: number, extra: Partial<BotItem> = {}): BotItem => ({
  number, title: `Item ${number}`, state: "planned", askedBy: "owner", addedBy: "b1", created: now, modified: now, spentUsd: 0, ...extra,
});
const asking = item(14, {
  title: "Move macOS CI to our own runner", state: "needsYou", summary: "Three pieces.",
  question: { text: "Approve the plan?", answers: ["Not now", "Approve and start", "Start, but ask before merging"], recommended: 1, asked: "2026-11-21T09:00:00Z" },
});
const working = item(12, { title: "Phase 2: merge main", state: "inProgress", doneMeans: [{ text: "merged", met: true }, { text: "tests pass", met: false }] });
const waiting = item(11, { title: "Pinned sessions on the phone", state: "waiting" });
const planned = item(10, { title: "Sort the open issues" });
const doneToday = item(9, { title: "Weekly status", state: "done", closed: now });
const asleep = item(8, { title: "Later", snoozedUntil: "2999-01-01T00:00:00Z" });
const future = item(7, { title: "From a newer build", state: "blocked" });

let list: BotItemList;
let needs: NeedsYou;

function route(command: string, args: Record<string, unknown> = {}) {
  switch (command) {
    case "bots_needs_you":
      return Promise.resolve(needs);
    case "bot_items":
      return Promise.resolve(args.id === "b1" ? list : { botId: args.id, revision: 1, items: [], unreadable: 0 });
    case "bot_item":
      return Promise.resolve({ ...(list.items.find((value) => value.number === args.number) ?? item(Number(args.number))), activity: [
        { at: "2026-11-21T12:48:00Z", by: "owner", kind: "gave", text: "You gave Atlas this work" },
        { at: "2026-11-21T12:49:00Z", by: "b1", kind: "comment", text: "Atlas noted", detail: "Split in two pieces" },
        { at: "2026-11-21T13:10:00Z", by: "owner", kind: "answered", text: "You answered “Approve and start”", detail: "Approve the plan?" },
      ] });
    case "bot_item_answer":
    case "bot_item_comment":
    case "bot_item_give":
    case "bot_item_stop":
      return Promise.resolve({ item: { ...asking, state: "inProgress", question: undefined }, delivery: { sent: true, sessionId: "home" } });
    default:
      return Promise.reject(new Error(`unexpected ${command}`));
  }
}

beforeEach(async () => {
  items.resetBotItemsForTests();
  mocks.listeners.clear();
  mocks.sessions = [];
  list = { botId: "b1", revision: 3, items: [asking, working, waiting, planned, doneToday, asleep, future], unreadable: 1 };
  needs = {
    entries: [
      { kind: "item", botId: "b1", at: asking.question!.asked, item: asking },
      { kind: "agentQuestion", botId: "b2", at: "2026-11-21T09:30:00Z", sessionId: "s2", tabId: "t2", requestId: "r2", sessionTitle: "Home chat",
        questions: [{ question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }] }] },
    ],
    counts: [{ botId: "b1", needsYou: 1, inProgress: 2 }, { botId: "b2", needsYou: 1, inProgress: 0 }],
  };
  for (const mock of [mocks.invoke, mocks.answerQuestions, mocks.confirm, mocks.selectSession, mocks.openBot]) mock.mockClear();
  mocks.invoke.mockImplementation(route);
  await items.bootBotItems();
});
afterEach(cleanup);

describe("a bot's Home tab (PRO-469, 23.01)", () => {
  it("shows what needs you, what is in progress and planned, and how much was done today or is snoozed", async () => {
    render(<BotHome bot={atlas} onOpenItem={() => {}} />);
    const needsYou = await screen.findByTestId("bot-home-needs-you");
    expect(within(needsYou).getByText("Approve the plan?")).toBeTruthy();
    // The recommended answer comes first, accented and labelled.
    const answers = within(needsYou).getAllByTestId("needs-you-answer");
    expect(answers.map((button) => button.textContent)).toEqual(["Approve and startrecommended", "Not now", "Start, but ask before merging"]);
    // Only this bot's questions.
    expect(within(needsYou).queryByText("Which database?")).toBeNull();
    const rows = (testId: string) => within(screen.getByTestId(testId)).queryAllByTestId("bot-item-row").map((row) => row.textContent);
    await waitFor(() => expect(rows("bot-home-in-progress")).toHaveLength(3));
    expect(rows("bot-home-in-progress").join("|")).toMatch(/Phase 2: merge main.*1 of 2.*Pinned sessions on the phone.*Waiting.*From a newer build.*blocked/);
    expect(rows("bot-home-planned")).toEqual([expect.stringContaining("Sort the open issues")]);
    expect(screen.getByTestId("bot-home-done").textContent).toContain("Done today · 1");
    expect(screen.getByTestId("bot-home-snoozed").textContent).toContain("Snoozed · 1");
    fireEvent.click(screen.getByTestId("bot-home-snoozed"));
    expect(screen.getByText("Later")).toBeTruthy();
    expect(screen.getByText(/1 item was saved by a newer TerminalX/)).toBeTruthy();
  });

  it("answers with a choice or with your own words, naming the question answered", async () => {
    render(<BotHome bot={atlas} onOpenItem={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Approve and start/ }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_item_answer", { id: "b1", number: 14, answer: 1, text: null, asked: "2026-11-21T09:00:00Z" }));
    fireEvent.click(screen.getByText("or reply…"));
    fireEvent.change(screen.getByLabelText("Your answer to Atlas"), { target: { value: "Only the Mac mini" } });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_item_answer", { id: "b1", number: 14, answer: null, text: "Only the Mac mini", asked: "2026-11-21T09:00:00Z" }));
    // Answering reads what needs you again.
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "bots_needs_you").length).toBeGreaterThan(1);
  });

  it("gives the bot work", async () => {
    render(<BotHome bot={atlas} onOpenItem={() => {}} />);
    fireEvent.click(screen.getByTestId("bot-give-work"));
    fireEvent.change(screen.getByLabelText("What should it do?"), { target: { value: "Weekly status for the owner" } });
    fireEvent.change(screen.getByLabelText("More about it"), { target: { value: "Fridays" } });
    fireEvent.click(screen.getByRole("button", { name: "Give work" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_item_give", { id: "b1", title: "Weekly status for the owner", summary: "Fridays" }));
    await waitFor(() => expect(screen.queryByTestId("bot-give-work-form")).toBeNull());
  });

  it("opens an item from its row", async () => {
    const open = vi.fn();
    render(<BotHome bot={atlas} onOpenItem={open} />);
    fireEvent.click(await screen.findByText("Sort the open issues"));
    expect(open).toHaveBeenCalledWith(10);
  });
});

describe("a work item's page (PRO-469, 23.09)", () => {
  it("shows its done means, activity, sessions and what the bot may do, and stops it when you confirm", async () => {
    mocks.sessions = [{ id: "worker", title: "Merge main into phase-2", created: now, modified: now, tabs: [] }, { id: "home", title: "Home chat", bot: { id: "b1", home: true }, created: now, modified: now, tabs: [] }];
    list.items = list.items.map((value) => (value.number === 12 ? { ...value, links: [{ kind: "session", target: "home" }, { kind: "session", target: "worker" }, { kind: "pullRequest", target: "#1398", title: "Merge main into phase-2" }], spentUsd: 2.1 } : value));
    render(<BotItemPage bot={atlas} number={12} onBack={() => {}} />);
    await screen.findByRole("heading", { name: "Phase 2: merge main" });
    const doneMeans = screen.getByTestId("bot-item-done-means");
    expect(within(doneMeans).getByText("1 of 2")).toBeTruthy();
    expect(within(doneMeans).getAllByTestId("bot-item-done-line").map((line) => line.dataset.met)).toEqual(["true", "false"]);
    await waitFor(() => expect(screen.getAllByTestId("bot-item-activity-row")).toHaveLength(3));
    const rows = screen.getAllByTestId("bot-item-activity-row");
    expect(rows.map((row) => row.dataset.by)).toEqual(["owner", "bot", "owner"]);
    // A bot's note is its own words; the owner's answer is the owner's.
    expect(within(rows[1]).getByText("Atlas's words · not an approval")).toBeTruthy();
    expect(within(rows[2]).getByText("your words")).toBeTruthy();
    expect(screen.getAllByText("$2.10", { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText(mayDoHere(atlas))).toBeTruthy();
    // Take it over opens the item's own session before the chat it came from.
    fireEvent.click(screen.getByTestId("bot-item-take-over"));
    expect(mocks.selectSession).toHaveBeenCalledWith("worker");
    fireEvent.click(screen.getByTestId("bot-item-stop"));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_item_stop", { id: "b1", number: 12 }));
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Stop item #12?", destructive: true }));
  });

  it("does nothing when you do not confirm the stop, and comments as you", async () => {
    mocks.confirm.mockResolvedValueOnce(false);
    render(<BotItemPage bot={atlas} number={12} onBack={() => {}} />);
    await screen.findByRole("heading", { name: "Phase 2: merge main" });
    fireEvent.click(screen.getByTestId("bot-item-stop"));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(mocks.invoke).not.toHaveBeenCalledWith("bot_item_stop", expect.anything());
    fireEvent.change(screen.getByLabelText("Comment, or tell Atlas what to change on this item"), { target: { value: "Keep it short" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_item_comment", { id: "b1", number: 12, text: "Keep it short" }));
  });
});

describe("Needs you across the bots", () => {
  it("lists every bot's question on the Bots page, with the recommended answer and Open, and answers a session's card", async () => {
    render(<NeedsYouQueue bots={[atlas, iris]} needs={needs} />);
    const queue = screen.getByTestId("bots-needs-you");
    expect(within(queue).getByRole("heading").textContent).toContain("2");
    const row = within(queue).getByTestId("needs-you-row");
    expect(within(row).getByTestId("needs-you-answer").textContent).toBe("Approve and startrecommended");
    fireEvent.click(within(row).getByTestId("needs-you-open"));
    expect(mocks.openBot).toHaveBeenCalledWith("b1");
    expect(items.getOpeningForTests()).toEqual({ botId: "b1", number: 14 });
    fireEvent.click(within(row).getByTestId("needs-you-answer"));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_item_answer", expect.objectContaining({ id: "b1", number: 14, answer: 1 })));
    // A question card open in Iris's session: opened from here.
    const card = within(queue).getByTestId("needs-you-agent-question");
    expect(card.textContent).toContain("Which database?");
    fireEvent.click(within(card).getByRole("button", { name: "Open" }));
    expect(mocks.selectSession).toHaveBeenCalledWith("s2");
  });

  it("counts from one answer, so every count agrees, and reads again when a bot's session changes state", async () => {
    await waitFor(() => expect(items.getNeedsForTests()).not.toBeNull());
    const read = items.getNeedsForTests();
    expect(items.needsYouCount(read, null)).toBe(2);
    expect(items.needsYouCount(read, "b1")).toBe(1);
    expect(items.needsYouOf(read, "b2").map((entry) => entry.kind)).toEqual(["agentQuestion"]);
    // A list change reads it again.
    needs = { entries: [], counts: [{ botId: "b1", needsYou: 0, inProgress: 3 }] };
    await act(async () => mocks.listeners.get("bot_items_changed")?.({ payload: { botId: "b1" } }));
    await waitFor(() => expect(items.needsYouCount(items.getNeedsForTests(), null)).toBe(0));
    // The sessions: only a change in a bot's session's tabs reads again.
    vi.useFakeTimers();
    try {
      const session = (status: string, bot = true) => ({ id: "s2", archived: false, ...(bot ? { bot: { id: "b2" } } : {}), tabs: [{ id: "t2", status }] }) as never;
      const before = mocks.invoke.mock.calls.length;
      items.noteBotSessions([session("in_progress")]);
      items.noteBotSessions([session("in_progress"), { id: "x", archived: false, tabs: [{ id: "t", status: "waiting" }] } as never]);
      vi.advanceTimersByTime(500);
      expect(mocks.invoke.mock.calls.length).toBe(before);
      items.noteBotSessions([session("waiting")]);
      vi.advanceTimersByTime(500);
      expect(mocks.invoke.mock.calls.length).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing and reads nothing once the switch is off", async () => {
    items.shutBotItems();
    mocks.invoke.mockClear();
    items.noteBotSessions([{ id: "s", archived: false, bot: { id: "b1" }, tabs: [{ id: "t", status: "waiting" }] } as never]);
    items.refreshNeedsYou();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(items.getNeedsForTests()).toBeNull();
  });

  it("words the waits, the oldest, a send that did not arrive, and snoozes", () => {
    const at = Date.parse("2026-11-21T10:00:00Z");
    expect(waited("2026-11-21T09:52:00Z", at)).toBe("8m");
    expect(waited("2026-11-21T08:00:00Z", at)).toBe("2h");
    expect(needsYouNote({ entries: [{ kind: "item", botId: "b1", at: "2026-11-21T09:34:00Z", item: asking }], counts: [] }, at)).toBe("oldest waiting 26 minutes");
    expect(needsYouNote(null)).toBe("Nothing waiting");
    expect(deliveryNote(atlas, { sent: true })).toBeNull();
    expect(deliveryNote(atlas, { sent: false, error: "the runtime is restarting" })).toContain("Recorded, but it could not be sent to Atlas's home chat: the runtime is restarting");
    expect(items.snoozed({ state: "planned", snoozedUntil: "2999-01-01T00:00:00Z" })).toBe(true);
    expect(items.snoozed({ state: "needsYou", snoozedUntil: "2999-01-01T00:00:00Z" })).toBe(false);
    expect(items.snoozed({ state: "planned", snoozedUntil: "2000-01-01T00:00:00Z" })).toBe(false);
  });
});
