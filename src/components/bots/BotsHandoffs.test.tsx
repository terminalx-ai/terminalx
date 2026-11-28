import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/icons", () => new Proxy({}, { has: () => true, get: (_, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : prop === "__esModule" ? true : (props: Record<string, unknown>) => <svg {...props} />) }));
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: import("react").ReactNode }) => children,
  WithTooltip: ({ children }: { children: import("react").ReactNode }) => children,
  Tooltip: ({ children }: { children: import("react").ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: import("react").ReactNode }) => children,
  TooltipContent: () => null,
  Kbd: ({ children }: { children: import("react").ReactNode }) => <kbd data-slot="kbd">{children}</kbd>,
  KbdGroup: ({ keys }: { keys: string[] }) => <span data-slot="kbd">{keys.map((k, i) => <kbd key={i}>{k}</kbd>)}</span>,
}));
import type { Bot } from "@/types/bots";
import type { Handoff, HandoffList } from "@/types/botHandoffs";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  openBots: vi.fn(),
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
vi.mock("@/lib/sessions", () => ({ openBots: mocks.openBots, openWelcome: vi.fn(), useSessionStore: () => ({ view: "bots" }) }));
vi.mock("@/lib/experimentalSettings", () => ({ useExperimentalSettings: () => ({ bots: true }) }));
vi.mock("@/components/machines/MachineHostError", () => ({
  MachineHostError: ({ error, onRestarted }: { error: string; onRestarted: () => void }) => (
    <div role="alert">{error}<button type="button" onClick={onRestarted}>Restart runtime</button></div>
  ),
}));

const { BotsHandoffs, unreadableNotes } = await import("./BotsHandoffs");
const { getBotsPage, resetBotsPageForTests, showBotsHandoffs } = await import("@/lib/botsPage");
const { chainLine, chainOf, handoffChains } = await import("@/lib/botHandoffChains");

const base: Bot = {
  id: "atlas", slug: "atlas", name: "Atlas", roleTitle: "CTO", roleTemplateId: "cto", harness: "claude", model: "", access: "full", runsOn: "thisMac",
  reportsTo: "owner", worksIn: ["personal"], created: "2026-11-20T10:00:00Z", modified: "2026-11-20T10:00:00Z",
};
const atlas = base;
const mira: Bot = { ...base, id: "mira", slug: "mira", name: "Mira", roleTitle: "Chief of staff", roleTemplateId: "chief-of-staff", reportsTo: "atlas" };
const iris: Bot = { ...base, id: "iris", slug: "iris", name: "Iris", roleTitle: "UX designer", roleTemplateId: "ux-designer", reportsTo: "mira" };
const kestrel: Bot = { ...base, id: "kestrel", slug: "kestrel", name: "Kestrel", roleTitle: "QA engineer", roleTemplateId: "qa-engineer", reportsTo: "iris", paused: { at: "2026-11-21T09:00:00Z", by: "owner" } as Bot["paused"] };

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const handoff = (number: number, from: string, to: string, extra: Partial<Handoff> = {}): Handoff => ({
  number, from, to, by: from, title: `Hand-off ${number}`, state: "working", depth: 1, created: minutesAgo(60 - number), modified: minutesAgo(60 - number),
  started: minutesAgo(52), waitingMessages: 0, ...extra,
});

/**
 * 23.16's chain: Atlas hands Mira work (1), Mira hands part on to Iris from its chat for it (2, answered), Iris hands
 * part on to Kestrel (3), who could not do it, and Iris hands it again (4), which waits because Kestrel is paused. Beside
 * it: one sent from a home chat while its sender held open work (5: depth 2, no parent), an answered one (6) and one
 * the owner stopped (7).
 */
const chainOfFour = (): Handoff[] => [
  handoff(1, "atlas", "mira", { title: "Offline mode: get the screens designed before any build work", scope: "Offline mode needs screens before anyone builds it." }),
  handoff(2, "mira", "iris", { parent: 1, depth: 2, state: "answered", title: "Design offline mode", closed: minutesAgo(40), answer: { at: minutesAgo(40), by: "iris", text: "The offline designs are done." } }),
  handoff(3, "iris", "kestrel", { parent: 2, depth: 3, state: "failed", title: "Check the offline screens at 760 wide", closed: minutesAgo(30), answer: { at: minutesAgo(30), by: "kestrel", failed: true, text: "I could not do it: there is no build to run." } }),
  handoff(4, "iris", "kestrel", { retryOf: 3, attempt: 1, depth: 3, state: "waiting", title: "Check the offline screens at 760 wide", started: undefined, waitingMessages: 1 }),
];
const others = (): Handoff[] => [
  handoff(5, "mira", "iris", { depth: 2, title: "Design the status page: how an outage is said" }),
  handoff(6, "atlas", "mira", { state: "answered", title: "Say which checks still run on the hosted runner", closed: minutesAgo(5), answer: { at: minutesAgo(5), by: "mira", text: "Only the Linux ones." } }),
  handoff(7, "mira", "kestrel", { state: "stopped", stoppedBy: "owner", title: "List the open issues with no owner", closed: minutesAgo(4) }),
];

