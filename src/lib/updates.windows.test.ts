// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";

// On Windows the installer ends the app before the install returns, so what the relaunched app needs (the runtime
// update plan) is left between the download and the install. Elsewhere it is left after, as before.
const native = vi.hoisted(() => vi.fn());
const platform = vi.hoisted(() => ({ windows: true }));
const order = vi.hoisted(() => [] as string[]);
const updater = vi.hoisted(() => ({ check: vi.fn(), relaunch: vi.fn() }));
const runtime = vi.hoisted(() => ({ work: vi.fn(), planUpdate: vi.fn(), handOverInstalled: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (original) => ({ ...(await original<object>()), invoke: native }));
vi.mock("@/lib/nativeUpdater", () => ({ check: updater.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: updater.relaunch }));
vi.mock("@/lib/api", async (original) => ({ ...(await original<typeof import("@/lib/api")>()), localRuntime: runtime }));
vi.mock("@/lib/platform", async (original) => ({ ...(await original<typeof import("@/lib/platform")>()), get isWindows() { return platform.windows; } }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  order.length = 0;
  native.mockResolvedValue({ enabled: false, managed: false });
  updater.check.mockResolvedValue({
    version: "9.9.9",
    // Download, the step between, then install: as the native wrapper runs them.
    downloadAndInstall: async (_progress: unknown, beforeInstall?: () => Promise<void>) => {
      order.push("download");
      await beforeInstall?.();
      order.push("install");
    },
  });
  runtime.work.mockResolvedValue({ epoch: "owner", work: [], readAt: 1 });
  runtime.planUpdate.mockImplementation(async () => { order.push("plan"); });
  runtime.handOverInstalled.mockImplementation(async () => { order.push("handover"); });
  updater.relaunch.mockImplementation(async () => { order.push("relaunch"); });
});

async function update() {
  await (await import("./dataPrivacy")).refreshDataPrivacy();
  const updates = await import("./updates");
  await updates.checkForUpdate();
  await updates.installUpdate();
}

it("leaves the runtime plan before installing on Windows, where installing ends the app", async () => {
  platform.windows = true;
  await update();
  // A real Windows install ends the app at "install"; what follows is the relaunched app's.
  expect(order).toEqual(["download", "plan", "install", "handover", "relaunch"]);
  expect(runtime.planUpdate).toHaveBeenCalledWith("owner", false, 1, []);
});

it("leaves it after installing elsewhere, as before", async () => {
  platform.windows = false;
  await update();
  expect(order).toEqual(["download", "install", "plan", "handover", "relaunch"]);
});
