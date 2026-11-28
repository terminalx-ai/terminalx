import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/icons", () => new Proxy({}, { has: () => true, get: (_, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : prop === "__esModule" ? true : (props: Record<string, unknown>) => <svg {...props} />) }));
import type { Bot } from "@/types/bots";
import type { BotItem, BotItemList, NeedsYou } from "@/types/botItems";
import type { Handoff, HandoffList } from "@/types/botHandoffs";

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
vi.mock("@/lib/localRuntime", () => ({ useLocalRuntime: () => ({ state: { state: "connected", epoch: "e1", generation: 1, view: 1 }, readAt: 0 }) }));

const items = await import("@/lib/botItems");

/** Put back after every test, failed or not (`afterEach` below). */
const layouts: (() => void)[] = [];

/** Lay out what jsdom does not: elements `cut` says hold more than they show are taller and wider than they are. */
function laidOut(cut: (element: HTMLElement) => boolean) {
  const proto = HTMLElement.prototype;
  const saved = ["scrollHeight", "clientHeight", "scrollWidth", "clientWidth"].map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const);
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get(this: HTMLElement) { return cut(this) ? 200 : 20; } });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get() { return 20; } });
  Object.defineProperty(proto, "scrollWidth", { configurable: true, get(this: HTMLElement) { return cut(this) ? 500 : 100; } });
  Object.defineProperty(proto, "clientWidth", { configurable: true, get() { return 100; } });
  layouts.push(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(proto, key, descriptor);
      else delete (proto as unknown as Record<string, unknown>)[key];
    }
  });
}
const { BotHome } = await import("./BotHome");
const { BotItemPage, mayDoHere } = await import("./BotItemPage");
const { NeedsYouQueue, needsYouNote } = await import("./NeedsYouQueue");
const { waited, undeliveredNote, ItemQuestionCard } = await import("./NeedsYou");

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
  question: { text: "Approve the plan?", answers: ["Not now", "Approve and start", "Start, but ask before merging"], recommended: 1, asked: "2026-11-21T09:00:00Z", id: "q14" },
});
const working = item(12, { title: "Phase 2: merge main", state: "inProgress", doneMeans: [{ text: "merged", met: true }, { text: "tests pass", met: false }] });
const waiting = item(11, { title: "Pinned sessions on the phone", state: "waiting" });
const planned = item(10, { title: "Sort the open issues" });
const doneToday = item(9, { title: "Weekly status", state: "done", closed: now });
const asleep = item(8, { title: "Later", snoozedUntil: "2999-01-01T00:00:00Z" });
const future = item(7, { title: "From a newer build", state: "blocked" });

let list: BotItemList;
let needs: NeedsYou;
/** Atlas's hand-offs, as the item's page reads them (PRO-540). */
let handoffs: HandoffList | Error;

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
        { at: "2026-11-21T13:10:00Z", by: "owner", kind: "chose", text: "You chose answer 2", detail: "Approve and start" },
      ] });
    case "bot_item_answer":
    case "bot_item_comment":
    case "bot_item_give":
    case "bot_item_stop":
    case "bot_item_resend":
    case "bot_item_reopen":
      return Promise.resolve({ item: { ...asking, state: "inProgress", question: undefined }, delivery: { sent: true, sessionId: "home" } });
    case "bot_handoffs":
      return handoffs instanceof Error ? Promise.reject(handoffs) : Promise.resolve(handoffs);
    case "bot_suggestions":
      return Promise.resolve({ suggestions: [], unreadable: 0, status: { lookAround: null, tidyMemory: null, paused: false, readOnly: false } });
    default:
      return Promise.reject(new Error(`unexpected ${command}`));
  }
}

