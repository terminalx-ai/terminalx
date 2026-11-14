import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(), requestPermission: vi.fn(), sendNotification: vi.fn(),
}));
const prefs = vi.hoisted(() => ({ sounds: true }));
vi.mock("@/lib/prefs", () => ({ getPrefs: () => prefs }));

class Oscillator {
  type = "sine";
  frequency = { value: 0 };
  onended: (() => void) | null = null;
  connect = vi.fn((node) => node);
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}
class Context {
  static instances: Context[] = [];
  state = "suspended";
  currentTime = 10;
  destination = {};
  oscillators: Oscillator[] = [];
  gains: { disconnect: ReturnType<typeof vi.fn> }[] = [];
  resume = vi.fn(async () => { this.state = "running"; });
  close = vi.fn(async () => { this.state = "closed"; });
  constructor() { Context.instances.push(this); }
  createOscillator() {
    const oscillator = new Oscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }
  createGain() {
    const gain = {
      gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(), disconnect: vi.fn(),
    };
    this.gains.push(gain);
    return gain;
  }
}

beforeEach(() => {
  vi.resetModules();
  Context.instances = [];
  prefs.sounds = true;
  vi.stubGlobal("AudioContext", Context);
  // These tests only exercise sound; do not retain notification window listeners.
  vi.spyOn(window, "addEventListener").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("attention sound output lifecycle", () => {
  it.each(["done", "waiting", "failed"] as const)("releases the output after the last %s note ends", async (kind) => {
    const { playSound } = await import("./notify");
    playSound(kind);
    const ctx = Context.instances[0];
    expect(ctx.resume).toHaveBeenCalledOnce();
    expect(ctx.oscillators).toHaveLength(2);
    ctx.oscillators[0].onended!();
    expect(ctx.close).not.toHaveBeenCalled();
    ctx.oscillators[1].onended!();
    expect(ctx.close).toHaveBeenCalledOnce();
    for (const node of [...ctx.oscillators, ...ctx.gains]) expect(node.disconnect).toHaveBeenCalledOnce();
  });

  it("keeps overlapping chimes alive until every scheduled note ends", async () => {
    const { playSound } = await import("./notify");
    playSound("failed");
    playSound("done");
    const ctx = Context.instances[0];
    expect(Context.instances).toHaveLength(1);
    // A shorter, later chime can finish before the earlier one.
    for (const index of [2, 0, 3]) ctx.oscillators[index].onended!();
    expect(ctx.close).not.toHaveBeenCalled();
    ctx.oscillators[1].onended!();
    expect(ctx.close).toHaveBeenCalledOnce();
  });

  it("uses a fresh context even while the previous close is pending", async () => {
    const { playSound } = await import("./notify");
    playSound("done");
    const first = Context.instances[0];
    first.close.mockImplementation(() => new Promise(() => {}));
    first.oscillators.forEach((node) => node.onended!());
    playSound("waiting");
    expect(Context.instances).toHaveLength(2);
    const next = Context.instances[1];
    expect(next.resume).toHaveBeenCalledOnce();
    next.oscillators.forEach((node) => node.onended!());
    expect(next.close).toHaveBeenCalledOnce();
  });

  it("handles rejected resume and close without retaining the context", async () => {
    const { playSound } = await import("./notify");
    vi.spyOn(Context.prototype, "createOscillator").mockImplementationOnce(function (this: Context) {
      this.close.mockRejectedValueOnce(new Error("Device unavailable"));
      throw new Error("Device unavailable");
    });
    playSound("done");
    expect(Context.instances[0].close).toHaveBeenCalledOnce();
    playSound("waiting");
    const ctx = Context.instances[1];
    ctx.state = "suspended";
    ctx.resume.mockRejectedValueOnce(new Error("Resume failed"));
    playSound("done");
    await Promise.resolve();
    expect(ctx.close).toHaveBeenCalledOnce();
    playSound("done");
    expect(Context.instances).toHaveLength(3);
  });

  it("does not open an audio device when sounds are disabled", async () => {
    const { playSound } = await import("./notify");
    prefs.sounds = false;
    playSound("done");
    expect(Context.instances).toHaveLength(0);
  });
});
