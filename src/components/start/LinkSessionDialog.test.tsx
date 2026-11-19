import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/types/session";

const app = vi.hoisted(() => ({
  store: {
    loaded: true,
    lastProject: "/code/web" as string | null,
    projects: [] as Project[],
    harnesses: [{ id: "claude", available: true }, { id: "codex", available: true }] as { id: string; available: boolean }[],
  },
  prefs: { lastAgent: "codex", lastModel: { codex: "gpt-5" } as Record<string, string>, lastEffort: { codex: "high" } as Record<string, string>, lastMode: "bypassPermissions" },
  createSession: vi.fn(),
  workStatus: vi.fn(),
  previewWorkspaceName: vi.fn(async (_path: string, name: string) => name),
  details: vi.fn(),
  select: vi.fn(),
  upsert: vi.fn(),
  send: vi.fn(async () => undefined),
  launch: vi.fn(async (_session: string, _tab: string, prompt: string) => `${prompt}\n\n[pipeline brief]`),
  issuePrompt: vi.fn(async () => "Work on Linear issue PRO-142: Invite email shows the wrong org name"),
}));
vi.mock("@/lib/api", () => ({
  api: { createSession: app.createSession, workStatus: app.workStatus, previewWorkspaceName: app.previewWorkspaceName },
  issues: { details: app.details },
  errorMessage: (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
}));
vi.mock("@/lib/sessions", () => ({
  getSessionStore: () => app.store,
  selectSession: app.select,
  upsertSession: app.upsert,
  subscribeSessionStore: () => () => undefined,
}));
vi.mock("@/lib/prefs", () => ({ getPrefs: () => app.prefs }));
vi.mock("@/lib/sessionBackend", () => ({ sendHeldFirstMessage: app.send }));
vi.mock("@/lib/pipelineLaunch", () => ({ preparePipelineLaunch: app.launch }));
vi.mock("@/lib/issuePipeline", () => ({
  pipelineSettings: (project: { issuePipeline?: { enabled: boolean } }) => ({ enabled: project.issuePipeline?.enabled ?? true, requirePerson: false }),
  pipelineLaunchDefaults: (_settings: unknown, fromIssue: boolean) => ({ autoMerge: fromIssue, resolveConflicts: fromIssue }),
}));
vi.mock("@/lib/issueSession", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/issueSession")>()), issuePromptWithComments: app.issuePrompt }));

const { LinkSessionDialog } = await import("./LinkSessionDialog");
const { LINK_ARMING_MS, askToStartFromLink, getLinkSessionRequest, linkPermissionMode, resetLinkSession, startLinkSession } = await import("@/lib/linkSessionStart");
const { getErrorToasts, dismissError } = await import("@/lib/errorToasts");

const web = { kind: "git", path: "/code/web", name: "web" } as Project;
const notes = { kind: "folder", path: "/code/notes", name: "notes" } as Project;
const created = { id: "new-1", tabs: [{ id: "tab-1" }] };
const link = (patch: Partial<{ project: string | null; branch: string | null; prompt: string | null; linear: string | null }> = {}) => ({
  kind: "new" as const, project: "/code/web", branch: "main", prompt: "Fix the flaky archive test in scripts.test.ts", linear: null, ...patch,
});
const dialog = () => screen.getByRole("dialog", { name: "Start a session from a link?" });
const createButton = () => within(dialog()).getByRole("button", { name: "Create session" }) as HTMLButtonElement;
/** Press Create once it is armed: what the dialog says has been up long enough to read. */
const pressCreate = async () => {
  await waitFor(() => expect(createButton().disabled).toBe(false), { timeout: LINK_ARMING_MS + 2000 });
  fireEvent.click(createButton());
};

beforeEach(() => {
  vi.clearAllMocks();
  app.store.projects = [web, notes];
  app.store.lastProject = "/code/web";
  app.prefs.lastMode = "bypassPermissions";
  app.createSession.mockResolvedValue(created);
  app.workStatus.mockResolvedValue({ defaultBranch: "trunk" });
});
afterEach(() => {
  cleanup();
  act(() => resetLinkSession());
  for (const toast of getErrorToasts()) dismissError(toast.id);
});

describe("starting a session from a terminalx://new link (PRO-130)", () => {
  it("asks first, naming the project, the branch and the prompt, and creates nothing until asked", async () => {
    render(<LinkSessionDialog />);
    await act(() => askToStartFromLink(link()));
    expect(within(dialog()).getByText("A link wants to start a session.")).toBeTruthy();
    const list = within(dialog()).getByLabelText("The session the link asks for");
    expect(list.textContent).toContain("Projectweb");
    expect(list.textContent).toContain("Branchfrom main");
    expect(list.textContent).toContain("PromptFix the flaky archive test in scripts.test.ts");
    expect(within(dialog()).getByRole("button", { name: "Create session" })).toBeTruthy();
    expect(app.createSession).not.toHaveBeenCalled();
    expect(app.send).not.toHaveBeenCalled();
  });

  it("starts nothing on Cancel", async () => {
    render(<LinkSessionDialog />);
    await act(() => askToStartFromLink(link()));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(getLinkSessionRequest()).toBeNull();
    expect(app.createSession).not.toHaveBeenCalled();
  });

  it("creates the session from the branch on Create, never in Bypass, opens it and sends the prompt", async () => {
    render(<LinkSessionDialog />);
    await act(() => askToStartFromLink(link({ branch: "release/1.2" })));
    await pressCreate();
    await waitFor(() => expect(app.send).toHaveBeenCalled());
    expect(app.createSession).toHaveBeenCalledExactlyOnceWith({
      projectPath: "/code/web",
      title: "Fix the flaky archive test in scripts.test.ts",
      useWorktree: true,
      onMain: false,
      worktreeName: expect.any(String),
      baseRef: "release/1.2",
      tab: { harness: "codex", model: "gpt-5", effort: "high", permissionMode: "manual" },
    });
    expect(app.upsert).toHaveBeenCalledWith(created);
    expect(app.select).toHaveBeenCalledWith("new-1");
    // Not from an issue: the project's launch switches for any other session.
    expect(app.launch).toHaveBeenCalledWith("new-1", "tab-1", "Fix the flaky archive test in scripts.test.ts", { autoMerge: false, resolveConflicts: false });
    expect(app.send).toHaveBeenCalledWith("new-1", "tab-1", "Fix the flaky archive test in scripts.test.ts\n\n[pipeline brief]");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps any other permission mode the person last chose", () => {
    expect(linkPermissionMode("acceptEdits")).toBe("acceptEdits");
    expect(linkPermissionMode("manual")).toBe("manual");
    expect(linkPermissionMode("bypassPermissions")).toBe("manual");
  });

  it("starts in the project last worked in, from its default branch, when the link names neither", async () => {
    render(<LinkSessionDialog />);
    await act(() => askToStartFromLink(link({ project: null, branch: null })));
    expect(app.workStatus).toHaveBeenCalledWith("/code/web");
    expect(within(dialog()).getByLabelText("The session the link asks for").textContent).toContain("Branchfrom trunk");
    await pressCreate();
    await waitFor(() => expect(app.createSession).toHaveBeenCalled());
    // The default branch is the backend's to choose: nothing is named.
    expect(app.createSession.mock.calls[0][0].baseRef).toBeNull();
  });

  it("runs a folder project in place, with no branch", async () => {
    render(<LinkSessionDialog />);
    await act(() => askToStartFromLink(link({ project: "/code/notes/", branch: "main" })));
    expect(within(dialog()).getByLabelText("The session the link asks for").textContent).toContain("No Git");
    await pressCreate();
    await waitFor(() => expect(app.createSession).toHaveBeenCalled());
    expect(app.createSession.mock.calls[0][0]).toMatchObject({ projectPath: "/code/notes", useWorktree: false, onMain: true, baseRef: null, worktreeName: null });
  });

  it("keeps the dialog up with the reason when the session can't be created", async () => {
    app.createSession.mockRejectedValue(new Error("No branch named release/9 in web."));
    render(<LinkSessionDialog />);
    await act(() => askToStartFromLink(link({ branch: "release/9" })));
    await pressCreate();
    expect((await within(dialog()).findByRole("alert")).textContent).toBe("No branch named release/9 in web.");
    expect(app.send).not.toHaveBeenCalled();
  });

  it("never adds a folder a link names: a project TerminalX hasn't opened starts nothing and says so", async () => {
    render(<LinkSessionDialog />);
    await act(() => askToStartFromLink(link({ project: "/Users/someone/elsewhere" })));
    expect(screen.queryByRole("dialog")).toBeNull();
    const toast = getErrorToasts().find((candidate) => candidate.key === "new-session-link");
    expect(toast?.title).toBe("That link names a project TerminalX hasn't opened");
    expect(toast?.cause).toBe("/Users/someone/elsewhere");
  });

  it("says so when no project is open to start in", async () => {
    app.store.projects = [];
    app.store.lastProject = null;
    render(<LinkSessionDialog />);
    await act(() => askToStartFromLink(link({ project: null })));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(getErrorToasts().find((candidate) => candidate.key === "new-session-link")?.title).toBe("No project to start that session in");
  });

  it("reads a Linear link's issue first, then starts on it with the issue's prompt and pipeline", async () => {
    let answer: (issue: unknown) => void = () => undefined;
    app.details.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    render(<LinkSessionDialog />);
    let asked: Promise<void> = Promise.resolve();
    act(() => { asked = askToStartFromLink(link({ project: null, branch: null, prompt: null, linear: "PRO-142" })); });
    await waitFor(() => expect(within(dialog()).getByText("Reading PRO-142…")).toBeTruthy());
    expect((within(dialog()).getByRole("button", { name: "Create session" }) as HTMLButtonElement).disabled).toBe(true);
    const issue = { provider: "linear", id: "uuid-142", identifier: "PRO-142", title: "Invite email shows the wrong org name", url: "https://linear.app/x/issue/PRO-142" };
    await act(async () => { answer(issue); await asked; });
    expect(app.details).toHaveBeenCalledWith("/code/web", "linear", "PRO-142");
    expect(within(dialog()).getByLabelText("The session the link asks for").textContent).toContain("IssuePRO-142 Invite email shows the wrong org name");
    await pressCreate();
    await waitFor(() => expect(app.send).toHaveBeenCalled());
    expect(app.createSession.mock.calls[0][0]).toMatchObject({
      title: "PRO-142 Invite email shows the wrong org name",
      worktreeName: "pro-142-invite-email-shows-the-wrong-org",
      issue: { provider: "linear", id: "uuid-142", identifier: "PRO-142", title: "Invite email shows the wrong org name", url: "https://linear.app/x/issue/PRO-142" },
    });
    // Never set to merge by itself from a link; conflicts are still resolved as the project says for issues.
    expect(app.launch).toHaveBeenCalledWith("new-1", "tab-1", "Work on Linear issue PRO-142: Invite email shows the wrong org name", { autoMerge: false, resolveConflicts: true });
  });

  it("starts nothing from a Linear issue that can't be read, and says why", async () => {
    app.details.mockRejectedValue(new Error("Linear is not connected."));
    render(<LinkSessionDialog />);
    await act(() => askToStartFromLink(link({ prompt: null, linear: "PRO-142" })));
    expect(within(dialog()).getByRole("alert").textContent).toBe("PRO-142 could not be read: Linear is not connected.");
    expect((within(dialog()).getByRole("button", { name: "Create session" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("starts on Cancel, and Create waits until the dialog has been up a moment", async () => {
    render(<LinkSessionDialog />);
    await act(() => askToStartFromLink(link()));
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Cancel"));
    expect(createButton().disabled).toBe(true);
    // Pressed too soon (or straight from another app's keypress), nothing starts.
    await act(() => startLinkSession(getLinkSessionRequest()!.id));
    expect(app.createSession).not.toHaveBeenCalled();
    await waitFor(() => expect(createButton().disabled).toBe(false), { timeout: LINK_ARMING_MS + 2000 });
    expect(within(dialog()).getByText("Merge when green stays off for a session started from a link.")).toBeTruthy();
  });

  it("starts only the request that was on screen: a link that took its place is asked about anew", async () => {
    render(<LinkSessionDialog />);
    await act(() => askToStartFromLink(link({ prompt: "first" })));
    const shown = getLinkSessionRequest()!.id;
    await act(() => askToStartFromLink(link({ prompt: "second" })));
    await new Promise((resolve) => setTimeout(resolve, LINK_ARMING_MS + 50));
    await act(() => startLinkSession(shown));
    expect(app.createSession).not.toHaveBeenCalled();
    expect(within(dialog()).getByLabelText("The session the link asks for").textContent).toContain("Promptsecond");
  });

  it("says how many lines a prompt has", async () => {
    render(<LinkSessionDialog />);
    await act(() => askToStartFromLink(link({ prompt: "one\ntwo\n\nthree" })));
    expect(within(dialog()).getByText("4 lines")).toBeTruthy();
  });
});
