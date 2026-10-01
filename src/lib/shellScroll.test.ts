// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { READER_SCROLL_EVENT, isShellBox, keepShellUnscrolled, revealInOwnScroller, scrollToInOwnScroller } from "./shellScroll";

/** jsdom lays nothing out: give an element a scroll position that can be written. */
function scrollable(element: HTMLElement, top = 0) {
  let value = top;
  Object.defineProperty(element, "scrollTop", { configurable: true, get: () => value, set: (next: number) => (value = next) });
  return element;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the app's outer boxes never scroll", () => {
  it("undoes a scroll of the root or the app shell at once, and leaves a view's own scroller alone", () => {
    document.body.innerHTML = '<div id="root"><div data-app-shell><div id="transcript"></div></div></div>';
    const root = scrollable(document.getElementById("root")!);
    const shell = scrollable(document.querySelector<HTMLElement>("[data-app-shell]")!);
    const transcript = scrollable(document.getElementById("transcript")!);
    const stop = keepShellUnscrolled();

    // What focus() or scrollIntoView() did to `overflow: hidden` boxes: the whole app moved up.
    root.scrollTop = 584;
    root.dispatchEvent(new Event("scroll"));
    shell.scrollTop = 120;
    shell.dispatchEvent(new Event("scroll"));
    transcript.scrollTop = 300;
    transcript.dispatchEvent(new Event("scroll"));

    expect(root.scrollTop).toBe(0);
    expect(shell.scrollTop).toBe(0);
    expect(transcript.scrollTop).toBe(300);

    stop();
    root.scrollTop = 40;
    root.dispatchEvent(new Event("scroll"));
    expect(root.scrollTop).toBe(40);
  });

  it("knows the shell's boxes", () => {
    document.body.innerHTML = '<div id="root"><div data-app-shell><main></main></div></div>';
    expect(isShellBox(document.documentElement)).toBe(true);
    expect(isShellBox(document.body)).toBe(true);
    expect(isShellBox(document.getElementById("root")!)).toBe(true);
    expect(isShellBox(document.querySelector("[data-app-shell]")!)).toBe(true);
    expect(isShellBox(document.querySelector("main")!)).toBe(false);
  });
});

describe("a jump within a scroller", () => {
  it("moves only the nearest scroller that holds the target, and tells it the reader asked", () => {
    document.body.innerHTML = '<div id="root"><div id="outer" style="overflow-y: hidden"><div id="scroller" style="overflow-y: auto"><h2 id="target"></h2></div></div></div>';
    const outer = scrollable(document.getElementById("outer")!);
    const scroller = scrollable(document.getElementById("scroller")!, 100);
    const target = document.getElementById("target")!;
    scroller.getBoundingClientRect = () => new DOMRect(0, 50, 0, 400);
    target.getBoundingClientRect = () => new DOMRect(0, 350, 0, 20);
    let asked = 0;
    scroller.addEventListener(READER_SCROLL_EVENT, () => asked++);

    scrollToInOwnScroller(target);

    expect(scroller.scrollTop).toBe(400);
    expect(outer.scrollTop).toBe(0);
    expect(asked).toBe(1);
  });

  it("reveals a target by the smallest move of its own scroller, and not at all when it already shows", () => {
    document.body.innerHTML = '<div id="root"><div id="outer" style="overflow-y: hidden"><div id="scroller" style="overflow-y: auto"><button id="target"></button></div></div></div>';
    const outer = scrollable(document.getElementById("outer")!);
    const scroller = scrollable(document.getElementById("scroller")!, 100);
    const target = document.getElementById("target")!;
    scroller.getBoundingClientRect = () => new DOMRect(0, 50, 0, 400);
    let asked = 0;
    scroller.addEventListener(READER_SCROLL_EVENT, () => asked++);

    // Below the fold by 30px.
    target.getBoundingClientRect = () => new DOMRect(0, 460, 0, 20);
    revealInOwnScroller(target);
    expect(scroller.scrollTop).toBe(130);
    // Above it by 40px.
    target.getBoundingClientRect = () => new DOMRect(0, 10, 0, 20);
    revealInOwnScroller(target);
    expect(scroller.scrollTop).toBe(90);
    // In view: nothing moves.
    target.getBoundingClientRect = () => new DOMRect(0, 200, 0, 20);
    revealInOwnScroller(target);
    expect(scroller.scrollTop).toBe(90);
    // Not the reader's doing, and never the boxes above.
    expect(asked).toBe(0);
    expect(outer.scrollTop).toBe(0);
  });
});
