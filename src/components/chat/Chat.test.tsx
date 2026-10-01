import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "./Chat";
import { buildTranscript } from "@/lib/transcript";
import { syntheticLog } from "@/demo/synthetic";
import type { StreamBlock } from "@/lib/agentEvents";
import { READER_SCROLL_EVENT } from "@/lib/shellScroll";

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
const latestShown = () => screen.getByRole("button", { name: /latest/i }).parentElement!.classList.contains("opacity-100");

function setup(turnCount: number) {
  const transcript = buildTranscript(syntheticLog(turnCount, true), true);
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
  const view = render(<Chat {...props} stream={stream()} />);
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

  it("holds the reader's paragraph while older turns backfill above, including scrolling during a step", () => {
    vi.useFakeTimers();
    const { transcript, turnTop } = setup(40);
    const reading = transcript.turns[transcript.turns.length - 3].key;
    wheel(-400);
    const seen = turnTop(reading);

    act(() => {
      vi.advanceTimersByTime(0);
      // The reader keeps scrolling while the step renders.
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -50 }));
      setTop(top - 50);
    });
    frame();
    act(() => {
      vi.advanceTimersToNextFrame();
    });
    expect(turnTop(reading)).toBe(seen + 50);

    for (let i = 0; i < 4; i++) {
      act(() => {
        vi.advanceTimersByTime(0);
      });
      frame();
      act(() => {
        vi.advanceTimersToNextFrame();
      });
    }
    expect(content.querySelectorAll("[data-turn]")).toHaveLength(40);
    expect(turnTop(reading)).toBe(seen + 50);
    expect(latestShown()).toBe(true);
  });
});
