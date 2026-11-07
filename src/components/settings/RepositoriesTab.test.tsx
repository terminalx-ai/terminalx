import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoriesTab, RepositorySettingsPage } from "./RepositoriesTab";
import type { RepositoryFilesPreview } from "@/types/repositorySettings";
import type { Project } from "@/types/session";

const mock = vi.hoisted(() => ({ preview: vi.fn(), update: vi.fn(), reveal: vi.fn(), copy: vi.fn(), projects: [] as Project[] }));
vi.mock("@/lib/api", () => ({ api: { repositoryFilesPreview: mock.preview }, errorMessage: (e: unknown) => String(e) }));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => ({ projects: mock.projects }), updateProject: mock.update }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: mock.reveal }));
vi.mock("@/lib/clipboard", () => ({ copyText: mock.copy }));
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

describe("Repository settings", () => {
  it("offers root and workspace paths with Reveal and Copy for the selected repository", async () => {
    render(<RepositoriesTab projectPath="/repo" />);
    await screen.findByText("/repo/.raccoon/worktrees");
    fireEvent.click(screen.getByRole("button", { name: "Copy root path" }));
    fireEvent.click(screen.getByRole("button", { name: "Reveal workspaces path" }));
    expect(mock.copy).toHaveBeenCalledWith("/repo");
    expect(mock.reveal).toHaveBeenCalledWith("/repo/.raccoon/worktrees");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("previews edits without saving and saves only the chosen repository's patterns", async () => {
    render(<RepositorySettingsPage project={project} page="files" />);
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
    render(<RepositorySettingsPage project={project} page="files" />);
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
    const view = render(<RepositorySettingsPage project={project} page="general" />);
    await screen.findByText("/repo/.raccoon/worktrees");
    expect(screen.getByRole("alert").textContent).toBe("Could not read .worktreeinclude");
    view.rerender(<RepositorySettingsPage project={project} page="files" />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("ignores a stale preview and reports invalid patterns without allowing a save", async () => {
    let answer!: (value: RepositoryFilesPreview) => void;
    render(<RepositorySettingsPage project={project} page="files" />);
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
    render(<RepositorySettingsPage project={project} page="files" />);
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
    render(<RepositorySettingsPage project={project} page="files" />);
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
    render(<RepositorySettingsPage project={project} page="files" />);
    expect((await screen.findByRole("alert")).textContent).toContain("Cannot read .worktreeinclude");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
    await screen.findByText(".env.local");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mock.preview.mock.calls[0][2]).not.toBe(mock.preview.mock.calls[1][2]);
  });

  it("reports scan and preview limits without treating them as invalid patterns", async () => {
    mock.preview.mockResolvedValue({ ...result(), warning: "Ignored-file scan limit reached", patterns: [{ pattern: ".env*", matches: [".env"], omitted: 105, error: null }] });
    render(<RepositorySettingsPage project={project} page="files" />);
    await screen.findByText("105 more matches omitted from preview.");
    expect(screen.getByText("Ignored-file scan limit reached")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
