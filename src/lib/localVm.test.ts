import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { description, task } from "@/components/localVm/localVm.testSupport";
import { loadSubmission, submissionStorageKey } from "@/components/localVm/submission";
import type { LocalVmJson, LocalVmSubmission, LocalVmTaskEvent } from "@/types/localVm";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), inspectPath: vi.fn(), readText: vi.fn() }));
vi.mock("@/lib/api", () => ({ invoke: mocks.invoke, fs: { inspectPath: mocks.inspectPath, readText: mocks.readText } }));
import { contextManifest, contextPaths, latestTaskProgress, pendingTaskApprovals, submissionUnavailable } from "./localVm";

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto); localStorage.clear(); mocks.invoke.mockReset(); mocks.inspectPath.mockReset(); mocks.readText.mockReset();
  mocks.inspectPath.mockImplementation(async (_base, path) => ({ path: path === "." ? "/project" : `/project/${path}`, root: "/project", rel: path, kind: path === "." ? "directory" : "file", text: true }));
  mocks.readText.mockResolvedValue({ content: "hello", size: 5, binary: false, truncated: false, mtimeMs: 0 });
});
afterEach(() => vi.unstubAllGlobals());

describe("selected context export", () => {
  it("hashes only explicit complete UTF-8 project files and defaults to no reads", async () => {
    expect(await contextManifest("/project", [])).toEqual([]);
    expect(mocks.inspectPath).not.toHaveBeenCalled();
    expect(await contextManifest("/project", contextPaths("src/a.ts\nsrc/a.ts"))).toEqual([{ path: "src/a.ts", bytes: 5, sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" }]);
    expect(mocks.readText).toHaveBeenCalledExactlyOnceWith("/project/src/a.ts");
  });

  it.each(["/outside", "../outside", "a/../outside", "cloud://workspace/path", "local-cua://env/path", "a\\b", ".env", "config/.env.local", ".ssh/config", ".git/config", "cert.key", "credentials.json"])("refuses unsafe or credential path %s", (path) => {
    expect(() => contextPaths(path)).toThrow();
  });

  it("refuses symlink escapes and credential aliases before reading their content", async () => {
    mocks.inspectPath.mockImplementation(async (_base, path) => ({ path: path === "." ? "/project" : "/outside/secret", kind: "file", text: true }));
    await expect(contextManifest("/project", ["alias"])).rejects.toThrow(/leaves the project/);
    mocks.inspectPath.mockImplementation(async (_base, path) => ({ path: path === "." ? "/project" : "/project/.env", kind: "file", text: true }));
    await expect(contextManifest("/project", ["alias"])).rejects.toThrow(/Credential/);
    expect(mocks.readText).not.toHaveBeenCalled();
  });

  it.each([{ binary: true }, { truncated: true }, { size: 7 }, { content: "a\ufffdb", size: 5 }])("refuses an incomplete/non-text preview %j", async (changes) => {
    mocks.readText.mockResolvedValue({ content: "hello", size: 5, binary: false, truncated: false, ...changes });
    await expect(contextManifest("/project", ["src/a.ts"])).rejects.toThrow(/complete UTF-8/);
  });
});

describe("durable submission and guest readiness", () => {
  it("loads the exact pending submission only for its originating conversation", () => {
    const record = task();
    const pending: LocalVmSubmission = { idempotencyKey: record.idempotencyKey, input: record.input, sourceRoot: "/project" };
    const key = submissionStorageKey(record.input.parentSessionId, record.input.parentTabId, null);
    localStorage.setItem(key, JSON.stringify(pending));
    expect(loadSubmission(key, record.input.parentSessionId, record.input.parentTabId, null)).toEqual(pending);
    expect(() => loadSubmission(key, record.input.parentSessionId, record.input.parentTabId, "other")).toThrow(/saved VM submission/);
    expect(localStorage.getItem(key)).toBe(JSON.stringify(pending));
  });

  it("requires positively reported runtime capability and all inherited settings", () => {
    const input = task().input;
    expect(submissionUnavailable(null, input)).toContain("unavailable");
    expect(submissionUnavailable({ ...description, capabilities: [] }, input)).toContain("not reported support");
    expect(submissionUnavailable(description, input)).toBeNull();
    expect(submissionUnavailable(description, { ...input, harness: "claude" })).toContain("claude");
    expect(submissionUnavailable(description, { ...input, model: "other" })).toContain("model other");
    expect(submissionUnavailable(description, { ...input, effort: "low" })).toContain("effort low");
    expect(submissionUnavailable(description, { ...input, permissionMode: "manual" })).toContain("mode manual");
  });

  it("allows an empty inherited model only when guest discovery explicitly advertises provider default", () => {
    const input = { ...task().input, model: "", effort: null };
    expect(submissionUnavailable(description, input)).toBe("The guest has not reported support for provider-default model selection.");
    const defaults = { ...description, harnesses: [{ ...description.harnesses[0], models: [{ id: "", efforts: ["high"] }] }] };
    expect(submissionUnavailable(defaults, input)).toBeNull();
    expect(submissionUnavailable(defaults, { ...input, effort: "high" })).toBeNull();
    expect(submissionUnavailable(defaults, { ...input, effort: "low" })).toContain("effort low");
    expect(submissionUnavailable({ ...defaults, available: false, reason: "Guest model discovery unavailable" }, input)).toBe("Guest model discovery unavailable");
  });

  it("removes decided guest permission requests and never shows them as pending on a finished task", () => {
    const record = task({ events: [
      { seq: 1, timestamp: "", payload: { type: "permission_requested", requestId: "a", input: null, options: [{ id: "once", label: "Allow once" }] } },
      { seq: 2, timestamp: "", payload: { type: "permission_decided", requestId: "a" } },
      { seq: 3, timestamp: "", payload: { payload: { type: "permission_requested", requestId: "b", input: null, options: [{ id: "deny", label: "Deny" }] } } },
    ] });
    expect(pendingTaskApprovals(record).map((approval) => approval.requestId)).toEqual(["b"]);
    expect(pendingTaskApprovals({ ...record, status: "completed" })).toEqual([]);
  });
});

describe("readable latest task progress", () => {
  // collect stores the complete AgentEvent as TaskEvent.payload, not its inner payload alone.
  const guestEvent = (seq: number, payload: LocalVmJson): LocalVmTaskEvent => ({ seq, timestamp: "2026-10-24T00:00:01Z", payload: {
    id: `guest-event-${seq}`, sessionId: "guest-session", tabId: "guest-tab", harness: "codex", seq, ts: "2026-10-24T00:00:01Z", payload,
  } });

  it("uses the latest wrapped normalized text and skips newer usage and unknown metadata", () => {
    const events = [guestEvent(1, { type: "status", text: "Inspecting the page" }), guestEvent(2, { type: "assistant_text", text: "Found the page.\n  Checking the form now." }), guestEvent(3, { type: "usage_update", inputTokens: 100 }), guestEvent(4, { type: "unknown", kind: "metadata" })];
    expect(latestTaskProgress(task({ events }))).toBe("Agent: Found the page. Checking the form now.");
  });

  it("shows a started tool title and correlates a later result by call ID", () => {
    const start = guestEvent(1, { type: "tool_call_started", callId: "read", name: "Read", title: "Read src/app.ts", toolType: "file_read", input: { path: "src/app.ts" } });
    expect(latestTaskProgress(task({ events: [start] }))).toBe("Tool started: Read src/app.ts");
    const unrelated = guestEvent(2, { type: "tool_call_started", callId: "search", name: "Search", toolType: "search", input: {} });
    const failed = guestEvent(3, { type: "tool_call_completed", callId: "read", result: { text: "File\nnot found", isError: true } });
    expect(latestTaskProgress(task({ events: [start, unrelated, failed] }))).toBe("Tool failed: Read src/app.ts · File not found");
  });

  it("uses the tool name when its title is absent and handles a paged result without its start", () => {
    expect(latestTaskProgress(task({ events: [guestEvent(1, { type: "tool_call_started", callId: "shell", name: "Shell", input: {} })] }))).toBe("Tool started: Shell");
    expect(latestTaskProgress(task({ events: [guestEvent(2, { type: "tool_call_completed", callId: "shell", result: { text: "3 tests passed", isError: false } })] }))).toBe("Tool finished · 3 tests passed");
  });

  it("reports normalized waiting/error status and direct guest lifecycle events", () => {
    expect(latestTaskProgress(task({ events: [guestEvent(1, { type: "status", text: "Waiting for the page to load" })] }))).toBe("Waiting for the page to load");
    expect(latestTaskProgress(task({ events: [guestEvent(1, { type: "permission_requested", toolName: "Shell", requestId: "p", input: {}, options: [] })] }))).toBe("Waiting for permission: Shell");
    expect(latestTaskProgress(task({ events: [guestEvent(1, { type: "error", message: "Provider disconnected", fatal: true })] }))).toBe("Error: Provider disconnected");
    expect(latestTaskProgress(task({ events: [{ seq: 1, timestamp: "", payload: { type: "taskSettled", status: "canceled" } }] }))).toBe("Canceled");
    expect(latestTaskProgress(task({ events: [{ seq: 1, timestamp: "", payload: { type: "outcomeUnknown", detail: "Guest disconnected" } }] }))).toBe("Outcome unknown: Guest disconnected");
  });

  it("does not mistake an authentication failure for a completed task", () => {
    expect(latestTaskProgress(task({ events: [guestEvent(1, { type: "turn_completed", status: "ok", authFailed: true })] }))).toBe("Guest provider sign-in required");
  });

  it("bounds readable output and leaves absent or unrecognized activity unknown", () => {
    const progress = latestTaskProgress(task({ events: [guestEvent(1, { type: "assistant_text", text: "x".repeat(500) })] }));
    expect(progress?.length).toBe(200);
    expect(progress?.endsWith("…")).toBe(true);
    expect(latestTaskProgress(task({ events: [guestEvent(1, { type: "assistant_text", text: " \n " }), guestEvent(2, { type: "usage_update" }), { seq: 3, timestamp: "", payload: null }] }))).toBeNull();
    expect(latestTaskProgress(task())).toBeNull();
  });
});
