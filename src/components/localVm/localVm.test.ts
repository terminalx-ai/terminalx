import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
import { invoke } from "@/lib/api";
import { contextManifest, contextPaths, localVmRequest, pendingTaskApprovals, taskMessagePrefix, tasksForConversation } from "@/lib/localVm";
import { assertLocal, guestTaskPath, isCloudKey, isGuestPath, isLocalKey, type GuestPath, type RemotePath } from "@/types/target";
import type { LocalVmTaskInput, LocalVmTaskStatus } from "@/types/localVm";
import { environment, makeTask, parentSessionId, parentTabId } from "./testFixtures";

beforeEach(() => { mocks.invoke.mockReset(); });

describe("local guest target routing", () => {
  it("keeps guest identities distinct from host paths and cloud identities, and guards real host commands", async () => {
    const target = makeTask().target;
    const guest = guestTaskPath(target, "/Users/lume/app/readme.md");
    expectTypeOf<GuestPath>().not.toEqualTypeOf<RemotePath>();
    expectTypeOf<LocalVmTaskInput["effort"]>().toEqualTypeOf<string | null>();
    expectTypeOf<LocalVmTaskStatus>().extract<"outcomeUnknown">().toEqualTypeOf<"outcomeUnknown">();
    expect(isGuestPath(guest)).toBe(true);
    expect(isLocalKey(guest)).toBe(false);
    expect(isCloudKey(guest)).toBe(false);
    expect(() => assertLocal(guest)).toThrow(/guest path/);
    for (const args of [{ path: guest }, { cwd: guest }, { root: guest }, { sessionId: guest }]) await expect(invoke("host_command", args)).rejects.toThrow(/guest path/);
    expect(mocks.invoke).not.toHaveBeenCalled();
    mocks.invoke.mockResolvedValue(null);
    await localVmRequest("task.cancel", { target });
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("local_vm_request", { method: "task.cancel", params: { target } });
    await expect(localVmRequest("environment.install", { environmentId: environment.id, runtimePath: guest })).rejects.toThrow(/guest path/);
    await expect(localVmRequest("task.submit", { idempotencyKey: "key", input: makeTask().input, sourceRoot: guest })).rejects.toThrow(/guest path/);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(assertLocal("/work/project")).toBe("/work/project");
    expect(() => assertLocal("cloud://org:workspace/file")).toThrow(/cloud path/);
  });

  it("keeps task cards in their exact parent session, tab and conversation", () => {
    const first = makeTask();
    const next = makeTask({ input: { ...first.input, parentMessageId: `${taskMessagePrefix("next")}:card-2` } });
    const anotherTab = makeTask({ input: { ...first.input, parentTabId: "another-tab" } });
    const anotherSession = makeTask({ input: { ...first.input, parentSessionId: "another-session" } });
    const state = { environments: { [environment.id]: environment }, tasks: { first, next, anotherTab, anotherSession } };
    expect(tasksForConversation(state, parentSessionId, parentTabId, null)).toEqual([first]);
    expect(tasksForConversation(state, parentSessionId, parentTabId, "next")).toEqual([next]);
  });
});

describe("explicit context manifests", () => {
  it("rejects traversal, host and guest roots, schemes and implicit folders", () => {
    for (const path of ["/etc/passwd", "../secret", "src/../secret", "a//b", "a/./b", "a\\b", "a/", "~/.ssh/id", "cloud:project", "local-cua://guest/path", "C:/secrets"]) expect(() => contextPaths(path)).toThrow();
    expect(contextPaths("src/main.ts\n README.md\nsrc/main.ts\n")).toEqual(["src/main.ts", "README.md"]);
  });

  it("rejects a symlink outside the canonical root before reading its content", async () => {
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "inspect_local_path") return args.path === "." ? { path: "/work", kind: "directory" } : { path: "/private/secret", root: "/private", rel: "secret", kind: "file", text: true };
      throw new Error(`Unexpected content read: ${command}`);
    });
    await expect(contextManifest("/work", ["linked-secret"])).rejects.toThrow(/leaves the project/);
    expect(mocks.invoke.mock.calls.every(([command]) => command === "inspect_local_path")).toBe(true);
    await expect(contextManifest(guestTaskPath(makeTask().target, "/work"), [])).rejects.toThrow(/guest path/);
  });

  it("hashes the exact selected file bytes, and rejects truncated text", async () => {
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "inspect_local_path") return args.path === "." ? { path: "/work", kind: "directory" } : { path: "/work/a.txt", kind: "file", text: true };
      if (command === "read_text_file") return { content: "hello", size: 5, binary: false, truncated: false };
    });
    expect(await contextManifest("/work", ["a.txt"])).toEqual([{ path: "a.txt", bytes: 5, sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" }]);
    mocks.invoke.mockImplementation(async (command, args) => command === "inspect_local_path" ? { path: args.path === "." ? "/work" : "/work/a.txt", kind: "file", text: true } : { content: "part", size: 100, binary: false, truncated: true });
    await expect(contextManifest("/work", ["a.txt"])).rejects.toThrow(/complete UTF-8/);
  });
});

it("reconciles permission decisions from normalized and enveloped events", () => {
  const request = { type: "permission_requested", requestId: "permission-1", title: "Run guest command?", input: { command: "pwd" }, options: [{ id: "allow", label: "Allow once", kind: "allow_once" }] };
  const task = makeTask({ status: "waiting", events: [{ seq: 1, timestamp: "", payload: { payload: request } }] });
  expect(pendingTaskApprovals(task)).toEqual([{ requestId: "permission-1", title: "Run guest command?", input: { command: "pwd" }, options: [{ id: "allow", label: "Allow once" }] }]);
  task.events.push({ seq: 2, timestamp: "", payload: { type: "permission_decided", requestId: "permission-1" } });
  expect(pendingTaskApprovals(task)).toEqual([]);
  expect(pendingTaskApprovals({ ...task, status: "completed", events: task.events.slice(0, 1) })).toEqual([]);
});
