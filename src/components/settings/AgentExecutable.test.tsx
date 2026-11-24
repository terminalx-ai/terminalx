import { fileManager } from "@/lib/platform";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentExecutable } from "@/lib/api";

const { invoke, open, showError } = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), showError: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));
vi.mock("@/lib/errorToasts", () => ({ showError }));
import { AgentConfigFileRow, AgentExecutableRow } from "./AgentExecutable";

const SYSTEM = "/Users/ada/.local/bin/claude";
/** The Rust side as `harness::executables` answers: a program is kept only once `--version` answered. */
let chosen: string | null;
const versions: Record<string, string> = { [SYSTEM]: "2.3.41", "/opt/dev/claude-dev": "2.4.0-dev" };
const state = (): AgentExecutable => {
  const path = chosen ?? SYSTEM;
  return { harness: "claude", chosen, path, system: SYSTEM, version: versions[path] ?? null, problem: null };
};

beforeEach(() => {
  chosen = null;
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case "agent_executable": return state();
      case "set_agent_executable": {
        const path = args.path as string | null;
        if (path === null) { chosen = null; return state(); }
        const full = path.replace(/^~\//, "/Users/ada/");
        if (!versions[full]) throw `${full} --version exited with 1: dyld: Library not loaded`;
        chosen = full;
        return state();
      }
      case "agent_config_file": return { path: "/Users/ada/.claude/settings.json", displayPath: "~/.claude/settings.json", exists: true };
      case "open_agent_config_file": return null;
      case "reveal_agent_path": return null;
      default: throw new Error(`unexpected command ${command}`);
    }
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const field = () => screen.getByRole("textbox", { name: "Claude Code executable" }) as HTMLInputElement;
const note = () => screen.getByTestId("executable-note").textContent;

describe("Executable row (PRO-157, design 10.01)", () => {
  it("shows the PATH's program as the placeholder until one is chosen", async () => {
    render(<AgentExecutableRow harness="claude" agentName="Claude Code" />);
    await waitFor(() => expect(note()).toBe("From your PATH · ~/.local/bin/claude · 2.3.41"));
    expect(screen.getByText("Executable")).toBeTruthy();
    expect(screen.getByText("Leave empty to use the version TerminalX finds on your PATH. TerminalX checks it with --version.")).toBeTruthy();
    expect(field().value).toBe("");
    expect(field().placeholder).toBe("~/.local/bin/claude");
    expect((screen.getByRole("button", { name: "Reset" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps a typed program once --version answers, and re-checks the agent", async () => {
    const onChanged = vi.fn();
    render(<AgentExecutableRow harness="claude" agentName="Claude Code" onChanged={onChanged} />);
    await waitFor(() => expect(field().disabled).toBe(false));
    fireEvent.change(field(), { target: { value: "/opt/dev/claude-dev" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(note()).toBe("Chosen · /opt/dev/claude-dev · 2.4.0-dev"));
    expect(invoke).toHaveBeenCalledWith("set_agent_executable", { harness: "claude", path: "/opt/dev/claude-dev" });
    expect(field().value).toBe("/opt/dev/claude-dev");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("shows why a program that fails --version was refused and keeps the old path", async () => {
    chosen = "/opt/dev/claude-dev";
    const onChanged = vi.fn();
    render(<AgentExecutableRow harness="claude" agentName="Claude Code" onChanged={onChanged} />);
    await waitFor(() => expect(field().value).toBe("/opt/dev/claude-dev"));
    fireEvent.change(field(), { target: { value: "/opt/broken/claude" } });
    fireEvent.blur(field());
    expect((await screen.findByRole("alert")).textContent).toBe("/opt/broken/claude --version exited with 1: dyld: Library not loaded");
    expect(field().value).toBe("/opt/dev/claude-dev");
    expect(chosen).toBe("/opt/dev/claude-dev");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("chooses with Browse… and goes back to the PATH with Reset", async () => {
    open.mockResolvedValue("/opt/dev/claude-dev");
    render(<AgentExecutableRow harness="claude" agentName="Claude Code" />);
    await waitFor(() => expect(field().disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect(note()).toContain("Chosen · /opt/dev/claude-dev"));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ multiple: false, directory: false, defaultPath: "/Users/ada/.local/bin" }));

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(note()).toBe("From your PATH · ~/.local/bin/claude · 2.3.41"));
    expect(invoke).toHaveBeenLastCalledWith("set_agent_executable", { harness: "claude", path: null });
    // The field follows the saved value in an effect, one render after the note changes.
    await waitFor(() => expect(field().value).toBe(""));
  });

  it("clearing the field is Reset, and a cancelled Browse… changes nothing", async () => {
    chosen = "/opt/dev/claude-dev";
    open.mockResolvedValue(null);
    render(<AgentExecutableRow harness="claude" agentName="Claude Code" title="Claude Code executable" resetLabel="Use system Claude Code" />);
    await waitFor(() => expect(field().value).toBe("/opt/dev/claude-dev"));
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(invoke.mock.calls.filter(([command]) => command === "set_agent_executable")).toHaveLength(0);
    fireEvent.change(field(), { target: { value: "" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(chosen).toBeNull());
    expect(screen.getByRole("button", { name: "Use system Claude Code" })).toBeTruthy();
  });

  it("says when the chosen program has gone since", async () => {
    invoke.mockImplementation(async () => ({ harness: "claude", chosen: "/opt/dev/claude-dev", path: null, system: SYSTEM, version: null,
      problem: "/opt/dev/claude-dev is gone or no longer executable. New tabs can’t start until you choose another or use the one on your PATH." }));
    render(<AgentExecutableRow harness="claude" agentName="Claude Code" />);
    expect((await screen.findByRole("alert")).textContent).toContain("is gone or no longer executable");
    expect((screen.getByRole("button", { name: "Reset" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("Agent settings file row (PRO-157)", () => {
  it("opens the agent's own file in the chosen editor or Finder", async () => {
    render(<AgentConfigFileRow harness="claude" title="Claude settings file" />);
    expect(await screen.findByText("~/.claude/settings.json")).toBeTruthy();
    expect(screen.getByText("Claude settings file")).toBeTruthy();
    const trigger = screen.getByRole("button", { name: "Open ~/.claude/settings.json in" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "VS Code" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_agent_config_file", { harness: "claude", editor: "vscode" }));
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: fileManager }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("reveal_agent_path", { harness: "claude", what: "config" }));
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open in its default app" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_agent_config_file", { harness: "claude", editor: null }));
    expect(showError).not.toHaveBeenCalled();
  });
});
