import "@testing-library/dom";

// jsdom lays nothing out and ships no ResizeObserver. Components observe
// their own boxes for re-fitting, so give them an observer that never fires;
// tests that need notifications stub a capturing one of their own.
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverNoop {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverNoop as unknown as typeof ResizeObserver;
}

// Nor does jsdom load fonts. Components that re-measure once the web fonts
// settle await document.fonts.ready; hand them an already-settled set.
if (typeof document !== "undefined" && !("fonts" in document)) {
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
}

// Nor does it measure text: a Range has no getClientRects or getBoundingClientRect. CodeMirror
// reads both when it measures its selection layer a frame after mounting, and without them it
// logs "textRange(...).getClientRects is not a function" under whichever test is running by then.
// Give every Range an empty answer, as a browser does for text that is not laid out.
if (typeof Range !== "undefined") {
  if (typeof Range.prototype.getClientRects !== "function") {
    Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  }
  if (typeof Range.prototype.getBoundingClientRect !== "function") {
    Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON() {} }) as DOMRect;
  }
}
