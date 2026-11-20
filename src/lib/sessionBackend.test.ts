import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const cloudSends = vi.hoisted(() => [] as { tabId: string; text: string; images: unknown[] }[]);
vi.mock("./cloudAgents", async (original) => ({
  ...(await original<typeof import("./cloudAgents")>()),
  sendToCloudAgent: vi.fn(async (_scope: unknown, tabId: string, text: string, _client: unknown, images: unknown[]) => void cloudSends.push({ tabId, text, images })),
}));

const { localSessionBackend, sendFirstMessage, cloudSessionBackend, REMOTE_UNAVAILABLE, RESEND_ATTACHMENTS, RESEND_MISSING, TURNS_OFFLINE, TURNS_OLD_RUNTIME, TURNS_NEED_ADMIN, REVIEW_NEEDS_ADMIN, HANDOFF_OFFLINE, HANDOFF_OLD_RUNTIME, HANDOFF_NEED_ADMIN } = await import("./sessionBackend");
const { getSessionStore } = await import("./sessions");
const { getTerminalState } = await import("./terminal");
const { applyEvent } = await import("./agentEvents");
const { getErrorToasts, dismissError } = await import("./errorToasts");

const ref = { path: "/home/.terminalx/attachments/s1/a1/notes.md", name: "notes.md", mediaType: "text/markdown", size: 3 };
const image = { mediaType: "image/png", data: "AQID", name: "shot.png" };

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => {
    if (command === "store_attachments") return [ref];
    if (command === "send_message") return { queued: false, events: [] };
    return null;
  });
});
afterEach(() => {
  for (const toast of getErrorToasts()) dismissError(toast.id);
});

const commands = () => invoke.mock.calls.map(([command]) => command);

describe("a local session's send (PRO-290)", () => {
  it("stores files in the session's attachments folder first, and sends their FileRefs with the images", async () => {
    await localSessionBackend("s1").send("t1", "Read these", [image], { pressedAt: 5, files: [{ name: "notes.md", path: "/Users/me/notes.md" }] });
    expect(commands()).toEqual(["store_attachments", "send_message"]);
    expect(invoke).toHaveBeenCalledWith("store_attachments", { sessionId: "s1", files: [{ name: "notes.md", path: "/Users/me/notes.md" }] });
    expect(invoke).toHaveBeenCalledWith("send_message", { sessionId: "s1", tabId: "t1", text: "Read these", images: [image], confirmDelivery: false, pressedAt: 5, files: [ref] });
  });

  it("sends nothing when the files cannot be stored", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "store_attachments") throw new Error("terminalx.json is a reserved name");
      return { queued: false, events: [] };
    });
    await expect(localSessionBackend("s1").send("t1", "Read these", [], { files: [{ name: "terminalx.json", data: "e30=" }] })).rejects.toThrow("reserved name");
    expect(commands()).toEqual(["store_attachments"]);
  });

  it("sends a message without files exactly as before: nothing is stored", async () => {
    await localSessionBackend("s1").send("t1", "Hello", [], { pressedAt: 9 });
    expect(commands()).toEqual(["send_message"]);
    expect(invoke).toHaveBeenCalledWith("send_message", { sessionId: "s1", tabId: "t1", text: "Hello", images: [], confirmDelivery: false, pressedAt: 9 });
  });
});