const listOf = (handoffs: Handoff[], extra: Partial<HandoffList> = {}): HandoffList => ({
  revision: 1, waitingMessages: 0, unreadable: 0, unreadableHandoffs: 0, unreadableMessages: 0, maxDepth: 3, maxRetries: 2, handoffs: [...handoffs].sort((a, b) => b.number - a.number), ...extra,
});

let list: HandoffList | Error;

function route(command: string) {
  switch (command) {
    case "bot_handoffs":
      return list instanceof Error ? Promise.reject(list) : Promise.resolve(list);
    case "bot_handoff_stop":
      return Promise.resolve({ handoff: {} });
    default:
      return Promise.reject(new Error(`unexpected ${command}`));
  }
}

const steps = () => screen.getAllByTestId("bots-handoffs-step");
const stepOf = (number: number) => steps().find((step) => step.dataset.number === String(number))!;
const changed = () => act(async () => { mocks.listeners.get("bot_handoffs_changed")?.({ payload: { revision: 2 } }); });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-28T12:00:00Z") });
  mocks.listeners.clear();
  mocks.bots = [atlas, mira, iris, kestrel];
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(route);
  mocks.openBots.mockClear();
  resetBotsPageForTests();
  list = listOf([...chainOfFour(), ...others()]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the Hand-offs page: the list of chains (PRO-540, 23.16)", () => {
  it("reads every bot's hand-offs in one call, with no bot named", async () => {
    render(<BotsHandoffs />);
    await screen.findByTestId("bots-handoffs-list");
    expect(mocks.invoke).toHaveBeenCalledWith("bot_handoffs", {});
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "bot_handoffs")).toHaveLength(1);
  });

  it("lists each chain once, open ones first, with its bots, its state, its title and how much is in it", async () => {
    render(<BotsHandoffs />);
    const nav = await screen.findByTestId("bots-handoffs-list");
    const open = within(within(nav).getByRole("region", { name: "Open" })).getAllByTestId("bots-handoffs-chain");
    const closed = within(within(nav).getByRole("region", { name: "Closed" })).getAllByTestId("bots-handoffs-chain");
    // Four hand-offs are one chain; the newest open chain is first.
    expect(open.map((row) => row.dataset.chain)).toEqual(["5", "1"]);
    expect(closed.map((row) => row.dataset.chain)).toEqual(["7", "6"]);
    const chain = open[1];
    expect(within(chain).getAllByTestId("bot-avatar").map((avatar) => avatar.dataset.role)).toEqual(["cto", "chief-of-staff", "ux-designer", "qa-engineer"]);
    expect(within(chain).getByTestId("bots-handoffs-chain-state").textContent).toBe("Working");
    expect(within(chain).getByText("Offline mode: get the screens designed before any build work")).toBeTruthy();
    expect(within(chain).getByTestId("bots-handoffs-chain-line").textContent).toMatch(/^4 hand-offs · 3 deep · started \d/);
    expect(within(closed[1]).getByTestId("bots-handoffs-chain-state").textContent).toBe("Answered");
    expect(within(closed[1]).getByTestId("bots-handoffs-chain-line").textContent).toMatch(/^1 hand-off · answered \d/);
    expect(within(closed[0]).getByTestId("bots-handoffs-chain-state").textContent).toBe("Stopped by you");
    expect(within(closed[0]).getByTestId("bots-handoffs-chain-line").textContent).toMatch(/^1 hand-off · stopped by you \d/);
    // The header counts open chains, and what waits for a paused bot.
    expect(screen.getByTestId("bots-handoffs-counts").textContent).toBe("2 open1 waits for a paused bot");
  });

  it("shows the newest open chain's thread first, and another's when it is picked", async () => {
    render(<BotsHandoffs />);
    const thread = await screen.findByTestId("bots-handoffs-thread");
    expect(thread.dataset.chain).toBe("5");
    fireEvent.click(screen.getAllByTestId("bots-handoffs-chain").find((row) => row.dataset.chain === "6")!);
    expect(screen.getByTestId("bots-handoffs-thread").dataset.chain).toBe("6");
    expect(screen.getAllByTestId("bots-handoffs-chain").filter((row) => row.getAttribute("aria-current")).map((row) => row.dataset.chain)).toEqual(["6"]);
    expect(steps()).toHaveLength(1);
  });

  it("a hand-off with a depth above 1 and no recorded parent is its own chain, and still says its depth", async () => {
    render(<BotsHandoffs />);
    const thread = await screen.findByTestId("bots-handoffs-thread");
    // Hand-off 5 was sent while its sender held open work, from another chat: the limit counts it 2 deep, and nothing
    // says which work it carries on. Mira and Iris are in hand-off 2 as well; that joins nothing.
    expect(thread.dataset.chain).toBe("5");
    expect(steps().map((step) => [step.dataset.number, step.dataset.level])).toEqual([["5", "0"]]);
    expect(within(stepOf(5)).getByTestId("bots-handoffs-step-depth").textContent).toBe("#5 · 2 of 3");
    expect(within(thread).getByTestId("bots-handoffs-depth").textContent).toBe("2 of 3 deep · a chain stops at 3");
  });

  it("joins hand-offs only by what they recorded: a parent or a retry that is not among them joins nothing", () => {
    const chains = handoffChains([handoff(9, "mira", "iris", { parent: 2, depth: 2 }), handoff(10, "iris", "kestrel", { retryOf: 3, attempt: 1 }), handoff(11, "atlas", "mira", { parent: 12 }), handoff(12, "atlas", "mira")]);
    expect(chains.map((chain) => [chain.root, chain.steps.length])).toEqual([[12, 1], [11, 1], [10, 1], [9, 1]]);
    expect(chainOf(chains, 10)?.root).toBe(10);
    expect(chainOf(chains, 3)).toBeNull();
  });

  it("says when a closed chain ended in the list's own words", () => {
    const now = new Date(2026, 10, 23, 15, 0).getTime();
    const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0).toISOString();
    const line = (extra: Partial<Handoff>) => chainLine(handoffChains([handoff(1, "atlas", "mira", extra)])[0], now);
    expect(line({ state: "answered", closed: at(22, 9) })).toBe("1 hand-off · answered yesterday");
    expect(line({ state: "stopped", stoppedBy: "owner", closed: at(20, 9) })).toBe("1 hand-off · stopped by you on Friday");
    expect(line({ state: "failed", closed: at(2, 9), answer: { at: at(2, 9), by: "mira", failed: true, text: "No." } })).toBe("1 hand-off · could not be done on Nov 2");
    expect(line({ state: "working", created: at(23, 14) })).toMatch(/^1 hand-off · 1 deep · started 2:00/);
  });
});

