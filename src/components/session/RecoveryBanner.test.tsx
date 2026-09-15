import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecoveryBanner } from "./RecoveryBanner";
import type { PendingAsk } from "@/lib/transcript";
import type { ModelInfo } from "@/lib/api";

const ask: PendingAsk = {
  seq: 1, kind: "permission", requestId: "request", toolUseId: "call", toolName: "Bash",
  input: { command: "TOKEN=secret /Users/private/run" }, description: "secret request details",
  options: [{ id: "allow", kind: "allow_once", label: "unsafe secret" }, { id: "deny", kind: "deny", label: "Deny" }],
};
const props = () => ({ kind: null, waiting: false, asks: [], busy: false, models: [], onPermission: vi.fn(), onQuestions: vi.fn(), onRetry: vi.fn(), onStop: vi.fn(), onContinue: vi.fn() });
afterEach(cleanup);

describe("session recovery UI smoke", () => {
  it("shows capacity recovery, model selection, then a permission request with allow, deny and stop", () => {
    const p = props();
    const { rerender, container } = render(<RecoveryBanner {...p} kind="capacity" models={[{ id: "available", label: "Available model" } as ModelInfo]} />);
    expect(screen.getByText(/provider is at capacity/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry safely" }));
    expect(p.onRetry).toHaveBeenCalledWith();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "available" } });
    expect(p.onRetry).toHaveBeenCalledWith("available");
    rerender(<RecoveryBanner {...p} waiting asks={[ask]} />);
    expect(screen.getByText(/Waiting for permission to run a command/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Allow/ }));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop session" }));
    expect(p.onPermission.mock.calls).toEqual([["request", "allow"], ["request", "deny"]]);
    expect(p.onStop).toHaveBeenCalledOnce();
    expect(container.textContent).not.toMatch(/secret|TOKEN|\/Users/);
    expect(screen.queryByRole("button", { name: "Retry safely" })).toBeNull();
  });

  it.each(["timeout", "disconnected"] as const)("distinguishes unknown %s outcomes from exit", kind => {
    render(<RecoveryBanner {...props()} kind={kind} />);
    expect(screen.getByText(/process outcome is unknown/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry safely" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop session" })).toBeTruthy();
  });

  it("retires expired permission controls and disables repeated actions while settling", () => {
    render(<RecoveryBanner {...props()} kind="permission_expired" busy />);
    expect(screen.queryByRole("button", { name: /^Allow/ })).toBeNull();
    expect((screen.getByRole("button", { name: "Stop session" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