describe("the first message of a new session (PRO-290)", () => {
  it("stores the files picked on the new-session screen now the session exists, and sends their FileRefs", async () => {
    await sendFirstMessage("s1", "t1", "Start here", [image], [{ name: "notes.md", data: "AQID", mediaType: "text/markdown" }]);
    expect(commands()).toEqual(["store_attachments", "send_message"]);
    expect(invoke).toHaveBeenCalledWith("send_message", { sessionId: "s1", tabId: "t1", text: "Start here", images: [image], confirmDelivery: false, files: [ref] });
  });

  it("without files, sends just as the shells always did", async () => {
    await sendFirstMessage("s1", "t1", "Start here");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("send_message", { sessionId: "s1", tabId: "t1", text: "Start here", images: null, confirmDelivery: false });
  });

  it("says so in a toast when the files cannot be stored, since no composer holds them any more", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "store_attachments") throw new Error("disk full");
      return { queued: false, events: [] };
    });
    await expect(sendFirstMessage("s1", "t1", "Start here", [], [{ name: "notes.md", path: "/Users/me/notes.md" }])).rejects.toThrow("disk full");
    expect(commands()).toEqual(["store_attachments"]);
    expect(getErrorToasts()).toEqual([expect.objectContaining({ action: "Couldn't attach notes.md to the first message", cause: "disk full" })]);
  });
});

describe("a cloud session's options a local one has (#1289)", () => {
  const backend = (authority = "manage") =>
    cloudSessionBackend({
      key: "cloud:org-1:ws-1:s-cloud",
      workspaceKey: "cloud:org-1:ws-1",
      scope: { organizationId: "org-1", workspaceId: "ws-1" },
      sessionId: "s-cloud",
      state: { state: "idle" },
      client: null,
      workspaceState: "ready",
      authority,
      outbox: [],
      followUps: () => [],
      wake: vi.fn(async () => undefined),
    });
  const message = (seq: number, payload: Record<string, unknown>) =>
    applyEvent({ id: `e${seq}`, seq, sessionId: "s-cloud", tabId: "t-cloud", harness: "claude", ts: "2026-11-19T00:00:00Z", payload: { type: "user_message", queued: false, ...payload } } as never);

  beforeEach(() => {
    cloudSends.length = 0;
  });

  it("sends a message again, Retry or Send again, as its own text through the mailbox", async () => {
    message(3, { text: "Run the tests" });
    await expect(backend().resendMessage!("t-cloud", 3)).resolves.toEqual({ events: [], queued: true });
    expect(cloudSends).toEqual([{ tabId: "t-cloud", text: "Run the tests", images: [] }]);
  });

  it("refuses a message with attachments, one that is not in the tab, and a view-only reader", async () => {
    message(5, { text: "Look", images: [{ url: "https://example.test/a.png" }] });
    await expect(backend().resendMessage!("t-cloud", 5)).rejects.toThrow(RESEND_ATTACHMENTS);
    await expect(backend().resendMessage!("t-cloud", 99)).rejects.toThrow(RESEND_MISSING);
    message(6, { text: "Hello" });
    await expect(backend("participate").resendMessage!("t-cloud", 6)).rejects.toThrow(/View only/);
    expect(cloudSends).toEqual([]);
  });

  it("says why each option it cannot take is off; a local session has none to say", () => {
    expect(backend().unavailable).toEqual({ ...REMOTE_UNAVAILABLE, ...TURNS_OFFLINE, ...HANDOFF_OFFLINE });
    expect(backend().unavailable).toBe(backend().unavailable);
    expect(REMOTE_UNAVAILABLE.runMenu).toMatch(/\w/);
    expect(localSessionBackend("s1").unavailable).toBeUndefined();
  });
});

