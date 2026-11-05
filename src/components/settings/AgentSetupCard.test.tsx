import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessInfo } from "@/types/session";
import type { AgentReadiness } from "@/lib/agentReadiness";

const { invoke, refreshHarnesses } = vi.hoisted(() => ({ invoke: vi.fn(), refreshHarnesses: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/sessions", () => ({ refreshHarnesses }));
import { AgentSetupCard } from "./AgentSetupCard";

const harness: HarnessInfo = {
  id: "codex", name: "Codex", binary: "codex", available: false,
  installHint: "npm install -g @openai/codex && codex login", installUrl: "https://developers.openai.com/codex/cli",
  caps: { images: true, steer: false, permissionModes: true, effort: true, slashCommands: true, atMentions: true, fork: true, resume: true },
};
const answer = (state: AgentReadiness["state"]): AgentReadiness => ({ state, checkedAt: "2026-11-05T16:00:00Z", version: state === "missing" ? null : "0.166.0" });

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("agent setup card (PRO-170)", () => {
  it("keeps badge and body together through missing → installed → ready despite a stale harness list", async () => {
    invoke.mockResolvedValue(answer("missing"));
    render(<ul><AgentSetupCard harness={harness} /></ul>);
    expect(await screen.findAllByText("Not installed")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Get it" })).toBeTruthy();

    invoke.mockResolvedValue(answer("signed_out"));
    act(() => window.dispatchEvent(new Event("focus")));
    expect(await screen.findByText("Sign in required")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Codex setup" })).getByRole("status").textContent).toBe("Installed · sign in required");
    expect(screen.queryByText("Not installed")).toBeNull();
    expect(screen.queryByRole("button", { name: "Get it" })).toBeNull();

    invoke.mockResolvedValue(answer("ready"));
    act(() => window.dispatchEvent(new Event("focus")));
    expect(await screen.findByText("Ready")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Codex setup" })).getByRole("status").textContent).toBe("Ready · local login found");
    expect(screen.queryByText("Sign in required")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy command" })).toBeNull();
  });

  it("uses the readiness result when an installed CLI is removed, and retains manual checks", async () => {
    invoke.mockResolvedValue(answer("ready"));
    render(<ul><AgentSetupCard harness={{ ...harness, available: true }} /></ul>);
    await screen.findByText("Ready");
    invoke.mockResolvedValue(answer("missing"));
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findAllByText("Not installed")).toHaveLength(2);
    expect(refreshHarnesses).toHaveBeenCalledOnce();
    expect(screen.queryByText("Ready")).toBeNull();
  });

  it("shows checking and unknown consistently without falling back to cached installation status", async () => {
    let reject: (reason: Error) => void = () => {};
    invoke.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    render(<ul><AgentSetupCard harness={harness} /></ul>);
    expect(screen.getByText("Checking…")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Checking installation and login…");
    expect(screen.queryByText("Not installed")).toBeNull();
    await act(async () => reject(new Error("private diagnostic")));
    expect(screen.getAllByText("Login not checked")).toHaveLength(2);
    expect(screen.queryByText("private diagnostic")).toBeNull();
  });
});
