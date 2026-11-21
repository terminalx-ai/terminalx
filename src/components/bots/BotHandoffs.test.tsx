import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/types/bots";
import type { BotItem } from "@/types/botItems";
import type { Handoff, HandoffList, TeamBrief } from "@/types/botHandoffs";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  openBot: vi.fn(),
  bots: [] as unknown[],
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  invoke: mocks.invoke,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, handler);
    return () => mocks.listeners.delete(name);
  }),
}));
vi.mock("@/lib/bots", () => ({ useBotStore: () => ({ loaded: true, bots: mocks.bots, revision: 1, unreadable: 0, error: null, templates: null }) }));
vi.mock("@/lib/sessions", () => ({ openBot: mocks.openBot }));
vi.mock("@/components/machines/MachineHostError", () => ({
  MachineHostError: ({ error, onRestarted }: { error: string; onRestarted: () => void }) => (
    <div role="alert">{error}<button type="button" onClick={onRestarted}>Restart runtime</button></div>
  ),
}));

const { HandoffCards, TeamBriefEditor, TeamBriefRow, BotReportsTo, HandToBot, chatHandoffs } = await import("./BotHandoffs");
const { handoffStateLabel } = await import("@/lib/botHandoffs");

const base: Bot = {
  id: "b1", slug: "atlas", name: "Atlas", roleTitle: "CTO", roleTemplateId: "cto", harness: "claude", model: "", access: "full", runsOn: "thisMac",
  reportsTo: "owner", worksIn: ["personal"], created: "2026-11-20T10:00:00Z", modified: "2026-11-20T10:00:00Z",
};
const atlas = base;
const sentry: Bot = { ...base, id: "b2", slug: "sentry", name: "Sentry", roleTitle: "Security auditor", roleTemplateId: "security-auditor", reportsTo: "b1" };
const iris: Bot = { ...base, id: "b3", slug: "iris", name: "Iris", roleTitle: "UX designer", roleTemplateId: "ux-designer", paused: { at: "2026-11-21T09:00:00Z", by: "owner" } as Bot["paused"] };

const handoff = (number: number, extra: Partial<Handoff> = {}): Handoff => ({
  number, from: "b1", to: "b2", by: "b1", title: `Hand-off ${number}`, state: "working", depth: 1, created: new Date().toISOString(),
  modified: new Date().toISOString(), started: new Date(Date.now() - 40_000).toISOString(), fromSession: "atlas-home", toSession: `sentry-work-${number}`,
  waitingMessages: 0, ...extra,
});

let list: HandoffList;
let brief: TeamBrief;

function route(command: string, args: Record<string, unknown> = {}) {
  switch (command) {
    case "bot_handoffs":
      return Promise.resolve(list);
    case "bot_handoff_stop":
      return Promise.resolve({ handoff: { ...list.handoffs[0], state: "stopped" } });
    case "bot_brief":
      return Promise.resolve(brief);
    case "bot_brief_write":
      brief = { ...brief, text: String(args.text), hash: "h2", lines: 1 };
      return Promise.resolve(brief);
    case "bot_item_hand":
      return Promise.resolve({ handoff: handoff(9, { by: "owner", fromItem: Number(args.number), to: String(args.to) }) });
    default:
      return Promise.reject(new Error(`unexpected ${command}`));
  }
}

beforeEach(() => {
  mocks.listeners.clear();
  mocks.bots = [atlas, sentry, iris];
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(route);
  mocks.openBot.mockClear();
  list = { revision: 1, waitingMessages: 0, unreadable: 0, handoffs: [] };
  brief = { text: "", hash: "h0", lines: 0, modified: "", outside: false, cut: false, unreadable: null, limit: 8192 };
});
afterEach(cleanup);

