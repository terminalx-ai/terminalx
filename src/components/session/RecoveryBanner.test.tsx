import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecoveryBanner } from "./RecoveryBanner";
import { askDetail } from "@/components/chat/AskCards";
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

  it("keeps keyboard decisions on the focused permission button", () => {
    const p = props();
    render(<RecoveryBanner {...p} waiting asks={[ask]} />);
    const deny = screen.getByRole("button", { name: "Deny" });
    deny.focus();
    fireEvent.keyDown(deny, { key: "Enter" });
    expect(p.onPermission).not.toHaveBeenCalled();
    // Native buttons generate their own click for Enter; no ancestor may
    // substitute the first option for the reader's focused choice.
    fireEvent.click(deny);
    expect(p.onPermission).toHaveBeenCalledExactlyOnceWith("request", "deny");
  });

  it("keeps Stop available while a permission response is pending", () => {
    const p = props();
    render(<RecoveryBanner {...p} waiting answering asks={[ask]} />);
    expect((screen.getByRole("button", { name: /^Allow/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Stop session" }));
    expect(p.onStop).toHaveBeenCalledOnce();
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

  it("names the command to everyone on a shared cloud workspace, whether or not they may answer", () => {
    const p = props();
    const shared: PendingAsk = { ...ask, input: { command: "touch /tmp/bob-asked" } };
    const { rerender } = render(<RecoveryBanner {...p} waiting asks={[shared]} askDetail answerBlockedReason="Waiting for someone who can approve" />);
    expect(screen.getByTestId("permission-detail").textContent).toBe("touch /tmp/bob-asked");
    expect((screen.getByRole("button", { name: /^Allow/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("answer-blocked").textContent).toBe("Waiting for someone who can approve");
    // An approver reads the same line, with the buttons enabled.
    rerender(<RecoveryBanner {...p} waiting asks={[shared]} askDetail />);
    expect(screen.getByTestId("permission-detail").textContent).toBe("touch /tmp/bob-asked");
    expect((screen.getByRole("button", { name: /^Allow/ }) as HTMLButtonElement).disabled).toBe(false);
    // A local session's banner stays as it was: no detail.
    rerender(<RecoveryBanner {...p} waiting asks={[shared]} />);
    expect(screen.queryByTestId("permission-detail")).toBeNull();
  });

  it("describes what a request is about by its tool: a command, a file, a URL, or the tool itself", () => {
    expect(askDetail({ toolName: "Bash", input: { command: "ls  -la\n/tmp" } })).toBe("ls -la /tmp");
    expect(askDetail({ toolName: "Edit", input: { file_path: "/workspace/api/src/login.ts", old_string: "a" } })).toBe("/workspace/api/src/login.ts");
    expect(askDetail({ toolName: "WebFetch", input: { url: "https://example.com/docs" } })).toBe("https://example.com/docs");
    expect(askDetail({ toolName: "mcp__linear__create_issue", input: { title: "x" } })).toBe("linear · create_issue");
    expect(askDetail({ toolName: "Task", input: {} })).toBe("Task");
    expect(askDetail({ toolName: "Bash", input: { command: "x".repeat(500) } })).toHaveLength(241);
    expect(askDetail({ input: null })).toBeNull();
  });
});
