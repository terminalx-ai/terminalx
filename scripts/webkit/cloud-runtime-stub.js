// A cloud workspace runtime for WebKit layout checks, loaded after
// `tauri-stub.js` when the fixture has `session`: one shared workspace with one
// session, a long transcript, and a runtime that answers the workspace RPC the
// way `SessionView.cloud.test.tsx`'s FakeRuntime does. `window.__PW_RUNTIME__`
// drives it from the test: another person's turn, a permission request, a
// terminal someone else opened.
(() => {
  const stub = window.__PW_STUB__;
  const f = stub.fixture.session;
  if (!f) return;
  const ORG = "org-a";
  const WS = "w1";
  const SESSION = "s1";
  const TAB = "t1";
  const CONNECTION = "conn-1";
  const now = Date.now();
  const at = new Date(now).toISOString();
  const role = f.role ?? "manager";
  const you = { userId: "u-you", role, canApprove: role === "manager" || !!f.canApprove };
  const authority = role === "manager" ? "manage" : "participate";
  const title = f.title ?? "echo:hello from Alice";

  const workspace = {
    workspace: { id: WS, orgId: ORG, name: "share-demo", provider: "local-docker", state: "ready", accessMode: "organization", createdAt: 1, updatedAt: now, releaseDisposition: null, repositories: [], authority, you: { role, canApprove: you.canApprove }, sharedWith: 1 },
    latestOperation: null,
  };
  const tab = { id: TAB, harness: "claude", title: "Echo:hello from Alice", model: "", permissionMode: "default", status: "idle", created: at, modified: at };
  const session = { id: SESSION, projectPath: "/w", cwd: "/w", title, branch: f.branch ?? null, created: at, modified: at, archived: false, pinned: !!f.pinned, tabs: [tab], activeTab: TAB };
  const capabilities = ["pty/1", ...(f.sessionTerminals === false ? [] : ["pty/2"]), "fs/1", "git/1", "session/1", "session/2", "keys/1", "agents/1", "collab/1"];
  const catalog = { version: 1, createMemory: {}, orgs: { [ORG]: { workspaces: [workspace], repositories: [], quota: { used: 1, limit: 3 }, fetchedAt: now, sessions: { [WS]: { sessions: [session], capabilities, at: now } } } } };
  const org = { id: ORG, name: "Local E2E", role: role === "manager" ? "owner" : "member", isPersonal: false, cloud: { enabled: true, flags: {} } };

  let seq = 0;
  const events = [];
  const event = (payload) => ({ id: `e${++seq}`, seq, sessionId: SESSION, tabId: TAB, harness: "claude", ts: new Date(now + seq).toISOString(), payload });
  const turn = (prompt, lines) => {
    events.push(event({ type: "user_message", text: prompt, queued: false }), event({ type: "turn_started" }));
    for (const line of lines) events.push(event({ type: "assistant_text", text: line }));
    events.push(event({ type: "turn_completed", status: "ok", authFailed: false, durationMs: 1000 }));
  };
  const lines = f.lines ?? 25;
  turn("echo:hello from Alice", ["hello from Alice"]);
  turn(`slow:${lines}:1500`, Array.from({ length: lines }, (_, i) => `chunk ${i + 1} of ${lines}`));

  let status = "idle";
  // `model` and `permissionMode`: what the composer's pickers read (their labels decide how wide its toolbar wants to be).
  const tabInfo = () => ({ sessionId: SESSION, tabId: TAB, title: tab.title, harness: "claude", model: f.model ?? "", effort: null, permissionMode: f.permissionMode ?? "default", status, process: "running", pendingPermissions: [], followUps: [], lastSeq: seq, created: at, modified: at });
  const terminals = [];
  const terminal = (sessionId) => ({ ptyId: `p${terminals.length + 1}`, number: terminals.length + 1, epoch: "e1", pid: 100 + terminals.length, cwd: "/w", cols: 80, rows: 24, createdAt: now, offset: 0, exited: false, exitCode: null, control: "none", controllerId: null, ...(sessionId ? { sessionId } : {}) });
  const notes = [];
  const subscriptions = new Map();
  let subscription = 0;
  let connected = false;

  const deliver = (message) => setTimeout(() => connected && stub.emit("cloud_remote_event", { kind: "message", connectionId: CONNECTION, message }), 0);
  const notify = (name, params) => deliver({ event: name, params });
  const toSessionSubscribers = (name, params) => {
    for (const [id, kind] of subscriptions) if (kind === "session") notify(name, { subscriptionId: id, ...params });
  };
  const setStatus = (next) => {
    status = next;
    toSessionSubscribers("session.status", { sessionId: SESSION, tabId: TAB, status });
    notify("session.tabs", { tabs: [tabInfo()] });
  };
  const push = (payload) => {
    const next = event(payload);
    events.push(next);
    toSessionSubscribers("session.event", { cursor: `1:${next.seq}`, event: next });
  };

  const answer = (frame) => {
    const params = frame.params ?? {};
    const ok = (result) => ({ id: frame.id, ok: true, result });
    switch (frame.method) {
      case "session.tabs":
        return ok({ tabs: [tabInfo()] });
      case "session.list":
        return ok({ sessions: [session] });
      case "session.subscribe": {
        const id = `sub-${++subscription}`;
        subscriptions.set(id, "session");
        return ok({ subscriptionId: id, events: events.map((entry) => ({ cursor: `1:${entry.seq}`, event: entry })), cursor: `1:${seq}` });
      }
      case "session.unsubscribe":
      case "pty.detach":
      case "fs.unwatch":
        subscriptions.delete(params.subscriptionId);
        return ok({});
      case "session.nudge":
      case "session.markRead":
      case "presence.update":
      case "lease.release":
        return ok({});
      case "collab.state":
        return ok({ you: { ...you, listed: true }, participants: [{ ...you, surfaces: 1, tabId: TAB, activity: "viewing", since: now }], leases: [] });
      case "notes.list":
        return ok({ notes: notes.filter((note) => note.tabId === params.tabId), more: false });
      case "notes.post": {
        const note = { id: `n${notes.length + 1}`, tabId: params.tabId, authorId: you.userId, text: params.text, createdAt: Date.now() };
        notes.push(note);
        return ok({ note });
      }
      case "lease.acquire":
      case "lease.takeOver":
        return ok({ lease: { tabId: params.tabId, holderId: you.userId, acquiredAt: Date.now(), expiresAt: Date.now() + 120_000 } });
      case "runtime.agents":
        return ok({ agents: [{ id: "claude", name: "Claude Code", caps: {}, models: [], modes: [], defaultMode: "default" }] });
      case "pty.list":
        return ok({ epoch: "e1", terminals });
      case "pty.create": {
        const created = { ...terminal(params.sessionId), control: "you", controllerId: you.userId };
        terminals.push(created);
        return ok(created);
      }
      case "pty.attach": {
        const id = `sub-${++subscription}`;
        subscriptions.set(id, "pty");
        const found = terminals.find((entry) => entry.ptyId === params.ptyId);
        return found ? ok({ subscriptionId: id, ...found, data: "", truncated: false }) : { id: frame.id, ok: false, error: { code: "not_found", message: "no such terminal" } };
      }
      case "git.repositories":
        return ok({ repositories: [] });
      case "fs.list":
        return ok({ path: "", entries: [] });
      case "fs.watch": {
        const id = `sub-${++subscription}`;
        subscriptions.set(id, "fs");
        return ok({ subscriptionId: id });
      }
      default:
        return { id: frame.id, ok: false, error: { code: "method_not_found", message: frame.method } };
    }
  };

  Object.assign(stub.answers, {
    account_status: { state: "signed-in", identity: { name: "You", email: "you@example.com", organization: org.name, organizationId: ORG }, expiresAt: null, lastError: null, context: { scope: "s", revision: "s:1" }, organizations: [org] },
    cloud_catalog_load: catalog,
    cloud_workspaces: { workspaces: [workspace], quota: { used: 1, limit: 3 } },
    cloud_workspace_shares: { shares: [], you: { role, canApprove: you.canApprove } },
    cloud_agent_cache_save: null,
    cloud_agent_outbox_sync: [],
    cloud_agent_checkpoint: null,
    git_identity: { name: "You", email: "you@example.com" },
    cloud_remote_attach: () => {
      setTimeout(() => {
        connected = true;
        stub.emit("cloud_remote_event", { kind: "state", connectionId: CONNECTION, state: { state: "connected", runtimeGeneration: 1, runtimeEpoch: "e1", runtimeVersion: "0.3.0", capabilities, authority, you: { ...you, listed: true } } });
      }, 0);
      return CONNECTION;
    },
    cloud_remote_send: ({ frame }) => {
      deliver(answer(frame));
      return true;
    },
    cloud_remote_activate: null,
    cloud_remote_detach: null,
  });

  window.__PW_RUNTIME__ = {
    sessionTitle: title,
    /** Another person starts a turn. */
    prompt(text) {
      push({ type: "user_message", text, queued: false });
      push({ type: "turn_started" });
      setStatus("in_progress");
    },
    /** The running turn says one more line. */
    chunk(text) {
      push({ type: "assistant_text", text });
    },
    /** The running turn asks for permission. */
    ask() {
      push({ type: "permission_requested", requestId: `req-${seq}`, toolUseId: `tool-${seq}`, toolName: "Bash", input: { command: "touch /tmp/asked" }, options: [{ id: "allow", label: "Allow", kind: "allow_once" }, { id: "deny", label: "Deny", kind: "deny" }] });
      setStatus("waiting");
    },
    /** Someone else opens a terminal: in this session (`pty/2`), or one that belongs to no session. */
    openTerminal(inSession = true) {
      const created = { ...terminal(inSession ? SESSION : null), control: "other", controllerId: "u-other" };
      terminals.push(created);
      return created.ptyId;
    },
  };
})();
