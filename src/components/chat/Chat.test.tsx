import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat, visibleTurns } from "./Chat";
import { buildTranscript } from "@/lib/transcript";
import { syntheticLog } from "@/demo/synthetic";
import type { StreamBlock } from "@/lib/agentEvents";
import type { AgentEvent } from "@/types/events";
import { READER_SCROLL_EVENT } from "@/lib/shellScroll";
import { TooltipProvider } from "@/components/ui/tooltip";
import { registerShortcut } from "@/lib/hotkeys";
import { setPrefs } from "@/lib/prefs";

// jsdom lays nothing out, so this models the one box that matters: a scroller
// of fixed height over content whose children stack at known heights. Like a
// browser, writing scrollTop clamps it and the scroll event arrives later, in
// frame(), which also delivers ResizeObserver notifications.
const VIEWPORT = 600;
const TURN = 300;
const OTHER = 20;

let heights: Map<string, number>;
let scroller: HTMLElement;
let content: HTMLElement;
let top = 0;
let dispatchedTop = 0;
const observers: ResizeObserverCallback[] = [];

const heightOf = (el: Element) => {
  // A spacer standing for turns that are not drawn is as tall as its style says.
  if (el.hasAttribute("data-spacer")) return parseFloat((el as HTMLElement).style.height) || 0;
  const key = el.getAttribute("data-turn");
  return key ? heights.get(key) ?? TURN : OTHER;
};
const contentHeight = () => [...content.children].reduce((sum, c) => sum + heightOf(c), 0);
const maxTop = () => Math.max(0, contentHeight() - VIEWPORT);
const setTop = (value: number) => {
  top = Math.min(Math.max(0, value), maxTop());
};

class CapturingResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    observers.push(callback);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function mountScrollModel(container: HTMLElement) {
  content = container.querySelector("[data-turn]")!.parentElement!;
  scroller = content.parentElement!;
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => VIEWPORT });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => contentHeight() });
  Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => top, set: setTop });
  scroller.scrollTo = ((opts: ScrollToOptions) => setTop(opts.top ?? top)) as typeof scroller.scrollTo;
}

/** One rendering frame: pending scroll event, then resize notifications. */
function frame() {
  act(() => {
    if (top !== dispatchedTop) {
      dispatchedTop = top;
      scroller.dispatchEvent(new Event("scroll"));
    }
    observers.forEach((notify) => notify([], {} as ResizeObserver));
  });
}

/** A wheel/trackpad step: the wheel event, then the scroll it causes. */
function wheel(deltaY: number) {
  act(() => {
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY }));
  });
  setTop(top + deltaY);
  frame();
}

const distFromBottom = () => maxTop() - top;
/** How many pixels of the view lie over the space that stands for turns not drawn. */
const overSpacer = () =>
  [...content.querySelectorAll<HTMLElement>(":scope > [data-spacer]")].reduce((sum, spacer) => {
    const { top: from, bottom: to } = spacer.getBoundingClientRect();
    return sum + Math.max(0, Math.min(to, VIEWPORT) - Math.max(from, 0));
  }, 0);
/** Turns of 180–540 px. */
const shortTurn = (index: number) => 180 + (index % 7) * 60;
/** Every third turn 3000–6000 px, far taller than the drawn band reaches past the view (#771). */
const tallTurn = (index: number) => (index % 3 === 1 ? 3000 + (index % 4) * 1000 : shortTurn(index));
const latestShown = () => {
  // Keep the role/name check local: a long transcript has thousands of prompt-map buttons.
  const button = screen.getByText("Latest", { selector: "button" });
  return within(button.parentElement!).getByRole("button", { name: /latest/i }).parentElement!.classList.contains("opacity-100");
};

