import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "@/types/session";
import { AgentDashboard } from "./AgentDashboard";

const state = vi.hoisted(() => ({ sessions: [] as SessionEntry[], select: vi.fn() }));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => ({ sessions: state.sessions, loaded: true, projects: [], harnesses: [] }), selectSession: state.select }));
vi.mock("@/lib/summaries", () => ({ useSessionSummaries: () => ({ get: () => undefined, loading: false }) }));
vi.mock("@/lib/cloudDashboard", () => ({ useCloudDashboard: () => [], isCloudDashboardSession: () => false }));
vi.mock("@/lib/organizationVisibility", () => ({ useOrganizationVisibility: () => ({ visibleIds: new Set() }) }));
vi.mock("@/lib/hotkeys", () => ({ useHotkey: vi.fn() }));
vi.mock("@/components/dashboard/AgentCard", () => ({
  AgentCard: ({ session }: { session: SessionEntry }) => <div>{session.title}</div>,
  AgentCardSkeleton: () => null,
}));
afterEach(cleanup);

it("renders empty chats under Not started and moves a chat after its first message", () => {
  const at = "2026-11-05T12:00:00Z";
  const empty: SessionEntry = {
    id: "empty", kind: "quick", projectPath: "/scratch", cwd: "/scratch", worktreeRemoved: false,
    title: "Empty chat", created: at, modified: at, archived: false, pinned: false,
    tabs: [{ id: "tab", harness: "codex", model: "", permissionMode: "auto", status: "idle", created: at, modified: at }],
  };
  const read = { ...empty, id: "read", title: "Read chat", lastMessageAt: at };
  state.sessions = [empty, read];
  const view = render(<AgentDashboard />);
  const column = (name: string) => within(screen.getByRole("region", { name }));
  expect(column("Not started").getByText("Empty chat")).toBeDefined();
  expect(column("Done").queryByText("Empty chat")).toBeNull();
  expect(column("Done").getByText("Read chat")).toBeDefined();

  fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), { target: { value: "Empty" } });
  expect(column("Not started").getByText("Empty chat")).toBeDefined();
  expect(column("Done").queryByText("Read chat")).toBeNull();

  state.sessions = [{ ...empty, lastMessageAt: at }, read];
  view.rerender(<AgentDashboard />);
  expect(column("Not started").queryByText("Empty chat")).toBeNull();
  expect(column("Done").getByText("Empty chat")).toBeDefined();
});
