import { fileManager } from "@/lib/platform";
import { useState } from "react";
import { SettingsLeaveGuardContext, useSettingsLeaveBoundary } from "./settingsLeaveGuard";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectPageForRow, RepositoriesTab, RepositorySettingsPage } from "./RepositoriesTab";
import type { RepositoryFilesPreview } from "@/types/repositorySettings";
import type { Project } from "@/types/session";

const mock = vi.hoisted(() => ({ persist: vi.fn(), preview: vi.fn(), update: vi.fn(), reveal: vi.fn(), copy: vi.fn(), remove: vi.fn(), projects: [] as Project[] }));
vi.mock("@/lib/api", () => ({ api: { repositoryFilesPreview: mock.preview }, errorMessage: (e: unknown) => String(e) }));
vi.mock("@/icons", () => new Proxy({}, { has: () => true, get: (_, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : prop === "__esModule" ? true : (props: Record<string, unknown>) => <svg {...props} />) }));
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
  WithTooltip: ({ children }: { children: React.ReactNode }) => children,
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: () => null,
  Kbd: ({ children }: { children: React.ReactNode }) => <kbd data-slot="kbd">{children}</kbd>,
  KbdGroup: ({ keys }: { keys: string[] }) => <span data-slot="kbd">{keys.map((k, i) => <kbd key={i}>{k}</kbd>)}</span>,
}));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => ({ projects: mock.projects, sessions: [], chatsPath: null, workspaces: {} }), updateProject: mock.update }));
vi.mock("@/components/layout/SessionSidebar", () => ({ confirmRemoveProject: mock.remove, conversationLink: () => null }));
vi.mock("./SettingsFiles", () => ({ ProjectSettingsFiles: ({ projectPath }: { projectPath: string }) => <p>Settings files for {projectPath}</p> }));
vi.mock("./MergedCleanupSettings", () => ({ MergedCleanupSettings: () => null }));
vi.mock("./ProjectAgentAccounts", () => ({ ProjectAgentAccounts: ({ projectPath }: { projectPath: string }) => <p>Agent accounts for {projectPath}</p> }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: mock.reveal }));
vi.mock("@/lib/clipboard", () => ({ copyText: mock.copy }));
vi.mock("./RepositoryActionsPage", () => ({ RepositoryActionsPage: ({ projectPath }: { projectPath: string }) => <p>Actions page for {projectPath}</p> }));
vi.mock("./RepositoryPreviewUrlsPage", () => ({ RepositoryPreviewUrlsPage: ({ projectPath }: { projectPath: string }) => <p>Preview URLs page for {projectPath}</p> }));
vi.mock("./EnvironmentSettings", () => ({ EnvironmentTable: ({ project }: { project: string }) => <p>Variables for {project}</p> }));
vi.mock("./RepositoryEnvironmentSettings", () => ({ RepositoryEnvironmentSettings: ({ projectPath }: { projectPath: string }) => <p>Environment page for {projectPath}</p> }));
const project: Project = { path: "/repo", name: "Example", repositorySettings: { filesToCopy: [".env*"] } };
const result = (patterns = [".env*"], fromIncludeFile = false): RepositoryFilesPreview => ({
  rootPath: "/repo", workspacesPath: "/repo/.raccoon/worktrees", fromIncludeFile, ignoredChecked: 1812,
  patterns: patterns.map((pattern) => ({ pattern, matches: pattern === ".env*" ? [".env", ".env.local"] : ["config/local/app.json"], error: null })),
});
beforeEach(() => {
  vi.clearAllMocks();
  mock.projects = [project, { path: "/folder", name: "Folder", kind: "folder" }];
  mock.preview.mockImplementation(async (_path, patterns) => result(patterns));
  mock.update.mockResolvedValue(project);
  mock.persist.mockResolvedValue(undefined);
  mock.reveal.mockResolvedValue(undefined);
  mock.copy.mockResolvedValue(undefined);
});
afterEach(cleanup);