describe("hand-off cards in a bot's chat (23.04)", () => {
  it("show the scope, when the answer is due, both bots, the live state, and a Stop for the receiving bot only", async () => {
    list.handoffs = [
      handoff(3, { title: "Check the runner's secrets", scope: "Read only.", due: "before the run merges" }),
      handoff(2, { state: "answered", answer: { at: "2026-11-21T10:00:00Z", text: "No secret reaches the logs.", by: "b2" }, closed: "2026-11-21T10:00:00Z" }),
      handoff(1, { fromSession: "elsewhere", toSession: "elsewhere-too", title: "Not in this chat" }),
    ];
    render(<HandoffCards bot={atlas} chatId="atlas-home" />);
    const cards = await screen.findAllByTestId("bot-handoff-card");
    expect(cards).toHaveLength(2);
    const [open, answered] = cards;
    expect(within(open).getByText("Check the runner's secrets")).toBeTruthy();
    expect(within(open).getByTestId("bot-handoff-scope").textContent).toBe("Read only.");
    expect(open.textContent).toContain("answer due before the run merges");
    expect(open.textContent).toContain("Atlas asked Sentry");
    expect(within(open).getAllByTestId("bot-avatar").map((avatar) => avatar.dataset.role)).toEqual(["cto", "security-auditor"]);
    expect(within(open).getByTestId("bot-handoff-state").textContent).toMatch(/^Working · 4\ds$/);
    // The answer is labelled as a bot's words; a closed card has no Stop.
    expect(within(answered).getByTestId("bot-handoff-answer").textContent).toBe("Sentry · a bot's words, not an approval: No secret reaches the logs.");
    expect(within(answered).queryByTestId("bot-handoff-stop")).toBeNull();
    expect(screen.queryByText("Not in this chat")).toBeNull();

    fireEvent.click(within(open).getByTestId("bot-handoff-stop"));
    expect(within(open).getByTestId("bot-handoff-stop").textContent).toContain("Stop Sentry");
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_handoff_stop", { number: 3 }));
  });

  it("show a waiting hand-off for a paused bot, and a state a newer app wrote as itself, still stoppable", async () => {
    list.handoffs = [handoff(5, { to: "b3", state: "waiting", toSession: undefined }), handoff(4, { state: "escalated" })];
    render(<HandoffCards bot={atlas} chatId="atlas-home" />);
    const states = (await screen.findAllByTestId("bot-handoff-state")).map((state) => state.textContent);
    expect(states).toEqual(["Waiting · Iris is paused", "escalated"]);
    expect(screen.getAllByTestId("bot-handoff-stop")).toHaveLength(2);
  });

  it("a failed Stop says why, and tries again after the runtime restarts", async () => {
    list.handoffs = [handoff(3)];
    mocks.invoke.mockImplementation((command: string, args: Record<string, unknown>) => command === "bot_handoff_stop" ? Promise.reject(new Error("restart_required")) : route(command, args));
    render(<HandoffCards bot={atlas} chatId="atlas-home" />);
    fireEvent.click(await screen.findByTestId("bot-handoff-stop"));
    expect((await screen.findByRole("alert")).textContent).toContain("restart_required");
    mocks.invoke.mockImplementation(route);
    fireEvent.click(screen.getByText("Restart runtime"));
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "bot_handoff_stop")).toHaveLength(2));
  });

  it("read again when the hand-offs change, and stop listening once gone", async () => {
    const { unmount } = render(<HandoffCards bot={atlas} chatId="atlas-home" />);
    await waitFor(() => expect(mocks.listeners.has("bot_handoffs_changed")).toBe(true));
    expect(screen.queryByTestId("bot-handoff-cards")).toBeNull();
    list = { ...list, handoffs: [handoff(6)] };
    await act(async () => mocks.listeners.get("bot_handoffs_changed")!({ payload: { revision: 2 } }));
    expect(await screen.findByTestId("bot-handoff-card")).toBeTruthy();
    unmount();
    await waitFor(() => expect(mocks.listeners.has("bot_handoffs_changed")).toBe(false));
  });

  it("keep the open ones and only the last few closed", () => {
    const many = [handoff(9), ...Array.from({ length: 5 }, (_, n) => handoff(n + 1, { state: "answered" }))];
    expect(chatHandoffs(many, "atlas-home").map((value) => value.number)).toEqual([9, 1, 2]);
    expect(handoffStateLabel(handoff(1, { state: "failed", answer: { at: "", text: "x", by: "terminalx", failed: true } }), "Sentry")).toBe("Failed · not started");
    expect(handoffStateLabel(handoff(1, { state: "stopped", stoppedBy: "owner" }), "Sentry")).toBe("Stopped by you");
    expect(handoffStateLabel(handoff(1, { state: "failed", stoppedBy: "deleted", answer: { at: "", text: "x", by: "terminalx", failed: true } }), "a bot no longer here")).toBe("Failed · its bot was deleted");
  });
});

