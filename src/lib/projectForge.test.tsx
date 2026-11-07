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

it("never carries the previous project's forge into a new project", async () => {
  invoke.mockResolvedValueOnce("github");
  const hook = renderHook(({ path }) => useProjectForge(path), { initialProps: { path: "/previous" } });
  await waitFor(() => expect(hook.result.current).toBe("github"));
  invoke.mockRejectedValueOnce(new Error("Offline"));
  hook.rerender({ path: "/next" });
  expect(hook.result.current).toBeUndefined();
  await act(async () => { await Promise.resolve(); });
  expect(hook.result.current).toBe("githubUnavailable");
  expect(await projectForge("/next")).toBe("githubUnavailable");
  expect(invoke).toHaveBeenCalledTimes(2);
});

it("shares a slow in-flight check and caches an unavailable answer for ten seconds after completion", async () => {
  const start = Date.now();
  const now = vi.spyOn(Date, "now").mockReturnValue(start);
  let resolve!: (forge: string) => void;
  invoke.mockImplementationOnce(() => new Promise<string>((done) => { resolve = done; }));
  const first = projectForge("/unavailable");
  now.mockReturnValue(start + 60_001);
  expect(projectForge("/unavailable")).toBe(first);
  resolve("githubUnavailable");
  expect(await first).toBe("githubUnavailable");
  now.mockReturnValue(start + 70_000);
  expect(projectForge("/unavailable")).toBe(first);
  expect(invoke).toHaveBeenCalledTimes(1);
  now.mockReturnValue(start + 70_001);
  invoke.mockResolvedValueOnce("github");
  expect(await projectForge("/unavailable")).toBe("github");
  expect(invoke).toHaveBeenCalledTimes(2);
});

it.each(["unavailable", "rejected"])("shares %s checks across panel remounts and retries on visibility after ten seconds", async (failure) => {
  const start = Date.now();
  const now = vi.spyOn(Date, "now").mockReturnValue(start);
  const path = `/remount-${failure}`;
  if (failure === "unavailable") invoke.mockResolvedValueOnce("githubUnavailable");
  else invoke.mockRejectedValueOnce(new Error("Offline"));
  const hook = renderHook(() => useProjectForge(path));
  await waitFor(() => expect(hook.result.current).toBe("githubUnavailable"));
  hook.unmount();
  now.mockReturnValue(start + 9_999);
  const remounted = renderHook(() => useProjectForge(path));
  await waitFor(() => expect(remounted.result.current).toBe("githubUnavailable"));
  invoke.mockResolvedValueOnce("github");
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(remounted.result.current).toBe("githubUnavailable");
  expect(invoke).toHaveBeenCalledTimes(1);
  now.mockReturnValue(start + 10_000);
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(remounted.result.current).toBe("github");
  expect(invoke).toHaveBeenCalledTimes(2);
});