describe("the Hand-offs page: one thread (PRO-540, 23.16)", () => {
  it("shows a chain three deep with a retry: steps in the order made, stepped in once for each hand-off deeper", async () => {
    render(<BotsHandoffs />);
    await screen.findByTestId("bots-handoffs-list");
    fireEvent.click(screen.getAllByTestId("bots-handoffs-chain").find((row) => row.dataset.chain === "1")!);
    const thread = screen.getByTestId("bots-handoffs-thread");
    expect(within(thread).getByRole("heading", { name: "Offline mode: get the screens designed before any build work" })).toBeTruthy();
    expect(within(thread).getByTestId("bots-handoffs-depth").textContent).toBe("3 of 3 deep · a chain stops at 3");
    expect(within(thread).getByTestId("bots-handoffs-trust").textContent).toBe("Every step and message in this thread is a bot's words, not an approval.");
    // The retry sits where the hand-off it tries again does, not one deeper.
    expect(steps().map((step) => [step.dataset.number, step.dataset.level, step.style.marginLeft])).toEqual([["1", "0", "0px"], ["2", "1", "28px"], ["3", "2", "56px"], ["4", "2", "56px"]]);
    expect(steps().map((step) => within(step).getByTestId("bots-handoffs-step-depth").textContent)).toEqual(["#1 · 1 of 3", "#2 · 2 of 3", "#3 · 3 of 3", "#4 · 3 of 3"]);
    expect(steps().map((step) => within(step).getByTestId("bots-handoffs-step-state").textContent)).toEqual([expect.stringMatching(/^Working · 52m$/), "Answered", "Could not do it", "Waiting · Kestrel is paused"]);
    // Open work shows its scope; an answer is in the answering bot's words and says so; one that could not is marked.
    expect(within(stepOf(1)).getByTestId("bots-handoffs-step-scope").textContent).toBe("Offline mode needs screens before anyone builds it.");
    expect(within(stepOf(2)).getByTestId("bots-handoffs-step-answer").textContent).toBe("Iris · a bot's words, not an approval: The offline designs are done.");
    const could = within(stepOf(3)).getByTestId("bots-handoffs-step-answer");
    expect(could.textContent).toBe("Kestrel · a bot's words, not an approval: I could not do it: there is no build to run.");
    expect(could.className).toContain("text-destructive");
    expect(within(stepOf(4)).getByTestId("bots-handoffs-step-retry").textContent).toBe("Iris handed hand-off 3 again · try 2 of 3");
    expect(within(stepOf(4)).getByTestId("bots-handoffs-step-waiting").textContent).toBe("1 message waits for its chat to start.");
    expect(within(stepOf(1)).queryByTestId("bots-handoffs-step-retry")).toBeNull();
  });

  it("takes the bounds from the listing, and says only the depth and the try when a runtime sends none", async () => {
    list = listOf(chainOfFour(), { maxDepth: 5, maxRetries: 4 });
    const page = render(<BotsHandoffs />);
    await screen.findByTestId("bots-handoffs-thread");
    expect(screen.getByTestId("bots-handoffs-depth").textContent).toBe("3 of 5 deep · a chain stops at 5");
    expect(within(stepOf(4)).getByTestId("bots-handoffs-step-depth").textContent).toBe("#4 · 3 of 5");
    expect(within(stepOf(4)).getByTestId("bots-handoffs-step-retry").textContent).toBe("Iris handed hand-off 3 again · try 2 of 5");
    page.unmount();
    list = listOf(chainOfFour(), { maxDepth: undefined, maxRetries: undefined });
    render(<BotsHandoffs />);
    await screen.findByTestId("bots-handoffs-thread");
    expect(screen.getByTestId("bots-handoffs-depth").textContent).toBe("3 deep");
    expect(within(stepOf(4)).getByTestId("bots-handoffs-step-depth").textContent).toBe("#4 · depth 3");
    expect(within(stepOf(4)).getByTestId("bots-handoffs-step-retry").textContent).toBe("Iris handed hand-off 3 again · try 2");
  });

  it("what TerminalX said is not a bot's words, and what the owner handed on is theirs", async () => {
    list = listOf([
      handoff(1, "atlas", "mira", { state: "failed", closed: minutesAgo(1), answer: { at: minutesAgo(1), by: "terminalx", failed: true, text: "It did not start: the line changed." } }),
      handoff(2, "mira", "iris", { by: "owner", fromItem: 14, note: "Have it by Friday.", scope: "The item's summary." }),
    ]);
    render(<BotsHandoffs />);
    await screen.findByTestId("bots-handoffs-thread");
    expect(within(stepOf(2)).getByTestId("bots-handoffs-step-owner").textContent).toBe("You handed Mira's item #14 to Iris. Its title is Mira's words.");
    expect(within(stepOf(2)).getByTestId("bots-handoffs-step-note").textContent).toBe("Your note · your own words: Have it by Friday.");
    fireEvent.click(screen.getAllByTestId("bots-handoffs-chain").find((row) => row.dataset.chain === "1")!);
    expect(within(stepOf(1)).getByTestId("bots-handoffs-step-answer").textContent).toBe("TerminalX: It did not start: the line changed.");
    expect(within(stepOf(1)).getByTestId("bots-handoffs-step-state").textContent).toBe("Failed · not started");
  });
});