function setup(turnCount: number, log = syntheticLog(turnCount, true)) {
  const transcript = buildTranscript(log, true);
  const lastKey = transcript.turns[transcript.turns.length - 1].key;
  const props = {
    sessionId: "s",
    transcript,
    cwd: "/tmp/repo",
    live: true,
    progressing: false,
    answering: false,
    onAnswerPermission: () => {},
    onAnswerQuestions: () => {},
    footer: null,
  };
  let seq = 0;
  const stream = (): StreamBlock[] => [
    { ref: { messageId: "m-live", index: 0 }, kind: "text", text: `streamed delta ${++seq}`, partialJson: "", done: false },
  ];
  const view = render(<Chat {...props} stream={stream()} />, { wrapper: TooltipProvider });
  mountScrollModel(view.container);
  setTop(maxTop());
  frame();
  /** Output arrives: the live turn grows, React commits, the observer fires. */
  const output = (grow = 120) => {
    heights.set(lastKey, (heights.get(lastKey) ?? TURN) + grow);
    view.rerender(<Chat {...props} stream={stream()} />);
    frame();
  };
  const turnTop = (key: string) => content.querySelector<HTMLElement>(`[data-turn="${key}"]`)!.getBoundingClientRect().top;
  return { view, transcript, output, turnTop };
}

