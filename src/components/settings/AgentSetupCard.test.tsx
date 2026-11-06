import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventCallback } from "@tauri-apps/api/event";
import type { HarnessInfo } from "@/types/session";
import type { AgentReadiness } from "@/lib/agentReadiness";

const { invoke, listen, refreshHarnesses } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), refreshHarnesses: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@/lib/sessions", () => ({ refreshHarnesses }));
import { AgentSetupCard } from "./AgentSetupCard";

const harness: HarnessInfo = {
  id: "codex", name: "Codex", binary: "codex", available: false,
  installHint: "npm install -g @openai/codex && codex login", installUrl: "https://developers.openai.com/codex/cli",
  caps: { images: true, steer: false, permissionModes: true, effort: true, slashCommands: true, atMentions: true, fork: true, resume: true },
};
const answer = (state: AgentReadiness["state"]): AgentReadiness => ({ state, checkedAt: "2026-11-05T16:00:00Z", version: state === "missing" ? null : "0.166.0" });
const exits = new Set<EventCallback<{ id: string; code: number }>>();
const exitLogin = (code: number) => exits.forEach((notify) => notify({ event: "pty_exit", id: 0, payload: { id: "codex-login", code } }));

beforeEach(() => {
  vi.clearAllMocks();
  listen.mockImplementation(async (event, callback) => {
    if (event === "pty_exit") exits.add(callback);
    return () => exits.delete(callback);
  });
});
afterEach(() => { cleanup(); invoke.mockReset(); vi.useRealTimers(); vi.restoreAllMocks(); });

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

  it("keeps badge and body together while checking an embedded login, including a failed sign-in", async () => {
    invoke.mockResolvedValue(answer("signed_out"));
    render(<ul><AgentSetupCard harness={harness} /></ul>);
    await screen.findByText("Sign in required");

    for (const [code, state] of [[1, "signed_out"], [0, "ready"]] as const) {
      let finish: (value: AgentReadiness) => void = () => {};
      invoke.mockReturnValueOnce(new Promise<AgentReadiness>((resolve) => { finish = resolve; }));
      act(() => exitLogin(code));
      expect(screen.getByText("Checking…")).toBeTruthy();
      expect(screen.getByRole("status").textContent).toBe("Checking installation and login…");
      expect(screen.queryByText("Sign in required")).toBeNull();
      expect(screen.queryByText("Ready")).toBeNull();
      expect(screen.getByRole("button", { name: "Check again" }).hasAttribute("disabled")).toBe(true);

      await act(async () => finish(answer(state)));
      expect(screen.getByText(state === "ready" ? "Ready" : "Sign in required")).toBeTruthy();
      expect(screen.getByRole("status").textContent).toBe(state === "ready" ? "Ready · local login found" : "Installed · sign in required");
    }
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(refreshHarnesses).not.toHaveBeenCalled();
  });

  it("updates both labels on the two-minute timer and stops checking after leaving Agents", async () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    invoke.mockResolvedValue(answer("missing"));
    const { unmount } = render(<ul><AgentSetupCard harness={harness} /></ul>);
    await act(async () => {});
    expect(screen.getAllByText("Not installed")).toHaveLength(2);

    invoke.mockResolvedValue(answer("signed_out"));
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(screen.getByText("Sign in required")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Installed · sign in required");
    expect(screen.queryByText("Not installed")).toBeNull();
    expect(screen.queryByRole("button", { name: "Get it" })).toBeNull();

    hidden.mockReturnValue(true);
    invoke.mockResolvedValue(answer("ready"));
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Sign in required")).toBeTruthy();

    hidden.mockReturnValue(false);
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Ready · local login found");
    expect(screen.queryByText("Sign in required")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy command" })).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(3);

    unmount();
    exitLogin(0);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(exits.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
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
