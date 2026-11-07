import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { projectForge, useProjectForge } from "./projectForge";

afterEach(() => { cleanup(); vi.restoreAllMocks(); invoke.mockReset(); });

it("shares one check per project, and refreshes changed credentials or remotes", async () => {
  invoke.mockResolvedValue("localOnly");
  const first = renderHook(() => useProjectForge("/one"));
  const second = renderHook(() => useProjectForge("/one"));
  await waitFor(() => expect(first.result.current).toBe("localOnly"));
  expect(second.result.current).toBe("localOnly");
  expect(invoke).toHaveBeenCalledTimes(1);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
  invoke.mockResolvedValue("github");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(first.result.current).toBe("github");
  expect(second.result.current).toBe("github");
  expect(invoke).toHaveBeenCalledTimes(2);
});

it("never carries the previous project's forge into a new project and retries failed checks", async () => {
  invoke.mockResolvedValueOnce("github");
  const hook = renderHook(({ path }) => useProjectForge(path), { initialProps: { path: "/previous" } });
  await waitFor(() => expect(hook.result.current).toBe("github"));
  invoke.mockRejectedValueOnce(new Error("Offline"));
  hook.rerender({ path: "/next" });
  expect(hook.result.current).toBeUndefined();
  await act(async () => { await Promise.resolve(); });
  invoke.mockResolvedValueOnce("localOnly");
  expect(await projectForge("/next")).toBe("localOnly");
});