describe("Reset, Fork and turn checkpoints on a remote session (#1326)", () => {
  type Call = [string, Record<string, unknown>];
  const client = (capabilities: string[], authority: "manage" | "participate" = "manage") => {
    const calls: Call[] = [];
    const connection = { state: "connected", runtimeGeneration: 1, runtimeVersion: "1", capabilities, authority } as const;
    const tab = (tabId: string, history?: string) => ({ sessionId: "s-cloud", tabId, title: null, harness: "claude", model: "opus", effort: null, permissionMode: "default", status: "idle", process: "running", pendingPermissions: [], followUps: [], lastSeq: 3, created: "", modified: "", ...(history ? { history } : {}) });
    const fake = {
      connection,
      hasCapability: (capability: string) => capabilities.includes(capability),
      turnCheckpoint: async (...args: unknown[]) => (calls.push(["turnCheckpoint", { args }]), { number: 2, reviewed: false, undone: false, files: [] }),
      keepTurn: async (...args: unknown[]) => void calls.push(["keepTurn", { args }]),
      undoTurn: async (...args: unknown[]) => (calls.push(["undoTurn", { args }]), { overlap: [], token: "", undone: true }),
      restoreUndo: async (...args: unknown[]) => (calls.push(["restoreUndo", { args }]), { overlap: [], token: "", undone: true }),
      resetAgentTab: async (params: Record<string, unknown>) => (calls.push(["reset", params]), { warning: null, tab: tab("t-cloud", "generation-2") }),
      forkAgentTab: async (params: Record<string, unknown>) => (calls.push(["fork", params]), params.into === "tab"
        ? { sessionId: "s-cloud", tabId: "t-fork", note: null, tab: tab("t-fork") }
        : { sessionId: "s-new", tabId: "t-new", note: "The fork shares this checkout, so its files are as they are now.", tab: null }),
    };
    return { calls, connection, client: fake as never };
  };
  const backend = (made: ReturnType<typeof client>, authority = made.connection.authority as string) =>
    cloudSessionBackend({
      key: "cloud:org-1:ws-1:s-cloud",
      workspaceKey: "cloud:org-1:ws-1",
      scope: { organizationId: "org-1", workspaceId: "ws-1" },
      sessionId: "s-cloud",
      state: made.connection as never,
      client: made.client,
      workspaceState: "ready",
      authority,
      outbox: [],
      followUps: () => [],
      wake: vi.fn(async () => undefined),
    });

  it("are off with why: not connected, a runtime from before checkpoints/1, or someone who is not an admin", () => {
    const offline = cloudSessionBackend({ key: "cloud:o:w:s", workspaceKey: "cloud:o:w", scope: { organizationId: "o", workspaceId: "w" }, sessionId: "s", state: { state: "idle" }, client: null, workspaceState: "suspended", authority: "manage", outbox: [], followUps: () => [], wake: vi.fn(async () => undefined) });
    expect(offline.turns).toBeUndefined();
    expect(offline.checkpoints).toBeUndefined();
    expect(offline.unavailable).toMatchObject(TURNS_OFFLINE);
    const old = backend(client(["session/1", "session/3"]));
    expect(old.turns).toBeUndefined();
    expect(old.unavailable).toMatchObject(TURNS_OLD_RUNTIME);
    // A driver reads what a turn changed, and is offered neither Reset nor Fork nor its review.
    const driver = backend(client(["session/1", "checkpoints/1"], "participate"));
    expect(driver.turns).toBeUndefined();
    expect(driver.unavailable).toMatchObject(TURNS_NEED_ADMIN);
    expect(driver.checkpoints?.readOnly).toBe(true);
    for (const key of ["fork", "reset"] as const) for (const off of [TURNS_OFFLINE, TURNS_OLD_RUNTIME, TURNS_NEED_ADMIN]) expect(off[key]).toMatch(/\w/);
  });

  it("a viewer's turn card reads the runtime's checkpoint and is refused its review", async () => {
    const made = client(["session/1", "checkpoints/1"], "participate");
    const checkpoints = backend(made).checkpoints!;
    await expect(checkpoints.get("s-cloud", "t-cloud", 7)).resolves.toMatchObject({ number: 2 });
    await expect(checkpoints.undo("s-cloud", "t-cloud", 7, null)).rejects.toThrow(REVIEW_NEEDS_ADMIN);
    expect(made.calls.map(([name]) => name)).toEqual(["turnCheckpoint"]);
  });

  it("an admin resets, reviews and forks on the runtime, and is shown the fork", async () => {
    const made = client(["session/1", "checkpoints/1", "handoff/1"]);
    const remote = backend(made);
    expect(remote.unavailable).toBe(REMOTE_UNAVAILABLE);
    const turns = remote.turns!;
    expect(remote.checkpoints).toBe(turns.checkpoints);
    expect(turns.checkpoints.readOnly).toBe(false);
    await turns.checkpoints.undo("s-cloud", "t-cloud", 7, "token-1");
    await turns.checkpoints.keep("s-cloud", "t-cloud", 9);
    await expect(turns.reset("t-cloud", 4, true, "reset:token")).resolves.toBeNull();
    expect(made.calls.slice(0, 3)).toEqual([
      ["undoTurn", { args: ["s-cloud", "t-cloud", 7, "token-1"] }],
      ["keepTurn", { args: ["s-cloud", "t-cloud", 9] }],
      ["reset", { sessionId: "s-cloud", tabId: "t-cloud", endSeq: 4, resetFiles: true, confirm: "reset:token" }],
    ]);
    // Into a tab of this session: it is the one shown.
    await expect(turns.fork("t-cloud", 4, "tab")).resolves.toEqual({ key: "cloud:org-1:ws-1:s-cloud", tabId: "t-fork", note: null });
    expect(getTerminalState().selected["cloud:org-1:ws-1:s-cloud"]).toEqual({ kind: "agent", id: "t-fork" });
    // Into a session of its own, on the same workspace: that session is opened, on its tab.
    const forked = await turns.fork("t-cloud", 4, "session");
    expect(forked).toEqual({ key: "cloud:org-1:ws-1:s-new", tabId: "t-new", note: expect.stringContaining("shares this checkout") });
    expect(getSessionStore().selectedSessionId).toBe("cloud:org-1:ws-1:s-new");
    expect(getTerminalState().selected["cloud:org-1:ws-1:s-new"]).toEqual({ kind: "agent", id: "t-new" });
    expect(made.calls.slice(3)).toEqual([
      ["fork", { sessionId: "s-cloud", tabId: "t-cloud", endSeq: 4, into: "tab" }],
      ["fork", { sessionId: "s-cloud", tabId: "t-cloud", endSeq: 4, into: "session" }],
    ]);
  });
});

