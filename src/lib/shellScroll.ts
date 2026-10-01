/**
 * The boxes that hold the whole app never scroll: the document, `body`,
 * `#root` and the app shell. `overflow: clip` (app.css) makes them unscrollable
 * where the engine has it; `overflow: hidden` alone still lets `focus()` and
 * `scrollIntoView()` scroll them, which leaves the header and the top of the
 * sidebar cut off with no way back. This undoes any such scroll at once, for
 * engines without `clip` (WebKit before Safari 16).
 */
export function isShellBox(element: Element): boolean {
  return element === document.scrollingElement || element === document.documentElement || element === document.body || element.id === "root" || element.hasAttribute("data-app-shell");
}

export function keepShellUnscrolled(): () => void {
  const reset = (event: Event) => {
    const target = event.target === document ? document.scrollingElement : event.target;
    if (!(target instanceof Element) || !isShellBox(target)) return;
    if (target.scrollTop !== 0) target.scrollTop = 0;
    if (target.scrollLeft !== 0) target.scrollLeft = 0;
  };
  // Scroll events do not bubble; capturing on the document sees them all.
  document.addEventListener("scroll", reset, true);
  return () => document.removeEventListener("scroll", reset, true);
}

/** Sent to a scroller just before it is scrolled on the reader's behalf (a link they followed), so a view that follows its bottom lets go. */
export const READER_SCROLL_EVENT = "terminalx:reader-scroll";

/** The nearest box that scrolls `target` vertically, short of the shell's own boxes. */
function ownScroller(target: HTMLElement): HTMLElement | null {
  for (let node = target.parentElement; node && !isShellBox(node); node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

/**
 * Bring `target` to the top of the nearest scroller that holds it, and move
 * nothing else: unlike `scrollIntoView()`, no ancestor of that scroller scrolls.
 */
export function scrollToInOwnScroller(target: HTMLElement): void {
  const scroller = ownScroller(target);
  if (!scroller) return;
  scroller.dispatchEvent(new Event(READER_SCROLL_EVENT));
  scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
}

/**
 * `scrollIntoView({ block: "nearest" })` confined to the nearest scroller that
 * holds `target`: it moves as little as shows the target, and nothing above it
 * moves at all. With `focus({ preventScroll: true })` this is how something
 * that appears by itself (a permission request) takes focus without the
 * window following it.
 */
export function revealInOwnScroller(target: HTMLElement): void {
  const scroller = ownScroller(target);
  if (!scroller) return;
  const box = scroller.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  if (rect.top < box.top) scroller.scrollTop -= box.top - rect.top;
  else if (rect.bottom > box.bottom) scroller.scrollTop += Math.min(rect.bottom - box.bottom, rect.top - box.top);
}
