import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";

/**
 * The real xterm and the real WebGL addon, with only the canvas contexts
 * stubbed (jsdom has none). What matters here is which canvas the addon
 * creates and in what order, and which timers it leaves behind: a mock of the
 * addon cannot get either wrong.
 */
vi.mock("@/lib/api", () => ({ pty: {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const loseContext = vi.fn();

/** A context that accepts every call: enough for the addon to set itself up. */
function context(canvas: HTMLCanvasElement, overrides: Record<string, unknown>) {
  return new Proxy(overrides, {
    get(target, key) {
      if (key in target) return target[key as string];
      if (key === "canvas") return canvas;
      return () => ({ width: 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2, data: new Uint8ClampedArray(4) });
    },
    set: () => true,
  });
}

const contexts = new WeakMap<HTMLCanvasElement, Map<string, unknown>>();
let webgl2 = true;

beforeEach(() => {
  vi.resetModules();
  loseContext.mockClear();
  webgl2 = true;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement, kind: string) {
    if (kind === "webgl2" && !webgl2) return null;
    const mine = contexts.get(this) ?? new Map<string, unknown>();
    contexts.set(this, mine);
    // As in a browser: a canvas has one kind of context, and asking for another gives none.
    if (mine.size && !mine.has(kind)) return null;
    if (!mine.has(kind)) {
      mine.set(
        kind,
        kind === "webgl2"
          ? context(this, {
              getExtension: (name: string) => (name === "WEBGL_lose_context" ? { loseContext } : {}),
              getParameter: () => 4096,
              getShaderParameter: () => true,
              getProgramParameter: () => true,
            })
          : context(this, {}),
      );
    }
    return mine.get(kind) as never;
  } as never);
  window.matchMedia ??= (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) as never;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

async function shown() {
  const webgl = await import("./terminalWebgl");
  const counters = await import("./terminalCounters");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const term = new Terminal({ allowProposedApi: true, cursorBlink: true });
  term.open(host);
  webgl.showWebgl(term);
  return { webgl, counters, term };
}

describe("WebGL contexts, with the real addon", () => {
  it("finds the addon's WebGL canvas, which is not the first one it adds", async () => {
    const { counters, term } = await shown();
    expect(counters.rendererOf(term)).toBe("webgl");
    const canvases = [...term.element!.querySelectorAll("canvas")];
    // The 2D link layer comes first; the WebGL canvas after it.
    expect(canvases.map((canvas) => canvas.classList.contains("xterm-link-layer"))).toEqual([true, false]);
  });

  it("releases the context when the terminal goes", async () => {
    const { webgl, term } = await shown();
    webgl.dropWebgl(term);
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  it("replaces a context the moment the browser takes it", async () => {
    vi.useFakeTimers();
    const { counters, term } = await shown();
    const gl = [...term.element!.querySelectorAll("canvas")].find((canvas) => !canvas.classList.contains("xterm-link-layer"))!;
    gl.dispatchEvent(new Event("webglcontextlost"));
    expect(counters.webglContexts.lost).toBe(1);
    expect(counters.rendererOf(term)).toBe("dom");
    vi.advanceTimersByTime(1);
    expect(counters.rendererOf(term)).toBe("webgl");
    expect(counters.webglContexts.created).toBe(2);
  });

  it("leaves no timer running after a focused, blinking terminal is closed", async () => {
    vi.useFakeTimers();
    const { webgl, term } = await shown();
    // What focus does to the renderer: the cursor starts to blink on an interval.
    (term as unknown as { _core: { _renderService: { handleFocus(): void } } })._core._renderService.handleFocus();
    vi.advanceTimersByTime(2000);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    term.dispose();
    webgl.dropWebgl(term);
    // Without stopping the addon's blink timer one interval stays, and with it the whole terminal.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("asks once, not on every show, where there is no WebGL2", async () => {
    webgl2 = false;
    const { webgl, counters, term } = await shown();
    expect(counters.rendererOf(term)).toBe("dom");
    expect(counters.webglRefused()).toBe(true);
    for (let round = 0; round < 5; round++) {
      webgl.hideWebgl(term);
      webgl.showWebgl(term);
    }
    expect(counters.webglContexts).toEqual({ created: 0, lost: 0, failed: 1 });
  });
});

it("preserves scrollback, alternate-screen content and pending terminal input across recovery", async () => {
  const { webgl, term } = await shown();
  const write = (text: string) => new Promise<void>((resolve) => term.write(text, resolve));
  await write("synthetic history\r\nsynthetic draft");
  const normal = term.buffer.normal.getLine(0)!.translateToString(true);
  await write("\x1b[?1049hsynthetic full-screen view");
  const alternate = term.buffer.active.getLine(0)!.translateToString(true);
  const input = vi.fn();
  const listener = term.onData(input);
  webgl.recoverWebgl(term);
  expect(term.buffer.normal.getLine(0)!.translateToString(true)).toBe(normal);
  expect(term.buffer.active.getLine(0)!.translateToString(true)).toBe(alternate);
  expect(input).not.toHaveBeenCalled();
  await write("\x1b[?1049l");
  expect(term.buffer.active.getLine(1)!.translateToString(true)).toContain("synthetic draft");
  listener.dispose();
  webgl.dropWebgl(term);
  term.dispose();
});

/** Source-only diagnostic draft: these are ordinary assertions, NOT expected-failure
 * tests. An uncancelled last-owner warm-up must fail, not receive a green xfail.
 * No reachability/GC/memory claim follows from this scheduler fixture.
 */
describe("atlas held-idle lifecycle (real addon)", () => {
  type Atlas = {
    warmUp(): void;
    dispose(): void;
    _drawToCache(...args: unknown[]): unknown;
  };
  type Trace = { action: string; atlas: number; handle?: number; callback?: number; branch?: string; draws?: number };
  type Primary = { error: unknown };
  type CleanupErrors = { count: number; entries: { stage: string; error: string }[] };
  type CleanupOwner = {
    term?: { dispose(): void };
    host: { remove(): void };
    closeAttempted?: boolean;
    disposeCompleted?: boolean;
  };

  function cleanupAttempt(errors: CleanupErrors, stage: string, operation: () => void): boolean {
    try { operation(); return true; }
    catch (error) {
      errors.count++;
      if (errors.entries.length < 16) {
        let message = "unprintable cleanup error";
        try { message = String(error).slice(0, 512); } catch { /* keep bounded fallback */ }
        errors.entries.push({ stage, error: message });
      }
      return false;
    }
  }

  function closeAtlasOwner<T extends CleanupOwner>(owner: T, drop: (term: NonNullable<T["term"]>) => void, errors: CleanupErrors) {
    if (owner.closeAttempted) return;
    owner.closeAttempted = true; // Do not blindly retry a partially failed disposal.
    const term = owner.term;
    if (term) {
      cleanupAttempt(errors, "dropWebgl", () => drop(term as NonNullable<T["term"]>));
      owner.disposeCompleted = cleanupAttempt(errors, "term.dispose", () => term.dispose());
      if (owner.disposeCompleted) owner.term = undefined;
      // A failed disposal retains its handle/status until the fixture leaves scope;
      // clearing DOM or scheduler roots is not reported as successful disposal.
    }
    cleanupAttempt(errors, "host.remove", () => owner.host.remove());
  }

  function finishAtlasCleanup(primary: Primary | undefined, errors: CleanupErrors,
    steps: { stage: string; run: () => void }[], report: () => void) {
    for (const step of steps) cleanupAttempt(errors, step.stage, step.run);
    cleanupAttempt(errors, "cleanup.report", report);
    if (primary) throw primary.error; // Preserve even a thrown undefined/null value.
    if (errors.count) throw new Error(`ATLAS_FIXTURE_INCONCLUSIVE: ${errors.count} cleanup errors: ${JSON.stringify(errors.entries)}`);
  }

  function reachable(condition: unknown, reason: string): asserts condition {
    if (!condition) throw new Error(`ATLAS_FIXTURE_INCONCLUSIVE: ${reason}`);
  }

  async function heldAtlas() {
    vi.useFakeTimers();
    // Real CharSizeService DOM measurement, supplied jsdom's missing layout.
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("xterm-char-measure-element") ? 32 * 8 : 640;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("xterm-char-measure-element") ? 16 : 384;
    });
    const webgl = await import("./terminalWebgl");
    const counters = await import("./terminalCounters");
    type Owner = CleanupOwner & { term?: Terminal; host: HTMLDivElement; atlas: number };
    const owners: Owner[] = [];
    const atlasIds = new WeakMap<object, number>();
    const callbackIds = new WeakMap<Function, number>();
    const draws = new Map<number, number>();
    const trace: Trace[] = [];
    const cleanupErrors: CleanupErrors = { count: 0, entries: [] };
    const pending = new Map<number, { run: () => void; atlas: number; callback: number; branch: string }>();
    let nextAtlas = 0;
    let nextCallback = 0;
    let nextHandle = 1_000_000;
    let activeAtlas = 0;
    let warmCalls = 0;
    let prototype: Atlas | undefined;
    let warmUp: Atlas["warmUp"] | undefined;
    let draw: Atlas["_drawToCache"] | undefined;
    let dispose: Atlas["dispose"] | undefined;
    const globalNames = ["setTimeout", "clearTimeout", "requestIdleCallback", "cancelIdleCallback"] as const;
    const descriptors = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const timeout = globalThis.setTimeout;
    const clear = globalThis.clearTimeout;
    let finished = false;
    const atlasOf = (term: Terminal) => (term as unknown as {
      _core: { _renderService: { _renderer: { value?: { _charAtlas?: Atlas } } } };
    })._core._renderService._renderer.value?._charAtlas;
    const number = (atlas: Atlas) => {
      let id = atlasIds.get(atlas);
      if (!id) { id = ++nextAtlas; atlasIds.set(atlas, id); }
      return id;
    };
    const close = (owner: Owner) => {
      const before = cleanupErrors.count;
      closeAtlasOwner(owner, (term) => webgl.dropWebgl(term), cleanupErrors);
      if (cleanupErrors.count !== before) throw new Error("ATLAS_FIXTURE_INCONCLUSIVE: explicit owner close failed");
    };
    const finish = (primary?: Primary) => {
      if (finished) {
        if (primary) throw primary.error;
        if (cleanupErrors.count) throw new Error("ATLAS_FIXTURE_INCONCLUSIVE: prior cleanup failed");
        return;
      }
      finished = true;
      const steps = owners.map((owner) => ({ stage: "owner.close", run: () => closeAtlasOwner(owner, (term) => webgl.dropWebgl(term), cleanupErrors) }));
      steps.push({ stage: "pending.clear", run: () => pending.clear() });
      if (prototype && warmUp && draw && dispose) {
        const target = prototype, originalWarm = warmUp, originalDraw = draw, originalDispose = dispose;
        steps.push({ stage: "restore.warmUp", run: () => { target.warmUp = originalWarm; } },
          { stage: "restore.draw", run: () => { target._drawToCache = originalDraw; } },
          { stage: "restore.dispose", run: () => { target.dispose = originalDispose; } });
      }
      for (const name of globalNames) steps.push({ stage: `restore.${name}`, run: () => {
        const descriptor = descriptors.get(name);
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else if (!Reflect.deleteProperty(globalThis, name)) throw new Error(`cannot restore absent ${name}`);
      } });
      steps.push({ stage: "timers.clear", run: () => vi.clearAllTimers() });
      finishAtlasCleanup(primary, cleanupErrors, steps, () => {
        console.info("ATLAS_LIFECYCLE_TRACE", JSON.stringify(trace));
        console.info("ATLAS_CLEANUP", JSON.stringify({ primaryPresent: primary !== undefined, errors: cleanupErrors,
          owners: owners.map((owner) => ({ atlas: owner.atlas, attempted: owner.closeAttempted === true, disposed: owner.disposeCompleted === true })) }));
      });
    };
    const open = () => {
      const host = document.createElement("div");
      document.body.appendChild(host);
      const owner: Owner = { term: new Terminal({ allowProposedApi: true, cursorBlink: false }), host, atlas: 0 };
      owners.push(owner);
      owner.term!.open(host);
      webgl.showWebgl(owner.term!);
      reachable(counters.rendererOf(owner.term!) === "webgl", "actual addon activation failed");
      const atlas = atlasOf(owner.term!);
      reachable(atlas, "actual renderer did not acquire an atlas");
      owner.atlas = number(atlas);
      return owner;
    };
    try {
      // Discover the installed class prototype, not an imitation/import of its
      // private source. Dispose this seed before any measured owner is opened.
      prototype = (() => {
        const seed = open();
        const seedAtlas = atlasOf(seed.term!);
        reachable(seedAtlas, "seed atlas unavailable");
        const discovered = Object.getPrototypeOf(seedAtlas) as Atlas;
        close(seed);
        return discovered; // No seed atlas/terminal escapes this scope.
      })();
      reachable(typeof prototype.warmUp === "function" && typeof prototype._drawToCache === "function" &&
        typeof prototype.dispose === "function", "installed atlas observation points changed");
      vi.clearAllTimers(); // Seed warm-up is not dispatched or counted.
      warmUp = prototype.warmUp;
      draw = prototype._drawToCache;
      dispose = prototype.dispose;
      const realWarmUp = warmUp;
      const realDraw = draw;
      const realDispose = dispose;
      // Plain wrappers avoid vi.spyOn's retained this/argument sample arrays.
      prototype.warmUp = function () {
        const previous = activeAtlas;
        activeAtlas = number(this);
        warmCalls++;
        trace.push({ action: "warmUp", atlas: activeAtlas });
        try { return realWarmUp.call(this); } finally { activeAtlas = previous; }
      };
      prototype._drawToCache = function (...args) {
        const result = realDraw.apply(this, args); // Real installed raster path.
        const id = number(this);
        draws.set(id, (draws.get(id) ?? 0) + 1);
        return result;
      };
      prototype.dispose = function () {
        trace.push({ action: "dispose", atlas: number(this), draws: draws.get(number(this)) ?? 0 });
        return realDispose.call(this);
      };
      const hold = (branch: string, callback: Function, run: () => void) => {
        const handle = nextHandle++;
        let identity = callbackIds.get(callback);
        if (!identity) { identity = ++nextCallback; callbackIds.set(callback, identity); }
        pending.set(handle, { run, atlas: activeAtlas, callback: identity, branch });
        trace.push({ action: "schedule", atlas: activeAtlas, handle, callback: identity, branch });
        return handle;
      };
      const cancel = (handle: number) => {
        const job = pending.get(handle);
        if (!job) return false;
        pending.delete(handle);
        trace.push({ action: "cancel", atlas: job.atlas, handle, callback: job.callback, branch: job.branch });
        return true;
      };
      globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
        if (activeAtlas) return hold("PriorityTaskQueue/setTimeout", callback, () => callback(...args));
        return timeout(callback, delay, ...args);
      }) as unknown as typeof setTimeout;
      globalThis.clearTimeout = ((handle: number) => { if (!cancel(handle)) clear(handle); }) as typeof clearTimeout;
      globalThis.requestIdleCallback = (callback) => {
        if (activeAtlas) return hold("IdleTaskQueue/requestIdleCallback", callback, () => callback({ didTimeout: false, timeRemaining: () => 1000 }));
        return timeout(() => callback({ didTimeout: false, timeRemaining: () => 1000 }), 0) as unknown as number;
      };
      globalThis.cancelIdleCallback = (handle) => { if (!cancel(handle)) clear(handle); };
      const dispatch = () => {
        let steps = 0;
        while (pending.size) {
          reachable(++steps <= 256, "warm-up did not drain within callback bound");
          const [handle, job] = pending.entries().next().value!;
          pending.delete(handle); // Remove scheduler root before invoking it.
          const previous = activeAtlas;
          activeAtlas = job.atlas;
          trace.push({ action: "dispatch", atlas: job.atlas, handle, callback: job.callback, branch: job.branch });
          try { job.run(); }
          catch (error) { throw new Error(`ATLAS_FIXTURE_INCONCLUSIVE: real warm-up dispatch failed: ${String(error)}`); }
          finally { activeAtlas = previous; }
        }
      };
      const ready = (owner: Owner) => {
        reachable(warmCalls > 0 && [...pending.values()].some((job) => job.atlas === owner.atlas),
          "real warmUp never scheduled a held callback; no lifecycle conclusion");
        reachable((draws.get(owner.atlas) ?? 0) === 0, "glyph work ran before held dispatch");
      };
      return { open, close, ready, dispatch, finish, trace,
        pendingCount: () => pending.size, draws: (owner: Owner) => draws.get(owner.atlas) ?? 0 };
    } catch (error) {
      finish({ error });
      throw error;
    }
  }

  it("preserves the primary diagnostic while exceptional cleanup attempts every owner and restoration", () => {
    const events: string[] = [];
    const errors: CleanupErrors = { count: 0, entries: [] };
    const primary = new Error("original lifecycle diagnostic");
    const failedTerm = { dispose() { events.push("first.dispose"); throw new Error("disposal failed"); } };
    const first: CleanupOwner = { term: failedTerm, host: { remove() { events.push("first.remove"); } } };
    const second: CleanupOwner = { term: { dispose() { events.push("second.dispose"); } },
      host: { remove() { events.push("second.remove"); } } };
    let caught: unknown;
    try {
      finishAtlasCleanup({ error: primary }, errors, [
        { stage: "first.close", run: () => closeAtlasOwner(first, () => { events.push("first.drop"); }, errors) },
        { stage: "second.close", run: () => closeAtlasOwner(second, () => { events.push("second.drop"); }, errors) },
        { stage: "restore.first", run: () => { events.push("restore.first"); throw new Error("restoration failed"); } },
        { stage: "restore.second", run: () => { events.push("restore.second"); } },
      ], () => { events.push("report"); });
    } catch (error) { caught = error; }
    expect(caught).toBe(primary);
    expect(events).toEqual(["first.drop", "first.dispose", "first.remove", "second.drop", "second.dispose",
      "second.remove", "restore.first", "restore.second", "report"]);
    expect(first.closeAttempted).toBe(true);
    expect(first.disposeCompleted).toBe(false);
    expect(first.term).toBe(failedTerm);
    expect(second.disposeCompleted).toBe(true);
    expect(second.term).toBeUndefined();
    expect(errors.count).toBe(2);
    expect(errors.entries.map((entry) => entry.stage)).toEqual(["term.dispose", "restore.first"]);
    closeAtlasOwner(first, () => { events.push("unexpected retry"); }, errors);
    expect(events).toHaveLength(9);
    // Without a primary diagnostic, the same recorded cleanup errors cannot pass.
    expect(() => finishAtlasCleanup(undefined, errors, [], () => {})).toThrow("ATLAS_FIXTURE_INCONCLUSIVE: 2 cleanup errors");
  });

  it("runs real warm-up for a live atlas (reachability control)", async () => {
    const fixture = await heldAtlas();
    let primary: Primary | undefined;
    try {
      const owner = fixture.open();
      fixture.ready(owner);
      fixture.dispatch();
      reachable(fixture.draws(owner) > 0, "scheduled callbacks produced no real glyph work");
      expect(fixture.pendingCount()).toBe(0);
    } catch (error) { primary = { error }; }
    finally { fixture.finish(primary); }
  });

  it("cancels held warm-up when the last owner closes", async () => {
    const fixture = await heldAtlas();
    let primary: Primary | undefined;
    try {
      const owner = fixture.open();
      fixture.ready(owner);
      fixture.close(owner);
      const pendingAfterDispose = fixture.pendingCount();
      const before = fixture.draws(owner);
      fixture.dispatch(); // Observe before asserting, so failed runs retain scalar evidence.
      expect({ pendingAfterDispose, drawsAfterDispose: fixture.draws(owner) - before })
        .toEqual({ pendingAfterDispose: 0, drawsAfterDispose: 0 });
    } catch (error) { primary = { error }; }
    finally { fixture.finish(primary); }
  });

  it("has no remaining warm-up after it drained before disposal", async () => {
    const fixture = await heldAtlas();
    let primary: Primary | undefined;
    try {
      const owner = fixture.open();
      fixture.ready(owner);
      fixture.dispatch();
      reachable(fixture.draws(owner) > 0, "drained control never drew");
      const before = fixture.draws(owner);
      fixture.close(owner);
      expect(fixture.pendingCount()).toBe(0);
      fixture.dispatch();
      expect(fixture.draws(owner)).toBe(before);
    } catch (error) { primary = { error }; }
    finally { fixture.finish(primary); }
  });

  it("preserves shared-atlas work until the remaining owner drains it", async () => {
    const fixture = await heldAtlas();
    let primary: Primary | undefined;
    try {
      const first = fixture.open();
      const second = fixture.open();
      reachable(first.atlas === second.atlas, "owners did not share the actual atlas");
      fixture.ready(second);
      const held = fixture.pendingCount();
      fixture.close(first);
      expect(fixture.trace.some((e) => e.action === "dispose" && e.atlas === second.atlas)).toBe(false);
      expect(fixture.pendingCount()).toBe(held);
      fixture.dispatch();
      reachable(fixture.draws(second) > 0, "nonlast-owner control did not draw");
      fixture.close(second);
      expect(fixture.trace.filter((e) => e.action === "dispose" && e.atlas === second.atlas)).toHaveLength(1);
      expect(fixture.pendingCount()).toBe(0);
    } catch (error) { primary = { error }; }
    finally { fixture.finish(primary); }
  });

  it("cancels shared-atlas warm-up only after both owners close before dispatch", async () => {
    const fixture = await heldAtlas();
    let primary: Primary | undefined;
    try {
      const first = fixture.open();
      const second = fixture.open();
      reachable(first.atlas === second.atlas, "owners did not share the actual atlas");
      fixture.ready(second);
      const held = fixture.pendingCount();
      fixture.close(first);
      expect(fixture.pendingCount()).toBe(held);
      fixture.close(second);
      expect(fixture.trace.filter((e) => e.action === "dispose" && e.atlas === second.atlas)).toHaveLength(1);
      const pendingAfterDispose = fixture.pendingCount();
      const before = fixture.draws(second);
      fixture.dispatch();
      expect({ pendingAfterDispose, drawsAfterDispose: fixture.draws(second) - before })
        .toEqual({ pendingAfterDispose: 0, drawsAfterDispose: 0 });
    } catch (error) { primary = { error }; }
    finally { fixture.finish(primary); }
  });
});
