import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PrAssociation } from "@/lib/api";
import { useDashboardPrs } from "./dashboardPrs";
import type { DashboardSession } from "./dashboard";
const associations = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ gh: { associations } }));
afterEach(() => { cleanup(); associations.mockReset(); });
const session = (id: string): DashboardSession => ({ id, title: id, projectPath: "/repo", cwd: "/repo", modified: "2026-11-01", archived: false, tabs: [] });
const pr: PrAssociation = { number: 2, url: "https://github.com/acme/api/pull/2", head: "feature", scope: { kind: "local", cwd: "/repo" } };

it("only reads in Table, preserves recorded session ownership and tolerates an unavailable record", async () => {
  associations.mockImplementation(async (id: string) => { if (id === "b") throw new Error("unavailable"); return [pr]; });
  const sessions = [session("a"), session("b")];
  const hook = renderHook(({ enabled }) => useDashboardPrs(sessions, enabled), { initialProps: { enabled: false } });
  expect(associations).not.toHaveBeenCalled();
  hook.rerender({ enabled: true });
  await waitFor(() => expect(hook.result.current.get("a")).toEqual([pr]));
  expect(hook.result.current.has("b")).toBe(false);
  expect(associations.mock.calls).toEqual([["a"], ["b"]]);
});

it("bounds concurrent reads and discards responses from an old list", async () => {
  const finish = new Map<string, (rows: PrAssociation[]) => void>();
  associations.mockImplementation((id: string) => new Promise<PrAssociation[]>((resolve) => finish.set(id, resolve)));
  const hook = renderHook(({ sessions }) => useDashboardPrs(sessions, true), { initialProps: { sessions: Array.from({ length: 8 }, (_, i) => session(String(i))) } });
  expect(associations).toHaveBeenCalledTimes(4);
  hook.rerender({ sessions: [session("new")] });
  await act(async () => { finish.get("new")!([pr]); });
  await waitFor(() => expect(hook.result.current.get("new")).toEqual([pr]));
  await act(async () => { for (const [id, resolve] of finish) if (id !== "new") resolve([]); });
  expect([...hook.result.current.keys()]).toEqual(["new"]);
  expect(associations).toHaveBeenCalledTimes(5);
});

it("finishes later rows while existing sessions receive streaming updates", async () => {
  const finish = new Map<string, (rows: PrAssociation[]) => void>();
  associations.mockImplementation((id: string) => new Promise<PrAssociation[]>((resolve) => finish.set(id, resolve)));
  const sessions = Array.from({ length: 5 }, (_, i) => session(String(i)));
  const hook = renderHook(({ rows }) => useDashboardPrs(rows, true), { initialProps: { rows: sessions } });
  hook.rerender({ rows: sessions.map((row) => ({ ...row, modified: "2026-11-02" })).reverse() });
  expect(associations).toHaveBeenCalledTimes(4);
  await act(async () => { for (const id of ["0", "1", "2", "3"]) finish.get(id)!([]); });
  expect(associations).toHaveBeenCalledTimes(5);
  await act(async () => { finish.get("4")!([pr]); });
  expect(hook.result.current.get("4")).toEqual([pr]);
});