beforeEach(async () => {
  items.resetBotItemsForTests();
  mocks.listeners.clear();
  mocks.sessions = [];
  handoffs = { revision: 1, handoffs: [], waitingMessages: 0, unreadable: 0 };
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
afterEach(() => {
  cleanup();
  while (layouts.length) layouts.pop()!();
});

describe("a bot's Home tab (PRO-469, 23.01)", () => {
  it("shows what needs you, what is in progress and planned, and how much was done today or is snoozed", async () => {
    render(<BotHome bot={atlas} onOpenItem={() => {}} />);
    const needsYou = await screen.findByTestId("bot-home-needs-you");
    expect(within(needsYou).getByText("Approve the plan?")).toBeTruthy();
    // The answers in the bot's own order, the recommended one accented and labelled.
    const answers = within(needsYou).getAllByTestId("needs-you-answer");
    // In the bot's own order and numbered, the recommended one marked where it stands.
    expect(answers.map((button) => button.textContent)).toEqual(["1Not now", "2Approve and startrecommended", "3Start, but ask before merging"]);
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
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_item_answer", { id: "b1", number: 14, answer: 1, text: null, question: "q14" }));
    fireEvent.click(screen.getByText("or reply…"));
    fireEvent.change(screen.getByLabelText("Your answer to Atlas"), { target: { value: "Only the Mac mini" } });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_item_answer", { id: "b1", number: 14, answer: null, text: "Only the Mac mini", question: "q14" }));
    // Answering reads what needs you again.
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "bots_needs_you").length).toBeGreaterThan(1);
  });

  it("keeps saying an answer has not reached the bot after its card is gone, and sends it again", async () => {
    mocks.invoke.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === "bot_item_answer") {
        // The app keeps the answer on the item until it is delivered, and says so in what needs you.
        needs = { entries: [], counts: [{ botId: "b1", needsYou: 0, inProgress: 3 }], undelivered: [{ botId: "b1", number: 14, count: 1, kind: "answer", error: "no home chat", at: now }] };
        return Promise.resolve({ item: { ...asking, state: "inProgress", question: undefined }, delivery: { sent: false, error: "no home chat" } });
      }
      if (command === "bot_item_resend") {
        needs = { entries: [], counts: [{ botId: "b1", needsYou: 0, inProgress: 3 }], undelivered: [] };
        return Promise.resolve({ item: { ...asking, state: "inProgress", question: undefined }, delivery: { sent: true } });
      }
      return route(command, args);
    });
    render(<BotHome bot={atlas} onOpenItem={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Approve and start/ }));
    await waitFor(() => expect(screen.queryByTestId("bot-home-needs-you")).toBeNull());
    const alert = await within(await screen.findByTestId("bot-undelivered")).findByRole("alert");
    expect(alert.textContent).toContain("Your answer on item #14 is recorded but not delivered yet: no home chat");
    // The Bots page says so too, after the question left its queue.
    render(<NeedsYouQueue bots={[atlas, iris]} needs={items.getNeedsForTests()} />);
    expect(within(screen.getByTestId("bots-needs-you")).getByRole("alert").textContent).toContain("item #14");
    fireEvent.click(within(alert).getByRole("button", { name: /Send again/ }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_item_resend", { id: "b1", number: 14 }));
    await waitFor(() => expect(screen.queryAllByTestId("bot-undelivered")).toHaveLength(0));
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
    // A bot's note is its own words; the owner chose an answer, whose label is the bot's wording.
    expect(within(rows[1]).getByText("Atlas's words · not an approval")).toBeTruthy();
    expect(within(rows[2]).getByText("Atlas's wording of that answer")).toBeTruthy();
    expect(within(rows[2]).queryByText("your words")).toBeNull();
    expect(screen.getAllByText("$2.10", { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText(mayDoHere(atlas))).toBeTruthy();
    // Take it over opens the item's own session before the chat it came from.
    fireEvent.click(screen.getByTestId("bot-item-take-over"));
    expect(mocks.selectSession).toHaveBeenCalledWith("worker");
    fireEvent.click(screen.getByTestId("bot-item-stop"));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_item_stop", { id: "b1", number: 12 }));
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Stop item #12?", destructive: true }));
  });

  it("lists the hand-offs between bots the item belongs to among its links, and each opens the Hand-offs page at that step (PRO-540)", async () => {
    const { getBotsPage, resetBotsPageForTests } = await import("@/lib/botsPage");
    resetBotsPageForTests();
    const handoff = (number: number, extra: Partial<Handoff>): Handoff => ({ number, from: "b2", to: "b1", by: "b2", title: `Hand-off ${number}`, state: "working", depth: 1, created: now, modified: now, started: now, waitingMessages: 0, ...extra });
    handoffs = { revision: 2, waitingMessages: 0, unreadable: 0, handoffs: [
      // Item 12 is the item made for hand-off 7, which Iris gave Atlas; the owner handed item 12 on to Iris as 9.
      handoff(9, { from: "b1", to: "b2", by: "owner", fromItem: 12, state: "answered" }),
      handoff(8, { item: 11 }),
      handoff(7, { item: 12 }),
      // Iris's own item 12 is not Atlas's.
      handoff(6, { from: "b1", to: "b2", by: "b1", item: 12 }),
    ] };
    render(<BotItemPage bot={atlas} number={12} onBack={() => {}} />);
    await screen.findByRole("heading", { name: "Phase 2: merge main" });
    const links = within(screen.getByRole("region", { name: "Sessions and links" }));
    const rows = await links.findAllByTestId("bot-item-handoff-link");
    expect(rows.map((row) => row.dataset.number)).toEqual(["7", "9"]);
    expect(rows[0].textContent).toMatch(/^Hand-off 7 · from a bot no longer hereWorking · /);
    expect(rows[1].textContent).toBe("Hand-off 9 · to a bot no longer hereAnswered");
    expect(links.queryByText("None yet.")).toBeNull();
    fireEvent.click(rows[0]);
    expect(getBotsPage()).toEqual({ page: "handoffs", number: 7 });
    fireEvent.click(rows[1]);
    expect(getBotsPage()).toEqual({ page: "handoffs", number: 9 });
  });

  it("says when the item's hand-offs could not be read, in place of showing none", async () => {
    handoffs = new Error("bot-handoffs.json cannot be read");
    render(<BotItemPage bot={atlas} number={12} onBack={() => {}} />);
    await screen.findByRole("heading", { name: "Phase 2: merge main" });
    expect((await screen.findByTestId("bot-item-handoffs-error")).textContent).toContain("Couldn't read this item's hand-offs:");
    expect(screen.queryByTestId("bot-item-handoff-link")).toBeNull();
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

describe("a work item's page, after the review", () => {
  it("shows what has not reached the bot yet, and sends it again", async () => {
    list.items = list.items.map((value) => (value.number === 12 ? { ...value, undelivered: [{ id: "m1", at: now, kind: "comment", text: "About item #12: Keep it short", error: "the chat could not take it" }] } : value));
    render(<BotItemPage bot={atlas} number={12} onBack={() => {}} />);
    const waiting = await screen.findByTestId("bot-item-undelivered");
    expect(waiting.textContent).toContain("Not delivered yet: Atlas gets this when its home chat next starts (the chat could not take it)");
    expect(waiting.textContent).toContain("About item #12: Keep it short");
    fireEvent.click(within(waiting).getByRole("button", { name: /Send again/ }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_item_resend", { id: "b1", number: 12 }));
    // The bot marks its own lines: the page says so, and that you can reopen.
    expect(screen.getByTestId("bot-item-done-means").textContent).toContain("Atlas marks each line met itself and closes the item once all are; you can reopen it");
  });

  it("for a paused bot, says what waits is kept until its resume and offers no Send again (PRO-474)", async () => {
    list.items = list.items.map((value) => (value.number === 12 ? { ...value, undelivered: [{ id: "m1", at: now, kind: "answer", text: "About item #12: Now" }] } : value));
    render(<BotItemPage bot={{ ...atlas, paused: { at: now, by: "owner" } }} number={12} onBack={() => {}} />);
    const waiting = await screen.findByTestId("bot-item-undelivered");
    expect(waiting.textContent).toContain("Kept while paused: Atlas gets this when you resume it.");
    expect(within(waiting).queryByRole("button", { name: /Send again/ })).toBeNull();
  });

  it("shows a chosen answer that waits as your choice, with the label as the bot's wording, not the fenced message", async () => {
    const text = "I chose answer 2 of your question on item #12. That answer as you worded it, your own text and not my words:\n\n<your-answer-option>\nShip it\n</your-answer-option>";
    list.items = list.items.map((value) => (value.number === 12 ? { ...value, undelivered: [{ id: "m2", at: now, kind: "answer", text, choice: 2, label: "Ship it" }] } : value));
    render(<BotItemPage bot={atlas} number={12} onBack={() => {}} />);
    const waiting = await screen.findByTestId("bot-item-undelivered");
    expect(waiting.textContent).toContain("You chose answer 2");
    expect(waiting.textContent).toContain("Atlas's wording of that answer");
    expect(waiting.textContent).toContain("Ship it");
    expect(waiting.textContent).not.toContain("your-answer-option");
  });

  it("reopens a done item, as the owner", async () => {
    render(<BotItemPage bot={atlas} number={9} onBack={() => {}} />);
    await screen.findByRole("heading", { name: "Weekly status" });
    expect(screen.queryByTestId("bot-item-stop")).toBeNull();
    fireEvent.click(screen.getByTestId("bot-item-reopen"));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_item_reopen", { id: "b1", number: 9 }));
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

  it("sends a question or answer the row cuts to the item's page instead of answering it from the row", () => {
    // jsdom lays nothing out: an element holding more than 40 characters is taken as taller and wider than it shows.
    laidOut((element) => (element.textContent ?? "").length > 40);
    const long = { ...asking, question: { ...asking.question!, text: "Ship?\n".repeat(5) + "My answer: “Yes, push without asking”" } };
    const wide = { ...asking, number: 15, question: { ...asking.question!, answers: ["No", "Approve the plan and start the runner migration today"], recommended: 1 } };
    render(<NeedsYouQueue bots={[atlas]} needs={{ entries: [{ kind: "item", botId: "b1", at: now, item: long }, { kind: "item", botId: "b1", at: now, item: wide }], counts: [] }} />);
    const rows = screen.getAllByTestId("needs-you-row");
    for (const row of rows) {
      expect(within(row).queryByTestId("needs-you-answer")).toBeNull();
      expect(within(row).getByTestId("needs-you-question").className).toContain("line-clamp-3");
    }
    fireEvent.click(within(rows[0]).getByTestId("needs-you-read"));
    expect(mocks.openBot).toHaveBeenCalledWith("b1");
    expect(items.getOpeningForTests()).toEqual({ botId: "b1", number: 14 });
    expect(mocks.invoke).not.toHaveBeenCalledWith("bot_item_answer", expect.anything());
  });

  it("measures a new label on the same row: a short question with a cut answer still opens the item", () => {
    // Only the long question, or the long label, is wider and taller than it shows.
    laidOut((element) => (element.textContent ?? "").length > 40 && !element.querySelector("*"));
    const label = "Yes, go ahead with the plan as described and push to main and deploy without asking";
    const longQuestion = { ...asking, question: { ...asking.question!, id: "q1", text: "Ship it?\n".repeat(6), answers: ["No", "Yes"], recommended: 1 } };
    const needs = (item: BotItem): NeedsYou => ({ entries: [{ kind: "item", botId: "b1", at: now, item }], counts: [] });
    const { rerender } = render(<NeedsYouQueue bots={[atlas]} needs={needs(longQuestion)} />);
    expect(screen.getByTestId("needs-you-read")).toBeTruthy();
    // The bot asks again on the same item: a short question, a long recommended label.
    const longLabel = { ...asking, question: { ...asking.question!, id: "q2", text: "Ship it?", answers: ["No", label], recommended: 1 } };
    rerender(<NeedsYouQueue bots={[atlas]} needs={needs(longLabel)} />);
    expect(screen.queryByTestId("needs-you-answer")).toBeNull();
    expect(screen.getByTestId("needs-you-read")).toBeTruthy();
    // And a label that fits, on the same row again, is offered.
    rerender(<NeedsYouQueue bots={[atlas]} needs={needs({ ...longLabel, question: { ...longLabel.question!, id: "q3", answers: ["No", "Yes"] } })} />);
    expect(screen.getByTestId("needs-you-answer").textContent).toContain("Yes");
  });

  it("answers from the row when it shows the question and answer whole, as measured", () => {
    laidOut(() => false);
    const long = { ...asking, question: { ...asking.question!, text: "Ship?\n".repeat(5) } };
    render(<NeedsYouQueue bots={[atlas]} needs={{ entries: [{ kind: "item", botId: "b1", at: now, item: long }], counts: [] }} />);
    expect(screen.getByTestId("needs-you-answer")).toBeTruthy();
  });

  it("clamps a long question on its card, with Show all, and shows its answers whole", async () => {
    laidOut((element) => element.tagName === "P" && (element.textContent ?? "").length > 30);
    const text = "Line\n".repeat(8) + "the end";
    const label = "Yes, go ahead with the plan as described and also push to main and deploy without asking again";
    render(<ItemQuestionCard bot={atlas} item={{ ...asking, question: { ...asking.question!, text, answers: ["No", label], recommended: 1 } }} />);
    const shown = screen.getByTestId("needs-you-question");
    expect(shown.className).toContain("line-clamp-4");
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(shown.className).not.toContain("line-clamp-4");
    const buttons = screen.getAllByTestId("needs-you-answer");
    // In the bot's own order, numbered as it numbered them.
    expect(buttons.map((value) => value.textContent?.slice(0, 1))).toEqual(["1", "2"]);
    const button = buttons[1];
    expect(button.textContent).toContain(label);
    expect(button.className).toContain("whitespace-normal");
    expect(button.querySelector(".truncate")).toBeNull();
  });

  it("shows a read that failed as an error, not as nothing waiting, and offers a restart to an older runtime", async () => {
    render(<NeedsYouQueue bots={[atlas, iris]} needs={null} error="the runtime is busy" />);
    expect(screen.getByTestId("bots-needs-you-error").textContent).toContain("the runtime is busy");
    expect(screen.queryByText(/Nothing needs you/)).toBeNull();
    cleanup();
    render(<NeedsYouQueue bots={[atlas, iris]} needs={null} error="Unknown bots operation needsYou" />);
    expect(screen.getByRole("button", { name: /Restart runtime/ })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("older than this app");
    cleanup();
    // One bot's list cannot be read: said for that bot, and its count is not taken for zero.
    const broken: NeedsYou = { entries: [], counts: [{ botId: "b1", needsYou: 0, inProgress: 0 }, { botId: "b2", needsYou: 0, inProgress: 0, error: "items.json cannot be read" }] };
    render(<NeedsYouQueue bots={[atlas, iris]} needs={broken} />);
    expect(screen.getByTestId("bots-needs-you-unread").textContent).toContain("Couldn't read Iris's work list");
    expect(items.needsYouTrouble(broken, null, "b2")).toContain("cannot be read");
    expect(items.needsYouTrouble(broken, null, "b1")).toBeNull();
    expect(items.needsYouTrouble(null, "failed", "b1")).toBe("failed");
    // A failed read is kept in the store for every badge.
    mocks.invoke.mockImplementation((command: string, args: Record<string, unknown>) => (command === "bots_needs_you" ? Promise.reject(new Error("the runtime is busy")) : route(command, args)));
    items.refreshNeedsYou();
    await waitFor(() => expect(items.getNeedsErrorForTests()).toContain("the runtime is busy"));
  });

  it("offers no one-click answer on the Bots page when the bot recommends none", () => {
    const open = { ...asking, question: { ...asking.question!, recommended: undefined } };
    render(<NeedsYouQueue bots={[atlas]} needs={{ entries: [{ kind: "item", botId: "b1", at: now, item: open }], counts: [] }} />);
    const row = screen.getByTestId("needs-you-row");
    expect(within(row).queryByTestId("needs-you-answer")).toBeNull();
    expect(within(row).getByTestId("needs-you-choose").textContent).toBe("3 answers · open to choose");
    expect(within(row).getByTestId("needs-you-open")).toBeTruthy();
  });

  it("counts from one answer, so every count agrees, and reads again when a bot's session changes state", async () => {
    await waitFor(() => expect(items.getNeedsForTests()).not.toBeNull());
    const read = items.getNeedsForTests();
    expect(items.needsYouCount(read, null)).toBe(2);
    expect(items.needsYouCount(read, "b1")).toBe(1);
    expect(items.needsYouOf(read, "b2").map((entry) => entry.kind)).toEqual(["agentQuestion"]);
    // A list change reads it again; many changes at once are one read.
    needs = { entries: [], counts: [{ botId: "b1", needsYou: 0, inProgress: 3 }] };
    const reads = () => mocks.invoke.mock.calls.filter(([command]) => command === "bots_needs_you").length;
    const first = reads();
    await act(async () => {
      for (let n = 0; n < 50; n++) mocks.listeners.get("bot_items_changed")?.({ payload: { botId: "b1" } });
    });
    await waitFor(() => expect(items.needsYouCount(items.getNeedsForTests(), null)).toBe(0));
    expect(reads() - first).toBe(1);
    // The bots changing reads it again too.
    needs = { entries: [], counts: [{ botId: "b1", needsYou: 0, inProgress: 3 }, { botId: "b3", needsYou: 2, inProgress: 0 }] };
    await act(async () => mocks.listeners.get("bots_changed")?.({ payload: {} }));
    await waitFor(() => expect(items.needsYouCount(items.getNeedsForTests(), null)).toBe(2));
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

  it("keeps a reply or comment typed and not sent across pages, and forgets it once sent (PRO-493)", async () => {
    const first = render(<BotHome bot={atlas} onOpenItem={() => {}} />);
    await screen.findByRole("button", { name: /Approve and start/ });
    fireEvent.click(screen.getByText("or reply…"));
    fireEvent.change(screen.getByLabelText("Your answer to Atlas"), { target: { value: "Only the Mac" } });
    first.unmount();
    const page = render(<BotItemPage bot={atlas} number={12} onBack={() => {}} />);
    await screen.findByRole("heading", { name: "Phase 2: merge main" });
    fireEvent.change(screen.getByLabelText("Comment, or tell Atlas what to change on this item"), { target: { value: "Keep it short" } });
    page.unmount();
    // Back on Home: the reply box is open again with what was typed.
    const home = render(<BotHome bot={atlas} onOpenItem={() => {}} />);
    expect(((await screen.findByLabelText("Your answer to Atlas")) as HTMLInputElement).value).toBe("Only the Mac");
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_item_answer", expect.objectContaining({ text: "Only the Mac" })));
    home.unmount();
    // A new question on the item starts with an empty box.
    render(<ItemQuestionCard bot={atlas} item={{ ...asking, question: { ...asking.question!, id: "q-new" } }} />);
    expect(screen.queryByLabelText("Your answer to Atlas")).toBeNull();
    cleanup();
    // The comment is back on the item's page, and gone once sent.
    const again = render(<BotItemPage bot={atlas} number={12} onBack={() => {}} />);
    await screen.findByRole("heading", { name: "Phase 2: merge main" });
    const box = screen.getByLabelText("Comment, or tell Atlas what to change on this item") as HTMLInputElement;
    expect(box.value).toBe("Keep it short");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(box.value).toBe(""));
    again.unmount();
    render(<BotItemPage bot={atlas} number={12} onBack={() => {}} />);
    await screen.findByRole("heading", { name: "Phase 2: merge main" });
    expect((screen.getByLabelText("Comment, or tell Atlas what to change on this item") as HTMLInputElement).value).toBe("");
  });

  it("puts Read and answer in the same grid cell as the answer it stands in for (PRO-493)", () => {
    laidOut((element) => (element.textContent ?? "").length > 40);
    const cut = { ...asking, question: { ...asking.question!, text: "Ship?\n".repeat(5) + "Say which one, and why, before I start.", answers: ["N", "Y"], recommended: 1 } };
    render(<NeedsYouQueue bots={[atlas]} needs={{ entries: [{ kind: "item", botId: "b1", at: now, item: cut }], counts: [] }} />);
    const cell = screen.getByTestId("needs-you-answer-cell");
    expect(cell.className).toContain("inline-grid");
    for (const button of [within(cell).getByTestId("needs-you-read"), within(cell).getByTestId("needs-you-answer-measured")]) {
      expect(button.className).toContain("col-start-1");
      expect(button.className).toContain("row-start-1");
      expect(button.className).not.toContain("absolute");
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
    expect(undeliveredNote(atlas, { number: 14, kind: "answer", count: 1, error: "the runtime is restarting" })).toBe(
      "Your answer on item #14 is recorded but not delivered yet: the runtime is restarting. Atlas gets it when its home chat next starts, or send again now.",
    );
    expect(undeliveredNote(atlas, { number: 3, kind: "comment", count: 2, error: "" })).toContain("2 of your messages on item #3 are recorded");
    expect(items.snoozed({ state: "planned", snoozedUntil: "2999-01-01T00:00:00Z" })).toBe(true);
    expect(items.snoozed({ state: "needsYou", snoozedUntil: "2999-01-01T00:00:00Z" })).toBe(false);
    expect(items.snoozed({ state: "planned", snoozedUntil: "2000-01-01T00:00:00Z" })).toBe(false);
  });
});