describe("a second opinion, Retry in a new chat and the agent handoff on a remote session (#1327)", () => {
  type Call = [string, unknown[]];
  const client = (capabilities: string[]) => {
    const calls: Call[] = [];
    const connection = { state: "connected", runtimeGeneration: 1, runtimeVersion: "1", capabilities, authority: "manage" } as const;
    const fake = {
      connection,
      hasCapability: (capability: string) => capabilities.includes(capability),
      handoffAgentTab: async (...args: unknown[]) => (calls.push(["handoff", args]), {
        sessionId: "s-cloud", tabId: "t-review", startError: null,
        tab: { sessionId: "s-cloud", tabId: "t-review", title: null, harness: "codex", model: "gpt-5.5", effort: null, permissionMode: "plan", status: "in_progress", process: "running", pendingPermissions: [], followUps: [], lastSeq: 1, created: "", modified: "" },
      }),
      handoffContext: async (...args: unknown[]) => (calls.push(["context", args]), { sessionId: "s-cloud", tabId: "t-cloud", transcriptPath: "/home/vm/.claude/projects/w/c.jsonl" }),
    };
    return { calls, connection, client: fake as never };
  };
  const backend = (made: ReturnType<typeof client> | null, authority = "manage") =>
    cloudSessionBackend({
      key: "cloud:org-1:ws-1:s-cloud",
      workspaceKey: "cloud:org-1:ws-1",
      scope: { organizationId: "org-1", workspaceId: "ws-1" },
      sessionId: "s-cloud",
      state: made ? (made.connection as never) : { state: "idle" },
      client: made?.client ?? null,
      workspaceState: made ? "ready" : "suspended",
      authority,
      outbox: [],
      followUps: () => [],
      wake: vi.fn(async () => undefined),
    });

  it("are off with why: not connected, a runtime from before handoff/1, or someone who is not an admin", () => {
    expect(backend(null).handoff).toBeUndefined();
    expect(backend(null).unavailable).toMatchObject(HANDOFF_OFFLINE);
    const old = backend(client(["session/1", "checkpoints/1"]));
    expect(old.handoff).toBeUndefined();
    expect(old.unavailable).toMatchObject({ ...HANDOFF_OLD_RUNTIME });
    // Fork and Reset are offered on that runtime: each option says its own reason.
    expect(old.unavailable?.fork).toBeUndefined();
    const driver = backend(client(["session/1", "checkpoints/1", "handoff/1"]), "participate");
    expect(driver.handoff).toBeUndefined();
    expect(driver.unavailable).toMatchObject({ ...TURNS_NEED_ADMIN, ...HANDOFF_NEED_ADMIN });
    // The same reasons are the same object each time the backend is made.
    expect(backend(client(["session/1", "checkpoints/1"])).unavailable).toBe(old.unavailable);
    for (const off of [HANDOFF_OFFLINE, HANDOFF_OLD_RUNTIME, HANDOFF_NEED_ADMIN]) {
      for (const key of ["secondOpinion", "retryInNewChat", "agentHandoff"] as const) expect(off[key]).toMatch(/\w/);
    }
    expect(localSessionBackend("s1").handoff).toBeUndefined();
  });

  it("an admin's handoff is one runtime call that opens the tab with its first prompt, and shows it", async () => {
    const made = client(["session/1", "handoff/1"]);
    const remote = backend(made);
    expect(remote.unavailable).not.toHaveProperty("secondOpinion");
    await expect(remote.handoff!.open({ agent: "codex", model: "gpt-5.5", mode: "plan", prompt: "Give a second opinion", requestId: "handoff-1" })).resolves.toEqual({ tabId: "t-review", startError: null });
    // The dialog's one request id, so a try after a lost reply is answered with the same tab.
    expect(made.calls).toEqual([["handoff", ["s-cloud", { agent: "codex", model: "gpt-5.5", mode: "plan", nativeCodex: undefined, prompt: "Give a second opinion" }, "handoff-1"]]]);
    expect(getTerminalState().selected["cloud:org-1:ws-1:s-cloud"]).toEqual({ kind: "agent", id: "t-review" });
    await expect(remote.handoff!.context("t-cloud")).resolves.toMatchObject({ transcriptPath: "/home/vm/.claude/projects/w/c.jsonl" });
    expect(made.calls.at(-1)).toEqual(["context", ["s-cloud", "t-cloud"]]);
  });
});

