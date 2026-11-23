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

const { HandoffStrip, TeamBriefEditor, TeamBriefRow, BotReportsTo, HandToBot, chatHandoffs } = await import("./BotHandoffs");
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
    case "bot_handoff_resend":
      list = { ...list, undelivered: (list.undelivered ?? []).filter((message) => message.id !== args.message) };
      return Promise.resolve({ delivery: { sent: 1 } });
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

describe("the strip of open hand-offs above a bot's chat (PRO-520)", () => {
  it("show an open hand-off as one line: both bots, the title, the live state and a Stop for the receiving bot only; never its scope, when it is due or an answer", async () => {
    list.handoffs = [
      handoff(3, { title: "Check the runner's secrets", scope: "Read only.", due: "before the run merges" }),
      handoff(2, { state: "answered", title: "Look at the relay token", answer: { at: "2026-11-21T10:00:00Z", text: "No secret reaches the logs.", by: "b2" }, closed: "2026-11-21T10:00:00Z" }),
      handoff(1, { fromSession: "elsewhere", toSession: "elsewhere-too", title: "Not in this chat" }),
    ];
    render(<HandoffStrip bot={atlas} chatId="atlas-home" />);
    const lines = await screen.findAllByTestId("bot-handoff-line");
    expect(lines).toHaveLength(1);
    const [open] = lines;
    const title = within(open).getByText("Check the runner's secrets");
    expect(title.title).toBe("Check the runner's secrets");
    expect(title.className).toContain("truncate");
    expect(within(open).getAllByTestId("bot-avatar").map((avatar) => avatar.dataset.role)).toEqual(["cto", "security-auditor"]);
    expect(within(open).getByTestId("bot-handoff-state").textContent).toMatch(/^Working · 4\ds$/);
    expect(within(open).getByTestId("bot-handoff-state").querySelector(".animate-spin")).toBeTruthy();
    // The line is the avatars, the title, the state and Stop, and nothing else: no scope, no "#N · asked · due" line.
    expect(open.textContent).toMatch(/^Check the runner's secretsWorking · 4\ds\s*Stop Sentry$/);
    const strip = screen.getByTestId("bot-handoff-cards");
    expect(screen.queryByTestId("bot-handoff-scope")).toBeNull();
    expect(strip.textContent).not.toContain("Read only.");
    expect(strip.textContent).not.toContain("before the run merges");
    expect(strip.textContent).not.toContain("Atlas asked Sentry");
    expect(strip.textContent).not.toContain("#3");
    // The answered one is not listed at all: no line, no answer, no Stop of its own.
    expect(screen.queryByTestId("bot-handoff-answer")).toBeNull();
    expect(strip.textContent).not.toContain("Look at the relay token");
    expect(strip.textContent).not.toContain("No secret reaches the logs.");
    expect(strip.textContent).not.toContain("Answered");
    expect(screen.getAllByTestId("bot-handoff-stop")).toHaveLength(1);
    expect(screen.queryByText("Not in this chat")).toBeNull();

    fireEvent.click(within(open).getByTestId("bot-handoff-stop"));
    expect(within(open).getByTestId("bot-handoff-stop").textContent).toContain("Stop Sentry");
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_handoff_stop", { number: 3 }));
  });

  it("show nothing above the chat for an answered, a failed and a stopped hand-off", async () => {
    list.handoffs = [
      handoff(4, { state: "answered", title: "Answered work", scope: "Its scope.", answer: { at: "2026-11-21T10:00:00Z", text: "Done.", by: "b2" }, closed: "2026-11-21T10:00:00Z" }),
      handoff(3, { state: "failed", title: "Failed work", answer: { at: "2026-11-21T10:00:00Z", text: "Could not start.", by: "terminalx", failed: true }, closed: "2026-11-21T10:00:00Z" }),
      handoff(2, { state: "stopped", title: "Stopped work", stoppedBy: "owner", closed: "2026-11-21T10:00:00Z" }),
    ];
    const { container } = render(<HandoffStrip bot={atlas} chatId="atlas-home" />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_handoffs", { id: "b1" }));
    await act(async () => {});
    expect(container.textContent).toBe("");
    expect(container.childElementCount).toBe(0);
    expect(screen.queryByTestId("bot-handoff-cards")).toBeNull();
    expect(screen.queryByTestId("bot-handoff-line")).toBeNull();
    // One still open beside them is the only line.
    list = { ...list, handoffs: [handoff(5, { title: "Open work" }), ...list.handoffs] };
    await act(async () => mocks.listeners.get("bot_handoffs_changed")!({ payload: { revision: 2 } }));
    expect((await screen.findAllByTestId("bot-handoff-line")).map((line) => line.dataset.state)).toEqual(["working"]);
    expect(screen.getByTestId("bot-handoff-cards").textContent).not.toMatch(/Answered|Failed|Stopped|Done\.|Could not start\./);
  });

  it("show a waiting hand-off for a paused bot, and a state a newer app wrote as itself, still stoppable", async () => {
    list.handoffs = [handoff(5, { to: "b3", state: "waiting", toSession: undefined }), handoff(4, { state: "escalated" })];
    render(<HandoffStrip bot={atlas} chatId="atlas-home" />);
    const states = (await screen.findAllByTestId("bot-handoff-state")).map((state) => state.textContent);
    expect(states).toEqual(["Waiting · Iris is paused", "escalated"]);
    expect(screen.getAllByTestId("bot-handoff-stop")).toHaveLength(2);
    // Only a working one spins.
    expect(screen.getByTestId("bot-handoff-cards").querySelector("[data-testid=bot-handoff-state] .animate-spin")).toBeNull();
    expect(screen.queryByTestId("bot-handoff-waiting")).toBeNull();
  });

  it("say the messages waiting for an open hand-off's chat as a count beside its state, in full in the tooltips", async () => {
    list.handoffs = [handoff(5, { to: "b3", state: "waiting", toSession: undefined, waitingMessages: 2 }), handoff(4, { waitingMessages: 1 }), handoff(3)];
    render(<HandoffStrip bot={atlas} chatId="atlas-home" />);
    const [paused, one, none] = await screen.findAllByTestId("bot-handoff-line");
    const count = within(paused).getByTestId("bot-handoff-waiting");
    expect(count.textContent?.trim()).toBe("2");
    expect(count.getAttribute("aria-label")).toBe("2 messages wait for its chat to start");
    expect(count.title).toBe("2 messages wait for its chat to start.");
    // The state's own words stay as they were; its tooltip says the wait too.
    expect(within(paused).getByTestId("bot-handoff-state").textContent).toBe("Waiting · Iris is paused");
    expect(within(paused).getByTestId("bot-handoff-state").title).toBe("Waiting · Iris is paused · 2 messages wait for its chat to start");
    expect(within(one).getByTestId("bot-handoff-waiting").getAttribute("aria-label")).toBe("1 message waits for its chat to start");
    expect(within(none).queryByTestId("bot-handoff-waiting")).toBeNull();
    expect(within(none).getByTestId("bot-handoff-state").title).toMatch(/^Working · 4\ds$/);
  });

  it("a failed Stop says why, and tries again after the runtime restarts", async () => {
    list.handoffs = [handoff(3), handoff(2)];
    mocks.invoke.mockImplementation((command: string, args: Record<string, unknown>) => command === "bot_handoff_stop" ? Promise.reject(new Error("restart_required")) : route(command, args));
    render(<HandoffStrip bot={atlas} chatId="atlas-home" />);
    fireEvent.click((await screen.findAllByTestId("bot-handoff-stop"))[1]);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("restart_required");
    // Said in the strip, outside the lines that scroll, so it is never under their fold.
    expect(screen.getByTestId("bot-handoff-cards").contains(alert)).toBe(true);
    expect(screen.getByRole("list", { name: "Open hand-offs" }).contains(alert)).toBe(false);
    mocks.invoke.mockImplementation(route);
    fireEvent.click(screen.getByText("Restart runtime"));
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "bot_handoff_stop")).toEqual([["bot_handoff_stop", { number: 2 }], ["bot_handoff_stop", { number: 2 }]]));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("read again when the hand-offs change, and stop listening once gone", async () => {
    const { unmount } = render(<HandoffStrip bot={atlas} chatId="atlas-home" />);
    await waitFor(() => expect(mocks.listeners.has("bot_handoffs_changed")).toBe(true));
    expect(screen.queryByTestId("bot-handoff-cards")).toBeNull();
    list = { ...list, handoffs: [handoff(6)] };
    await act(async () => mocks.listeners.get("bot_handoffs_changed")!({ payload: { revision: 2 } }));
    expect(await screen.findByTestId("bot-handoff-line")).toBeTruthy();
    // Once it is answered its line leaves, and the strip with it.
    list = { ...list, handoffs: [handoff(6, { state: "answered", answer: { at: "2026-11-21T10:00:00Z", text: "Done.", by: "b2" } })] };
    await act(async () => mocks.listeners.get("bot_handoffs_changed")!({ payload: { revision: 3 } }));
    await waitFor(() => expect(screen.queryByTestId("bot-handoff-cards")).toBeNull());
    unmount();
    await waitFor(() => expect(mocks.listeners.has("bot_handoffs_changed")).toBe(false));
  });

  it("say a failed read, never showing it as no hand-offs, and read again after the runtime restarts (lead review 1)", async () => {
    mocks.invoke.mockImplementation((command: string, args: Record<string, unknown>) => command === "bot_handoffs" ? Promise.reject(new Error("runtime_unavailable")) : route(command, args));
    render(<HandoffStrip bot={atlas} chatId="atlas-home" />);
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't read Atlas's hand-offs: runtime_unavailable");
    expect(screen.getByTestId("bot-handoff-cards-error")).toBeTruthy();
    expect(screen.queryByText("Restart runtime")).toBeNull();
    list.handoffs = [handoff(3)];
    mocks.invoke.mockImplementation(route);
    fireEvent.click(screen.getByTestId("bot-handoffs-retry"));
    expect(await screen.findByTestId("bot-handoff-line")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offer Restart runtime, not Retry, for a read only a restart helps (lead review 2)", async () => {
    mocks.invoke.mockImplementation((command: string, args: Record<string, unknown>) => command === "bot_handoffs" ? Promise.reject(new Error("runtime_restart_required:e1: Restarting stops 2 agents.")) : route(command, args));
    render(<HandoffStrip bot={atlas} chatId="atlas-home" />);
    expect((await screen.findByRole("alert")).textContent).toContain("runtime_restart_required:e1");
    expect(screen.queryByTestId("bot-handoffs-retry")).toBeNull();
    list.handoffs = [handoff(3)];
    mocks.invoke.mockImplementation(route);
    fireEvent.click(screen.getByText("Restart runtime"));
    expect(await screen.findByTestId("bot-handoff-line")).toBeTruthy();
  });

  it("show an answer or a message that did not reach its chat, with a Resend, though the hand-off it is about is finished and not listed (lead review 1)", async () => {
    list.handoffs = [handoff(3, { state: "answered", answer: { at: "2026-11-21T10:00:00Z", text: "Done.", by: "b2" } })];
    list.undelivered = [
      { id: "m1", at: "2026-11-21T10:00:00Z", from: "b2", to: "b1", kind: "answer", handoff: 3, tries: 3, error: "the chat could not take the message", held: true },
      { id: "m2", at: "2026-11-21T10:01:00Z", from: "b2", to: "b1", kind: "tell", handoff: null, tries: 1, error: "the tab is gone", held: false },
    ];
    render(<HandoffStrip bot={atlas} chatId="atlas-home" />);
    const [answer, loose] = await screen.findAllByTestId("bot-handoff-undelivered-message");
    // The answered hand-off has no line; its undelivered answer shows as a loose message, never its text.
    expect(screen.queryByTestId("bot-handoff-line")).toBeNull();
    expect(screen.getByTestId("bot-handoff-cards").textContent).not.toContain("Done.");
    expect(answer.textContent).toContain("An answer from Sentry to Atlas is not delivered · it goes when that bot's chat starts: the chat could not take the message");
    expect(loose.textContent).toContain("A message from Sentry to Atlas is not delivered: the tab is gone");
    expect(screen.getAllByTestId("bot-handoff-resend")).toHaveLength(2);
    fireEvent.click(within(answer).getByTestId("bot-handoff-resend"));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_handoff_resend", { message: "m1" }));
    await waitFor(() => expect(screen.getAllByTestId("bot-handoff-undelivered-message")).toHaveLength(1));
  });

  it("show a message not delivered about an open hand-off under the lines, with its Resend", async () => {
    list.handoffs = [handoff(3)];
    list.undelivered = [{ id: "m1", at: "2026-11-21T10:00:00Z", from: "b1", to: "b2", kind: "handoff", handoff: 3, tries: 3, error: "the chat could not take the message", held: true }];
    render(<HandoffStrip bot={atlas} chatId="atlas-home" />);
    const line = await screen.findByTestId("bot-handoff-line");
    const message = screen.getByTestId("bot-handoff-undelivered-message");
    expect(line.contains(message)).toBe(false);
    expect(message.textContent).toContain("The hand-off from Atlas to Sentry is not delivered · it goes when that bot's chat starts: the chat could not take the message");
    expect(within(message).getByTestId("bot-handoff-resend")).toBeTruthy();
  });

  it("keep only the open ones", () => {
    expect(handoffStateLabel(handoff(1, { state: "waiting" }), "Sentry", Date.now(), false)).toBe("Waiting to start");
    expect(handoffStateLabel(handoff(1, { state: "stopped", stoppedBy: "deleted" }), "Sentry")).toBe("Stopped · its sender was deleted");
    const many = [handoff(9), ...Array.from({ length: 5 }, (_, n) => handoff(n + 1, { state: "answered" }))];
    expect(chatHandoffs(many, "atlas-home").map((value) => value.number)).toEqual([9]);
    // Every open one is kept, however many, with a state a newer app wrote; none that is finished, and none of another chat.
    const mixed = [
      handoff(8, { state: "waiting" }), handoff(7), handoff(6, { state: "escalated" }), handoff(5), handoff(4, { state: "failed" }), handoff(3, { state: "stopped" }),
      handoff(2, { state: "answered" }), handoff(1, { fromSession: "elsewhere", toSession: "elsewhere-too" }),
    ];
    expect(chatHandoffs(mixed, "atlas-home").map((value) => value.number)).toEqual([8, 7, 6, 5]);
    expect(chatHandoffs(mixed, "sentry-work-7").map((value) => value.number)).toEqual([7]);
    expect(chatHandoffs(many.slice(1), "atlas-home")).toEqual([]);
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

  it("a save refused because the brief changed offers the newer text and keeps the draft (lead review 1)", async () => {
    brief = { ...brief, text: "Old.\n", hash: "h1", lines: 1 };
    render(<TeamBriefEditor />);
    const box = screen.getByLabelText<HTMLTextAreaElement>("Team brief text");
    await waitFor(() => expect(box.value).toBe("Old.\n"));
    fireEvent.change(box, { target: { value: "Mine." } });
    brief = { ...brief, text: "Theirs.\n", hash: "h5" };
    mocks.invoke.mockImplementation((command: string, args: Record<string, unknown>) =>
      command === "bot_brief_write" && args.expected === "h1" ? Promise.reject(new Error("The team brief changed since you opened it. Open it again to see what changed.")) : route(command, args));
    fireEvent.click(screen.getByTestId("bot-team-brief-save"));
    await screen.findByTestId("bot-team-brief-stale");
    expect(box.value).toBe("Mine.");
    fireEvent.click(screen.getByTestId("bot-team-brief-load-newer"));
    await waitFor(() => expect(box.value).toBe("Theirs.\n"));
    fireEvent.click(screen.getByTestId("bot-team-brief-put-back"));
    expect(box.value).toBe("Mine.");
    fireEvent.click(screen.getByTestId("bot-team-brief-save"));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_brief_write", { text: "Mine.", expected: "h5" }));
  });

  it("Save mine over it writes the draft over the newer brief", async () => {
    brief = { ...brief, text: "Old.\n", hash: "h1", lines: 1 };
    render(<TeamBriefEditor />);
    const box = screen.getByLabelText<HTMLTextAreaElement>("Team brief text");
    await waitFor(() => expect(box.value).toBe("Old.\n"));
    fireEvent.change(box, { target: { value: "Mine." } });
    brief = { ...brief, text: "Theirs.\n", hash: "h5" };
    mocks.invoke.mockImplementation((command: string, args: Record<string, unknown>) =>
      command === "bot_brief_write" && args.expected === "h1" ? Promise.reject(new Error("The team brief changed since you opened it.")) : route(command, args));
    fireEvent.click(screen.getByTestId("bot-team-brief-save"));
    fireEvent.click(await screen.findByTestId("bot-team-brief-save-over"));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_brief_write", { text: "Mine.", expected: "h5" }));
    await waitFor(() => expect(screen.queryByTestId("bot-team-brief-stale")).toBeNull());
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

  it("says a failed read of the hand-offs, and does not show a stale lead's list for another bot", async () => {
    mocks.invoke.mockImplementation((command: string, args: Record<string, unknown>) => command === "bot_handoffs" ? Promise.reject(new Error("runtime_unavailable")) : route(command, args));
    render(<BotReportsTo bot={atlas} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't read Atlas's hand-offs");
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

describe("useBotHandoffs (lead review 1)", () => {
  it("clears what it read for one bot when asked about another", async () => {
    const { useBotHandoffs } = await import("@/lib/botHandoffs");
    let release: (value: HandoffList) => void = () => {};
    mocks.invoke.mockImplementation((command: string, args: Record<string, unknown>) =>
      command === "bot_handoffs" && args.id === "b2" ? new Promise<HandoffList>((resolve) => { release = resolve; }) : route(command, args));
    list.handoffs = [handoff(1)];
    function Probe({ id }: { id: string }) {
      const { list: read } = useBotHandoffs(id);
      return <p data-testid="probe">{read ? read.handoffs.length : "none"}</p>;
    }
    const { rerender } = render(<Probe id="b1" />);
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("1"));
    rerender(<Probe id="b2" />);
    expect(screen.getByTestId("probe").textContent).toBe("none");
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_handoffs", { id: "b2" }));
    await act(async () => release({ ...list, handoffs: [] }));
    expect(screen.getByTestId("probe").textContent).toBe("0");
  });
});
