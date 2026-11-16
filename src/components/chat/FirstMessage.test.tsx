import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSetup } from "@/lib/workspaceSetup";

const mocks = vi.hoisted(() => ({ sessions: [] as unknown[], setup: undefined as WorkspaceSetup | undefined, reveal: vi.fn() }));
vi.mock("@/lib/sessions", async (original) => {
  const actual = await original<typeof import("@/lib/sessions")>();
  return { ...actual, useSessionStore: () => ({ ...actual.useSessionStore(), sessions: mocks.sessions, harnesses: [{ id: "claude", name: "Claude Code" }] }) };
});
vi.mock("@/lib/workspaceSetup", () => ({ useWorkspaceSetup: () => mocks.setup, revealSetup: mocks.reveal }));

const { FirstMessage } = await import("./FirstMessage");

const message = { sessionId: "s1", tabId: "t1", text: "Fix duplicate permission cards", images: [], files: [{ name: "notes.md" }], startedAt: Date.now(), error: null };
const session = {
  id: "s1",
  tabs: [{ id: "t1", harness: "claude" }],
  branch: "raccoon/dedupe-permission-cards",
  worktreeBase: { commit: "abc", fetched: true, warning: null, from: "origin/main", fileCopy: { copiedCount: 3, copiedBytes: 10, firstCopied: ".env.local", skippedCount: 0, warnings: [], skipped: [], error: null } },
};

afterEach(() => {
  cleanup();
  mocks.setup = undefined;
});

describe("the start progress under a held first message (PRO-397)", () => {
  it("lists the worktree, the copied files, the setup script and the agent starting, and that the message waits for it", () => {
    mocks.sessions = [session];
    mocks.setup = { sessionId: "s1", paneId: "p", command: "bun install", status: "running", exitCode: null, error: null, hasPane: true };
    render(<FirstMessage message={message} />);
    const steps = [...document.querySelectorAll("[data-step]")].map((step) => [step.getAttribute("data-step"), step.getAttribute("data-state"), step.textContent]);
    expect(steps).toEqual([
      ["worktree", "done", "Created worktree raccoon/dedupe-permission-cards from origin/main"],
      ["copy", "done", "Copied .env.local and 2 other files"],
      ["setup", "running", "Running the setup script · bun install"],
      ["agent", "running", "Starting Claude Code"],
    ]);
    expect(screen.getByText("Your first message is held and sent as soon as Claude Code is ready.")).toBeTruthy();
    screen.getByRole("button", { name: "Setup tab" }).click();
    expect(mocks.reveal).toHaveBeenCalledWith("s1");
  });

  it("in a project's own folder, with no worktree or setup, says only that the agent is starting", () => {
    mocks.sessions = [{ id: "s1", tabs: [{ id: "t1", harness: "claude" }] }];
    render(<FirstMessage message={message} />);
    expect([...document.querySelectorAll("[data-step]")].map((step) => step.getAttribute("data-step"))).toEqual(["agent"]);
    expect(screen.queryByRole("button", { name: "Setup tab" })).toBeNull();
  });

  it("shows the error in place of the wait once the send failed", () => {
    mocks.sessions = [session];
    render(<FirstMessage message={{ ...message, error: "the agent exited" }} />);
    expect(screen.getByRole("alert").textContent).toBe("Couldn't send the first message: the agent exited");
    expect(screen.queryByText(/is held and sent/)).toBeNull();
    expect(document.querySelector('[data-step="agent"]')?.getAttribute("data-state")).toBe("failed");
  });
});
