import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ANNOUNCEMENT_REFRESH_MS, announcementOrg } from "@/lib/announcements";
import type { AccountStatus } from "@/lib/api";
import { AnnouncementCard } from "./AnnouncementCard";

const mocks = vi.hoisted(() => ({
  status: {} as Record<string, unknown>,
  privacy: { ready: true, enabled: false },
  current: vi.fn(),
  openUrl: vi.fn(async () => {}),
}));
vi.mock("@/lib/account", () => ({ useAccount: () => ({ status: mocks.status }) }));
vi.mock("@/lib/dataPrivacy", () => ({ useDataPrivacy: () => mocks.privacy }));
vi.mock("@/lib/api", () => ({ api: { announcementsCurrent: mocks.current } }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));

const ready = (features: string[]) => ({
  state: "signed-in", identity: { organizationId: "org-1" }, phase2Readiness: { "org-1": features },
});
const card = (id: string, over: Record<string, unknown> = {}) => ({
  announcement: { id, title: `Team cloud workspaces ${id}`, body: "Run sessions on your own machines.", link: "https://example.com/changelog", isNew: true, publishedAt: "2026-11-20T00:00:00.000Z", ...over },
});
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  mocks.status = ready(["desktop.announcements.v1"]);
  mocks.privacy = { ready: true, enabled: false };
  mocks.current.mockReset();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("asks only a signed-in organization with the key on, and never under data privacy", () => {
  const status = (value: unknown) => value as AccountStatus;
  expect(announcementOrg(status(ready(["desktop.announcements.v1"])), { ready: true, enabled: false })).toBe("org-1");
  expect(announcementOrg(status(ready([])), { ready: true, enabled: false })).toBeNull();
  expect(announcementOrg(status(ready(["desktop.announcements.v1"])), { ready: true, enabled: true })).toBeNull();
  expect(announcementOrg(status({ ...ready(["desktop.announcements.v1"]), state: "signed-out" }), { ready: true, enabled: false })).toBeNull();
});

it("shows nothing and asks nothing while the key is off", async () => {
  mocks.status = ready([]);
  render(<AnnouncementCard />);
  await flush();
  expect(mocks.current).not.toHaveBeenCalled();
  expect(screen.queryByTestId("announcement-card")).toBeNull();
});

it("shows NEW, the title, the line and Read the changelog, and opens the link", async () => {
  mocks.current.mockResolvedValue(card("a"));
  render(<AnnouncementCard />);
  await flush();
  expect(mocks.current).toHaveBeenCalledWith("org-1");
  expect(screen.getByText("NEW")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Team cloud workspaces a" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Read the changelog/ }));
  expect(mocks.openUrl).toHaveBeenCalledWith("https://example.com/changelog");
});

it("picks up a new announcement within the hour", async () => {
  mocks.current.mockResolvedValueOnce({ announcement: null }).mockResolvedValue(card("b"));
  render(<AnnouncementCard />);
  await flush();
  expect(screen.queryByTestId("announcement-card")).toBeNull();
  await act(async () => { vi.advanceTimersByTime(ANNOUNCEMENT_REFRESH_MS); });
  await flush();
  expect(mocks.current).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("heading", { name: "Team cloud workspaces b" })).toBeTruthy();
});

it("stays hidden on this device once closed, and NEW shows only the first time", async () => {
  mocks.current.mockResolvedValue(card("a"));
  const first = render(<AnnouncementCard />);
  await flush();
  first.unmount();
  const second = render(<AnnouncementCard />);
  await flush();
  expect(screen.queryByText("NEW")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close announcement" }));
  expect(screen.queryByTestId("announcement-card")).toBeNull();
  second.unmount();
  render(<AnnouncementCard />);
  await flush();
  expect(screen.queryByTestId("announcement-card")).toBeNull();
  mocks.current.mockResolvedValue(card("c", { isNew: false, link: null }));
  await act(async () => { vi.advanceTimersByTime(ANNOUNCEMENT_REFRESH_MS); });
  await flush();
  expect(screen.getByRole("heading", { name: "Team cloud workspaces c" })).toBeTruthy();
  expect(screen.queryByText("NEW")).toBeNull();
  expect(screen.queryByRole("button", { name: /Read the changelog/ })).toBeNull();
});

it("keeps the card when a refresh fails", async () => {
  mocks.current.mockResolvedValueOnce(card("a")).mockRejectedValue({ code: "announcements_unavailable" });
  render(<AnnouncementCard />);
  await flush();
  await act(async () => { vi.advanceTimersByTime(ANNOUNCEMENT_REFRESH_MS); });
  await flush();
  expect(screen.getByTestId("announcement-card")).toBeTruthy();
});