describe("chat scroll follow", () => {
  it("shows a reported goal above the scroller before the first turn and hides a cleared goal", () => {
    const event: AgentEvent = { id: "goal", seq: 1, sessionId: "s", tabId: "t", harness: "codex", ts: "",
      payload: { type: "goal_updated", goal: { objective: "Finish the migration", status: "active", tokenBudget: 1000, tokensUsed: 0 } } };
    const props = { sessionId: "s", live: false, progressing: false, answering: false, stream: [], onAnswerPermission: () => {}, onAnswerQuestions: () => {}, footer: null };
    const view = render(<Chat {...props} transcript={buildTranscript([event], false)} />, { wrapper: TooltipProvider });
    const banner = screen.getByRole("region", { name: "Codex goal" });
    expect(banner.textContent).toContain("Finish the migration");
    expect(view.container.querySelector("[data-chat-scroller]")?.contains(banner)).toBe(false);
    // The banner shares main's focusable chat root; it must not replace search.
    fireEvent.pointerDown(banner);
    const region = view.container.querySelector('[data-find-scope="chat"]');
    expect(document.activeElement).toBe(region);
    fireEvent.keyDown(document.activeElement!, { key: "f", ctrlKey: true });
    expect(screen.getByRole("textbox", { name: "Find in chat" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Codex goal" })).toBe(banner);
    view.rerender(<Chat {...props} transcript={buildTranscript([event, { ...event, id: "clear", seq: 2, payload: { type: "goal_cleared" } }], false)} />);
    expect(screen.queryByRole("region", { name: "Codex goal" })).toBeNull();
  });

  it("shows confirmed compaction while ordinary work is idle", () => {
    const scope = { sessionId: "s", tabId: "t", conversationId: null, provider: "claude", threadId: "thread", subagentId: null };
    const events: AgentEvent[] = [
      { id: "open", seq: 1, sessionId: "s", tabId: "t", harness: "claude", ts: "", payload: { type: "context_compaction_lifecycle", persisted: true, evidence: { scope, type: "connection_opened", generation: 1 } } },
      { id: "start", seq: 2, sessionId: "s", tabId: "t", harness: "claude", ts: "", payload: { type: "context_compaction_lifecycle", persisted: true, confirmedStart: true, evidence: { scope, type: "item_started", generation: 1, turnId: "turn", itemId: "item" } } },
    ];
    const transcript = buildTranscript(events, false, { compactionContinuityKnown: true });
    render(<Chat sessionId="s" transcript={transcript} cwd="/tmp/repo" live={false} progressing={false} answering={false} stream={[]} onAnswerPermission={() => {}} onAnswerQuestions={() => {}} footer={null} />);
    expect(screen.getByText("Compacting context…")).toBeDefined();
    expect(screen.queryByText("Context compacted")).toBeNull();
  });

  beforeEach(() => {
    heights = new Map();
    top = 0;
    dispatchedTop = 0;
    observers.length = 0;
    vi.stubGlobal("ResizeObserver", CapturingResizeObserver);
    // Nor does it answer media queries; reduced motion keeps the raccoon still.
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("reduced-motion"),
      addEventListener() {},
      removeEventListener() {},
    }));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      let y = 0;
      if (this !== content) {
        // Something inside a turn is taken to be at the turn's top.
        const turn = this.parentElement?.closest<HTMLElement>("[data-turn]");
        if (turn && content.contains(turn)) return turn.getBoundingClientRect();
        if (this.parentElement !== content) return new DOMRect(0, 0, 0, 0);
        for (let c = this.previousElementSibling; c; c = c.previousElementSibling) y += heightOf(c);
      }
      return new DOMRect(0, y - top, 0, this === content ? contentHeight() : heightOf(this));
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("follows new output while at the bottom", () => {
    const { output } = setup(4);
    output();
    output();
    expect(distFromBottom()).toBe(0);
    expect(latestShown()).toBe(false);
  });

  it("keeps a small upward step inside the near-bottom zone through a render and resize", () => {
    const { output } = setup(4);
    wheel(-8);
    const kept = top;
    output();
    expect(top).toBe(kept);
    expect(latestShown()).toBe(true);
  });

  it("walks upward in slow increments without snapping back, idle or streaming", () => {
    const { output } = setup(4);
    const start = top;
    for (let i = 1; i <= 12; i++) {
      wheel(-3);
      if (i % 2) output();
      else frame();
      expect(top).toBe(start - 3 * i);
    }
  });

  it("releases following on an upward scrollbar drag with no wheel", () => {
    const { output } = setup(4);
    fireEvent.pointerDown(scroller);
    setTop(top - 20);
    frame();
    fireEvent.pointerUp(window);
    const kept = top;
    output();
    expect(top).toBe(kept);
  });

  it("keeps following through an upward layout nudge the reader didn't make", () => {
    const { output } = setup(12);
    // Chromium moved a pinned scroller up 16.5px mid-backfill with no input.
    setTop(top - 16.5);
    frame();
    output();
    expect(distFromBottom()).toBe(0);
    expect(latestShown()).toBe(false);
  });

  it("takes the bottom back from a layout nudge at once, with no output to wait for", () => {
    setup(12);
    // An idle transcript (or one about to grow by someone else's turn): a
    // nudge with no input left it short of the bottom until the next output.
    setTop(top - 16);
    frame();
    expect(distFromBottom()).toBe(0);
    expect(latestShown()).toBe(false);
  });

  it("follows a turn another person drives, start to finish", () => {
    const { view, transcript, output } = setup(4);
    // Their prompt and its output arrive as events like the reader's own: a new last turn, then growth.
    const theirs = buildTranscript(syntheticLog(5, true), true);
    expect(theirs.turns.length).toBeGreaterThan(transcript.turns.length);
    view.rerender(
      <Chat sessionId="s" transcript={theirs} stream={[]} cwd="/tmp/repo" live progressing={false} answering={false} onAnswerPermission={() => {}} onAnswerQuestions={() => {}} footer={null} />,
    );
    frame();
    expect(distFromBottom()).toBe(0);
    output();
    output();
    expect(distFromBottom()).toBe(0);
    expect(latestShown()).toBe(false);
  });

  it("lets go when the reader scrolls up with the keyboard, and stays where they went", () => {
    const { output } = setup(4);
    act(() => {
      scroller.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    });
    setTop(top - 300);
    frame();
    const kept = top;
    output();
    expect(top).toBe(kept);
    expect(latestShown()).toBe(true);
  });

  it("lets go for a link that jumps within the transcript", () => {
    const { output } = setup(4);
    act(() => {
      scroller.dispatchEvent(new Event(READER_SCROLL_EVENT));
    });
    setTop(top - 250);
    frame();
    const kept = top;
    output();
    expect(top).toBe(kept);
  });

  it("resumes following when the reader scrolls back down to the bottom", () => {
    const { output } = setup(4);
    wheel(-200);
    output();
    expect(distFromBottom()).toBeGreaterThan(200);
    wheel(distFromBottom() - 10);
    output();
    expect(distFromBottom()).toBe(0);
    expect(latestShown()).toBe(false);
  });

  it("jump to latest restores following", () => {
    const { output } = setup(4);
    wheel(-500);
    fireEvent.click(screen.getByRole("button", { name: /latest/i }));
    frame();
    output();
    expect(distFromBottom()).toBe(0);
    expect(latestShown()).toBe(false);
  });

  it("keeps a clamp from shrinking content pinned", () => {
    const { transcript, output } = setup(4);
    const lastKey = transcript.turns[transcript.turns.length - 1].key;
    output(400);
    heights.set(lastKey, TURN);
    frame();
    output();
    expect(distFromBottom()).toBe(0);
  });

  // #727: only the turns near the view are drawn. One drawn for the first
  // time is rarely as tall as its spacer took it to be; the turn the reader
  // is on stays exactly where their scrolling put it.
  // #771: a turn taller than the overscan is drawn the whole time it is on
  // screen, its first screen too, not left out of the band for a spacer.
  it.each([
    ["of 180–540 px", shortTurn],
    ["up to 6000 px, taller than the overscan", tallTurn],
  ])("draws only the turns near the view, and holds the reader's turn as turns above are drawn: turns %s", (_, turnHeight) => {
    const keys = buildTranscript(syntheticLog(200, true), true).turns.map((turn) => turn.key);
    keys.forEach((key, index) => heights.set(key, turnHeight(index)));
    const { turnTop } = setup(200);
    const drawn = () => content.querySelectorAll("[data-turn]").length;
    expect(drawn()).toBeLessThan(25);
    expect(content.querySelector(`[data-turn="${keys.at(-1)}"]`)).not.toBeNull();
    expect(distFromBottom()).toBe(0);

    for (let step = 0; step < 30; step++) {
      // The turn at the view's top: the first drawn one with any of it on screen.
      const node = [...content.querySelectorAll<HTMLElement>("[data-turn]")].find((turn) => turn.getBoundingClientRect().bottom > 0);
      expect(node?.getBoundingClientRect().top, `step ${step}: a drawn turn at the view's top`).toBeLessThan(VIEWPORT);
      const reading = node!.dataset.turn!;
      const seen = turnTop(reading);
      wheel(-250);
      expect(turnTop(reading), `step ${step}`).toBe(seen + 250);
      expect(overSpacer(), `step ${step}: the view over spacers`).toBe(0);
      expect(drawn()).toBeLessThan(25);
    }
    expect(content.querySelector(`[data-turn="${keys.at(-1)}"]`)).toBeNull();
    expect(latestShown()).toBe(true);
  });

  // #771: the band is worked out on the heights just measured, and runs
  // through the turn holding its lower edge, so a reply taller than the
  // overscan never leaves the view empty, scrolling either way, right after
  // a step or once the reader holds still. Its 510 steps redraw a 200-turn
  // chat four times each: about 2 s alone, 6–7 s in CI's full run, and over
  // 30 s in a loaded shared VM. Allow for that without reducing the steps.
  // VITEST_SLOW_TEST_TIMEOUT_MS can raise this bound further on a busy host.
  it("never leaves the view over spacers while scrolling past turns taller than the overscan", () => {
    const keys = buildTranscript(syntheticLog(200, true), true).turns.map((turn) => turn.key);
    keys.forEach((key, index) => heights.set(key, tallTurn(index)));
    setup(200);
    // A fixed sequence, so a failing step can be told apart and replayed.
    let seed = 771;
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const runs: [string, number[]][] = [
      ["small steps up", Array.from({ length: 150 }, () => -120)],
      ["large steps, mostly up", Array.from({ length: 150 }, () => (random() < 0.7 ? -1 : 1) * Math.round(200 + random() * 1300))],
      ["small steps both ways", Array.from({ length: 150 }, () => (random() < 0.5 ? -1 : 1) * Math.round(40 + random() * 300))],
      ["large steps down", Array.from({ length: 60 }, () => Math.round(200 + random() * 1300))],
    ];
    for (const [run, steps] of runs) {
      steps.forEach((delta, step) => {
        wheel(delta);
        expect(overSpacer(), `${run}, step ${step} (${delta} px) at ${top}: right after it`).toBe(0);
        frame();
        frame();
        frame();
        expect(overSpacer(), `${run}, step ${step} (${delta} px) at ${top}: settled`).toBe(0);
      });
    }
  }, Math.max(120_000, Number(process.env.VITEST_SLOW_TEST_TIMEOUT_MS) || 0));

  // #727: a turn scrolled far from the view is not drawn. What the reader
  // opened in it is the chat's to keep, so it comes back as they left it.
  it("keeps a turn's tool calls unfolded after it was scrolled out of the drawn band and back", () => {
    setPrefs({ foldToolCalls: true });
    const { transcript } = setup(200);
    const key = transcript.turns.at(-2)!.key;
    const fold = () => content.querySelector<HTMLElement>(`[data-turn="${key}"]`)?.querySelector<HTMLElement>("button[aria-expanded]") ?? null;
    expect(fold()!.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(fold()!);
    expect(fold()!.getAttribute("aria-expanded")).toBe("true");
    for (let step = 0; step < 40 && fold(); step++) wheel(-400);
    expect(fold(), "scrolled out of the drawn band").toBeNull();
    setTop(maxTop());
    frame();
    frame();
    expect(fold()!.getAttribute("aria-expanded")).toBe("true");
    // Another turn's fold was never opened, and is not now.
    const other = content.querySelector<HTMLElement>(`[data-turn="${transcript.turns.at(-3)!.key}"] button[aria-expanded]`)!;
    expect(other.getAttribute("aria-expanded")).toBe("false");
  });

  // #727: a link to a place in a turn that is not drawn draws every turn to
  // find it, brings it to the top, and goes back to drawing the turns near it.
  it("follows a link to a place in a turn that is not drawn", () => {
    const log = syntheticLog(200, true);
    const answers = log.flatMap((event, index) => (event.payload.type === "assistant_text" ? [index] : []));
    const place = (index: number, text: string) => {
      log[index] = { ...log[index], payload: { type: "assistant_text", text } };
    };
    place(answers[3], 'The plan is <span id="the-plan">here</span>.');
    place(answers.at(-1)!, "As [the plan](#the-plan) says.");
    const { transcript } = setup(200, log);
    scroller.style.overflowY = "auto";
    const far = transcript.turns[3].key;
    const drawn = () => content.querySelectorAll("[data-turn]").length;
    expect(content.querySelector(`[data-turn="${far}"]`)).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "the plan" }));
    expect(content.querySelector("#the-plan")).not.toBeNull();
    expect(content.querySelector<HTMLElement>(`[data-turn="${far}"]`)!.getBoundingClientRect().top).toBe(0);
    expect(drawn()).toBeLessThan(25);
    frame();
    expect(content.querySelector<HTMLElement>(`[data-turn="${far}"]`)!.getBoundingClientRect().top).toBe(0);
    expect(latestShown()).toBe(true);
  });

  it("finds and highlights a far-off Markdown phrase without mounting the full transcript", async () => {
    const highlights = new Map<string, Set<Range>>();
    vi.stubGlobal("Highlight", class extends Set<Range> { priority = 0; constructor(...ranges: Range[]) { super(ranges); } });
    vi.stubGlobal("CSS", { escape: CSS.escape.bind(CSS), highlights });
    const log = syntheticLog(2000, true);
    const answer = log.filter((event) => event.payload.type === "assistant_text")[3];
    answer.payload = { type: "assistant_text", text: "The **elusive** [file](https://example.test) is here. Another elusive file." };
    const { transcript, view } = setup(2000, log);
    const far = transcript.turns[3].key;
    expect(content.querySelector(`[data-turn="${far}"]`)).toBeNull();
    const region = scroller.closest<HTMLElement>('[data-find-scope="chat"]')!;
    fireEvent.pointerDown(content);
    expect(document.activeElement).toBe(region);
    fireEvent.keyDown(region, { key: "f", ctrlKey: true });
    const field = screen.getByRole("textbox", { name: "Find in chat" });
    fireEvent.change(field, { target: { value: "elusive file" } });
    expect(screen.getByRole("status").textContent).toBe("1 of 2");
    expect(content.querySelector(`[data-turn="${far}"]`)).not.toBeNull();
    expect(content.querySelectorAll("[data-turn]").length).toBeLessThan(25);
    const shownTop = content.querySelector<HTMLElement>(`[data-turn="${far}"]`)!.getBoundingClientRect().top;
    expect(shownTop).toBeGreaterThanOrEqual(0);
    expect(shownTop).toBeLessThan(VIEWPORT);
    await act(async () => {}); // MutationObserver paints the newly mounted row.
    const selected = () => [...highlights.entries()].find(([name]) => name.endsWith("-active"))![1];
    expect([...selected()].map((range) => range.toString())).toEqual(["elusive file"]);
    fireEvent.keyDown(field, { key: "g", ctrlKey: true });
    expect(screen.getByRole("status").textContent).toBe("2 of 2");
    fireEvent.keyDown(field, { key: "g", ctrlKey: true, shiftKey: true });
    expect(screen.getByRole("status").textContent).toBe("1 of 2");
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(screen.getByRole("status").textContent).toBe("2 of 2");
    fireEvent.keyDown(field, { key: "Enter", keyCode: 229 });
    expect(screen.getByRole("status").textContent).toBe("2 of 2");
    const updated = { ...transcript, turns: [...transcript.turns, { ...transcript.turns.at(-1)!, key: "new", work: [], prompt: { seq: 99999, ts: "", text: "A new prompt" } }] };
    view.rerender(<Chat sessionId="s" transcript={updated} stream={[]} live answering={false} onAnswerPermission={() => {}} onAnswerQuestions={() => {}} footer={null} />);
    frame();
    expect(content.querySelector(`[data-turn="${far}"]`)).not.toBeNull();
    expect(latestShown()).toBe(true);
    const interrupt = vi.fn();
    const unbind = registerShortcut("session.interrupt", interrupt, { global: true });
    try {
      fireEvent.keyDown(field, { key: "Escape" });
      expect(screen.queryByRole("search", { name: "Find in chat" })).toBeNull();
      expect(interrupt).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(region);
      expect(highlights.size).toBe(0);
    } finally { unbind(); }
  });

  it("reveals folded reasoning and grouped Read output beyond its preview, then restores folds", () => {
    setPrefs({ foldToolCalls: true });
    const { transcript, view } = setup(4);
    const first = transcript.turns[0];
    const updated = { ...transcript, turns: [{ ...first, completed: { status: "ok", ts: "" }, work: [
      { kind: "reasoning" as const, key: "thought", seq: 1, text: "Consider the hidden clue" },
      { kind: "tool_group" as const, key: "group", name: "Read", calls: [
        { callId: "one", seq: 2, name: "Read", toolType: "file_read", input: {}, result: { isError: false, text: "x".repeat(21000) + "hidden clue" } },
        { callId: "two", seq: 3, name: "Read", toolType: "file_read", input: {}, result: { isError: false, text: "other" } },
      ] },
      { kind: "text" as const, key: "answer", seq: 4, text: "Finished." },
    ] }, ...transcript.turns.slice(1)] };
    view.rerender(<Chat sessionId="s" transcript={updated} stream={[]} live={false} answering={false} onAnswerPermission={() => {}} onAnswerQuestions={() => {}} footer={<textarea aria-label="Composer" />} />);
    const composer = screen.getByRole("textbox", { name: "Composer" });
    composer.focus();
    fireEvent.keyDown(composer, { key: "f", ctrlKey: true });
    const field = screen.getByRole("textbox", { name: "Find in chat" });
    fireEvent.change(field, { target: { value: "hidden clue" } });
    expect(screen.getByRole("status").textContent).toBe("1 of 2");
    expect(screen.getByText("Consider the hidden clue")).toBeTruthy();
    fireEvent.keyDown(field, { key: "g", ctrlKey: true });
    expect(screen.getByRole("status").textContent).toBe("2 of 2");
    expect(screen.getByText("x".repeat(21000) + "hidden clue")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Include tool output" }));
    expect(screen.getByRole("status").textContent).toBe("1 of 1");
    expect(screen.queryByText("x".repeat(21000) + "hidden clue")).toBeNull();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByText("Consider the hidden clue")).toBeNull();
    expect(document.activeElement).toBe(composer);
  });
});