describe("the Hand-offs page: Stop (PRO-540)", () => {
  it("is on each open step only, and stops that one hand-off through the strip's own call", async () => {
    render(<BotsHandoffs />);
    await screen.findByTestId("bots-handoffs-list");
    fireEvent.click(screen.getAllByTestId("bots-handoffs-chain").find((row) => row.dataset.chain === "1")!);
    // Steps 1 (working) and 4 (waiting) are open; 2 is answered and 3 failed.
    expect(steps().map((step) => within(step).queryAllByTestId("bots-handoffs-stop").length)).toEqual([1, 0, 0, 1]);
    const stop = within(stepOf(4)).getByTestId("bots-handoffs-stop");
    expect(stop.textContent?.trim()).toBe("Stop Kestrel");
    expect(stop.getAttribute("aria-label")).toBe("Stop Kestrel's work on hand-off 4");
    fireEvent.click(stop);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_handoff_stop", { number: 4 }));
    // That hand-off and no other: the rest of the chain is not asked to stop.
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "bot_handoff_stop")).toEqual([["bot_handoff_stop", { number: 4 }]]);
    expect(mocks.invoke.mock.calls.map(([command]) => command).filter((command) => !["bot_handoffs", "bot_handoff_stop"].includes(command))).toEqual([]);
  });

  it("says why a Stop failed, on its step, and keeps the step", async () => {
    mocks.invoke.mockImplementation((command: string) => (command === "bot_handoff_stop" ? Promise.reject(new Error("Hand-off 5 is answered already.")) : route(command)));
    render(<BotsHandoffs />);
    await screen.findByTestId("bots-handoffs-thread");
    fireEvent.click(within(stepOf(5)).getByTestId("bots-handoffs-stop"));
    expect((await within(stepOf(5)).findByRole("alert")).textContent).toContain("Hand-off 5 is answered already.");
    expect(within(stepOf(5)).getByTestId("bots-handoffs-stop")).toBeTruthy();
  });
});

