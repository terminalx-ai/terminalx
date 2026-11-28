import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/icons", () => new Proxy({}, { has: () => true, get: (_, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : prop === "__esModule" ? true : (props: Record<string, unknown>) => <svg {...props} />) }));
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: import("react").ReactNode }) => children,
  WithTooltip: ({ children }: { children: import("react").ReactNode }) => children,
  Tooltip: ({ children }: { children: import("react").ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: import("react").ReactNode }) => children,
  TooltipContent: () => null,
  Kbd: ({ children }: { children: import("react").ReactNode }) => <kbd data-slot="kbd">{children}</kbd>,
  KbdGroup: ({ keys }: { keys: string[] }) => <span data-slot="kbd">{keys.map((k, i) => <kbd key={i}>{k}</kbd>)}</span>,
}));
import type { HarnessInfo, Project } from "@/types/session";

const { dragDropListener, invoke, openDialog, openUrl, store, account, sessions, signIn, prefs, setPrefs } = vi.hoisted(() => ({
  dragDropListener: vi.fn(),
  invoke: vi.fn(),
  openDialog: vi.fn(),
  openUrl: vi.fn(),
  signIn: vi.fn(),
  store: { harnesses: [] as unknown[], projects: [] as Project[], sessions: [] as { projectPath: string; modified: string }[] },
  account: { ready: true, busy: false, status: { state: "signed-out" as string, identity: null as { name: string | null; email: string } | null } },
  sessions: { addProject: vi.fn(), startSessionIn: vi.fn(), refreshHarnesses: vi.fn(async () => {}) },
  prefs: { projectsDir: null, lastMode: "manual", lastAgent: "claude", bypassConfirmed: false },
  setPrefs: vi.fn(),
}));

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: dragDropListener }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialog }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("@/lib/api", () => ({ errorMessage: (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)), files: { droppedText: vi.fn(async () => null) } }));
vi.mock("@/lib/account", () => ({ signIn, useAccount: () => account }));
vi.mock("@/lib/prefs", () => ({ setPrefs, getPrefs: () => prefs, usePrefs: () => prefs }));
vi.mock("@/lib/sessions", () => ({ ...sessions, useSessionStore: () => store }));

const { StartScreen } = await import("./StartScreen");
const { ProjectStartDialogHost } = await import("./ProjectStartDialogs");
const { BypassDialog } = await import("@/components/session/BypassDialog");
const { closeBypass } = await import("@/lib/dialogs");
const { openProjectStart } = await import("@/lib/projectStart");
const { forgetReadiness } = await import("@/lib/agentReadiness");

const claude = { id: "claude", name: "Claude Code", available: true, installHint: "npm i -g claude", installUrl: "https://example.com/claude" } as HarnessInfo;
const codex = { id: "codex", name: "Codex", available: false, installHint: "npm i -g codex", installUrl: "https://example.com/codex" } as HarnessInfo;

const cards = () => screen.getAllByRole("button").filter((button) => button.hasAttribute("data-start-card"));

