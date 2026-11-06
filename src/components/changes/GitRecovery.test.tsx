import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { GitHubConnectionStatus } from "@/lib/api";

const backend = vi.hoisted(() => ({ invoke: vi.fn(), events: new Map<string, (event: { payload: unknown }) => void>(), openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: backend.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (event, handler) => { backend.events.set(event, handler); return () => backend.events.delete(event); }) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: backend.openUrl }));
vi.mock("@/components/terminal/TerminalView", () => ({ TerminalView: ({ id }: { id: string }) => <div data-testid="login-terminal">{id}</div> }));
vi.mock("./DiffPane", () => ({ DiffPane: () => null }));
const { PrPanel } = await import("./PrPanel");
const { RepoPanel } = await import("./RepoPanel");
const { LocalGitHubConnection } = await import("./GitRecovery");

const cwd = "/repos/new-project";
const signedOut = "You are not logged into any GitHub hosts. Run gh auth login to authenticate.";
let connection: GitHubConnectionStatus;
let remote: boolean;
let pushFailure: string | null;

beforeEach(() => {
  connection = { state: "signed_out", details: signedOut };
  remote = true;
  pushFailure = null;
  backend.invoke.mockImplementation(async (command: string) => {
    switch (command) {
      case "gh_connection_status": return connection;
      case "git_has_remote": return remote;
      case "work_status": return { isRepo: true, branch: "feature", upstream: null, ahead: 0, behind: 0, defaultBranch: "main", aheadOfBase: 1, head: "abc", dirty: false };
      case "working_changes": return ["abc", []];
      case "pr_list": return [];
      case "git_add_remote": case "gh_create_repository": remote = true; return;
      case "git_push": if (pushFailure) throw pushFailure; return "";
      case "gh_login_start": case "pty_kill": return;
      default: throw new Error(`Unexpected command: ${command}`);
    }
  });
});
afterEach(() => { cleanup(); backend.invoke.mockReset(); backend.openUrl.mockReset(); backend.events.clear(); });
function pr() { return render(<PrPanel cwd={cwd} branch="feature" active busy={false} />); }
function repo() { return render(<TooltipProvider><RepoPanel cwd={cwd} active view="uncommitted" onViewChange={() => {}} /></TooltipProvider>); }

