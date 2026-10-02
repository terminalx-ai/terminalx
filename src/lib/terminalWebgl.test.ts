import { beforeEach, describe, expect, it, vi } from "vitest";

const addons = vi.hoisted(() => ({ made: [] as { lose: () => void; disposed: boolean }[], refuse: false }));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    disposed = false;
    private listener: (() => void) | null = null;
    constructor() {
      if (addons.refuse) throw new Error("no WebGL2");
      addons.made.push(this as never);
    }
    onContextLoss(listener: () => void) {
      this.listener = listener;
    }
    dispose() {
      this.disposed = true;
    }
    /** The browser took the context away. */
    lose() {
      this.listener?.();
    }
  },
}));

vi.mock("@/lib/api", () => ({ pty: {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

/** A terminal whose addon puts a canvas in its element, as the real one does. */
function terminal() {
  const element = document.createElement("div");
  const loseContext = vi.fn();
  const term = {
    element,
    loadAddon: vi.fn(() => {
      // As the real addon: a 2D canvas for links first, then the WebGL one.
      const links = document.createElement("canvas");
      links.className = "xterm-link-layer";
      links.getContext = (() => null) as never;
      element.appendChild(links);
      const canvas = document.createElement("canvas");
      canvas.getContext = (() => ({ getExtension: () => ({ loseContext }) })) as never;
      element.appendChild(canvas);
    }),
  };
  return { term: term as never, loseContext, loads: term.loadAddon };
}

async function load() {
  vi.resetModules();
  return { webgl: await import("./terminalWebgl"), counters: await import("./terminalCounters"), store: await import("./terminal") };
}

beforeEach(() => {
  addons.made.length = 0;
  addons.refuse = false;
  vi.useRealTimers();
});

describe("WebGL contexts", () => {
  it("gives a terminal a context when it is shown and releases it for good when the terminal goes", async () => {
    const { webgl, counters } = await load();
    const a = terminal();
    expect(counters.rendererOf(a.term)).toBe("dom");
    webgl.showWebgl(a.term);
    expect(counters.rendererOf(a.term)).toBe("webgl");
    // Shown again (another view, a re-render): still one context.
    webgl.showWebgl(a.term);
    expect(a.loads).toHaveBeenCalledTimes(1);

    webgl.dropWebgl(a.term);
    expect(addons.made[0].disposed).toBe(true);
    // Not left to the garbage collector: the browser stops counting it now.
    expect(a.loseContext).toHaveBeenCalledTimes(1);
    expect(counters.rendererOf(a.term)).toBe("dom");
    expect(counters.webglContexts).toEqual({ created: 1, lost: 0, failed: 0 });
  });

  it("releases the context of a terminal the store disposes", async () => {
    const { webgl, store } = await load();
    const a = terminal();
    const inst = store.getInstance("p1", () => ({ el: document.createElement("div"), term: Object.assign(a.term, { dispose: vi.fn() }), fit: {} }) as never);
    webgl.showWebgl(inst.term);
    store.disposeInstance("p1");
    expect(a.loseContext).toHaveBeenCalledTimes(1);
  });

  it("keeps the most recently shown hidden terminals on WebGL and no more than the budget", async () => {
    const { webgl, counters } = await load();
    const terminals = Array.from({ length: webgl.WEBGL_BUDGET + 3 }, terminal);
    for (const { term } of terminals) {
      webgl.showWebgl(term);
      webgl.hideWebgl(term);
    }
    const renderers = terminals.map(({ term }) => counters.rendererOf(term));
    expect(renderers.slice(0, 3)).toEqual(["dom", "dom", "dom"]);
    expect(renderers.slice(3).every((renderer) => renderer === "webgl")).toBe(true);
    expect(terminals.slice(0, 3).every(({ loseContext }) => loseContext.mock.calls.length === 1)).toBe(true);

    // Going back to the oldest survivor makes it the newest; the next one out is the one after it.
    webgl.showWebgl(terminals[3].term);
    webgl.hideWebgl(terminals[3].term);
    webgl.showWebgl(terminals[0].term);
    webgl.hideWebgl(terminals[0].term);
    expect(counters.rendererOf(terminals[3].term)).toBe("webgl");
    expect(counters.rendererOf(terminals[4].term)).toBe("dom");
    expect(counters.rendererOf(terminals[0].term)).toBe("webgl");
  });

  it("never takes a context from a terminal that is on screen, whatever the budget", async () => {
    const { webgl, counters } = await load();
    const terminals = Array.from({ length: webgl.WEBGL_BUDGET + 2 }, terminal);
    for (const { term } of terminals) webgl.showWebgl(term);
    expect(terminals.every(({ term }) => counters.rendererOf(term) === "webgl")).toBe(true);
    webgl.hideWebgl(terminals[0].term);
    expect(counters.rendererOf(terminals[0].term)).toBe("dom");
    expect(counters.rendererOf(terminals[1].term)).toBe("webgl");
  });

  it("gives a terminal on screen a new context when the browser takes its own, and a hidden one none", async () => {
    vi.useFakeTimers();
    const { webgl, counters } = await load();
    const shown = terminal();
    const hidden = terminal();
    webgl.showWebgl(shown.term);
    webgl.showWebgl(hidden.term);
    webgl.hideWebgl(hidden.term);

    addons.made[0].lose();
    addons.made[1].lose();
    expect(counters.rendererOf(shown.term)).toBe("dom");
    vi.runAllTimers();
    expect(counters.rendererOf(shown.term)).toBe("webgl");
    expect(counters.rendererOf(hidden.term)).toBe("dom");
    expect(counters.webglContexts).toEqual({ created: 3, lost: 2, failed: 0 });

    // It gets one when it is next shown.
    webgl.showWebgl(hidden.term);
    expect(counters.rendererOf(hidden.term)).toBe("webgl");
  });

  it("replaces a lost context as soon as the browser says so, without the addon's three-second wait", async () => {
    vi.useFakeTimers();
    const { webgl, counters } = await load();
    const { term } = terminal();
    webgl.showWebgl(term);
    (term as { element: HTMLElement }).element.querySelector("canvas")!.dispatchEvent(new Event("webglcontextlost"));
    vi.runAllTimers();
    expect(counters.rendererOf(term)).toBe("webgl");
    // The addon's own late report of the same loss changes nothing.
    addons.made[0].lose();
    vi.runAllTimers();
    expect(counters.webglContexts).toEqual({ created: 2, lost: 1, failed: 0 });
  });

  it("waits before asking again when the browser keeps taking the context away, and does ask again", async () => {
    vi.useFakeTimers();
    const { webgl, counters } = await load();
    const { term } = terminal();
    webgl.showWebgl(term);
    for (let round = 0; round < 6; round++) {
      addons.made.at(-1)!.lose();
      vi.advanceTimersByTime(1);
    }
    // Six losses in a moment: no seventh context straight away.
    expect(counters.rendererOf(term)).toBe("dom");
    expect(counters.webglContexts.created).toBe(6);
    // Still on screen once things have settled: it is not left on the fallback.
    vi.advanceTimersByTime(10_000);
    expect(counters.rendererOf(term)).toBe("webgl");
    expect(counters.webglContexts.created).toBe(7);
  });

  it("leaves the DOM renderer in place when WebGL is refused, and does not ask on every show", async () => {
    vi.useFakeTimers();
    const { webgl, counters } = await load();
    addons.refuse = true;
    const { term } = terminal();
    webgl.showWebgl(term);
    webgl.hideWebgl(term);
    webgl.showWebgl(term);
    expect(counters.rendererOf(term)).toBe("dom");
    expect(counters.webglRefused()).toBe(true);
    expect(counters.webglContexts).toEqual({ created: 0, lost: 0, failed: 1 });

    // Later it is worth one more try, and a success clears the verdict.
    addons.refuse = false;
    vi.advanceTimersByTime(30_000);
    webgl.showWebgl(term);
    expect(counters.rendererOf(term)).toBe("webgl");
    expect(counters.webglRefused()).toBe(false);
  });
});