describe("the Hand-offs page: its states (PRO-540, 23.19)", () => {
  it("loading: says it is reading, with no counts and no list", async () => {
    let arrive: (value: HandoffList) => void = () => {};
    mocks.invoke.mockImplementation(() => new Promise<HandoffList>((resolve) => { arrive = resolve; }));
    render(<BotsHandoffs />);
    expect((await screen.findByTestId("bots-handoffs-reading")).textContent).toBe(" Reading the hand-offs…");
    expect(screen.queryByTestId("bots-handoffs-counts")).toBeNull();
    expect(screen.queryByTestId("bots-handoffs-list")).toBeNull();
    expect(screen.queryByTestId("bots-handoffs-empty")).toBeNull();
    await act(async () => arrive(listOf(others())));
    expect(screen.getByTestId("bots-handoffs-list")).toBeTruthy();
    expect(screen.queryByTestId("bots-handoffs-reading")).toBeNull();
  });

  it("empty: No hand-offs yet and what brings one, with no button to start anything", async () => {
    list = listOf([]);
    render(<BotsHandoffs />);
    const empty = await screen.findByTestId("bots-handoffs-empty");
    expect(within(empty).getByRole("heading", { name: "No hand-offs yet" })).toBeTruthy();
    expect(empty.textContent).toContain("When one bot hands work to another, the chain shows here as one thread.");
    expect(within(empty).queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByTestId("bots-handoffs-list")).toBeNull();
    expect(screen.queryByTestId("bots-handoffs-counts")).toBeNull();
  });

  it("a failed read is never shown as No hand-offs yet: the error as written, with Retry, which reads again", async () => {
    list = new Error("/Users/you/.raccoon/bot-handoffs.json cannot be read; it is left as it is");
    render(<BotsHandoffs />);
    const row = await screen.findByTestId("bots-handoffs-error");
    expect(row.getAttribute("role")).toBe("alert");
    expect(row.textContent).toContain("Couldn't read the hand-offs: /Users/you/.raccoon/bot-handoffs.json cannot be read; it is left as it is");
    expect(screen.queryByText("No hand-offs yet")).toBeNull();
    expect(screen.queryByTestId("bots-handoffs-empty")).toBeNull();
    expect(screen.queryByTestId("bots-handoffs-list")).toBeNull();
    expect(screen.queryByTestId("bots-handoffs-counts")).toBeNull();
    list = listOf(others());
    fireEvent.click(screen.getByTestId("bots-handoffs-retry"));
    expect(await screen.findByTestId("bots-handoffs-list")).toBeTruthy();
    expect(screen.queryByTestId("bots-handoffs-error")).toBeNull();
  });

  it("a read that fails after one that worked leaves nothing of the earlier read under the error, and never an empty page", async () => {
    render(<BotsHandoffs />);
    await screen.findByTestId("bots-handoffs-list");
    list = new Error("the runtime is not answering");
    await changed();
    expect((await screen.findByTestId("bots-handoffs-error")).textContent).toContain("the runtime is not answering");
    expect(screen.queryByTestId("bots-handoffs-list")).toBeNull();
    expect(screen.queryByTestId("bots-handoffs-thread")).toBeNull();
    expect(screen.queryByTestId("bots-handoffs-counts")).toBeNull();
    expect(screen.queryByText("No hand-offs yet")).toBeNull();
  });

  it("offers Restart runtime in place of Retry when only that helps", async () => {
    list = new Error("runtime_restart_required:e7: The runtime must restart to read the hand-offs.");
    render(<BotsHandoffs />);
    expect(await screen.findByRole("button", { name: "Restart runtime" })).toBeTruthy();
    expect(screen.queryByTestId("bots-handoffs-retry")).toBeNull();
    expect(screen.queryByText("No hand-offs yet")).toBeNull();
    list = listOf(others());
    fireEvent.click(screen.getByRole("button", { name: "Restart runtime" }));
    expect(await screen.findByTestId("bots-handoffs-list")).toBeTruthy();
  });

  it("some unreadable: counts the hand-offs alone in its sentence, above the list it could read", async () => {
    // Five records cannot be read: two hand-offs and three messages. The sentence about hand-offs says two.
    list = listOf(others(), { unreadable: 5, unreadableHandoffs: 2, unreadableMessages: 3 });
    render(<BotsHandoffs />);
    await screen.findByTestId("bots-handoffs-list");
    const notes = screen.getAllByTestId("bots-handoffs-unreadable");
    expect(notes.map((note) => [note.dataset.of, note.textContent])).toEqual([
      ["handoffs", "2 hand-offs were saved by a newer TerminalX and can't be shown here. Update the app to see them."],
      ["messages", "3 messages between bots were saved by a newer TerminalX too. This version does not deliver or count them."],
    ]);
    expect(screen.getAllByTestId("bots-handoffs-chain")).toHaveLength(3);
  });

  it("only messages unreadable: says nothing of hand-offs that cannot be shown", () => {
    expect(unreadableNotes({ unreadable: 4, unreadableHandoffs: 0, unreadableMessages: 4 }).map((note) => note.of)).toEqual(["messages"]);
    expect(unreadableNotes({ unreadable: 1, unreadableHandoffs: 1, unreadableMessages: 0 })).toEqual([{ of: "handoffs", text: "1 hand-off was saved by a newer TerminalX and can't be shown here. Update the app to see it." }]);
    expect(unreadableNotes({ unreadable: 0, unreadableHandoffs: 0, unreadableMessages: 0 })).toEqual([]);
    // A runtime from before the counts were split: the sum is said as a sum, never as a count of hand-offs.
    expect(unreadableNotes({ unreadable: 3 })).toEqual([{ of: "records", text: "3 hand-offs or messages between bots were saved by a newer TerminalX and can't be shown here. Update the app to see them." }]);
  });

  it("with none it can read and some it cannot, says so and never No hand-offs yet", async () => {
    list = listOf([], { unreadable: 2, unreadableHandoffs: 2, unreadableMessages: 0 });
    render(<BotsHandoffs />);
    expect((await screen.findByTestId("bots-handoffs-unreadable")).textContent).toContain("2 hand-offs were saved by a newer TerminalX");
    expect(screen.queryByText("No hand-offs yet")).toBeNull();
  });
});

