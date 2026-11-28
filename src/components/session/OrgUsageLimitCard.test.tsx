import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => undefined) }));
import { copyText } from "@/lib/clipboard";
import { loginOwner, switchTarget, usageLimitCardText, type OrgLimit } from "./OrgUsageLimitCard";
import { RecoveryBanner } from "./RecoveryBanner";

const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

function banner(orgLimit: OrgLimit | null, resetsAt: number, extra: Partial<Parameters<typeof RecoveryBanner>[0]> = {}) {
  const handlers = { onRetry: vi.fn(), onStop: vi.fn(), onContinue: vi.fn(), onSendContinue: vi.fn() };
  render(<RecoveryBanner placement="composer" kind="usage_limit" limit={{ resetsAt, window: "five_hour" }} waiting={false} asks={[]} busy={false}
    models={[]} onPermission={vi.fn()} onQuestions={vi.fn()} {...handlers} orgLimit={orgLimit} {...extra} />);
  return handlers;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("usage-limit card (PRO-200, design 17.13)", () => {
  it("tells a member an admin has to act, copies a ready request, and keeps the card's recovery", async () => {
    const at = Date.now() + 2 * 3600_000;
    const onSwitch = vi.fn();
    const handlers = banner({ harness: "codex", organization: "Acme Robotics", who: null, onSwitch }, at);
    expect(screen.getByText("Codex usage limit reached")).toBeTruthy();
    expect(screen.getByTestId("org-usage-limit").textContent).toBe(`The Codex login Acme Robotics set for cloud workspaces is out of usage until ${clock(at)}. Ask an organization admin to raise it or switch logins.`);
    expect(screen.queryByTestId("usage-limit-reset"), "the card's own words carry the time").toBeNull();
    fireEvent.click(screen.getByTestId("usage-limit-copy"));
    expect(copyText).toHaveBeenCalledWith(`Codex in Acme Robotics’s cloud workspaces has reached its usage limit until ${clock(at)}. Could you raise the limit or switch the Codex login in Settings → Organizations → Acme Robotics → Agent logins?`);
    await waitFor(() => expect(screen.getByTestId("usage-limit-copy").textContent).toBe("Copied"));
    expect(screen.getByTestId("usage-limit-switch").textContent).toBe("Switch to Claude Code");
    expect(screen.getByText("Switch opens a Claude Code tab that continues from this conversation.")).toBeTruthy();
    fireEvent.click(screen.getByTestId("usage-limit-switch"));
    expect(onSwitch).toHaveBeenCalledWith("claude");
    // The card's usual recovery stays: another model, Stop, and Continue in new session. "Continue here" waits for the reset.
    expect(screen.getByRole("combobox", { name: "Choose another model" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue here" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop session" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue in new session" }));
    expect(handlers.onStop).toHaveBeenCalled();
    expect(handlers.onContinue).toHaveBeenCalled();
  });

  it("after the reset says no stale time and offers to continue here", () => {
    const past = Date.now() - 60_000;
    const handlers = banner({ harness: "claude", organization: "Acme", who: null }, past);
    expect(screen.getByTestId("org-usage-limit").textContent).toBe("The Claude Code login Acme set for cloud workspaces is out of usage. Ask an organization admin to raise it or switch logins.");
    fireEvent.click(screen.getByRole("button", { name: "Continue here" }));
    expect(handlers.onSendContinue).toHaveBeenCalled();
    expect(screen.queryByTestId("usage-limit-switch"), "no switch where the tab can't open another").toBeNull();
  });

  it("keeps Continue with another account", () => {
    const onSwitchAccount = vi.fn();
    const account = { id: "work", label: "Work account" } as Parameters<typeof onSwitchAccount>[0];
    banner({ harness: "claude", organization: "Acme", who: null }, Date.now() + 3600_000, {
      accounts: { choices: [account], switching: null, onSwitch: onSwitchAccount },
    });
    fireEvent.click(screen.getByTestId("continue-with-account"));
    expect(onSwitchAccount).toHaveBeenCalledWith(account);
  });

  it("is the usual card when the limit is not the organization's login", () => {
    banner(null, Date.now() + 3600_000);
    expect(screen.queryByTestId("org-usage-limit")).toBeNull();
    expect(screen.queryByTestId("usage-limit-copy")).toBeNull();
    expect(screen.getByTestId("usage-limit-reset")).toBeTruthy();
  });

  it("names whose login it is, but a Bedrock login's name is a region: the organization is named", () => {
    expect(loginOwner({ authKind: "oauth-credentials-json", displayIdentity: "Ada Example · until 18:00" })).toBe("Ada Example");
    expect(loginOwner({ authKind: "bedrock", displayIdentity: "us-east-1 · us.anthropic.claude-opus-5-5" })).toBeNull();
    expect(loginOwner(undefined)).toBeNull();
    expect(usageLimitCardText({ agent: "Codex", organization: "Acme", resetsAt: null, who: "Ada Example" }).body)
      .toBe("Ada Example’s login is out of Codex usage. It is the Codex login Acme set for cloud workspaces. Ask an organization admin to raise it or switch logins.");
  });

  it("switches Claude Code to Codex and anything else to Claude Code", () => {
    expect(switchTarget("claude")).toBe("codex");
    expect(switchTarget("codex")).toBe("claude");
    expect(switchTarget("cursor")).toBe("claude");
    expect(usageLimitCardText({ agent: "Cursor", organization: "Acme", resetsAt: null, who: null }).title).toBe("Cursor usage limit reached");
  });
});
