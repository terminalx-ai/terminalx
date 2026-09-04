import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PullRequest } from "@/lib/api";
import type { WorkspaceDisposition } from "@/types/session";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const { PrPanel } = await import("./PrPanel");

const cwd = "/repos/raccoon/.raccoon/worktrees/65-delete-workspace";
const projectPath = "/repos/raccoon";
const mergedPr: PullRequest = {
  number: 62,
  title: "Show delete workspace",
  url: "https://example.test/pull/62",
  state: "MERGED",
  isDraft: false,
  base: "main",
  head: "raccoon/65-delete-workspace",
  additions: 12,
  deletions: 3,
  mergeable: "UNKNOWN",
  reviewDecision: null,
  checks: [],
  body: "",
  author: "terminalx",
};

const cleanMerged: WorkspaceDisposition = {
  exists: true,
  isMain: false,
  branch: mergedPr.head,
  uncommitted: 0,
  unpushed: 0,
  aheadOfBase: 0,
  pr: {
    number: mergedPr.number,
    title: mergedPr.title,
    url: mergedPr.url,
    state: "MERGED",
    isDraft: false,
  },
  prChecked: true,
  sessions: 0,
};

function mockBackend(disposition: WorkspaceDisposition, shouldFailDisposition: () => boolean = () => false) {
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "gh_available") return true;
    if (command === "pr_list") return [mergedPr];
    if (command === "work_status") {
      return {
        isRepo: true,
        dirty: false,
        branch: mergedPr.head,
        upstream: `origin/${mergedPr.head}`,
        ahead: 0,
        behind: 0,
        defaultBranch: "main",
        aheadOfBase: 0,
        head: "abc123",
      };
    }
    if (command === "workspace_disposition") {
      if (shouldFailDisposition()) throw new Error("Unable to verify workspace");
      return disposition;
    }
    throw new Error(`Unexpected command: ${command}`);
  });
}

afterEach(() => {
  cleanup();
  mocks.invoke.mockReset();
});

describe("merged workspace action", () => {
  it("offers guarded workspace deletion when a managed workspace is merged and clean", async () => {
    mockBackend(cleanMerged);
    const openDelete = vi.fn();

    render(
      <PrPanel
        cwd={cwd}
        branch={mergedPr.head}
        active
        busy={false}
        onSettle={() => {}}
        workspace={{ projectPath, onDelete: openDelete }}
      />,
    );

    const button = await screen.findByRole("button", { name: "Delete workspace" });
    fireEvent.click(button);

    expect(openDelete).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("workspace_disposition", { projectPath, path: cwd });
    });
    expect(screen.queryByRole("button", { name: "Settle worktree" })).toBeNull();
  });

  it.each([
    ["has uncommitted changes", { ...cleanMerged, uncommitted: 1 }],
    ["has unpushed commits", { ...cleanMerged, unpushed: 1 }],
    ["has no confirmed pull-request status", { ...cleanMerged, pr: null, prChecked: false }],
    ["has an unknown pull-request state", { ...cleanMerged, pr: { ...cleanMerged.pr!, state: "UNKNOWN" } }],
    ["is the main workspace", { ...cleanMerged, isMain: true }],
  ])("does not offer deletion when the workspace %s", async (_case, disposition) => {
    mockBackend(disposition);

    render(
      <PrPanel
        cwd={cwd}
        branch={mergedPr.head}
        active
        busy={false}
        onSettle={() => {}}
        workspace={{ projectPath, onDelete: vi.fn() }}
      />,
    );

    await screen.findByText("This branch has been merged.");
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("workspace_disposition", { projectPath, path: cwd });
    });
    expect(screen.queryByRole("button", { name: "Delete workspace" })).toBeNull();
  });

  it("removes deletion eligibility when a workspace safety recheck fails", async () => {
    let failDisposition = false;
    mockBackend(cleanMerged, () => failDisposition);
    const workspace = { projectPath, onDelete: vi.fn() };
    const view = render(
      <PrPanel cwd={cwd} branch={mergedPr.head} active busy={false} onSettle={() => {}} workspace={workspace} />,
    );
    await screen.findByRole("button", { name: "Delete workspace" });

    failDisposition = true;
    view.rerender(<PrPanel cwd={cwd} branch={mergedPr.head} active busy onSettle={() => {}} workspace={workspace} />);

    await screen.findByText("Unable to verify workspace");
    expect(screen.queryByRole("button", { name: "Delete workspace" })).toBeNull();
  });
});