describe("a local session's Reset (PRO-378)", () => {
  it("resets on this computer's runtime, then reads the tab's history and the session list again", async () => {
    invoke.mockImplementation(async (command: string) => (command === "list_sessions" || command === "load_tab_events" ? [] : null));
    await expect(localSessionBackend("s1").turns!.reset("t1", 9, true, "reset:token")).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledWith("reset_chat", { sessionId: "s1", tabId: "t1", endSeq: 9, resetFiles: true, confirm: "reset:token" });
    expect(commands()[0]).toBe("reset_chat");
    expect(commands()).toContain("list_sessions");
  });

  it("a reset that went through is not repeated when reading it back fails: it says so instead", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "reset_chat") return null;
      throw new Error("disconnected");
    });
    await expect(localSessionBackend("s1").turns!.reset("t1", null, false, null)).resolves.toMatch(/Chat reset/);
    expect(commands().filter((command) => command === "reset_chat")).toHaveLength(1);
  });

  it("passes on the runtime's warning about what went wrong after the reset", async () => {
    invoke.mockImplementation(async (command: string) => (command === "reset_chat" ? "Chat reset, but the agent could not restart." : null));
    await expect(localSessionBackend("s1").turns!.reset("t1", 9, false, null)).resolves.toBe("Chat reset, but the agent could not restart.");
  });
});