describe("the ways in to the Hand-offs page (PRO-540)", () => {
  it("showBotsHandoffs() opens the page on the Bots view; with a number it opens the thread that holds that hand-off, at that step", async () => {
    showBotsHandoffs();
    expect(getBotsPage()).toEqual({ page: "handoffs" });
    expect(mocks.openBots).toHaveBeenCalledTimes(1);
    render(<BotsHandoffs />);
    expect((await screen.findByTestId("bots-handoffs-thread")).dataset.chain).toBe("5");
    expect(steps().filter((step) => step.getAttribute("aria-current"))).toHaveLength(0);

    // Hand-off 3 is in the chain that starts at 1.
    act(() => showBotsHandoffs(3));
    expect(getBotsPage()).toEqual({ page: "handoffs", number: 3 });
    expect(mocks.openBots).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("bots-handoffs-thread").dataset.chain).toBe("1");
    expect(steps().filter((step) => step.getAttribute("aria-current") === "step").map((step) => step.dataset.number)).toEqual(["3"]);
    expect(screen.getAllByTestId("bots-handoffs-chain").filter((row) => row.getAttribute("aria-current")).map((row) => row.dataset.chain)).toEqual(["1"]);

    // Picking another chain in the list leaves that step; asking for the same number again opens it again.
    fireEvent.click(screen.getAllByTestId("bots-handoffs-chain").find((row) => row.dataset.chain === "6")!);
    expect(screen.getByTestId("bots-handoffs-thread").dataset.chain).toBe("6");
    act(() => showBotsHandoffs(3));
    expect(screen.getByTestId("bots-handoffs-thread").dataset.chain).toBe("1");
    expect(stepOf(3).getAttribute("aria-current")).toBe("step");
  });

  it("opened already on a number, shows that hand-off's thread once the hand-offs are read", async () => {
    showBotsHandoffs(7);
    render(<BotsHandoffs />);
    expect((await screen.findByTestId("bots-handoffs-thread")).dataset.chain).toBe("7");
    expect(stepOf(7).getAttribute("aria-current")).toBe("step");
  });

  it("asked for a hand-off that is not among those read, says so and shows no step as it", async () => {
    showBotsHandoffs(99);
    render(<BotsHandoffs />);
    expect((await screen.findByTestId("bots-handoffs-missing")).textContent).toContain("Hand-off 99 is not among the hand-offs kept here.");
    expect(steps().filter((step) => step.getAttribute("aria-current"))).toHaveLength(0);
  });

  it("Bots goes back to the team", async () => {
    showBotsHandoffs();
    render(<BotsHandoffs />);
    fireEvent.click(await screen.findByTestId("bots-handoffs-back"));
    expect(getBotsPage()).toEqual({ page: "team", focus: true });
  });
});