// #771: the band of turns drawn runs through the turn holding its lower
// edge, which is on screen when it is taller than the overscan.
describe("the turns drawn for a view", () => {
  it("draws a turn taller than the overscan while the view is wholly inside it", () => {
    const { start, end } = visibleTurns([0, 500, 5500, 6000], 1000, 600, false);
    expect(start).toBeLessThanOrEqual(1);
    expect(end).toBeGreaterThan(1);
  });

  it("draws every turn on screen, wherever the view is over turns of 1500, 3000 and 6000 px", () => {
    const sizes = [300, 1500, 220, 3000, 6000, 180, 1500, 400, 6000, 3000, 260, 1500, 6000];
    const tops = sizes.reduce((list, size) => [...list, list[list.length - 1] + size], [0]);
    const listEnd = tops[sizes.length];
    const missed: string[] = [];
    for (const viewport of [200, 600, 900, 2000]) {
      for (let top = 0; top + viewport <= listEnd; top += 10) {
        const { start, end } = visibleTurns(tops, top, viewport, false);
        for (let turn = 0; turn < sizes.length; turn++) {
          const onScreen = tops[turn] < top + viewport && tops[turn + 1] > top;
          if (onScreen && (turn < start || turn >= end)) missed.push(`turn ${turn}, view of ${viewport} px at ${top}: drew [${start}, ${end})`);
        }
      }
    }
    expect(missed.slice(0, 10)).toEqual([]);
  });
});