/** Navigation uses the same boundary as the settings sidebar and app shell. */
function NavigationHarness() {
  const boundary = useSettingsLeaveBoundary();
  const [current, setCurrent] = useState(project);
  const [destination, setDestination] = useState<string | null>(null);
  mock.update.mockImplementation((_path, patch) => new Promise<Project>((resolve, reject) => {
    mock.persist().then(() => {
      const saved = { ...project, ...patch };
      setCurrent(saved);
      resolve(saved);
    }, reject);
  }));
  return <SettingsLeaveGuardContext.Provider value={boundary.guards}>
    {destination ? <p>Arrived at {destination}</p> : <>
      <RepositorySettingsPage project={current} />
      {["Scripts", "Another repository", "Back to app"].map((label) => <button key={label} onClick={() => {
        if (boundary.canLeave()) setDestination(label);
      }}>{label}</button>)}
      {boundary.warning && <p>Navigation blocked until changes are saved</p>}
    </>}
  </SettingsLeaveGuardContext.Provider>;
}

describe("Project settings", () => {
  it("shows root and worktree folders as paths whose menu reveals or copies them, with no Change", async () => {
    render(<RepositoriesTab projectPath="/repo" />);
    const worktrees = await screen.findByRole("button", { name: "Worktree folder: /repo/.raccoon/worktrees" });
    expect(screen.queryByRole("button", { name: /^Reveal|^Copy/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Change/ })).toBeNull();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Root path: /repo" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy path" }));
    await waitFor(() => expect(mock.copy).toHaveBeenCalledWith("/repo"));
    fireEvent.pointerDown(worktrees, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: `Show in ${fileManager}` }));
    await waitFor(() => expect(mock.reveal).toHaveBeenCalledWith("/repo/.raccoon/worktrees"));
  });

  it("holds paths, Preview URLs, Files to copy and Remove project on General, in that order, with no tab nav (PRO-131, PRO-387)", async () => {
    render(<RepositoriesTab projectPath="/repo" page="general" />);
    await screen.findByText(".env.local");
    const general = document.querySelector('[data-setting-id="repositories.rootPath"]')!;
    const preview = document.querySelector('[data-setting-id="repositories.previewUrls"]')!;
    const files = document.querySelector('[data-setting-id="repositories.filesToCopy"]')!;
    const remove = screen.getByRole("button", { name: "Remove project" });
    expect(preview.textContent).toContain("Preview URLs page for /repo");
    expect(general.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(preview.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(files.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Project settings" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "General" })).toBeNull();
    fireEvent.click(remove);
    expect(mock.remove).toHaveBeenCalledWith(expect.objectContaining({ path: "/repo", name: "Example", sessions: [] }));
  });

  it("files to copy is a title, one line and the patterns, then the count and the matching files", async () => {
    render(<RepositorySettingsPage project={project} />);
    expect(await screen.findByText("2 ignored files match")).toBeTruthy();
    const section = within(screen.getByRole("region", { name: "Files to copy" }));
    expect(section.getByText("Ignored files copied into each new workspace, one pattern per line.")).toBeTruthy();
    expect(within(section.getByRole("list", { name: "Matching ignored files" })).getAllByRole("listitem").map((item) => item.textContent)).toEqual([".env", ".env.local"]);
    expect(section.queryByRole("button", { name: "Save" })).toBeNull();
    expect(section.queryByText(/Glob patterns/)).toBeNull();
  });

  it("says no ignored file matches as a warning, with the count checked and each reason as prose, and checks again (design 11.12)", async () => {
    mock.preview.mockImplementation(async () => ({
      rootPath: "/Users/me/code/raccoon", workspacesPath: "/repo/.raccoon/worktrees", fromIncludeFile: false, ignoredChecked: 1812,
      patterns: [
        { pattern: ".env.production", matches: [], error: null, reason: ".env.production doesn't exist yet." },
        { pattern: "tmp/**", matches: [], error: null },
      ],
    }));
    render(<RepositorySettingsPage project={project} />);
    const status = await screen.findByText("No ignored files match these patterns");
    expect(status.parentElement!.className).toContain("text-warning");
    expect((screen.getByRole("textbox") as HTMLElement).className).toContain("border-warning");
    const why = screen.getByLabelText("Why each pattern matched nothing").textContent!;
    expect(why).toContain("Checked 1,812 ignored files in ~/code/raccoon.");
    expect(why).toContain(".env.production: .env.production doesn't exist yet.");
    expect(why).toContain("tmp/**: No ignored files match.");
    expect(screen.queryByRole("button", { name: "Refresh preview" })).toBeNull();
    const before = mock.preview.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(mock.preview.mock.calls.length).toBe(before + 1));
    expect(mock.preview.mock.calls.at(-1)?.[2]).not.toBe(mock.preview.mock.calls[before - 1][2]);
    await screen.findByText("No ignored files match these patterns");
  });

  it("gives a pattern's reason beside the ones that match", async () => {
    mock.preview.mockResolvedValue({ ...result(), patterns: [
      { pattern: ".env*", matches: [".env"], error: null, reason: null },
      { pattern: ".env.production", matches: [], error: null, reason: ".env.production doesn't exist yet." },
    ] });
    render(<RepositorySettingsPage project={project} />);
    await screen.findByText(".env.production doesn't exist yet.", { exact: false });
    expect(screen.queryByText("No ignored files match these patterns")).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh preview" })).toBeTruthy();
  });

  it("commits a validated edit on blur, and only the chosen repository's patterns", async () => {
    render(<RepositorySettingsPage project={project} />);
    await screen.findByText(".env.local");
    const snapshot = mock.preview.mock.calls[0][2];
    fireEvent.change(screen.getByRole("textbox"), { target: { value: ".env*\nconfig/local/**\n" } });
    await screen.findByText("config/local/app.json");
    expect(mock.preview).toHaveBeenLastCalledWith("/repo", [".env*", "config/local/**"], expect.any(String));
    expect(mock.preview.mock.calls.at(-1)?.[2]).toBe(snapshot);
    expect(mock.update).not.toHaveBeenCalled();
    fireEvent.blur(screen.getByRole("textbox"));
    await waitFor(() => expect(mock.update).toHaveBeenCalledWith("/repo", { repositorySettings: { filesToCopy: [".env*", "config/local/**"] } }));
    // The line being started stays under the cursor.
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(".env*\nconfig/local/**\n");
  });

  it("previews a paused intermediate glob without persisting it", async () => {
    render(<RepositorySettingsPage project={project} />);
    await screen.findByText(".env.local");
    const textarea = screen.getByRole("textbox");
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: "*" } });
    await screen.findByText("config/local/app.json");
    expect(mock.preview).toHaveBeenLastCalledWith("/repo", ["*"], expect.any(String));
    expect(mock.update).not.toHaveBeenCalled();
    fireEvent.change(textarea, { target: { value: "*.local" } });
    fireEvent.blur(textarea);
    await waitFor(() => expect(mock.update).toHaveBeenCalledTimes(1));
    expect(mock.update).toHaveBeenLastCalledWith("/repo", { repositorySettings: { filesToCopy: ["*.local"] } });
  });

  it("cancels a pending blur commit when editing resumes before validation", async () => {
    let answer!: (value: RepositoryFilesPreview) => void;
    render(<RepositorySettingsPage project={project} />);
    await screen.findByText(".env.local");
    mock.preview.mockImplementationOnce(() => new Promise<RepositoryFilesPreview>((resolve) => { answer = resolve; }));
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "*" } });
    fireEvent.blur(textarea);
    await waitFor(() => expect(answer).toBeDefined());
    fireEvent.focus(textarea);
    await act(async () => answer(result(["*"])));
    expect(mock.update).not.toHaveBeenCalled();
    fireEvent.blur(textarea);
    await waitFor(() => expect(mock.update).toHaveBeenCalledTimes(1));
  });

  it.each(["Scripts", "Another repository", "Back to app"])("prevents unmount via %s until a pending blur commit is validated and saved", async (destination) => {
    let previewDone!: (value: RepositoryFilesPreview) => void;
    let saveDone!: () => void;
    render(<NavigationHarness />);
    await screen.findByText(".env.local");
    mock.preview.mockImplementationOnce(() => new Promise<RepositoryFilesPreview>((resolve) => { previewDone = resolve; }));
    mock.persist.mockImplementationOnce(() => new Promise<void>((resolve) => { saveDone = resolve; }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "config/local/**" } });
    fireEvent.blur(screen.getByRole("textbox"));
    fireEvent.click(screen.getByRole("button", { name: destination }));
    expect(screen.getByText("Navigation blocked until changes are saved")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("config/local/**");
    await waitFor(() => expect(previewDone).toBeDefined());
    await act(async () => previewDone(result(["config/local/**"])));
    expect(mock.update).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: destination }));
    expect(screen.queryByText(`Arrived at ${destination}`)).toBeNull();
    await act(async () => saveDone());
    fireEvent.click(screen.getByRole("button", { name: destination }));
    expect(screen.getByText(`Arrived at ${destination}`)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(mock.update).toHaveBeenCalledWith("/repo", { repositorySettings: { filesToCopy: ["config/local/**"] } });
  });

  it("keeps navigation guarded after a failed save until retry succeeds", async () => {
    mock.persist.mockRejectedValueOnce(new Error("Cannot save"));
    render(<NavigationHarness />);
    await screen.findByText(".env.local");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "config/local/**" } });
    fireEvent.blur(screen.getByRole("textbox"));
    await screen.findByRole("button", { name: "Retry save" });
    fireEvent.click(screen.getByRole("button", { name: "Back to app" }));
    expect(screen.getByRole("textbox")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry save" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Back to app" }));
    expect(screen.getByText("Arrived at Back to app")).toBeTruthy();
  });

  it("does not guard navigation for read-only include patterns", async () => {
    mock.preview.mockResolvedValue(result(["config/local/**"], true));
    render(<NavigationHarness />);
    await screen.findByText("Patterns come from this repository's .worktreeinclude");
    fireEvent.blur(screen.getByRole("textbox"));
    fireEvent.click(screen.getByRole("button", { name: "Back to app" }));
    expect(screen.getByText("Arrived at Back to app")).toBeTruthy();
    expect(mock.update).not.toHaveBeenCalled();
  });

  it("shows the repository include patterns read-only and never saves them", async () => {
    mock.preview.mockResolvedValue(result(["config/local/**"], true));
    render(<RepositorySettingsPage project={project} />);
    await screen.findByText("Patterns come from this repository's .worktreeinclude");
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(true);
    expect(textarea.value).toBe("config/local/**");
    fireEvent.blur(textarea);
    expect(screen.queryByRole("button", { name: "Retry save" })).toBeNull();
    expect(mock.update).not.toHaveBeenCalled();
    mock.preview.mockResolvedValue(result([".env*"]));
    fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
    await screen.findByText(".env.local");
    expect(textarea.readOnly).toBe(false);
    expect(textarea.value).toBe(".env*");
    expect(mock.update).not.toHaveBeenCalled();
  });

  it("keeps paths visible and the list read-only when the repository file cannot be read", async () => {
    mock.preview.mockResolvedValue({ ...result([], true), error: "Could not read .worktreeinclude" });
    render(<RepositorySettingsPage project={project} />);
    await screen.findByRole("button", { name: "Worktree folder: /repo/.raccoon/worktrees" });
    expect(screen.getByRole("alert").textContent).toBe("Could not read .worktreeinclude");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).readOnly).toBe(true);
  });

  it("ignores a stale preview and reports invalid patterns without saving", async () => {
    let answer!: (value: RepositoryFilesPreview) => void;
    render(<RepositorySettingsPage project={project} />);
    await screen.findByText(".env.local");
    mock.preview.mockImplementationOnce(() => new Promise<RepositoryFilesPreview>((resolve) => { answer = resolve; }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "slow" } });
    await waitFor(() => expect(answer).toBeDefined());
    mock.preview.mockResolvedValue({ ...result(), patterns: [{ pattern: "[", matches: [], error: "Unclosed character class" }] });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "[" } });
    fireEvent.blur(screen.getByRole("textbox"));
    await screen.findByRole("alert");
    await act(async () => answer(result(["slow"])));
    expect(screen.getByRole("alert").textContent).toBe("[: Unclosed character class");
    expect(mock.update).not.toHaveBeenCalled();
    expect(screen.queryByText("config/local/app.json")).toBeNull();
  });

  it("keeps the draft and explicitly retries unchanged text after a failed save", async () => {
    mock.update.mockRejectedValueOnce(new Error("Cannot save"));
    render(<RepositorySettingsPage project={project} />);
    await screen.findByText(".env.local");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "config/local/**" } });
    fireEvent.blur(screen.getByRole("textbox"));
    expect((await screen.findByRole("alert")).textContent).toContain("Cannot save");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("config/local/**");
    expect(mock.update).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
    await screen.findByText("1 ignored file matches");
    expect(screen.getByRole("alert").textContent).toContain("Cannot save");
    expect(mock.update).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(mock.update).toHaveBeenCalledTimes(2));
    expect(mock.update.mock.calls[1]).toEqual(mock.update.mock.calls[0]);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry save" })).toBeNull());
  });

  it("reports unreadable previews and can refresh after recovery", async () => {
    mock.preview.mockRejectedValueOnce(new Error("Cannot read .worktreeinclude"));
    render(<RepositorySettingsPage project={project} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Cannot read .worktreeinclude");
    fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
    await screen.findByText(".env.local");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mock.preview.mock.calls[0][2]).not.toBe(mock.preview.mock.calls[1][2]);
  });

  it("reports scan and preview limits without treating them as invalid patterns", async () => {
    mock.preview.mockResolvedValue({ ...result(), warning: "Ignored-file scan limit reached", patterns: [{ pattern: ".env*", matches: [".env"], omitted: 105, error: null }] });
    render(<RepositorySettingsPage project={project} />);
    await screen.findByText("105 more matches omitted from preview.");
    expect(screen.getByText("Ignored-file scan limit reached")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("opens each page by name, and a row's link on the page that holds it (PRO-155, PRO-144, PRO-131, PRO-387)", async () => {
    const { rerender } = render(<RepositoriesTab projectPath="/repo" page="actions" />);
    expect(screen.getByText("Actions page for /repo")).toBeTruthy();
    expect(screen.queryByText("Root path")).toBeNull();
    rerender(<RepositoriesTab projectPath="/repo" page="environment" />);
    expect(screen.getByText("Environment page for /repo")).toBeTruthy();
    expect(document.querySelector('[data-setting-id="repositories.environment"]')).toBeTruthy();
    rerender(<RepositoriesTab projectPath="/repo" page="settingsFiles" />);
    expect(screen.getByText("Settings files for /repo")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove project" })).toBeNull();
    expect(["repositories.previewUrls", "repositories.filesToCopy", "repositories.mergedCleanup", "repositories.rootPath", null].map(projectPageForRow)).toEqual(["general", "general", "general", "general", "general"]);
    expect(["repositories.scripts", "repositories.actions", "repositories.environment"].map(projectPageForRow)).toEqual(["scripts", "actions", "environment"]);
    await act(async () => undefined);
  });
});

describe("a project's default agent account (#980)", () => {
  it("is on a repository's General page and on a folder project's settings, and on no other page", async () => {
    const { unmount } = render(<RepositoriesTab projectPath="/repo" page="general" />);
    expect(screen.getByText("Agent accounts for /repo")).toBeTruthy();
    unmount();
    const other = render(<RepositoriesTab projectPath="/repo" page="environment" />);
    expect(screen.queryByText("Agent accounts for /repo")).toBeNull();
    other.unmount();
    render(<RepositoriesTab projectPath="/folder" />);
    expect(screen.getByText("Agent accounts for /folder")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove project" })).toBeTruthy();
  });
});
