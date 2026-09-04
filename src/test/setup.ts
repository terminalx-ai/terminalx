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