// #250: a prompt typed into the agent's own terminal reaches the chat from
// the CLI's record of it, so its event has text and nothing the composer adds.
describe("a prompt the composer never saw", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", CapturingResizeObserver);
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("reduced-motion"),
      addEventListener() {},
      removeEventListener() {},
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("is drawn as the reader's message, ahead of the reply to it", () => {
    const base = { sessionId: "s", tabId: "t", harness: "claude" };
    const at = (seq: number) => new Date(1_700_000_000_000 + seq * 1000).toISOString();
    const transcript = buildTranscript(
      [
        { ...base, id: "e1", seq: 1, ts: at(1), payload: { type: "user_message", text: "sent from the composer", queued: false, baseline: "abc", cwd: "/tmp/repo" } },
        { ...base, id: "e2", seq: 2, ts: at(2), payload: { type: "assistant_text", text: "first reply" } },
        { ...base, id: "e3", seq: 3, ts: at(3), payload: { type: "turn_completed", status: "ok", authFailed: false } },
        // Text only: no baseline, cwd, images or `queued`.
        { ...base, id: "e4", seq: 4, ts: at(4), payload: { type: "user_message", text: "typed in the terminal" } as never },
        { ...base, id: "e5", seq: 5, ts: at(5), payload: { type: "assistant_text", text: "second reply" } },
        { ...base, id: "e6", seq: 6, ts: at(6), payload: { type: "turn_completed", status: "ok", authFailed: false } },
      ],
      false,
    );
    const view = render(
      <Chat
        sessionId="s"
        transcript={transcript}
        stream={[]}
        cwd="/tmp/repo"
        live={false}
        progressing={false}
        answering={false}
        onAnswerPermission={() => {}}
        onAnswerQuestions={() => {}}
        footer={null}
      />,
    );
    const text = view.container.textContent ?? "";
    const order = ["sent from the composer", "first reply", "typed in the terminal", "second reply"].map((part) => text.indexOf(part));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text.match(/typed in the terminal/g)).toHaveLength(1);
  });
});