describe("local Git recovery", () => {
  it("hides signed-out CLI output, runs web login in an embedded terminal, and refreshes on exit", async () => {
    pr();
    const connect = await screen.findByRole("button", { name: "Connect GitHub" });
    expect(screen.queryByText(signedOut)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(screen.getByText(signedOut)).toBeTruthy();
    fireEvent.click(connect);
    await screen.findByTestId("login-terminal");
    const spawn = backend.invoke.mock.calls.find(([command]) => command === "gh_login_start")!;
    expect(spawn[1].id).toMatch(/^github-login-/);
    expect(Object.keys(spawn[1])).toEqual(["id"]);
    connection = { state: "connected", details: null };
    act(() => backend.events.get("pty_exit")?.({ payload: { id: spawn[1].id, code: 0 } }));
    await screen.findByRole("button", { name: "Create pull request" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(backend.invoke).toHaveBeenCalledWith("pty_kill", { id: spawn[1].id }));
  });

  it("keeps a cancelled login recoverable and closes only its own terminal", async () => {
    pr();
    fireEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }));
    await screen.findByTestId("login-terminal");
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    await screen.findByRole("button", { name: "Connect GitHub" });
    expect(screen.queryByText(signedOut)).toBeNull();
    expect(backend.invoke.mock.calls.filter(([command]) => command === "pty_kill")).toHaveLength(1);
  });

  it("cancels a login whose start finishes after its dialog has closed", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const original = backend.invoke.getMockImplementation()!;
    backend.invoke.mockImplementation((command, args) => command === "gh_login_start" ? pending : original(command, args));
    pr();
    fireEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }));
    await waitFor(() => expect(backend.invoke.mock.calls.some(([command]) => command === "gh_login_start")).toBe(true));
    const id = backend.invoke.mock.calls.find(([command]) => command === "gh_login_start")![1].id;
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(backend.invoke.mock.calls.some(([command]) => command === "pty_kill")).toBe(false);
    await act(async () => finish());
    await waitFor(() => expect(backend.invoke).toHaveBeenCalledWith("pty_kill", { id }));
    expect(screen.queryByTestId("login-terminal")).toBeNull();
  });

  it("offers installation when gh is missing, without starting a command that cannot run", async () => {
    connection = { state: "missing", details: null };
    pr();
    fireEvent.click(await screen.findByRole("button", { name: "Install GitHub CLI" }));
    expect(backend.openUrl).toHaveBeenCalledWith("https://cli.github.com/");
    expect(backend.invoke.mock.calls.some(([command]) => command === "gh_login_start")).toBe(false);
  });

  it("checks GitHub from Settings and refreshes after an external login", async () => {
    render(<LocalGitHubConnection />);
    await screen.findByRole("button", { name: "Connect GitHub" });
    connection = { state: "connected", details: null };
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await screen.findByText("GitHub connected");
  });

  it("offers a remote URL instead of invoking a push with no remote, then allows a real push", async () => {
    remote = false;
    repo();
    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    const url = await screen.findByRole("textbox", { name: "Remote URL" });
    expect(backend.invoke.mock.calls.some(([command]) => command === "git_push")).toBe(false);
    expect(screen.queryByRole("button", { name: "Create a GitHub repository" })).toBeNull();
    fireEvent.change(url, { target: { value: "https://github.com/owner/repo.git" } });
    fireEvent.click(screen.getByRole("button", { name: "Add remote" }));
    await screen.findByText("Remote added. Push when you’re ready.");
    expect(backend.invoke).toHaveBeenCalledWith("git_add_remote", { cwd, url: "https://github.com/owner/repo.git" });
    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    await waitFor(() => expect(backend.invoke).toHaveBeenCalledWith("git_push", { cwd }));
  });

  it("lets a signed-in person create a private GitHub repository without publishing commits", async () => {
    remote = false;
    connection = { state: "connected", details: null };
    repo();
    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create a GitHub repository" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Repository name" }), { target: { value: "owner/new-project" } });
    expect((screen.getByRole("combobox", { name: "Visibility" }) as HTMLSelectElement).value).toBe("private");
    fireEvent.click(screen.getByRole("button", { name: "Create repository" }));
    await screen.findByText("Remote added. Push when you’re ready.");
    expect(backend.invoke).toHaveBeenCalledWith("gh_create_repository", { cwd, name: "owner/new-project", private: true });
    expect(backend.invoke.mock.calls.some(([command]) => command === "git_push")).toBe(false);
  });

  it("shows permission-denied push as an access problem with stderr behind Show details", async () => {
    pushFailure = "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.";
    repo();
    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    await screen.findByText("Repository access denied");
    expect(screen.queryByText(/Permission denied \(publickey\)/)).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Remote URL" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(screen.getByText(/Permission denied \(publickey\)/)).toBeTruthy();
  });

  it("offers remote setup in the PR tab after connection, before attempting PR discovery", async () => {
    remote = false;
    connection = { state: "connected", details: null };
    pr();
    await screen.findByRole("textbox", { name: "Remote URL" });
    expect(backend.invoke.mock.calls.some(([command]) => command === "pr_list")).toBe(false);
  });

  it("does not show a late missing-remote result in a newly selected repository", async () => {
    let finish!: (remote: boolean) => void;
    const pending = new Promise<boolean>((resolve) => { finish = resolve; });
    const original = backend.invoke.getMockImplementation()!;
    backend.invoke.mockImplementation((command, args) => command === "git_has_remote" ? pending : original(command, args));
    const view = repo();
    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    view.rerender(<TooltipProvider><RepoPanel cwd="/repos/other" active view="uncommitted" onViewChange={() => {}} /></TooltipProvider>);
    await act(async () => finish(false));
    expect(screen.queryByRole("textbox", { name: "Remote URL" })).toBeNull();
    expect(backend.invoke.mock.calls.some(([command]) => command === "git_push")).toBe(false);
  });
});
