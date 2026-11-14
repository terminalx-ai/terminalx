import { describe, expect, it, vi } from "vitest";
import type { HostConnection } from "../transport/connection";
import { HostApi, type NewSessionOptions } from "./host-api";
import { agentDefaults, blocked, chooseModel, initialChoices, request } from "./new-session";

vi.mock("expo-crypto", () => ({ randomUUID: () => "client-id" }));

const options: NewSessionOptions = {
  projects: [{ id: "p-notes", name: "notes", git: false, lastUsed: false }, { id: "p-repo", name: "terminalx", git: true, lastUsed: true }],
  agents: [
    { id: "opencode", name: "OpenCode", available: false, installHint: "brew install opencode", effort: false, permissionModes: false, models: [] },
    { id: "codex", name: "Codex", available: true, installHint: "", effort: true, permissionModes: true, models: [
      { id: "gpt-5", label: "GPT-5", isDefault: false, efforts: ["low", "high"], defaultEffort: "low" },
      { id: "gpt-5.6", label: "GPT-5.6", isDefault: true, efforts: ["medium", "high", "xhigh"], defaultEffort: "medium" },
    ] },
  ],
  modes: [{ id: "plan", label: "Plan" }, { id: "bypassPermissions", label: "Bypass permissions" }],
  defaultMode: "bypassPermissions",
  nativeCodex: false,
};

describe("the phone's new-session form", () => {
  it("opens as the desktop's view does: the last project, the first installed agent, its defaults", () => {
    expect(initialChoices(options)).toEqual({ where: { projectId: "p-repo", useWorktree: true }, agent: "codex", model: "gpt-5.6", effort: "medium", mode: "bypassPermissions", title: "", text: "" });
    expect(initialChoices({ ...options, projects: [] }).where).toEqual({ quick: true });
    expect(agentDefaults(null)).toEqual({ agent: null, model: "", effort: null });
  });

  it("keeps an effort across models only when the new model offers it", () => {
    const codex = options.agents[1];
    const start = { ...initialChoices(options), effort: "high" };
    expect(chooseModel(start, codex, "gpt-5")).toMatchObject({ model: "gpt-5", effort: "high" });
    expect(chooseModel({ ...start, effort: "xhigh" }, codex, "gpt-5")).toMatchObject({ model: "gpt-5", effort: "low" });
    expect(chooseModel(start, codex, "no-such-model")).toBe(start);
  });

  it("says what is missing before it can start", () => {
    const ready = { ...initialChoices(options), text: "Fix the login redirect" };
    expect(blocked(ready, options)).toBeNull();
    expect(blocked({ ...ready, text: "  " }, options)).toBe("Write the first message.");
    expect(blocked({ ...ready, where: null }, options)).toBe("Choose a project or a quick chat.");
    expect(blocked({ ...ready, where: { projectId: "p-notes", useWorktree: true } }, options)).toContain("not a Git repository");
    expect(blocked({ ...ready, where: { projectId: "gone", useWorktree: false } }, options)).toBe("That project is no longer on this Mac.");
    expect(blocked({ ...ready, agent: "opencode" }, options)).toBe("OpenCode is not installed on this Mac.");
    expect(request(ready)).toEqual({ where: { projectId: "p-repo", useWorktree: true }, agent: "codex", model: "gpt-5.6", effort: "medium", mode: "bypassPermissions", title: "", text: "Fix the login redirect" });
  });
});

describe("the Mac's side of a new session", () => {
  const api = (request: ReturnType<typeof vi.fn>) => new HostApi({ request } as unknown as HostConnection);

  it("asks only a Mac that says it can start sessions for a phone", async () => {
    const old = vi.fn(async (method: string) => method === "sync.capabilities" ? { ok: true, value: { sendIds: 1 } } : { ok: false, refusal: { message: "unknown method" } });
    const host = api(old);
    await expect(host.newSessionOptions()).resolves.toBeNull();
    await expect(host.createSession(request({ ...initialChoices(options), text: "hi" }), "draft")).resolves.toEqual({ created: false, message: "Update TerminalX on this Mac to start sessions from your phone." });
    await expect(host.macSettings()).resolves.toBeNull();
    expect(old.mock.calls.map((call) => call[0])).toEqual(["sync.capabilities"]);
  });

  it("sends the choices and the draft id, and reads back the session it started", async () => {
    const calls: [string, unknown][] = [];
    const host = vi.fn(async (method: string, params?: unknown) => {
      calls.push([method, params]);
      if (method === "sync.capabilities") return { ok: true, value: { sendIds: 1, sessionCreate: 1, macSettings: 1 } };
      if (method === "sessions.options") return { ok: true, value: options };
      return { ok: true, value: { sessionId: "s-1", tabId: "t-1", title: "Fix it", native: true, sent: { status: "sent", queued: false } } };
    });
    await expect(api(host).newSessionOptions()).resolves.toEqual(options);
    const created = await api(host).createSession({ where: { projectId: "p-repo", useWorktree: false }, agent: "codex", model: "gpt-5.6", effort: "medium", mode: "plan", title: " ", text: "Fix it" }, "draft-1");
    expect(created).toEqual({ created: true, sessionId: "s-1", tabId: "t-1", title: "Fix it", native: true, queued: false });
    expect(calls.find(([method]) => method === "sessions.create")?.[1]).toEqual({ projectId: "p-repo", useWorktree: false, agent: "codex", model: "gpt-5.6", effort: "medium", mode: "plan", text: "Fix it", clientMessageId: "draft-1" });
  });

  it("opens a session whose first message was not sent, and says why", async () => {
    const host = vi.fn(async (method: string) => method === "sync.capabilities"
      ? { ok: true, value: { sessionCreate: 1 } }
      : { ok: true, value: { sessionId: "s-1", tabId: "t-1", title: "Hi", native: false, sendError: "The agent is busy; the mobile prompt must wait." } });
    await expect(api(host).createSession({ where: { quick: true }, agent: "claude", model: "", text: "Hi" })).resolves.toEqual({ created: true, sessionId: "s-1", tabId: "t-1", title: "Hi", native: false, sendError: "The agent is busy; the mobile prompt must wait." });
  });

  it("reads and changes Native Codex, and keeps the Mac's refusal", async () => {
    const host = vi.fn(async (method: string, params?: { nativeCodex?: boolean }) => {
      if (method === "sync.capabilities") return { ok: true, value: { macSettings: 1 } };
      if (method === "mac.settings") return { ok: true, value: { nativeCodex: false } };
      if (params?.nativeCodex === false) return { ok: false, refusal: { message: "this paired device is read-only" } };
      return { ok: true, value: { nativeCodex: true } };
    });
    await expect(api(host).macSettings()).resolves.toEqual({ nativeCodex: false });
    await expect(api(host).setNativeCodex(true)).resolves.toEqual({ nativeCodex: true });
    await expect(api(host).setNativeCodex(false)).rejects.toThrow("read-only");
  });
});
