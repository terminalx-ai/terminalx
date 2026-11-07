import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { IssuePipeline } from "@/types/issuePipeline";

const state = vi.hoisted(() => ({ pipelines: [] as unknown[] }));
vi.mock("@/lib/sessions", () => ({
  useSessionStore: () => ({ sessions: [{ id: "s1", projectPath: "/repo", cwd: "/repo/wt", activeTab: "t1", tabs: [{ id: "t1" }] }], projects: [] }),
}));
vi.mock("@/lib/issuePipeline", async (actual) => ({ ...(await actual<typeof import("@/lib/issuePipeline")>()), useIssuePipelines: () => state.pipelines }));
vi.mock("@/components/session/SessionPipelineControls", () => ({
  SessionPipelineControls: ({ pipeline }: { pipeline?: IssuePipeline }) => <p>{pipeline ? "pipeline panel" : "autopilot switches"}</p>,
}));
const { BranchAutopilot } = await import("./BranchAutopilot");

afterEach(() => { cleanup(); state.pipelines = []; });

it("is one line while off, and opens its switches in place", () => {
  render(<BranchAutopilot sessionId="s1" offer />);
  const line = screen.getByRole("button", { name: /Autopilot/ });
  expect(line.textContent).toContain("Off");
  expect(line.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("autopilot switches")).toBeNull();
  fireEvent.click(line);
  expect(screen.getByText("autopilot switches")).toBeTruthy();
});

it("shows a running pipeline's status, opened, even where none can be started", () => {
  state.pipelines = [{ id: "p", author: { sessionId: "s1" }, state: "waiting", note: "checks running", stage: "review", stopped: false, branch: "b", projectPath: "/repo", autoMerge: true, updatedAt: "" }];
  render(<BranchAutopilot sessionId="s1" offer={false} />);
  expect(screen.getByRole("button", { name: /Autopilot/ }).textContent).toContain("Waiting for checks");
  expect(screen.getByText("pipeline panel")).toBeTruthy();
});

it("is absent where it cannot be started and nothing runs", () => {
  const { container } = render(<BranchAutopilot sessionId="s1" offer={false} />);
  expect(container.innerHTML).toBe("");
});
