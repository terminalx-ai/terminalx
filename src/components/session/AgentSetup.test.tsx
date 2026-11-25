import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { HarnessInfo } from "@/types/session";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/components/terminal/TerminalView", () => ({ TerminalView: () => null }));
const { AgentSetup } = await import("./AgentSetup");

afterEach(cleanup);

const harness = (installHint: string): HarnessInfo => ({ id: "opencode", name: "OpenCode", available: false, installable: false, installHint, installUrl: "https://opencode.ai/docs" }) as unknown as HarnessInfo;
const missing = { state: "missing" as const, checkedAt: null, version: null };

// An agent with no install command for this system (OpenCode on Windows) points to its setup guide, not an empty command (3.3).
it("points to the setup guide, with no command box, when this system has no install command", () => {
  render(<AgentSetup harness={harness("")} value={missing} checking={false} onRefresh={() => undefined} headless />);
  expect(screen.getByText("Install OpenCode with its setup guide, then sign in.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Copy command" })).toBeNull();
  expect(screen.queryByText(/Open a terminal and run this command/)).toBeNull();
  expect(screen.getByRole("button", { name: "Setup guide" })).toBeTruthy();
});

it("shows the command to copy where this system has one", () => {
  render(<AgentSetup harness={harness("curl -fsSL https://opencode.ai/install | bash")} value={missing} checking={false} onRefresh={() => undefined} headless />);
  expect(screen.getByText("curl -fsSL https://opencode.ai/install | bash")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy();
});