async function emitDrop(payload: { type: string; paths?: string[] }) {
  await waitFor(() => expect(dragDropListener).toHaveBeenCalled());
  await act(async () => {
    await dragDropListener.mock.calls.at(-1)![0]({ payload: { position: { x: 5, y: 5 }, ...payload } });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  forgetReadiness();
  dragDropListener.mockResolvedValue(vi.fn());
  store.harnesses = [claude];
  store.projects = [];
  store.sessions = [];
  account.status = { state: "signed-out", identity: null };
  Object.assign(prefs, { lastMode: "manual", bypassConfirmed: false });
  sessions.addProject.mockImplementation(async (path: string) => ({ path, name: path.split("/").pop() }) as Project);
  invoke.mockImplementation(async (command: string, args?: { harness?: string }) => {
    // Each agent's login is found exactly when it is installed.
    if (command === "check_agent_readiness") return { state: (store.harnesses as HarnessInfo[]).find((harness) => harness.id === args?.harness)?.available ? "ready" : "missing", checkedAt: null, version: null };
    if (command === "github_repositories") return { status: "ready", repositories: [], truncated: false };
    if (command === "project_start_defaults") return { projectsDir: "/home/me/Projects", suggestedName: "my-project" };
    throw new Error(`unexpected command ${command}`);
  });
});

afterEach(() => {
  cleanup();
  act(() => { openProjectStart(null); closeBypass(); });
});

const probed = () => invoke.mock.calls.filter(([command]) => command === "check_agent_readiness").map(([, args]) => (args as { harness: string }).harness);

describe("the start screen", () => {
  it("welcomes by name with the three numbered steps, the project one open", async () => {
    render(<StartScreen onOpenSettings={vi.fn()} />);

    expect(screen.getByRole("heading", { level: 1, name: "Welcome to TerminalX" })).toBeTruthy();
    expect(screen.getByText("Run coding agents side by side, each in its own worktree.")).toBeTruthy();
    // An agent can run: step 1 is done, step 2 is the one in hand, step 3 waits with its choice.
    await waitFor(() => expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Agents ready", "Open a project", "Choose how much the agent may do alone"]));
    expect(screen.getByTestId("start-screen").getAttribute("data-stage")).toBe("project");
    expect(screen.getByRole("group", { name: "Get started" })).toBeTruthy();
    expect(cards().map((card) => card.getAttribute("data-start-card"))).toEqual(["local", "github", "quick"]);
    // Each is a real button with a name of its own, and its hint as a description.
    expect(screen.getByRole("button", { name: "Open local project" }).getAttribute("aria-describedby")).toBe("start-card-hint-local");
    expect(screen.getByRole("button", { name: "Open GitHub project" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Quick start" })).toBeTruthy();
    expect(screen.queryByTestId("start-no-agent")).toBeNull();
  });

  it("opens a chosen folder as a project and lands on its new-session view", async () => {
    openDialog.mockResolvedValue("/code/widgets");
    render(<StartScreen onOpenSettings={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Open local project" }));

    await waitFor(() => expect(sessions.startSessionIn).toHaveBeenCalledWith("/code/widgets", null));
    expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
    expect(sessions.addProject).toHaveBeenCalledWith("/code/widgets");
  });

  it("attaches nothing when the folder picker is dismissed", async () => {
    openDialog.mockResolvedValue(null);
    render(<StartScreen onOpenSettings={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Open local project" }));

    await waitFor(() => expect(openDialog).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByRole("button", { name: "Open local project" }) as HTMLButtonElement).disabled).toBe(false));
    expect(sessions.addProject).not.toHaveBeenCalled();
    expect(sessions.startSessionIn).not.toHaveBeenCalled();
  });

  it("says why a folder could not be opened", async () => {
    openDialog.mockResolvedValue("/code/mirror");
    sessions.addProject.mockRejectedValue(new Error("That folder is a cloud mirror."));
    render(<StartScreen onOpenSettings={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Open local project" }));

    expect((await screen.findByRole("alert")).textContent).toBe("That folder is a cloud mirror.");
    expect(sessions.startSessionIn).not.toHaveBeenCalled();
  });

  it("opens the GitHub and Quick start dialogs from their cards", async () => {
    render(
      <>
        <StartScreen onOpenSettings={vi.fn()} />
        <ProjectStartDialogHost />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open GitHub project" }));
    expect(await screen.findByTestId("start-github-dialog")).toBeTruthy();

    act(() => openProjectStart(null));
    fireEvent.click(screen.getByRole("button", { name: "Quick start" }));
    expect(await screen.findByTestId("start-quick-dialog")).toBeTruthy();
  });

  it("moves between the cards with the arrow keys, Home and End", () => {
    render(<StartScreen onOpenSettings={vi.fn()} />);
    const [local, github, quick] = cards();

    local.focus();
    fireEvent.keyDown(local, { key: "ArrowRight" });
    expect(document.activeElement).toBe(github);
    fireEvent.keyDown(github, { key: "ArrowDown" });
    expect(document.activeElement).toBe(quick);
    fireEvent.keyDown(quick, { key: "ArrowRight" });
    expect(document.activeElement).toBe(local);
    fireEvent.keyDown(local, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(quick);
    fireEvent.keyDown(quick, { key: "ArrowUp" });
    expect(document.activeElement).toBe(github);
    fireEvent.keyDown(github, { key: "End" });
    expect(document.activeElement).toBe(quick);
    fireEvent.keyDown(quick, { key: "Home" });
    expect(document.activeElement).toBe(local);
  });

  it("opens a folder dropped anywhere on it", async () => {
    render(<StartScreen onOpenSettings={vi.fn()} />);

    await emitDrop({ type: "drop", paths: ["/code/dropped", "/code/second"] });

    await waitFor(() => expect(sessions.startSessionIn).toHaveBeenCalledWith("/code/dropped", null));
    expect(sessions.addProject).toHaveBeenCalledTimes(1);
  });

  it("refuses a dropped file without attaching anything", async () => {
    sessions.addProject.mockRejectedValue("Not a directory: /code/notes.txt");
    render(<StartScreen onOpenSettings={vi.fn()} />);

    await emitDrop({ type: "drop", paths: ["/code/notes.txt"] });

    expect((await screen.findByRole("alert")).textContent).toBe("Drop a folder to open it as a project.");
    expect(sessions.startSessionIn).not.toHaveBeenCalled();
  });

  it("adds nothing behind an open dialog when a folder is dropped on it", async () => {
    render(<StartScreen onOpenSettings={vi.fn()} />);
    act(() => openProjectStart("quick"));

    await emitDrop({ type: "drop", paths: ["/code/dropped"] });

    expect(sessions.addProject).not.toHaveBeenCalled();
  });

  it("gives the real reason when a dropped folder cannot be a project", async () => {
    sessions.addProject.mockRejectedValue("That folder is a cloud mirror.");
    render(<StartScreen onOpenSettings={vi.fn()} />);

    await emitDrop({ type: "drop", paths: ["/code/mirror"] });

    expect((await screen.findByRole("alert")).textContent).toBe("That folder is a cloud mirror.");
  });

  it("puts the agent step first when no agent is installed: a card each, with its maker and its install", async () => {
    store.harnesses = [{ ...claude, available: false, installable: true }, { ...codex, installable: true }];
    render(<StartScreen onOpenSettings={vi.fn()} />);

    expect(screen.getByTestId("start-screen").getAttribute("data-stage")).toBe("agent");
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Set up an agent", "Open a project", "Choose how much the agent may do alone"]);
    const setup = screen.getByTestId("start-no-agent");
    expect(setup.textContent).toContain("Pick one; we install it and open its sign-in.");
    // Neutral cards: nothing here is an alert.
    expect(within(setup).queryByRole("alert")).toBeNull();
    // Installed from here, not by way of Settings or the provider's site.
    expect(await screen.findByRole("button", { name: "Install Claude Code and sign in" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Install Codex and sign in" })).toBeTruthy();
    expect(openUrl).not.toHaveBeenCalled();
    const codexCard = screen.getByRole("region", { name: "Codex setup" });
    expect(codexCard.textContent).toContain("Codex by OpenAI");
    expect(screen.getByRole("region", { name: "Claude Code setup" }).textContent).toContain("Claude Code by Anthropic");
    await waitFor(() => expect(within(codexCard).getByRole("status").textContent).toBe("Not installed"));
    // One action per agent: no commands to run by hand, and no second button.
    expect(screen.queryByText(codex.installHint)).toBeNull();
    expect(within(codexCard).getAllByRole("button")).toHaveLength(1);
    // The project step waits with its two buttons.
    expect(cards().map((card) => card.textContent)).toEqual(["Open folder", "Clone from GitHub"]);
    expect(screen.queryByRole("button", { name: "Quick start" })).toBeNull();
  });

  it("gives the command to run for an agent the app cannot install itself", async () => {
    store.harnesses = [{ ...codex, installable: false }];
    render(<StartScreen onOpenSettings={vi.fn()} />);

    const card = screen.getByRole("region", { name: "Codex setup" });
    await waitFor(() => expect(within(card).getByRole("status").textContent).toBe("Not installed"));
    expect(within(card).getByText(codex.installHint)).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Copy command" })).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Setup guide" }));
    expect(openUrl).toHaveBeenCalledWith(codex.installUrl);
  });

  it("opens a folder and the GitHub dialog from the project step's two buttons while an agent is set up", async () => {
    store.harnesses = [{ ...codex, installable: true }];
    openDialog.mockResolvedValue("/code/widgets");
    render(
      <>
        <StartScreen onOpenSettings={vi.fn()} />
        <ProjectStartDialogHost />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
    await waitFor(() => expect(sessions.startSessionIn).toHaveBeenCalledWith("/code/widgets", null));
    fireEvent.click(screen.getByRole("button", { name: "Clone from GitHub" }));
    expect(await screen.findByTestId("start-github-dialog")).toBeTruthy();
  });

  it("asks about the agents again when the reader comes back to the app", async () => {
    vi.useFakeTimers();
    try {
      store.harnesses = [{ ...codex, installable: true }];
      render(<StartScreen onOpenSettings={vi.fn()} />);
      expect(sessions.refreshHarnesses).not.toHaveBeenCalled();
      window.dispatchEvent(new Event("focus"));
      await act(async () => { await vi.advanceTimersByTimeAsync(150); });
      expect(sessions.refreshHarnesses).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers sign-in when every installed agent is signed out, and nothing once one is ready", async () => {
    store.harnesses = [{ ...claude, installable: true }, { ...codex, installable: true }];
    let claudeState = "signed_out";
    invoke.mockImplementation(async (command: string, args: { harness: string }) => {
      if (command === "check_agent_readiness") return { state: args.harness === "claude" ? claudeState : "missing", checkedAt: null, version: null };
      throw new Error(`unexpected command ${command}`);
    });
    const { unmount } = render(<StartScreen onOpenSettings={vi.fn()} />);
    expect((await screen.findByTestId("start-no-agent")).textContent).toContain("Set up an agent");
    expect(await screen.findByRole("button", { name: "Sign in to Claude Code" })).toBeTruthy();
    // Each agent's readiness probe settles independently.
    expect(await screen.findByRole("button", { name: "Install Codex and sign in" })).toBeTruthy();
    unmount();

    claudeState = "ready";
    // Wait for this mount's probe, not the matching call from the previous one.
    invoke.mockClear();
    render(<StartScreen onOpenSettings={vi.fn()} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("check_agent_readiness", { harness: "claude" }));
    await waitFor(() => expect(screen.queryByTestId("start-no-agent")).toBeNull());
    // Step 1 is done: each agent on a line, the ready one marked, the other with its way on.
    expect(screen.getByRole("heading", { name: "Agents ready" })).toBeTruthy();
    const claudeRow = screen.getByRole("region", { name: "Claude Code setup" });
    await waitFor(() => expect(within(claudeRow).getByRole("status").textContent).toBe("Local login found"));
    expect(within(claudeRow).getByText("Ready")).toBeTruthy();
    expect(await within(screen.getByRole("region", { name: "Codex setup" })).findByRole("button", { name: "Install Codex and sign in" })).toBeTruthy();
  });

  it("claims nothing about agents before the probe has answered", () => {
    store.harnesses = [];
    render(<StartScreen onOpenSettings={vi.fn()} />);
    expect(screen.queryByTestId("start-no-agent")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Agents ready" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Set up an agent" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Agents" })).toBeNull();
  });

  it("calls step 1 done only on an answer, and keeps Sign in on offer for a login that cannot be told", async () => {
    store.harnesses = [{ ...claude, installable: true }];
    let answer: ((value: unknown) => void) | undefined;
    invoke.mockImplementation((command: string) => {
      if (command === "check_agent_readiness") return new Promise((resolve) => { answer = resolve; });
      throw new Error(`unexpected command ${command}`);
    });
    render(<StartScreen onOpenSettings={vi.fn()} />);

    // Installed, and nobody has answered about its login yet: the project step is open, and nothing says "ready".
    const headings = () => screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(screen.getByTestId("start-screen").getAttribute("data-stage")).toBe("project");
    expect(headings()[0]).toBe("Set up an agent");
    const line = screen.getByRole("region", { name: "Claude Code setup" });
    expect(within(line).getByRole("status").textContent).toBe("Installed");
    expect(within(line).queryByText("Ready")).toBeNull();
    expect(within(line).queryByRole("button")).toBeNull();

    await waitFor(() => expect(answer).toBeTruthy());
    await act(async () => answer!({ state: "unknown", checkedAt: null, version: "2.1.318" }));
    expect(headings()[0]).toBe("Set up an agent");
    expect(within(line).getByRole("status").textContent).toBe("Login not checked");
    expect(within(line).queryByText("Ready")).toBeNull();
    expect(within(line).getByRole("button", { name: "Sign in to Claude Code" })).toBeTruthy();
  });

  it("costs a set-up reader one check on Home, and none on coming back to the app", async () => {
    store.harnesses = [claude, { ...codex, available: true }];
    const { unmount } = render(<StartScreen onOpenSettings={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Agents ready" })).toBeTruthy());
    expect(probed()).toEqual(["claude"]);
    // The agent nobody asked about is on its line with no more claimed than that it is installed.
    const codexLine = screen.getByRole("region", { name: "Codex setup" });
    expect(within(codexLine).getByRole("status").textContent).toBe("Installed");
    expect(within(codexLine).queryByText("Ready")).toBeNull();

    vi.useFakeTimers();
    try {
      window.dispatchEvent(new Event("focus"));
      await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    } finally {
      vi.useRealTimers();
    }
    expect(probed()).toEqual(["claude"]);
    expect(sessions.refreshHarnesses).not.toHaveBeenCalled();

    // Home again a moment later: the answer just given is enough.
    unmount();
    render(<StartScreen onOpenSettings={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Agents ready" })).toBeTruthy();
    await act(async () => {});
    expect(probed()).toEqual(["claude"]);
  });

  it("says an account is optional and who is signed in, beside the docs, the shortcuts and the way to Settings › Agents", async () => {
    const onOpenSettings = vi.fn();
    const { unmount } = render(<StartScreen onOpenSettings={onOpenSettings} />);

    await screen.findByRole("heading", { name: "Agents ready" });
    expect(screen.getByText("A TerminalX account is optional for local work.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Read the docs" }));
    expect(openUrl).toHaveBeenCalledWith(expect.stringMatching(/github\.com.*README\.md$/));
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    expect(onOpenSettings).toHaveBeenCalledWith("shortcuts");
    fireEvent.click(screen.getByRole("button", { name: "Manage in Settings › Agents" }));
    expect(onOpenSettings).toHaveBeenCalledWith("agents");

    unmount();
    account.status = { state: "signed-in", identity: { name: "Ada Lovelace", email: "ada@example.com" } };
    render(<StartScreen onOpenSettings={onOpenSettings} />);
    expect(screen.getByText("Signed in as Ada Lovelace. You can sign out in Settings › Account.")).toBeTruthy();
    expect(screen.queryByText("A TerminalX account is optional for local work.")).toBeNull();
  });

  it("offers the permission choice: Ask every time until another mode is picked, Bypass only after its warning", async () => {
    const { rerender } = render(<StartScreen onOpenSettings={vi.fn()} />);
    const step = screen.getByRole("region", { name: "Choose how much the agent may do alone" });
    expect(step.textContent).toContain("Ask every time is the safe default: you approve each edit and command, with the diff shown.");
    const select = within(step).getByRole("button", { name: "Permissions: Ask every time" });

    fireEvent.keyDown(select, { key: "Enter" });
    const modes = await screen.findAllByRole("menuitemradio");
    expect(modes.map((mode) => mode.getAttribute("aria-checked"))).toEqual(["false", "true", "false", "false", "false"]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Auto/ }));
    // The mode new chats start in, the same setting the new-session picker writes.
    expect(setPrefs).toHaveBeenCalledWith({ lastMode: "auto" });

    prefs.lastMode = "auto";
    rerender(<StartScreen onOpenSettings={vi.fn()} />);
    expect(within(step).getByRole("button", { name: "Permissions: Auto" })).toBeTruthy();
    expect(step.textContent).toContain("Auto: Routine actions are approved; risky ones ask. Ask every time is the safe default.");

    setPrefs.mockClear();
    fireEvent.keyDown(within(step).getByRole("button", { name: "Permissions: Auto" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /^Bypass permissions/ }));
    // Bypass waits for the app's warning dialog; nothing is saved by the pick alone.
    expect(setPrefs).not.toHaveBeenCalled();
  });

  it("warns about Bypass in the terms of the agent a new chat would start with, not the saved one", async () => {
    // A Mac with only Codex, on a profile whose saved agent is still the default, Claude.
    store.harnesses = [{ ...claude, available: false }, { ...codex, available: true }];
    expect(prefs.lastAgent).toBe("claude");
    render(
      <>
        <StartScreen onOpenSettings={vi.fn()} />
        <BypassDialog />
      </>,
    );
    await screen.findByRole("heading", { name: "Agents ready" });

    fireEvent.keyDown(screen.getByRole("button", { name: "Permissions: Ask every time" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /^Bypass permissions/ }));

    const warning = await screen.findByRole("dialog", { name: "Let Codex run without asking?" });
    expect(warning.textContent).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(warning.textContent).toContain("sandbox off");
    expect(warning.textContent).not.toContain("--dangerously-skip-permissions");
    expect(setPrefs).not.toHaveBeenCalled();
    fireEvent.click(within(warning).getByRole("button", { name: "Bypass permissions" }));
    expect(setPrefs).toHaveBeenCalledWith({ lastMode: "bypassPermissions" });
  });

  it.each([
    { saved: "codex", order: ["claude", "codex"], title: "Let Codex run without asking?", flag: "--dangerously-bypass-approvals-and-sandbox" },
    { saved: "claude", order: ["codex", "claude"], title: "Let Claude Code run without asking?", flag: "--dangerously-skip-permissions" },
    { saved: "claude", order: ["claude", "codex"], title: "Let Claude Code run without asking?", flag: "--dangerously-skip-permissions" },
  ])("names the saved agent ($saved) when both are signed in, though Home asked only about the first ($order)", async ({ saved, order, title, flag }) => {
    const both = { claude, codex: { ...codex, available: true } };
    store.harnesses = order.map((id) => both[id as keyof typeof both]);
    Object.assign(prefs, { lastAgent: saved });
    try {
      render(
        <>
          <StartScreen onOpenSettings={vi.fn()} />
          <BypassDialog />
        </>,
      );
      await screen.findByRole("heading", { name: "Agents ready" });
      // Home's own cost is unchanged: one agent asked about.
      expect(probed()).toEqual([order[0]]);

      fireEvent.keyDown(screen.getByRole("button", { name: "Permissions: Ask every time" }), { key: "Enter" });
      fireEvent.click(await screen.findByRole("menuitemradio", { name: /^Bypass permissions/ }));

      // The pick asks about every installed agent, as New Session does, and names the one it would start.
      const warning = await screen.findByRole("dialog", { name: title });
      expect(warning.textContent).toContain(flag);
      expect(probed().slice(1).sort()).toEqual(["claude", "codex"]);
      expect(setPrefs).not.toHaveBeenCalled();
    } finally {
      Object.assign(prefs, { lastAgent: "claude" });
    }
  });

  it("holds Bypass back when every installed agent is signed out, and says why", async () => {
    store.harnesses = [{ ...claude, installable: true }, { ...codex, available: true, installable: true }];
    invoke.mockImplementation(async (command: string) => {
      if (command === "check_agent_readiness") return { state: "signed_out", checkedAt: null, version: null };
      throw new Error(`unexpected command ${command}`);
    });
    render(
      <>
        <StartScreen onOpenSettings={vi.fn()} />
        <BypassDialog />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("start-screen").getAttribute("data-stage")).toBe("agent"));

    fireEvent.keyDown(screen.getByRole("button", { name: "Permissions: Ask every time" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /^Bypass permissions/ }));

    const step = screen.getByRole("region", { name: "Choose how much the agent may do alone" });
    expect((await within(step).findByRole("status")).textContent).toContain("Sign in to an agent first");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(setPrefs).not.toHaveBeenCalled();
    expect(within(step).getByRole("button", { name: "Permissions: Ask every time" })).toBeTruthy();
  });

  it("applies Bypass at once, with no check, for a reader who said not to be asked again", async () => {
    store.harnesses = [claude, { ...codex, available: true }];
    Object.assign(prefs, { bypassConfirmed: true });
    render(
      <>
        <StartScreen onOpenSettings={vi.fn()} />
        <BypassDialog />
      </>,
    );
    await screen.findByRole("heading", { name: "Agents ready" });

    fireEvent.keyDown(screen.getByRole("button", { name: "Permissions: Ask every time" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /^Bypass permissions/ }));
    expect(setPrefs).toHaveBeenCalledWith({ lastMode: "bypassPermissions" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(probed()).toEqual(["claude"]);
  });

  it("names the agent whose login was found when two are installed, whatever the saved one is", async () => {
    store.harnesses = [claude, { ...codex, available: true }];
    invoke.mockImplementation(async (command: string, args: { harness: string }) => {
      if (command === "check_agent_readiness") return { state: args.harness === "codex" ? "ready" : "signed_out", checkedAt: null, version: null };
      throw new Error(`unexpected command ${command}`);
    });
    render(
      <>
        <StartScreen onOpenSettings={vi.fn()} />
        <BypassDialog />
      </>,
    );
    await screen.findByRole("heading", { name: "Agents ready" });

    fireEvent.keyDown(screen.getByRole("button", { name: "Permissions: Ask every time" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /^Bypass permissions/ }));
    expect(await screen.findByRole("dialog", { name: "Let Codex run without asking?" })).toBeTruthy();
  });

  it("holds Bypass back while no agent is installed: there is none to name in its warning", async () => {
    store.harnesses = [{ ...claude, available: false, installable: true }, { ...codex, installable: true }];
    render(
      <>
        <StartScreen onOpenSettings={vi.fn()} />
        <BypassDialog />
      </>,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "Permissions: Ask every time" }), { key: "Enter" });
    const bypass = await screen.findByRole("menuitemradio", { name: /^Bypass permissions/ });
    expect(bypass.getAttribute("aria-disabled")).toBe("true");
    expect(bypass.textContent).toContain("Set up an agent first");
    fireEvent.click(bypass);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(setPrefs).not.toHaveBeenCalled();
    // The other modes need no agent to be named.
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Auto/ }));
    expect(setPrefs).toHaveBeenCalledWith({ lastMode: "auto" });
  });

  it("reads a saved mode the way a new chat does: one the picker cannot read is Ask every time", () => {
    for (const saved of [null, undefined, "dontAsk"]) {
      Object.assign(prefs, { lastMode: saved });
      const { unmount } = render(<StartScreen onOpenSettings={vi.fn()} />);
      expect(screen.getByRole("button", { name: "Permissions: Ask every time" })).toBeTruthy();
      unmount();
    }
  });
});

describe("recent projects (PRO-130)", () => {
  const project = (name: string, lastOpened: string | null, extra: Partial<Project> = {}) => ({ kind: "git", path: `/code/${name}`, name, lastOpened, ...extra }) as Project;

  it("says none yet, and where they will show, before any project is opened", async () => {
    render(<StartScreen onOpenSettings={vi.fn()} />);
    await screen.findByRole("heading", { name: "Agents ready" });
    const recent = screen.getByTestId("recent-projects");
    expect(recent.textContent).toContain("Recent projects");
    expect(recent.textContent).toContain("none yet, projects you open show here");
    expect(recent.textContent).toContain("Or drop a folder anywhere on this window");
    expect(within(recent).queryByRole("list")).toBeNull();
  });

  it("lists the five opened or worked in most lately, newest first, with path and when", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-19T12:00:00Z"));
    try {
      store.projects = [
        project("alpha", "2026-11-19T11:00:00Z"),
        project("beta", "2026-11-10T12:00:00Z"),
        project("gamma", "2026-11-18T12:00:00Z"),
        project("delta", "2026-11-17T12:00:00Z"),
        project("epsilon", null),
        project("zeta", "2026-11-16T12:00:00Z"),
        project("archived", "2026-11-19T11:59:00Z", { archived: true }),
      ];
      // A session worked in a minute ago makes its project the most recent, whenever it was opened.
      store.sessions = [{ projectPath: "/code/beta", modified: "2026-11-19T11:59:00Z" }];
      render(<StartScreen onOpenSettings={vi.fn()} />);
      const list = await screen.findByRole("list", { name: "Recent projects" });
      const rows = within(list).getAllByRole("button");
      expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["Open beta", "Open alpha", "Open gamma", "Open delta", "Open zeta"]);
      expect(rows[0].textContent).toContain("/code/beta");
      expect(rows[0].textContent).toContain("1m ago");
      expect(rows[1].textContent).toContain("1h ago");
      expect(screen.getByTestId("recent-projects").textContent).not.toContain("none yet");
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens one with one click on its new-session view", async () => {
    store.projects = [project("alpha", "2026-11-19T11:00:00Z")];
    render(<StartScreen onOpenSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open alpha" }));
    await waitFor(() => expect(sessions.startSessionIn).toHaveBeenCalledWith("/code/alpha", null));
    expect(sessions.addProject).toHaveBeenCalledWith("/code/alpha");
    expect(setPrefs).toHaveBeenCalledWith({ lastProject: "/code/alpha" });
  });

  it("says why when a recent project's folder has gone", async () => {
    store.projects = [project("alpha", "2026-11-19T11:00:00Z")];
    sessions.addProject.mockRejectedValue(new Error("Not a directory: /code/alpha"));
    render(<StartScreen onOpenSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open alpha" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Not a directory: /code/alpha");
    expect(sessions.startSessionIn).not.toHaveBeenCalled();
  });
});
