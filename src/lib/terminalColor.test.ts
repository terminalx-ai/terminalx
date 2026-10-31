import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());

function context() {
  return {
    clearRect: vi.fn(), fillStyle: "#000", fillRect: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([17, 34, 51, 255]) })),
  };
}

it("uses one bounded surface for repeated palettes, not one per conversion", async () => {
  const ctx = context();
  const get = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
  const { terminalColorHex } = await import("./terminalColor");
  for (let palette = 0; palette < 200; palette++) {
    expect(terminalColorHex("#112233", "#ffffff")).toBe("#112233");
    expect(terminalColorHex("#112233", "#000000")).toBe("#112233");
  }
  expect(get).toHaveBeenCalledTimes(1);
  expect(get.mock.instances[0]).toMatchObject({ width: 1, height: 1 });
  expect(ctx.clearRect).toHaveBeenCalledTimes(400);
});

it("does not cache a refusal and returns each caller's own fallback", async () => {
  const get = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const { terminalColorHex } = await import("./terminalColor");
  expect(terminalColorHex("#112233", "#eeeeee")).toBe("#eeeeee");
  expect(terminalColorHex("#112233", "#222222")).toBe("#222222");
  get.mockReturnValue(context() as never);
  expect(terminalColorHex("#112233", "#000000")).toBe("#112233");
});

it("drops a failed surface so a later conversion can recover", async () => {
  const failed = context();
  failed.getImageData.mockImplementation(() => { throw new Error("readback failed"); });
  const get = vi.spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValueOnce(failed as never).mockReturnValue(context() as never);
  const { terminalColorHex } = await import("./terminalColor");
  expect(terminalColorHex("#112233", "#abcdef")).toBe("#abcdef");
  expect(terminalColorHex("#112233", "#ffffff")).toBe("#112233");
  expect(get).toHaveBeenCalledTimes(2);
});

it("replaces a cached context that reports loss without reusing its pixels", async () => {
  const first = { ...context(), isContextLost: vi.fn(() => false) };
  const get = vi.spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValueOnce(first as never).mockReturnValue(context() as never);
  const { terminalColorHex } = await import("./terminalColor");
  expect(terminalColorHex("#112233", "#ffffff")).toBe("#112233");
  first.isContextLost.mockReturnValue(true);
  expect(terminalColorHex("#112233", "#ffffff")).toBe("#112233");
  expect(get).toHaveBeenCalledTimes(2);
  expect(first.getImageData).toHaveBeenCalledTimes(1);
});
