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
