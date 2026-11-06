import { beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => vi.fn());
const updater = vi.hoisted(() => ({ check: vi.fn(), install: vi.fn(), relaunch: vi.fn() }));
const runtime = vi.hoisted(() => ({ work: vi.fn(), planUpdate: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (original) => ({ ...(await original<object>()), invoke: native }));
vi.mock("@/lib/nativeUpdater", () => ({ check: updater.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: updater.relaunch }));
vi.mock("@/lib/api", async (original) => ({ ...(await original<typeof import("@/lib/api")>()), localRuntime: runtime }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  updater.check.mockResolvedValue({ version: "9.9.9", downloadAndInstall: updater.install });
  updater.install.mockResolvedValue(undefined);
  runtime.work.mockResolvedValue({ epoch: "owner", work: [], readAt: 1 });
  runtime.planUpdate.mockResolvedValue(undefined);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function privacy(enabled: boolean) {
  native.mockResolvedValue({ enabled, managed: false });
  await (await import("./dataPrivacy")).refreshDataPrivacy();
}

it.each([false, true])("withdraws found updates and deferred choices on activation (choosing: %s)", async (choosing) => {
  await privacy(false);
  const updates = await import("./updates");
  await updates.checkForUpdate();
  if (choosing) {
    runtime.work.mockResolvedValue({ epoch: "owner", work: ["running turn"], readAt: 1 });
    await updates.installUpdate();
    expect(updates.getUpdateState().kind).toBe("choosing");
  }
  await privacy(true);
  await updates.installUpdate();
  await updates.chooseUpdate("now");
  await privacy(false);
  await updates.installUpdate();
  await updates.chooseUpdate("whenDone");
  expect(updater.install).not.toHaveBeenCalled();
  expect(updater.relaunch).not.toHaveBeenCalled();
  expect(updates.getUpdateState().kind).toBe("idle");
  // A new local request works after restoring privacy without signing in.
  runtime.work.mockResolvedValue({ epoch: "owner", work: [], readAt: 1 });
  await updates.checkForUpdate();
  await updates.installUpdate();
  expect(updater.install).toHaveBeenCalledOnce();
});

it.each([false, true])("cancels an install paused on runtime work, including off/on restoration: %s", async (restore) => {
  await privacy(false);
  const updates = await import("./updates");
  await updates.checkForUpdate();
  const reading = deferred<{ epoch: string; work: string[]; readAt: number }>();
  runtime.work.mockReturnValue(reading.promise);
  const installing = updates.installUpdate();
  await privacy(true);
  if (restore) await privacy(false);
  reading.resolve({ epoch: "owner", work: [], readAt: 1 });
  await installing;
  expect(updater.install).not.toHaveBeenCalled();
  expect(runtime.planUpdate).not.toHaveBeenCalled();
  expect(updater.relaunch).not.toHaveBeenCalled();
  expect(updates.getUpdateState().kind).toBe("idle");
});

it("does not publish a check that completes after privacy activation and restoration", async () => {
  await privacy(false);
  const updates = await import("./updates");
  const checking = deferred<null>();
  updater.check.mockReturnValue(checking.promise);
  const result = updates.checkForUpdate();
  await privacy(true);
  await privacy(false);
  checking.resolve(null);
  await result;
  expect(updates.getUpdateState().kind).toBe("idle");
});
