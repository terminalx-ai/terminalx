import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Project, SessionEntry } from "@/types/session";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/notify", () => ({ notePipelineState: vi.fn() }));
const { SessionPipelineControls } = await import("./SessionPipelineControls");

// A project that chose nothing for the launch switches.
const project = { path: "/repo", name: "Raccoon", kind: "git", issuePipeline: { enabled: true } } as Project;
const issue = { provider: "linear", id: "lin-700", identifier: "ENG-700", title: "Merge issue sessions when green", url: "https://example.test/linear/ENG-700" };
const session = (patch: Partial<SessionEntry>) => ({ id: "session-1", projectPath: "/repo", cwd: "/repo/.raccoon/worktrees/eng-700", title: "Work", tabs: [{ id: "tab-1" }], ...patch }) as SessionEntry;
const switches = () => ["Resolve conflicts automatically", "Merge when green"].map((name) => screen.getByRole("switch", { name }).getAttribute("aria-checked"));

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "issue_pipeline_start") return { pipeline: { id: "p1", resolveConflicts: false }, authorBrief: "HANDOFF BRIEF" };
    if (command === "issue_pipeline_set_resolve_conflicts") return { id: "p1", resolveConflicts: args?.value };
    return null;
  });
});
afterEach(cleanup);

it("offers automation for an issue's session that has none with both switches on, as an issue's start has them (#700)", async () => {
  render(<SessionPipelineControls session={session({ issue })} project={project} tabId="tab-1" />);
  expect(switches()).toEqual(["true", "true"]);
  fireEvent.click(screen.getByRole("button", { name: "Enable automation" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("issue_pipeline_set_resolve_conflicts", { id: "p1", value: true }));
  expect(invoke).toHaveBeenCalledWith("issue_pipeline_start", { sessionId: "session-1", tabId: "tab-1", autoMerge: true });
});

it("offers it for any other session with both off, as before", () => {
  render(<SessionPipelineControls session={session({})} project={project} tabId="tab-1" />);
  expect(switches()).toEqual(["false", "false"]);
  expect(screen.getByRole("button", { name: "Enable automation" }).hasAttribute("disabled")).toBe(true);
});
