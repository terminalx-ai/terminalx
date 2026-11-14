import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoriesTab, RepositorySettingsPage } from "./RepositoriesTab";
import type { RepositoryFilesPreview } from "@/types/repositorySettings";
import type { Project } from "@/types/session";

const mock = vi.hoisted(() => ({ preview: vi.fn(), update: vi.fn(), reveal: vi.fn(), copy: vi.fn(), projects: [] as Project[] }));
vi.mock("@/lib/api", () => ({ api: { repositoryFilesPreview: mock.preview }, errorMessage: (e: unknown) => String(e) }));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => ({ projects: mock.projects }), updateProject: mock.update }));
vi.mock("./MergedCleanupSettings", () => ({ MergedCleanupSettings: () => null }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: mock.reveal }));
vi.mock("@/lib/clipboard", () => ({ copyText: mock.copy }));
vi.mock("./RepositoryActionsPage", () => ({ RepositoryActionsPage: ({ projectPath }: { projectPath: string }) => <p>Actions page for {projectPath}</p> }));
vi.mock("./RepositoryPreviewUrlsPage", () => ({ RepositoryPreviewUrlsPage: ({ projectPath }: { projectPath: string }) => <p>Preview URLs page for {projectPath}</p> }));
vi.mock("./RepositoryEnvironmentSettings", () => ({ RepositoryEnvironmentSettings: ({ projectPath }: { projectPath: string }) => <p>Environment page for {projectPath}</p> }));
const project: Project = { path: "/repo", name: "Example", repositorySettings: { filesToCopy: [".env*"] } };
const result = (patterns = [".env*"], fromIncludeFile = false): RepositoryFilesPreview => ({
  rootPath: "/repo", workspacesPath: "/repo/.raccoon/worktrees", fromIncludeFile,
  patterns: patterns.map((pattern) => ({ pattern, matches: pattern === ".env*" ? [".env", ".env.local"] : ["config/local/app.json"], error: null })),
});
beforeEach(() => {
  vi.clearAllMocks();
  mock.projects = [project, { path: "/folder", name: "Folder", kind: "folder" }];
  mock.preview.mockImplementation(async (_path, patterns) => result(patterns));
  mock.update.mockResolvedValue(project);
  mock.reveal.mockResolvedValue(undefined);
  mock.copy.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("Project settings", () => {
  it("offers root and workspace paths with Reveal and Copy for the selected repository", async () => {
    render(<RepositoriesTab projectPath="/repo" />);
    await screen.findByText("/repo/.raccoon/worktrees");
    fireEvent.click(screen.getByRole("button", { name: "Copy root path" }));
    fireEvent.click(screen.getByRole("button", { name: "Reveal worktree folder" }));
    expect(mock.copy).toHaveBeenCalledWith("/repo");
    expect(mock.reveal).toHaveBeenCalledWith("/repo/.raccoon/worktrees");
    // The worktree folder is read-only: revealed or copied, never changed here.
    expect(screen.getByRole("button", { name: "Copy worktree folder" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Change/ })).toBeNull();
  });

  it("holds Preview URLs and Files to copy as sections of General, with no nav entries of their own (PRO-131)", async () => {
    render(<RepositoriesTab projectPath="/repo" row="repositories.rootPath" />);
    await screen.findByText(".env.local");
    const general = document.querySelector('[data-setting-id="repositories.rootPath"]')!;
    const preview = document.querySelector('[data-setting-id="repositories.previewUrls"]')!;
    const files = document.querySelector('[data-setting-id="repositories.filesToCopy"]')!;
    expect(preview.textContent).toContain("Preview URLs page for /repo");
    expect(screen.getByRole("region", { name: "Files to copy" })).toBeTruthy();
    // Paths, then Preview URLs, then Files to copy.
    expect(general.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(preview.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const nav = within(screen.getByRole("navigation", { name: "Project settings" }));
    expect(nav.getAllByRole("button").map((button) => button.textContent)).toEqual(["General", "Scripts", "Actions", "Environment"]);
  });

  it("says no ignored file matches, why for each pattern, and checks again (design 11.12)", async () => {
    mock.preview.mockImplementation(async () => ({
      rootPath: "/repo", workspacesPath: "/repo/.raccoon/worktrees", fromIncludeFile: false,
      patterns: [
        { pattern: ".env.production", matches: [], error: null, reason: ".env.production doesn't exist yet." },
        { pattern: "config/secrets/*.json", matches: [], error: null, reason: "config/secrets/example.json is tracked by git, so every worktree already has it." },
        { pattern: "tmp/**", matches: [], error: null },
      ],
    }));
    render(<RepositorySettingsPage project={project} />);
    await screen.findByText("No ignored files match these patterns");
    const why = within(screen.getByRole("list", { name: "Why each pattern matched nothing" }));
    expect(why.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      ".env.production.env.production doesn't exist yet.",
      "config/secrets/*.jsonconfig/secrets/example.json is tracked by git, so every worktree already has it.",
      "tmp/**No ignored files match.",
    ]);
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
    await screen.findByText(".env.production doesn't exist yet.");
    expect(screen.queryByText("No ignored files match these patterns")).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh preview" })).toBeTruthy();
  });

  it("previews edits without saving and saves only the chosen repository's patterns", async () => {
    render(<RepositorySettingsPage project={project} />);
    await screen.findByText(".env.local");
    const snapshot = mock.preview.mock.calls[0][2];
    fireEvent.change(screen.getByRole("textbox"), { target: { value: ".env*\nconfig/local/**\n" } });
    await screen.findByText("config/local/app.json");
    expect(mock.preview).toHaveBeenLastCalledWith("/repo", [".env*", "config/local/**"], expect.any(String));
    expect(mock.preview.mock.calls.at(-1)?.[2]).toBe(snapshot);
    expect(mock.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mock.update).toHaveBeenCalledWith("/repo", { repositorySettings: { filesToCopy: [".env*", "config/local/**"] } }));
  });

  it("shows the repository include patterns read-only and keeps the saved list separate", async () => {
    mock.preview.mockResolvedValue(result(["config/local/**"], true));
    render(<RepositorySettingsPage project={project} />);
    await screen.findByText("Patterns come from this repository's .worktreeinclude");
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(true);
    expect(textarea.value).toBe("config/local/**");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(mock.update).not.toHaveBeenCalled();
    mock.preview.mockResolvedValue(result([".env*"]));
    fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
    await screen.findByText(".env.local");
    expect(textarea.readOnly).toBe(false);
    expect(textarea.value).toBe(".env*");
  });

  it("keeps paths visible and the list read-only when the repository file cannot be read", async () => {
    mock.preview.mockResolvedValue({ ...result([], true), error: "Could not read .worktreeinclude" });
    render(<RepositorySettingsPage project={project} />);
    await screen.findByText("/repo/.raccoon/worktrees");
    expect(screen.getByRole("alert").textContent).toBe("Could not read .worktreeinclude");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("ignores a stale preview and reports invalid patterns without allowing a save", async () => {
    let answer!: (value: RepositoryFilesPreview) => void;
    render(<RepositorySettingsPage project={project} />);
    await screen.findByText(".env.local");
    mock.preview.mockImplementationOnce(() => new Promise<RepositoryFilesPreview>((resolve) => { answer = resolve; }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "slow" } });
    await waitFor(() => expect(answer).toBeDefined());
    mock.preview.mockResolvedValue({ ...result(), patterns: [{ pattern: "[", matches: [], error: "Unclosed character class" }] });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "[" } });
    await screen.findByRole("alert");
    await act(async () => answer(result(["slow"])));
    expect(screen.getByRole("alert").textContent).toBe("Unclosed character class");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("config/local/app.json")).toBeNull();
  });

  it("lets the reader correct a draft rejected by the preview service", async () => {
    render(<RepositorySettingsPage project={project} />);
    await screen.findByText(".env.local");
    mock.preview.mockRejectedValueOnce(new Error("Use at most 128 patterns"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: Array(129).fill(".env*").join("\n") } });
    await screen.findByRole("alert");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(false);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "config/local/**" } });
    await screen.findByText("config/local/app.json");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the draft when saving fails and supports retry", async () => {
    mock.update.mockRejectedValueOnce(new Error("Cannot save"));
    render(<RepositorySettingsPage project={project} />);
    await screen.findByText(".env.local");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "config/local/**" } });
    await screen.findByText("config/local/app.json");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Cannot save");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("config/local/**");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mock.update).toHaveBeenCalledTimes(2));
  });

  it("reports unreadable previews and can refresh after recovery", async () => {
    mock.preview.mockRejectedValueOnce(new Error("Cannot read .worktreeinclude"));
    render(<RepositorySettingsPage project={project} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Cannot read .worktreeinclude");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
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

  it("opens the Actions and Environment pages from their rows and its nav, and Preview URLs and Files to copy on General (PRO-155, PRO-144, PRO-131)", async () => {
    const onSelectRow = vi.fn();
    const { rerender } = render(<RepositoriesTab projectPath="/repo" row="repositories.actions" onSelectRow={onSelectRow} />);
    expect(screen.getByText("Actions page for /repo")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Actions" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByText("Root path")).toBeNull();
    expect(screen.queryByText("Preview URLs page for /repo")).toBeNull();
    // A link to either former page (terminalx://settings/repositories.previewUrls, …filesToCopy) opens General, at its section.
    for (const row of ["repositories.previewUrls", "repositories.filesToCopy"]) {
      rerender(<RepositoriesTab projectPath="/repo" row={row} onSelectRow={onSelectRow} />);
      expect(screen.getByRole("button", { name: "General" }).getAttribute("aria-current")).toBe("page");
      expect(screen.getByText("Root path")).toBeTruthy();
      expect(document.querySelector(`[data-setting-id="${row}"]`)).toBeTruthy();
    }
    expect(screen.getByText("Preview URLs page for /repo")).toBeTruthy();
    rerender(<RepositoriesTab projectPath="/repo" row="repositories.environment" onSelectRow={onSelectRow} />);
    expect(screen.getByText("Environment page for /repo")).toBeTruthy();
    expect(document.querySelector('[data-setting-id="repositories.environment"]')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    expect(onSelectRow.mock.calls).toEqual([["repositories.actions"], ["repositories.rootPath"]]);
    // Scripts is its own page beside ours; rows that live on General, such as Workspace cleanup, open General.
    rerender(<RepositoriesTab projectPath="/repo" row="repositories.scripts" onSelectRow={onSelectRow} />);
    expect(screen.getByRole("button", { name: "Scripts" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByText("Actions page for /repo")).toBeNull();
    rerender(<RepositoriesTab projectPath="/repo" row="repositories.mergedCleanup" onSelectRow={onSelectRow} />);
    expect(screen.getByRole("button", { name: "General" }).getAttribute("aria-current")).toBe("page");
    expect(within(screen.getByRole("navigation", { name: "Project settings" })).getAllByRole("button").map((button) => button.textContent)).toEqual(["General", "Scripts", "Actions", "Environment"]);
    await act(async () => undefined);
  });
});
