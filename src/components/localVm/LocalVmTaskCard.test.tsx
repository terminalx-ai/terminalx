import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { environment, task } from "./localVm.testSupport";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/api", () => ({ invoke: mocks.invoke, fs: {}, errorMessage: (error: unknown) => String(error) }));
vi.mock("./useLocalVmState", () => ({ reconcileLocalVmState: vi.fn() }));
import { artifactHref, LocalVmTaskCard } from "./LocalVmTaskCard";
const calls = (method: string) => mocks.invoke.mock.calls.filter(([, args]) => args.method === method);
beforeEach(() => { mocks.invoke.mockReset(); mocks.invoke.mockResolvedValue(null); });
afterEach(cleanup);

describe("durable local VM task actions", () => {
  it("shows latest guest progress without expanding its raw diagnostic events", () => {
    const record = task({ events: [{ seq: 1, timestamp: "2026-10-24T00:00:01Z", payload: { id: "guest-event", sessionId: "guest-session", tabId: "guest-tab", harness: "codex", seq: 1, ts: "2026-10-24T00:00:01Z", payload: { type: "tool_call_started", callId: "navigate", name: "computer", title: "Navigate to the project page", input: {} } } }] });
    const view = render(<LocalVmTaskCard task={record} destinationRoot="/project" readOnly={false} />);
    const progress = screen.getByRole("status", { name: "Latest task progress" });
    expect(progress.textContent).toBe("Latest progress: Tool started: Navigate to the project page");
    expect(progress.closest("details")).toBeNull();
    const diagnostics = screen.getByText("Retained task events · 1").closest("details")!;
    expect(diagnostics.open).toBe(false);
    expect(diagnostics.querySelector("pre")?.textContent).toContain("tool_call_started");
    view.rerender(<LocalVmTaskCard task={{ ...record, events: [...record.events, { seq: 2, timestamp: "2026-10-24T00:00:02Z", payload: { payload: { type: "status", text: "Checking the loaded page" } } }] }} destinationRoot="/project" readOnly={false} />);
    expect(screen.getByRole("status", { name: "Latest task progress" }).textContent).toBe("Latest progress: Checking the loaded page");
  });

  it("states when no readable task progress has been received", () => {
    render(<LocalVmTaskCard task={task()} destinationRoot="/project" readOnly={false} />);
    expect(screen.getByRole("status", { name: "Latest task progress" }).textContent).toContain("No status, tool activity or text received yet.");
  });

  it("confirms takeover, acquires the manual hold and verifies the exact stopped task before opening its desktop", async () => {
    const record = task();
    const stopped = { ...record, status: "canceled" };
    mocks.invoke.mockImplementation(async (_command, { method }) => method === "state" ? { environments: { env: { ...environment, manualControl: true } }, tasks: { task: stopped } } : { ready: true, manualControl: true, task: stopped });
    render(<LocalVmTaskCard task={record} destinationRoot="/project" readOnly={false} />);
    expect(screen.getByText(/The workflow may still control it/).textContent).toContain("Closing the viewer never stops a task");
    fireEvent.click(screen.getByRole("button", { name: "Take over desktop…" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Stop this task before manual desktop control?");
    expect(dialog.textContent).toContain("Queued tasks in this VM wait until you explicitly return control");
    expect(dialog.textContent).toContain("Closing the viewer does not release the hold");
    expect(mocks.invoke).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop task and take over" }));
    await waitFor(() => expect(calls("environment.desktop")).toHaveLength(1));
    expect(mocks.invoke.mock.calls.map(([, args]) => args.method)).toEqual(["task.takeover", "state", "environment.desktop"]);
    expect(calls("task.takeover")[0][1].params).toEqual({ target: record.target, confirm: true });
    expect(calls("environment.desktop")[0][1].params).toEqual({ environmentId: record.target.environmentId, target: record.target });
  });

  it.each(["not-ready", "no-hold", "not-stopped", "wrong-target"])("does not open a takeover viewer when its response is %s", async (condition) => {
    const record = task();
    mocks.invoke.mockResolvedValue({ ready: condition !== "not-ready", manualControl: condition !== "no-hold", task: { ...record, target: condition === "wrong-target" ? { ...record.target, workspaceId: "other-workspace" } : record.target, status: condition === "not-stopped" ? "canceling" : "canceled" } });
    render(<LocalVmTaskCard task={record} destinationRoot="/project" readOnly={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Take over desktop…" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Stop task and take over" }));
    await screen.findByText(/The task has not confirmed it stopped/);
    expect(calls("environment.desktop")).toHaveLength(0);
    expect(calls("state")).toHaveLength(0);
  });

  it.each(["not-stopped", "no-hold", "wrong-generation", "wrong-target"])("does not trust a ready response when retained state has %s", async (condition) => {
    const record = task();
    mocks.invoke.mockImplementation(async (_command, { method }) => method === "state" ? {
      environments: { env: { ...environment, manualControl: condition !== "no-hold", generation: condition === "wrong-generation" ? "replacement-generation" : environment.generation } },
      tasks: { task: { ...record, status: condition === "not-stopped" ? "canceling" : "canceled", target: condition === "wrong-target" ? { ...record.target, taskId: "other-task" } : record.target } },
    } : { ready: true, manualControl: true, task: { ...record, status: "canceled" } });
    render(<LocalVmTaskCard task={record} destinationRoot="/project" readOnly={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Take over desktop…" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Stop task and take over" }));
    await screen.findByText(/Retained history has not confirmed the stopped task and manual desktop hold/);
    expect(calls("environment.desktop")).toHaveLength(0);
  });

  it("keeps manual control through viewer closure and explicitly returns queued work without resuming the canceled task", async () => {
    const record = task({ status: "canceled" });
    const view = render(<LocalVmTaskCard task={record} destinationRoot="/project" readOnly={false} manualControl />);
    const held = screen.getByRole("status", { name: "Manual desktop control" });
    expect(held.textContent).toContain("Closing the viewer does not release this hold");
    expect(mocks.invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Return control to queued tasks" }));
    await waitFor(() => expect(calls("environment.releaseDesktop")).toHaveLength(1));
    expect(calls("environment.releaseDesktop")[0][1].params).toEqual({ environmentId: record.target.environmentId, confirm: true });
    expect(mocks.invoke.mock.calls.map(([, args]) => args.method)).toEqual(["environment.releaseDesktop"]);
    expect(screen.getByRole("status", { name: "Manual desktop control" })).toBeTruthy();
    view.rerender(<LocalVmTaskCard task={record} destinationRoot="/project" readOnly={false} manualControl={false} />);
    expect(screen.queryByRole("status", { name: "Manual desktop control" })).toBeNull();
  });

  it("retains manual control after an ambiguous release and disables release for read-only conversations", async () => {
    mocks.invoke.mockRejectedValue(new Error("Release acknowledgment lost"));
    const record = task({ status: "canceled" });
    const view = render(<LocalVmTaskCard task={record} destinationRoot="/project" readOnly={false} manualControl />);
    fireEvent.click(screen.getByRole("button", { name: "Return control to queued tasks" }));
    await screen.findByText(/Release acknowledgment lost/);
    expect(screen.getByRole("status", { name: "Manual desktop control" })).toBeTruthy();
    view.rerender(<LocalVmTaskCard task={record} destinationRoot="/project" readOnly manualControl />);
    expect((screen.getByRole("button", { name: "Return control to queued tasks" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("routes guest permission, follow-up and cancellation to the complete immutable target", async () => {
    const record = task({ status: "waiting", events: [{ seq: 1, timestamp: "", payload: { payload: { type: "permission_requested", requestId: "permission", title: "Guest command", input: { command: "pwd" }, options: [{ id: "allow", label: "Allow once" }] } } }] });
    render(<LocalVmTaskCard task={record} destinationRoot="/project" readOnly={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Open desktop" }));
    await waitFor(() => expect(calls("environment.desktop")).toHaveLength(1));
    expect(calls("environment.desktop")[0][1].params).toEqual({ environmentId: record.target.environmentId, target: record.target });
    await waitFor(() => expect((screen.getByRole("button", { name: "Allow once" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(calls("task.permission")).toHaveLength(1));
    expect(calls("task.permission")[0][1].params).toEqual({ target: record.target, requestId: "permission", optionId: "allow", idempotencyKey: expect.any(String) });
    await waitFor(() => expect((screen.getByLabelText("Follow-up for this task") as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Follow-up for this task"), { target: { value: "Check the result" } });
    fireEvent.click(screen.getByRole("button", { name: "Send task follow-up" }));
    await waitFor(() => expect(calls("task.followup")).toHaveLength(1));
    expect(calls("task.followup")[0][1].params).toEqual({ target: record.target, text: "Check the result", idempotencyKey: expect.any(String) });
    await waitFor(() => expect((screen.getByRole("button", { name: "Cancel task" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Cancel task" }));
    await waitFor(() => expect(calls("task.cancel")).toHaveLength(1));
    expect(calls("task.cancel")[0][1].params).toEqual({ target: record.target });
    expect(mocks.invoke.mock.calls.every(([command]) => command === "local_vm_request")).toBe(true);
  });

  it("fetches artifacts through the task target and imports only after deliberate conflict-aware confirmation", async () => {
    const record = task({ status: "completed", artifacts: [{ id: "patch", name: "changes.patch", mediaType: "text/x-patch", sha256: "abc", bytes: 42, expiresAt: null }] });
    mocks.invoke.mockImplementation(async (_command, { method }) => method === "task.artifact" ? { name: "changes.patch", mediaType: "text/x-patch", content: "diff --git a/a b/a" } : { applied: false, conflicts: ["src/a.ts"], detail: "Conflicts found; patch was not applied." });
    render(<LocalVmTaskCard task={record} destinationRoot="/project/worktree" readOnly={false} />);
    fireEvent.click(screen.getByRole("button", { name: "View artifact" }));
    await screen.findByRole("link", { name: "Open or save artifact" });
    expect(calls("task.artifact")[0][1].params).toEqual({ target: record.target, artifactId: "patch" });
    await waitFor(() => expect((screen.getByRole("button", { name: "Import patch…" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Import patch…" }));
    expect(calls("task.applyPatch")).toHaveLength(0);
    const dialog = screen.getByRole("dialog");
    expect((within(dialog).getByLabelText("Destination project directory on this Mac") as HTMLInputElement).value).toBe("/project/worktree");
    fireEvent.click(within(dialog).getByRole("button", { name: "Check conflicts and import" }));
    await screen.findByText("Conflicts found; patch was not applied.");
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(calls("task.applyPatch")[0][1].params).toEqual({ target: record.target, artifactId: "patch", destinationRoot: "/project/worktree", confirm: true });
  });

  it("rejects guest and executable artifact URLs instead of handing them to host openers", () => {
    for (const url of ["javascript:alert(1)", "file:///Users/guest/result", "local-cua://env/generation/workspace/task/file"]) expect(artifactHref({ name: "result", mediaType: "text/plain", url })).toBeNull();
    expect(artifactHref({ name: "result", mediaType: "text/plain", url: "https://example.com/result" })).toBeNull();
    expect(artifactHref({ name: "result", mediaType: "text/plain", url: "http://127.0.0.1:8080/result" })).toBe("http://127.0.0.1:8080/result");
    expect(artifactHref({ name: "result", mediaType: "text/plain", url: "http://localhost.example.com/result" })).toBeNull();
  });

  it("downloads verified binary content as a safe data file and rejects malformed base64", async () => {
    const record = task({ status: "completed", artifacts: [{ id: "image", name: "result.png", mediaType: "image/png", sha256: "abc", bytes: 3, expiresAt: null }] });
    mocks.invoke.mockResolvedValue({ name: "result.png", mediaType: "image/png", contentBase64: "YWJj" });
    render(<LocalVmTaskCard task={record} destinationRoot="/project" readOnly={false} />);
    fireEvent.click(screen.getByRole("button", { name: "View artifact" }));
    const download = await screen.findByRole("link", { name: "Download artifact" });
    expect(download.getAttribute("href")).toBe("data:application/octet-stream;base64,YWJj");
    expect(download.getAttribute("download")).toBe("result.png");
    expect(artifactHref({ name: "bad", mediaType: "image/png", contentBase64: "bad<script>" })).toBeNull();
  });
});