// #551: a note left in a turn that is over offered a Send now that could only fail.
describe("a message sent while the agent worked", () => {
  const base = { sessionId: "s", tabId: "t", harness: "claude" };
  const at = (seq: number) => new Date(1_700_000_000_000 + seq * 1000).toISOString();

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", CapturingResizeObserver);
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduced-motion"), addEventListener() {}, removeEventListener() {} }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("can be sent now only while it waits behind the running turn", () => {
    const transcript = buildTranscript(
      [
        { ...base, id: "e1", seq: 1, ts: at(1), payload: { type: "user_message", text: "go", queued: false } },
        // Taken mid-turn in a log from before `prompt_absorbed`: nothing says so.
        { ...base, id: "e2", seq: 2, ts: at(2), payload: { type: "user_message", text: "taken long ago", queued: true } },
        { ...base, id: "e3", seq: 3, ts: at(3), payload: { type: "assistant_text", text: "done" } },
        { ...base, id: "e4", seq: 4, ts: at(4), payload: { type: "turn_completed", status: "ok", authFailed: false } },
        { ...base, id: "e5", seq: 5, ts: at(5), payload: { type: "user_message", text: "next", queued: false } },
        { ...base, id: "e6", seq: 6, ts: at(6), payload: { type: "user_message", text: "waiting now", queued: true } },
      ],
      true,
    );
    const sendNow = vi.fn();
    render(
      <TooltipProvider>
        <Chat sessionId="s" transcript={transcript} stream={[]} live answering={false} onAnswerPermission={() => {}} onAnswerQuestions={() => {}} footer={null} onSendQueuedNow={sendNow} />
      </TooltipProvider>,
    );
    expect(screen.getAllByTestId("queued-message").map((card) => card.textContent)).toEqual([expect.stringContaining("taken long ago"), expect.stringContaining("waiting now")]);
    expect(screen.getAllByTestId("reader-message").map((bubble) => bubble.textContent)).toEqual([expect.stringContaining("go"), expect.stringContaining("next")]);
    // One Send now, on the message behind the running turn.
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(sendNow).toHaveBeenCalledWith(6);
  });

  it("keeps a stopped turn historical while accepted queued input continues working (#627)", () => {
    const events: AgentEvent[] = [
      { ...base, id: "e1", seq: 1, ts: at(1), payload: { type: "user_message", text: "go", queued: false } },
      { ...base, id: "e2", seq: 2, ts: at(2), payload: { type: "user_message", text: "Please summarize progress before continuing.", queued: true } },
      { ...base, id: "e3", seq: 3, ts: at(3), payload: { type: "user_message", text: "Then list the remaining steps.", queued: true } },
      { ...base, id: "e4", seq: 4, ts: at(4), payload: { type: "turn_completed", status: "aborted", authFailed: false } },
      { ...base, id: "e5", seq: 5, ts: at(5), payload: { type: "turn_started", promptSeq: 2 } },
      { ...base, id: "e6", seq: 6, ts: at(6), payload: { type: "model_request_started" } },
    ];
    const sendNow = vi.fn();
    const view = (log: AgentEvent[]) => (
      <TooltipProvider>
        <Chat sessionId="s" transcript={buildTranscript(log, true)} stream={[]} live answering={false} onAnswerPermission={() => {}} onAnswerQuestions={() => {}} footer={null} onSendQueuedNow={sendNow} />
      </TooltipProvider>
    );
    const { rerender } = render(view(events));
    expect(screen.getByText("Stopped")).toBeTruthy();
    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.getAllByTestId("queued-message")).toHaveLength(1);
    expect(screen.getByTestId("queued-message").textContent).toContain("Then list the remaining steps.");
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(sendNow).toHaveBeenCalledWith(3);

    rerender(view([...events, { ...base, id: "e7", seq: 7, ts: at(7), payload: { type: "prompt_absorbed", promptSeq: 3 } }]));
    expect(screen.queryByTestId("queued-message")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
    expect(screen.getAllByTestId("reader-message")).toHaveLength(3);
    expect(screen.getByText("Working")).toBeTruthy();
  });

  it("offers no Send now once the turn it waited behind is over: the agent sends it itself", () => {
    const transcript = buildTranscript(
      [
        { ...base, id: "e1", seq: 1, ts: at(1), payload: { type: "user_message", text: "go", queued: false } },
        { ...base, id: "e2", seq: 2, ts: at(2), payload: { type: "user_message", text: "then this", queued: true } },
        { ...base, id: "e3", seq: 3, ts: at(3), payload: { type: "turn_completed", status: "ok", authFailed: false } },
      ],
      true,
    );
    render(
      <TooltipProvider>
        <Chat sessionId="s" transcript={transcript} stream={[]} live answering={false} onAnswerPermission={() => {}} onAnswerQuestions={() => {}} footer={null} onSendQueuedNow={vi.fn()} />
      </TooltipProvider>,
    );
    expect(screen.getByTestId("queued-message").textContent).toContain("then this");
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
  });
});

// A shared cloud tab opened here for the first time: its conversation is on its way.
describe("an empty chat", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", CapturingResizeObserver);
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduced-motion"), addEventListener() {}, removeEventListener() {} }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const empty = (loading?: boolean) =>
    render(<Chat sessionId="s" transcript={buildTranscript([], false)} stream={[]} live={false} loading={loading} answering={false} onAnswerPermission={() => {}} onAnswerQuestions={() => {}} footer={null} />);

  it("says it is loading while the conversation has not been read, not that nothing was said", () => {
    empty(true);
    expect(screen.getByRole("status").textContent).toContain("Loading the conversation…");
    expect(screen.queryByText(/Nothing here yet/)).toBeNull();
  });

  it("invites a first message once there is nothing to read", () => {
    empty();
    expect(screen.getByText("Nothing here yet. Ask for something below.")).toBeTruthy();
  });
});
