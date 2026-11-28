// @vitest-environment node
import { expect, it, vi } from "vitest";

// An update is downloaded, then the caller's step runs, then it is installed: three calls, in that order.
const calls = vi.hoisted(() => [] as string[]);
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class { onmessage: unknown = null; },
  invoke: vi.fn(async (command: string) => {
    calls.push(command);
    return command === "app_update_check" ? { id: "u1", version: "9.9.9" } : undefined;
  }),
}));

const { check } = await import("./nativeUpdater");

it("downloads, runs the step before installing, then installs", async () => {
  const update = await check({ headers: { "X-Raccoon-Channel": "stable" } });
  await update!.downloadAndInstall(() => undefined, async () => { calls.push("before install"); });
  expect(calls).toEqual(["app_update_check", "app_update_download", "before install", "app_update_apply"]);
});
