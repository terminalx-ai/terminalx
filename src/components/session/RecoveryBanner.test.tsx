import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyRecovery } from "@/lib/recovery";
import { RecoveryBanner } from "./RecoveryBanner";
import { askDetail } from "@/components/chat/AskCards";
import { buildTranscript, type PendingAsk } from "@/lib/transcript";
import type { AgentEvent } from "@/types/events";
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
  it("keeps hook context through transcript replay and distinguishes the session directory from an explicit workdir", () => {
    // The real Codex PreToolUse event has Bash + command, not the original
    // exec_command arguments the previous UI-only fixture supplied.
    const event: AgentEvent = JSON.parse(`{
      "id":"permission-event", "sessionId":"s", "tabId":"t", "harness":"codex", "seq":1, "ts":"2026-10-26T00:00:00Z",
      "payload":{"type":"permission_requested", "requestId":"r", "toolUseId":"", "toolName":"Bash",
        "input":{"command":"git status --short --branch"}, "cwd":"/workspace/app",
        "description":"Approval is required because this session is set to Ask every time.", "options":[]}
    }`);
    const { rerender } = render(<RecoveryBanner {...props()} waiting asks={buildTranscript([event], true).pendingAsks} />);
    expect(screen.getByText("/workspace/app")).toBeTruthy();
    expect(screen.getByText(/Session directory:/)).toBeTruthy();
    expect(screen.getByText("Approval is required because this session is set to Ask every time.")).toBeTruthy();
    if (event.payload.type !== "permission_requested") throw new Error("permission fixture");
    event.payload.input = { command: "pwd", workdir: "/workspace/other", justification: "Inspect the selected checkout" };
    rerender(<RecoveryBanner {...props()} waiting asks={buildTranscript([event], true).pendingAsks} />);
    expect(screen.getByText("/workspace/other")).toBeTruthy();
    expect(screen.getByText(/Working directory:/)).toBeTruthy();
    expect(screen.queryByText("/workspace/app")).toBeNull();
    expect(screen.getByText("Inspect the selected checkout")).toBeTruthy();
  });

  it("shows the full local Codex command, working directory and reason before approval", () => {
    const command = `printf 'keep  two spaces\\n'\n${"echo next\n".repeat(40)}echo final-command`;
    const local: PendingAsk = { ...ask, toolName: "exec_command", input: { cmd: command, workdir: "/workspace/app", justification: "Run the focused regression test" }, description: undefined };
    render(<RecoveryBanner {...props()} waiting asks={[local]} />);
    expect(screen.getByTestId("permission-detail").textContent).toBe(command);
    expect(screen.getByText("/workspace/app")).toBeTruthy();
    expect(screen.getByText("Run the focused regression test")).toBeTruthy();
    expect(screen.getByText("Waiting for permission to run a command")).toBeTruthy();
  });

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
    expect(screen.getByTestId("permission-detail").textContent).toBe("TOKEN=secret /Users/private/run");
    expect(container.textContent).not.toContain("unsafe secret");
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
      return <RecoveryBanner {...p} kind="usage_limit" models={models} onOpenModels={refresh} />;
    }
    render(<CloudRecovery />);
    expect(await screen.findByRole("option", { name: "Opus (latest · Opus 4.6)" })).toBeTruthy();
    expect(screen.queryByText(/Retry/i)).toBeNull();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "claude-opus-4-6" } });
    expect(p.onRetry).toHaveBeenCalledWith("claude-opus-4-6");
    act(() => runtime.emit({ state: "suspended" }));
    expect(screen.getByRole("option", { name: "Opus (latest)" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Opus 4.6" })).toBeNull();
  });

  it.each([
    ["usage_limit_reached", false],
    ["insufficient_quota", false],
    ["You've hit your weekly limit", false],
    ["429 Too many requests", true],
    ["529 overloaded", true],
    ["Network connection lost", true],
  ])("offers retry only for recoverable synthetic error: %s", (message, retryable) => {
    render(<RecoveryBanner {...props()} kind={classifyRecovery(message)} />);
    expect(screen.queryByRole("button", { name: /retry/i, hidden: true }) !== null).toBe(retryable);
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

  it("names the plan window that ran out and when it resets, and offers another model", () => {
    const p = props();
    const resetsAt = Date.now() + 23 * 3_600_000 + 5 * 60_000;
    render(<RecoveryBanner {...p} kind="usage_limit" limit={{ status: "rejected", resetsAt, window: "seven_day" }} models={[{ id: "other", label: "Other model" } as ModelInfo]} />);
    expect(screen.getByText("Usage limit reached")).toBeTruthy();
    expect(screen.queryByText(/Retry/i)).toBeNull();
    expect(screen.getByText(/plan's usage limit is reached/)).toBeTruthy();
    const reset = screen.getByTestId("usage-limit-reset").textContent!;
    expect(reset).toMatch(/^Weekly limit · resets .+ \(in 23h [45]m\)$/);
    expect(reset).toContain(new Date(resetsAt).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Choose another model" }), { target: { value: "other" } });
    expect(p.onRetry).toHaveBeenCalledWith("other");
    // Without a reset time there is nothing to count down to; the window alone is not worth a line.
    cleanup();
    render(<RecoveryBanner {...p} kind="usage_limit" limit={{ status: "rejected" }} />);
    expect(screen.queryByTestId("usage-limit-reset")).toBeNull();
    expect(screen.queryByText(/Retry/i)).toBeNull();
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
    // Local approvers need the same information before deciding.
    rerender(<RecoveryBanner {...p} waiting asks={[shared]} />);
    expect(screen.getByTestId("permission-detail").textContent).toBe("touch /tmp/bob-asked");
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
    expect(askDetail({ toolName: "Bash", input: { command: "ls  -la\n/tmp" } })).toBe("ls  -la\n/tmp");
    expect(askDetail({ toolName: "Edit", input: { file_path: "/workspace/api/src/login.ts", old_string: "a" } })).toBe("/workspace/api/src/login.ts");
    expect(askDetail({ toolName: "WebFetch", input: { url: "https://example.com/docs" } })).toBe("https://example.com/docs");
    expect(askDetail({ toolName: "mcp__linear__create_issue", input: { title: "x" } })).toBe("linear · create_issue");
    expect(askDetail({ toolName: "Task", input: {} })).toBe("Task");
    expect(askDetail({ toolName: "Bash", input: { command: "x".repeat(500) } })).toHaveLength(500);
    expect(askDetail({ input: null })).toBeNull();
  });
});
