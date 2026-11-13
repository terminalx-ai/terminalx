import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
      case "working_change_sets": return ["abc", "index", [], []];
      case "pr_list": return [];
      case "git_add_remote": case "gh_create_repository": remote = true; return;
      case "git_push": if (pushFailure) throw pushFailure; return "";
      case "gh_login_start": case "pty_kill": return;
      default: throw new Error(`Unexpected command: ${command}`);
    }
  });
});
afterEach(async () => { await act(async () => cleanup()); vi.restoreAllMocks(); backend.invoke.mockReset(); backend.openUrl.mockReset(); backend.events.clear(); });
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
    expect(spawn[1].hostname).toBe("github.com");
    expect(backend.invoke).toHaveBeenCalledWith("gh_connection_status", { cwd });
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

  it.each([false, true])("preserves the login PTY across visibility changes until closed or exited (authenticated=%s)", async (authenticated) => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    pr();
    fireEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }));
    const terminal = await screen.findByTestId("login-terminal");
    const id = terminal.textContent;
    const checks = backend.invoke.mock.calls.filter(([command]) => command === "gh_connection_status").length;

    await act(async () => {
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // Browser authentication can succeed before the login process has exited.
    if (authenticated) connection = { state: "connected", details: null };
    await act(async () => {
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(backend.invoke.mock.calls.filter(([command]) => command === "pty_kill")).toHaveLength(0);
    expect(screen.getByTestId("login-terminal")).toBe(terminal);
    expect(backend.invoke.mock.calls.filter(([command]) => command === "gh_login_start")).toHaveLength(1);
    if (authenticated) {
      act(() => backend.events.get("pty_exit")?.({ payload: { id, code: 0 } }));
      await screen.findByRole("button", { name: "Create pull request" });
    } else {
      fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
      await screen.findByRole("button", { name: "Connect GitHub" });
    }
    await waitFor(() => expect(backend.invoke).toHaveBeenCalledWith("pty_kill", { id }));
    expect(backend.invoke.mock.calls.filter(([command]) => command === "pty_kill")).toHaveLength(1);
    expect(backend.invoke.mock.calls.filter(([command]) => command === "gh_connection_status").length).toBeGreaterThan(checks);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancels the old repository's login when selecting another repository", async () => {
    const view = pr();
    fireEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }));
    const id = (await screen.findByTestId("login-terminal")).textContent;
    view.rerender(<PrPanel cwd="/repos/other" branch="feature" active busy={false} />);
    await waitFor(() => expect(backend.invoke).toHaveBeenCalledWith("pty_kill", { id }));
    await screen.findByRole("button", { name: "Connect GitHub" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(backend.invoke).toHaveBeenCalledWith("gh_connection_status", { cwd: "/repos/other" });
    const checks = backend.invoke.mock.calls.filter(([command]) => command === "gh_connection_status").length;
    view.rerender(<PrPanel cwd={cwd} branch="feature" active busy={false} />);
    await waitFor(() => expect(backend.invoke.mock.calls.filter(([command]) => command === "gh_connection_status").length).toBeGreaterThan(checks));
    fireEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }));
    expect((await screen.findByTestId("login-terminal")).textContent).not.toBe(id);
  });

  it.each([1, null])("retains failed login output until dismissed (exit %s)", async (code) => {
    pr();
    fireEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }));
    const terminal = await screen.findByTestId("login-terminal");
    const id = terminal.textContent;
    act(() => backend.events.get("pty_exit")?.({ payload: { id, code } }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("GitHub sign-in did not finish. Check the command output before trying again.")).toBeTruthy();
    expect(backend.invoke.mock.calls.some(([command]) => command === "pty_kill")).toBe(false);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(Array.from(dialog.querySelectorAll("button")).find((button) => button.textContent === "Show details")!);
    expect(screen.getByTestId("login-terminal").textContent).toBe(id);
    fireEvent.click(screen.getByRole("button", { name: "Close sign-in" }));
    await waitFor(() => expect(backend.invoke).toHaveBeenCalledWith("pty_kill", { id }));
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

  it("connects to the repository's Enterprise host", async () => {
    connection = { state: "signed_out", details: signedOut, hostname: "github.example.test" };
    pr();
    fireEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }));
    await screen.findByTestId("login-terminal");
    expect(backend.invoke).toHaveBeenCalledWith("gh_login_start", { id: expect.stringMatching(/^github-login-/), hostname: "github.example.test" });
  });

  it("offers connection recovery for a transport failure without starting login", async () => {
    connection = { state: "unavailable", details: "proxyconnect tcp: connect: connection refused", hostname: "github.com" };
    pr();
    await screen.findByRole("heading", { name: "Could not check GitHub" });
    expect(screen.queryByRole("button", { name: "Connect GitHub" })).toBeNull();
    expect(screen.queryByText(connection.details!)).toBeNull();
    const checks = backend.invoke.mock.calls.filter(([command]) => command === "gh_connection_status").length;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(backend.invoke.mock.calls.filter(([command]) => command === "gh_connection_status").length).toBeGreaterThan(checks));
    expect(backend.invoke.mock.calls.some(([command]) => command === "gh_login_start")).toBe(false);
  });

  it("checks GitHub from Settings and refreshes after an external login", async () => {
    render(<LocalGitHubConnection />);
    await screen.findByRole("button", { name: "Connect GitHub" });
    connection = { state: "connected", details: null };
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await screen.findByText("GitHub connected");
  });

  it("keeps file review controls while adding a remote, then allows an explicit push", async () => {
    remote = false;
    const original = backend.invoke.getMockImplementation()!;
    backend.invoke.mockImplementation((command, args) => command === "working_change_sets" ? Promise.resolve(["abc", "index", [], [
      { path: "src/recovery.ts", status: "modified", additions: 1, deletions: 0 },
      { path: "README.md", status: "modified", additions: 1, deletions: 0 },
    ]]) : original(command, args));
    repo();
    await screen.findByTitle("Modified · src/recovery.ts");
    const unstaged = within(screen.getByRole("region", { name: "Unstaged" }));
    fireEvent.click(unstaged.getByRole("radio", { name: "Folders" }));
    fireEvent.change(unstaged.getByRole("searchbox", { name: "Filter changed files" }), { target: { value: "recovery" } });
    expect(screen.queryByRole("button", { name: /README.md/ })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Viewed src/recovery.ts" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    const url = await screen.findByRole("textbox", { name: "Remote URL" });
    expect(backend.invoke.mock.calls.some(([command]) => command === "git_push")).toBe(false);
    expect(screen.queryByRole("button", { name: "Create a GitHub repository" })).toBeNull();
    fireEvent.change(url, { target: { value: "https://github.com/owner/repo.git" } });
    fireEvent.click(screen.getByRole("button", { name: "Add remote" }));
    await screen.findByText("Remote added. Push when you’re ready.");
    expect(backend.invoke).toHaveBeenCalledWith("git_add_remote", { cwd, url: "https://github.com/owner/repo.git" });
    expect(backend.invoke.mock.calls.some(([command]) => command === "git_push")).toBe(false);
    expect(unstaged.getByRole("searchbox", { name: "Filter changed files" })).toHaveProperty("value", "recovery");
    expect(unstaged.getByRole("radio", { name: "Folders" }).getAttribute("aria-checked")).toBe("true");
    expect(await screen.findByTitle("Modified · src/recovery.ts")).toBeTruthy();
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

describe("PR load failures by cause", () => {
  afterEach(cleanup);
  it("names access, timeout and offline, with their actions", async () => {
    const { GitError } = await import("./GitRecovery");
    const retry = vi.fn();
    const connect = vi.fn();
    const view = render(<GitError details="HTTP 403: Resource not accessible by integration" onConnect={connect} onRetry={retry} />);
    expect(screen.getByText("GitHub access required")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));
    expect(connect).toHaveBeenCalled();
    view.rerender(<GitError details="gh pr view: call did not answer" onRetry={retry} />);
    expect(screen.getByText("Couldn't refresh PR info")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalled();
    view.rerender(<GitError details="error connecting to api.github.com" />);
    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    view.rerender(<GitError details="HTTP 403" operation="push" />);
    expect(screen.queryByText("GitHub access required")).toBeNull();
  });
});