describe("the Hand-offs page folded to one column under 820 wide (PRO-572, 23.18)", () => {
  // jsdom lays nothing out: the page is given a width, and an observer that a test can make report a new one.
  let pageWidth = 0;
  let resized: (() => void)[] = [];
  const resizeTo = (width: number) => act(() => { pageWidth = width; resized.forEach((notify) => notify()); });
  beforeEach(() => {
    pageWidth = 492;
    resized = [];
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const width = this.dataset.testid === "bots-handoffs" ? pageWidth : 0;
      return { width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    vi.stubGlobal("ResizeObserver", class {
      constructor(private notify: ResizeObserverCallback) {}
      observe() { resized.push(() => this.notify([], this as unknown as ResizeObserver)); }
      unobserve() {}
      disconnect() {}
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const chainRow = (root: number) => screen.getAllByTestId("bots-handoffs-chain").find((row) => row.dataset.chain === String(root))!;
  const marked = () => screen.getAllByTestId("bots-handoffs-chain").filter((row) => row.getAttribute("aria-current")).map((row) => row.dataset.chain);

  it("at 492 (a 760 window) the Hand-offs button lands on a thread alone, with All hand-offs and which open chain it is; the keyboard is on its title", async () => {
    showBotsHandoffs();
    render(<BotsHandoffs />);
    const thread = await screen.findByTestId("bots-handoffs-thread");
    expect(screen.getByTestId("bots-handoffs").dataset.folded).toBe("true");
    expect(thread.dataset.chain).toBe("5");
    expect(screen.queryByTestId("bots-handoffs-list")).toBeNull();
    expect(screen.getByTestId("bots-handoffs-all").textContent?.trim()).toBe("All hand-offs");
    expect(screen.getByTestId("bots-handoffs-position").textContent).toBe("1 of 2 open");
    expect(document.activeElement).toBe(screen.getByTestId("bots-handoffs-title"));
    // Bots still goes back to the team.
    expect(screen.getByTestId("bots-handoffs-back").textContent?.trim()).toBe("Bots");
  });

  it("All hand-offs shows the list alone with the same chain still marked and the keyboard on it; opening another shows its thread alone", async () => {
    render(<BotsHandoffs />);
    await screen.findByTestId("bots-handoffs-thread");
    fireEvent.click(screen.getByTestId("bots-handoffs-all"));
    expect(screen.queryByTestId("bots-handoffs-thread")).toBeNull();
    const list = screen.getByTestId("bots-handoffs-list");
    expect(list.className).toContain("flex-1");
    expect(list.className).not.toContain("border-r");
    expect(marked()).toEqual(["5"]);
    expect(document.activeElement).toBe(chainRow(5));

    fireEvent.click(chainRow(1));
    expect(screen.queryByTestId("bots-handoffs-list")).toBeNull();
    expect(screen.getByTestId("bots-handoffs-thread").dataset.chain).toBe("1");
    expect(screen.getByTestId("bots-handoffs-position").textContent).toBe("2 of 2 open");
    expect(document.activeElement).toBe(screen.getByTestId("bots-handoffs-title"));
    expect(screen.getByTestId("bots-handoffs-title").textContent).toBe("Offline mode: get the screens designed before any build work");

    fireEvent.click(screen.getByTestId("bots-handoffs-all"));
    expect(marked()).toEqual(["1"]);
    expect(document.activeElement).toBe(chainRow(1));
    // A closed chain says which closed one it is.
    fireEvent.click(chainRow(6));
    expect(screen.getByTestId("bots-handoffs-position").textContent).toBe("2 of 2 closed");
  });

  it("the same chain stays marked after All hand-offs, and stays marked when a newer chain arrives under the list", async () => {
    render(<BotsHandoffs />);
    await screen.findByTestId("bots-handoffs-thread");
    fireEvent.click(screen.getByTestId("bots-handoffs-all"));
    fireEvent.click(chainRow(5));
    const shown = screen.getByTestId("bots-handoffs-thread").dataset.chain;
    expect(shown).toBe("5");
    fireEvent.click(screen.getByTestId("bots-handoffs-all"));
    expect(marked()).toEqual(["5"]);
    // A newer open chain now comes first in the list; the one the reader came back from is still the one marked.
    list = listOf([...chainOfFour(), ...others(), handoff(8, "atlas", "iris", { title: "A newer open chain" })]);
    await changed();
    await waitFor(() => expect(screen.getAllByTestId("bots-handoffs-chain").map((row) => row.dataset.chain)).toContain("8"));
    expect(screen.getAllByTestId("bots-handoffs-chain")[0].dataset.chain).toBe("8");
    expect(marked()).toEqual(["5"]);
  });

  it("steps are stepped in 14 for each hand-off deeper; state, Stop and time take their own line; the scope is whole", async () => {
    render(<BotsHandoffs />);
    await screen.findByTestId("bots-handoffs-thread");
    fireEvent.click(screen.getByTestId("bots-handoffs-all"));
    fireEvent.click(chainRow(1));
    expect(steps().map((step) => [step.dataset.number, step.dataset.level, step.style.marginLeft])).toEqual([["1", "0", "0px"], ["2", "1", "14px"], ["3", "2", "28px"], ["4", "2", "28px"]]);
    const status = within(stepOf(1)).getByTestId("bots-handoffs-step-status");
    expect(status.className).toContain("basis-full");
    expect(status.className).not.toContain("ml-auto");
    expect(within(status).getByTestId("bots-handoffs-stop")).toBeTruthy();
    expect(within(status).getByTestId("bots-handoffs-step-state")).toBeTruthy();
    expect(status.querySelector("time")?.className).toContain("ml-auto");
    expect(within(stepOf(1)).getByTestId("bots-handoffs-step-scope").className).not.toContain("line-clamp");
    // The sentence under the title has its own line and is not cut short.
    const about = screen.getByTestId("bots-handoffs-about");
    expect(about.className).toContain("basis-full");
    expect(about.className).not.toContain("truncate");
  });

  it("the wide page keeps both columns, 28 a level, the clamped scope, and the keyboard where it was", async () => {
    pageWidth = 820;
    render(<BotsHandoffs />);
    await screen.findByTestId("bots-handoffs-thread");
    expect(screen.getByTestId("bots-handoffs").dataset.folded).toBe("false");
    expect(screen.getByTestId("bots-handoffs-list")).toBeTruthy();
    expect(screen.queryByTestId("bots-handoffs-all")).toBeNull();
    expect(document.activeElement).not.toBe(screen.getByTestId("bots-handoffs-title"));
    chainRow(1).focus();
    fireEvent.click(chainRow(1));
    expect(document.activeElement).toBe(chainRow(1));
    expect(steps().map((step) => step.style.marginLeft)).toEqual(["0px", "28px", "56px", "56px"]);
    expect(within(stepOf(1)).getByTestId("bots-handoffs-step-scope").className).toContain("line-clamp-2");
    expect(screen.getByTestId("bots-handoffs-about").className).toContain("truncate");
  });

  it("folds and unfolds as the page's own width crosses 820, keeping the chain that shows", async () => {
    pageWidth = 1100;
    render(<BotsHandoffs />);
    await screen.findByTestId("bots-handoffs-list");
    fireEvent.click(chainRow(1));
    await resizeTo(819);
    expect(screen.queryByTestId("bots-handoffs-list")).toBeNull();
    expect(screen.getByTestId("bots-handoffs-thread").dataset.chain).toBe("1");
    expect(steps().map((step) => step.style.marginLeft)).toEqual(["0px", "14px", "28px", "28px"]);
    fireEvent.click(screen.getByTestId("bots-handoffs-all"));
    await resizeTo(820);
    expect(screen.getByTestId("bots-handoffs-list")).toBeTruthy();
    expect(screen.getByTestId("bots-handoffs-thread").dataset.chain).toBe("1");
    expect(marked()).toEqual(["1"]);
    await resizeTo(600);
    // Folded again from the list, it stays on the list.
    expect(screen.getByTestId("bots-handoffs-list")).toBeTruthy();
    expect(screen.queryByTestId("bots-handoffs-thread")).toBeNull();
  });

  it("every way in lands on the thread: a card's chain link or an item's hand-off row opens its chain at that step, from the list too", async () => {
    render(<BotsHandoffs />);
    await screen.findByTestId("bots-handoffs-thread");
    fireEvent.click(screen.getByTestId("bots-handoffs-all"));
    expect(screen.queryByTestId("bots-handoffs-thread")).toBeNull();
    // showBotsHandoffs(number) is what a card's chain link (BotMessageCards) and an item's hand-off row (BotItemPage) call.
    act(() => showBotsHandoffs(3));
    expect(screen.queryByTestId("bots-handoffs-list")).toBeNull();
    expect(screen.getByTestId("bots-handoffs-thread").dataset.chain).toBe("1");
    expect(stepOf(3).getAttribute("aria-current")).toBe("step");
    expect(document.activeElement).toBe(screen.getByTestId("bots-handoffs-title"));
    fireEvent.click(screen.getByTestId("bots-handoffs-all"));
    expect(marked()).toEqual(["1"]);
    // The Hand-offs button, from the list: the thread again.
    act(() => showBotsHandoffs());
    expect(screen.getByTestId("bots-handoffs-thread").dataset.chain).toBe("5");
  });

  it("opened on a number before the read ends, shows that thread and takes the keyboard to it once read", async () => {
    showBotsHandoffs(7);
    render(<BotsHandoffs />);
    const thread = await screen.findByTestId("bots-handoffs-thread");
    expect(thread.dataset.chain).toBe("7");
    expect(stepOf(7).getAttribute("aria-current")).toBe("step");
    expect(document.activeElement).toBe(screen.getByTestId("bots-handoffs-title"));
    expect(screen.queryByTestId("bots-handoffs-list")).toBeNull();
  });

  it("renders its states folded: loading, empty, read failed and some unreadable", async () => {
    let arrive: (value: HandoffList) => void = () => {};
    mocks.invoke.mockImplementation(() => new Promise<HandoffList>((resolve) => { arrive = resolve; }));
    const loading = render(<BotsHandoffs />);
    expect((await screen.findByTestId("bots-handoffs-reading")).textContent).toBe(" Reading the hand-offs…");
    expect(screen.queryByTestId("bots-handoffs-list")).toBeNull();
    await act(async () => arrive(listOf([])));
    expect(within(screen.getByTestId("bots-handoffs-empty")).getByRole("heading", { name: "No hand-offs yet" })).toBeTruthy();
    loading.unmount();

    mocks.invoke.mockImplementation(route);
    list = new Error("/Users/you/.raccoon/bot-handoffs.json cannot be read; it is left as it is");
    const failed = render(<BotsHandoffs />);
    expect((await screen.findByTestId("bots-handoffs-error")).textContent).toContain("Couldn't read the hand-offs: /Users/you/.raccoon/bot-handoffs.json cannot be read; it is left as it is");
    expect(screen.queryByText("No hand-offs yet")).toBeNull();
    expect(screen.getByTestId("bots-handoffs-retry")).toBeTruthy();
    failed.unmount();

    list = listOf(others(), { unreadable: 5, unreadableHandoffs: 2, unreadableMessages: 3 });
    render(<BotsHandoffs />);
    expect((await screen.findAllByTestId("bots-handoffs-unreadable"))[0].textContent).toBe("2 hand-offs were saved by a newer TerminalX and can't be shown here. Update the app to see them.");
    expect(screen.getByTestId("bots-handoffs-thread")).toBeTruthy();
    fireEvent.click(screen.getByTestId("bots-handoffs-all"));
    expect(screen.getAllByTestId("bots-handoffs-unreadable")).toHaveLength(2);
    expect(screen.getAllByTestId("bots-handoffs-chain")).toHaveLength(3);
  });
});
