import { describe, expect, it } from "vitest";
import type { DashboardSession, DashboardTabStatus } from "@/lib/dashboard";
import { bucketSessions, isUnread } from "@/lib/dashboard";
import { sessionPassesFilter, SIDEBAR_FILTERS } from "./sidebarFilter";

const session = (id: string, statuses: DashboardTabStatus[], fields: Partial<DashboardSession> = {}): DashboardSession => ({
  id,
  projectPath: "/repos/a",
  cwd: "/repos/a",
  title: id,
  modified: "2026-10-03T10:00:00.000Z",
  archived: false,
  tabs: statuses.map((status) => ({ harness: "claude", status })),
  ...fields,
});

describe("the sidebar's session filter", () => {
  const waiting = session("waiting", ["idle", "waiting"]);
  const working = session("working", ["in_progress", "completed"]);
  const unread = session("unread", ["completed", "idle"]);
  const read = session("read", ["idle"]);
  const all = [waiting, working, unread, read];

  it("shows everything by default", () => {
    expect(all.every((entry) => sessionPassesFilter("all", entry))).toBe(true);
    expect(sessionPassesFilter("all", session("archived", ["idle"], { archived: true }))).toBe(true);
  });

  it("Needs you is exactly the dashboard's Needs you column", () => {
    const needs = bucketSessions(all).needs.map((entry) => entry.id);
    expect(all.filter((entry) => sessionPassesFilter("needs", entry)).map((entry) => entry.id)).toEqual(needs);
    expect(needs).toEqual(["waiting"]);
  });

  it("Unread is a finished answer nobody has read: not one still working, not one waiting", () => {
    expect(all.filter((entry) => sessionPassesFilter("unread", entry)).map((entry) => entry.id)).toEqual(["unread"]);
    expect(all.filter(isUnread).map((entry) => entry.id)).toEqual(["unread"]);
  });

  it("never shows an archived session or one with no tab under a filter", () => {
    for (const filter of ["unread", "needs"] as const) {
      expect(sessionPassesFilter(filter, session("archived", ["waiting", "completed"], { archived: true }))).toBe(false);
      expect(sessionPassesFilter(filter, session("empty", []))).toBe(false);
    }
  });

  it("names each filter and what it says when nothing matches", () => {
    expect(SIDEBAR_FILTERS.map((entry) => [entry.id, entry.label, entry.empty])).toEqual([
      ["all", "All sessions", ""],
      ["unread", "Unread", "No unread sessions."],
      ["needs", "Needs you", "Nothing needs you."],
    ]);
  });
});
