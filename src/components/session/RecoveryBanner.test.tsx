import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecoveryBanner } from "./RecoveryBanner";
import { askDetail } from "@/components/chat/AskCards";
import type { PendingAsk } from "@/lib/transcript";
import { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { FakeAgentRuntime } from "@/test/fakeAgentRuntime";
import { usePickerModels } from "@/lib/cloudModels";
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

  it("offers the workspace's pinned model for recovery, with aliases only offline", async () => {
    const p = props();
    const runtime = new FakeAgentRuntime();
    const alias: ModelInfo = { id: "opus", label: "Opus", harness: "claude", alias: true, resolved: "claude-opus-5-5", isDefault: true, efforts: [], defaultEffort: null, acceptsImages: true, upgrade: null, description: null };
    runtime.agents[0].models = [{ ...alias, resolved: "claude-opus-4-6" }, { ...alias, id: "claude-opus-4-6", label: "Opus 4.6", alias: false, isDefault: false }];
    const client = new WorkspaceRpcClient(runtime);
    runtime.connect();
    function CloudRecovery() {
      const { models, refresh } = usePickerModels([alias], true, client, "claude");
      return <RecoveryBanner {...p} kind="capacity" models={models} onOpenModels={refresh} />;
    }
    render(<CloudRecovery />);
    expect(await screen.findByRole("option", { name: "Opus (latest · Opus 4.6)" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "claude-opus-4-6" } });
    expect(p.onRetry).toHaveBeenCalledWith("claude-opus-4-6");
    act(() => runtime.emit({ state: "suspended" }));
    expect(screen.getByRole("option", { name: "Opus (latest)" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Opus 4.6" })).toBeNull();
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

  it("shows every option as off, with the reason, to someone who may not approve", () => {
    const p = props();
    const reason = "Waiting for someone who can approve";
    const { rerender } = render(<RecoveryBanner {...p} waiting asks={[ask]} askDetail answerBlockedReason={reason} />);
    const allow = screen.getByRole("button", { name: /^Allow/ }) as HTMLButtonElement;
    const deny = screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement;
    for (const button of [allow, deny]) {
      expect(button.disabled).toBe(true);
      expect(button.title).toBe(reason);
      // The same quiet outline: neither keeps the accent fill that reads as "press me".
      expect(button.className).not.toMatch(/\bbg-accent\b/);
      expect(button.className).toMatch(/\bborder-border\b/);
      expect(button.className).toMatch(/\btext-muted-foreground\b/);
    }
    // No Return hint on a button Return cannot press.
    expect(allow.textContent).toBe("Allow");
    // The reason is written once, inside the card, under its buttons.
    const blocked = screen.getAllByTestId("answer-blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].textContent).toBe(reason);
    expect(allow.closest("div.rounded-xl")?.contains(blocked[0])).toBe(true);
    fireEvent.click(allow);
    expect(p.onPermission).not.toHaveBeenCalled();

    // An approver: Allow is the accent button again, enabled, with its Return hint and no reason.
    rerender(<RecoveryBanner {...p} waiting asks={[ask]} askDetail />);
    const enabled = screen.getByRole("button", { name: /^Allow/ }) as HTMLButtonElement;
    expect(enabled.disabled).toBe(false);
    expect(enabled.className).toMatch(/\bbg-accent\b/);
    expect(enabled.textContent).toContain("⏎");
    expect(screen.queryByTestId("answer-blocked")).toBeNull();

    // A question card for a non-approver: Answer and Skip are off the same way.
    const question: PendingAsk = { requestId: "q-1", kind: "question", questions: [{ question: "Which one?", header: "Pick", options: [{ label: "A", description: "" }], multiSelect: false, freeText: false }] } as unknown as PendingAsk;
    rerender(<RecoveryBanner {...p} waiting asks={[question]} answerBlockedReason={reason} />);
    const answer = screen.getByRole("button", { name: "Answer" }) as HTMLButtonElement;
    expect(answer.disabled).toBe(true);
    expect(answer.className).not.toMatch(/\bbg-accent\b/);
    expect((screen.getByRole("button", { name: "Skip" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("answer-blocked").textContent).toBe(reason);
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