describe("the team brief (Every bot reads)", () => {
  it("saves the owner's text against the brief it started from, and keeps a draft a save could not take", async () => {
    brief = { ...brief, text: "Ask before anything leaves this Mac.\n", hash: "h1", lines: 1 };
    render(<><ul><TeamBriefRow selected={false} onOpen={() => {}} /></ul><TeamBriefEditor /></>);
    expect((await screen.findByTestId("bot-team-brief-row")).textContent).toContain("1 line");
    const box = screen.getByLabelText<HTMLTextAreaElement>("Team brief text");
    await waitFor(() => expect(box.value).toBe("Ask before anything leaves this Mac.\n"));
    expect(box.getAttribute("spellcheck")).toBe("false");
    mocks.invoke.mockImplementation((command: string, args: Record<string, unknown>) => command === "bot_brief_write" ? Promise.reject(new Error("person_required: restart the runtime")) : route(command, args));
    fireEvent.change(box, { target: { value: "Status updates go in a table." } });
    fireEvent.click(screen.getByTestId("bot-team-brief-save"));
    expect((await screen.findByRole("alert")).textContent).toContain("person_required");
    expect(box.value).toBe("Status updates go in a table.");
    // Brief re-read meanwhile: the draft stays; the retry after the restart still says what it started from.
    await act(async () => mocks.listeners.get("bot_brief_changed")!({ payload: {} }));
    expect(box.value).toBe("Status updates go in a table.");
    mocks.invoke.mockImplementation(route);
    fireEvent.click(screen.getByText("Restart runtime"));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_brief_write", { text: "Status updates go in a table.", expected: "h1" }));
  });

  it("says when the file was changed outside TerminalX", async () => {
    brief = { ...brief, text: "Push to main.\n", hash: "h9", lines: 1, outside: true };
    render(<><ul><TeamBriefRow selected onOpen={() => {}} /></ul><TeamBriefEditor /></>);
    expect((await screen.findByTestId("bot-team-brief-outside")).textContent).toContain("as information, not as your instruction");
    expect(screen.getByTestId("bot-team-brief-row").textContent).toContain("changed outside");
  });
});

describe("Reports to, on a bot's Home", () => {
  it("lists the bots that report to the lead with the hand-offs it gave each, and names a report's lead", async () => {
    list.handoffs = [handoff(3), handoff(2, { state: "answered" })];
    const { unmount } = render(<BotReportsTo bot={atlas} />);
    const section = await screen.findByTestId("bot-reports-to");
    expect(within(section).getByText("Reports to Atlas")).toBeTruthy();
    const report = within(section).getByTestId("bot-report");
    expect(report.textContent).toContain("Sentry");
    await waitFor(() => expect(report.textContent).toContain("1 hand-off"));
    fireEvent.click(report);
    expect(mocks.openBot).toHaveBeenCalledWith("b2");
    unmount();
    render(<BotReportsTo bot={sentry} />);
    expect(screen.getByTestId("bot-lead").textContent).toContain("Reports to Atlas");
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "bot_handoffs")).toHaveLength(1);
  });

  it("shows nothing for a bot with no line", () => {
    const { container } = render(<BotReportsTo bot={iris} />);
    expect(container.textContent).toBe("");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("Hand to another bot, on an item's page (23.09)", () => {
  const item: BotItem = { number: 14, title: "Move macOS CI", state: "inProgress", askedBy: "owner", addedBy: "b1", created: "", modified: "", spentUsd: 0 };

  it("hands the item with the owner's note to the bot they pick, and keeps the input when it fails", async () => {
    const handed = vi.fn();
    mocks.invoke.mockImplementationOnce(() => Promise.reject(new Error("restart_required: the window's proof")));
    render(<HandToBot bot={atlas} item={item} onClose={() => {}} onHanded={handed} />);
    const picker = screen.getByLabelText<HTMLSelectElement>("Bot to hand it to");
    expect(picker.value).toBe("b2");
    expect([...picker.options].map((option) => option.textContent)).toEqual(["Sentry · Security auditor", "Iris · UX designer (paused)"]);
    fireEvent.change(picker, { target: { value: "b3" } });
    expect(screen.getByTestId("bot-hand-form").textContent).toContain("once you resume it");
    fireEvent.change(screen.getByLabelText("Your note"), { target: { value: "Look at how this reads." } });
    fireEvent.change(screen.getByLabelText("When the answer is due"), { target: { value: "Friday" } });
    fireEvent.click(screen.getByTestId("bot-hand-submit"));
    expect((await screen.findByRole("alert")).textContent).toContain("restart_required");
    expect(screen.getByLabelText<HTMLTextAreaElement>("Your note").value).toBe("Look at how this reads.");
    fireEvent.click(screen.getByText("Restart runtime"));
    await waitFor(() => expect(handed).toHaveBeenCalled());
    expect(mocks.invoke).toHaveBeenLastCalledWith("bot_item_hand", { id: "b1", number: 14, to: "b3", note: "Look at how this reads.", due: "Friday" });
  });

  it("says so when there is no other bot", () => {
    mocks.bots = [atlas];
    render(<HandToBot bot={atlas} item={item} onClose={() => {}} onHanded={() => {}} />);
    expect(screen.getByTestId("bot-hand-none")).toBeTruthy();
  });
});
