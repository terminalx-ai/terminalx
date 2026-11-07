import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PrAssociation } from "@/lib/api";
import { useDashboardPrs } from "./dashboardPrs";
import type { DashboardSession } from "./dashboard";
const associationsBatch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ gh: { associationsBatch } }));
afterEach(() => { cleanup(); associationsBatch.mockReset(); vi.useRealTimers(); });
const session = (id: string): DashboardSession => ({ id, title: id, projectPath: "/repo", cwd: "/repo", modified: "2026-11-01", archived: false, tabs: [] });
const pr: PrAssociation = { number: 2, url: "https://github.com/acme/api/pull/2", head: "feature", scope: { kind: "local", cwd: "/repo" } };

it("reads one indexed batch only in Table, including on refresh", async () => {
  vi.useFakeTimers();
  const sessions = Array.from({ length: 118 }, (_, i) => session(String(i)));
  associationsBatch.mockResolvedValue({ "0": [pr], "1": [] });
  const hook = renderHook(({ enabled }) => useDashboardPrs(sessions, enabled), { initialProps: { enabled: false } });
  expect(associationsBatch).not.toHaveBeenCalled();
  await act(async () => { hook.rerender({ enabled: true }); });
  expect(hook.result.current.get("0")).toEqual([pr]);
  expect(associationsBatch.mock.calls).toEqual([[sessions.map(({ id }) => id)]]);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(associationsBatch).toHaveBeenCalledTimes(2);
  associationsBatch.mockRejectedValueOnce(Error("unavailable"));
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(hook.result.current.get("0")).toEqual([pr]);
});

it("discards responses from an old list", async () => {
  let finish!: (rows: Record<string, PrAssociation[]>) => void;
  associationsBatch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue({ new: [pr] });
  const hook = renderHook(({ sessions }) => useDashboardPrs(sessions, true), { initialProps: { sessions: [session("old")] } });
  hook.rerender({ sessions: [session("new")] });
  await waitFor(() => expect(hook.result.current.get("new")).toEqual([pr]));
  await act(async () => { finish({ old: [] }); });
  expect([...hook.result.current.keys()]).toEqual(["new"]);
});

it("does not restart or overlap a batch on streaming updates, reordering or a slow refresh", async () => {
  vi.useFakeTimers();
  let finish!: (rows: Record<string, PrAssociation[]>) => void;
  associationsBatch.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const sessions = [session("a"), session("b")];
  const hook = renderHook(({ rows }) => useDashboardPrs(rows, true), { initialProps: { rows: sessions } });
  hook.rerender({ rows: sessions.map((row) => ({ ...row, modified: "2026-11-02" })).reverse() });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(associationsBatch).toHaveBeenCalledTimes(1);
  await act(async () => { finish({ a: [pr], b: [] }); });
  expect(hook.result.current.get("a")).toEqual([pr]);
});
