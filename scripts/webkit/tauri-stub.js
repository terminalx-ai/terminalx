// A Tauri bridge stub for WebKit layout checks: fixture answers for the sidebar;
// every other command stays pending. `window.__PW_FIXTURE__` picks the fixture.
window.__PW_FIXTURE__ = window.__PW_FIXTURE__ || { cloud: true, localProjects: 3 };
(() => {
  const f = window.__PW_FIXTURE__;
  const ORG = "org-a";
  const now = Date.now();
  const projects = Array.from({ length: f.localProjects }, (_, i) => ({ path: `/repos/p${i}`, name: `local-${i}` }));
  const orgs = f.cloud ? [{ id: ORG, name: f.orgName ?? "Demo", role: "admin", isPersonal: false, cloud: { enabled: true, flags: {} } },
    ...Array.from({ length: 10 }, (_, i) => ({ id: `o${i}`, name: `Other ${i}`, role: "member", isPersonal: false, cloud: { enabled: true, flags: {} } }))] : [];
  const status = { state: "signed-in", identity: { name: f.accountName ?? "A", email: "a@b.c", organization: "Demo", organizationId: ORG }, expiresAt: null, lastError: null, context: { scope: "s", revision: "s:1" }, organizations: orgs };
  const ws = (id, name) => ({ workspace: { id, orgId: ORG, name, provider: "box", state: "ready", accessMode: "private", createdAt: 1, updatedAt: now, releaseDisposition: null, repositories: [] }, latestOperation: null });
  const session = (id, title) => ({ id, projectPath: "/w", cwd: "/w", title, created: "2026-09-30T10:00:00Z", modified: "2026-09-30T11:00:00Z", archived: false, pinned: false, tabs: [{ id: id + "t", harness: "claude", model: "", permissionMode: "x", status: "idle", created: "", modified: "" }] });
  const catalog = { version: 1, createMemory: {}, orgs: { [ORG]: { workspaces: [ws("w1", "parity-test"), ws("w2", "demo workspace")], repositories: [], quota: { used: 2, limit: 3 }, fetchedAt: now,
    sessions: { w1: { sessions: Array.from({ length: 12 }, (_, i) => session(`s${i}`, i === 11 ? "Last session" : `Session ${i}`)), capabilities: ["session/2"], at: now }, w2: { sessions: [session("s3", "Demo session")], capabilities: null, at: now } } } } };
  const answers = {
    list_projects: { projects, lastSelected: projects[0]?.path ?? null },
    list_sessions: [],
    list_harnesses: [{ id: "claude", name: "Claude", available: true }],
    list_workspaces: [],
    account_status: f.cloud ? status : { state: "signed-out", identity: null, expiresAt: null, lastError: null },
    cloud_catalog_load: catalog,
    // `running` as a server since PRO-76 reports it: the header's chip counts running workspaces only.
    cloud_workspaces: { workspaces: catalog.orgs[ORG].workspaces, quota: { used: 2, limit: 3, running: { used: 2, limit: 3 }, total: { used: 2, limit: 20 } } },
    cloud_workspace_repositories: { configured: true, repositories: [] },
    cloud_agent_cache_load: { tabs: {} },
    cloud_agent_outbox: [],
    cloud_agent_checkpoints: [],
    // Settings → Account → Agent logins (PRO-79): one connected, one revoked, one missing.
    cloud_agent_logins: { credentials: [
      { provider: "claude", authKind: "oauth-credentials-json", fingerprint: "sha256:ab", displayIdentity: "ada.lovelace@example.com", version: 2, updatedAt: now, state: "connected", sharedUse: "organization" },
      { provider: "codex", authKind: "api-key", fingerprint: "sha256:cd", version: 1, updatedAt: now, state: "revoked", sharedUse: "organization" },
    ] },
    list_automations: [],
    automations_list: [],
    automation_issue_states: [],
    list_models: [],
    mobile_terminal_drivers: [],
    transcription_models: [],
    // Dictation is there, with the saved input left at the system default: the composer shows the mic and its input picker.
    dictation_available: true,
    transcription_preferences: { model: "", inputDevice: null, muteWhileRecording: false },
    status_bar_settings: { visible: false },
  };
  // `archived`: an archive that failed with a long reason, an archive whose
  // final save timed out, and a workspace deleted elsewhere (its notice).
  if (f.archived) {
    const day = 86_400_000;
    const archived = (id, name, state, operation) => ({ workspace: { ...ws(id, name).workspace, state, archivedAt: now - day, deleteAfter: now + 12.5 * day }, latestOperation: { id: `op-${id}`, workspaceId: id, type: "archive", action: "archive", stage: "done", cancelable: false, createdAt: now, updatedAt: now, ...operation } });
    const rows = [
      ...catalog.orgs[ORG].workspaces,
      archived("a1", "quarterly-report-migration-archive", "attention-required", { state: "failed", errorCode: "cloud_provider_unavailable" }),
      archived("a2", "old-experiment", "archived", { state: "succeeded", checkpoint: "timed-out" }),
    ];
    catalog.orgs[ORG].workspaces = [...rows, ws("gone", "deleted-on-another-mac")];
    answers.cloud_workspaces = { workspaces: rows, tombstones: [{ id: "gone", orgId: ORG, deletedAt: now, expiresAt: now + 30 * day }], quota: { used: 2, limit: 3 } };
    answers.cloud_agent_purge_workspace = { removed: true, unsentCommands: 2, cachedTabs: 1 };
    answers.cloud_providers = { providers: [] };
  }
  // `localSession`: one local session with a long transcript and a pending
  // permission request, as a PTY-first agent tab (claude) and as one that is not.
  if (f.localSession) {
    const at = new Date(now).toISOString();
    const SESSION = "local-s1";
    const tab = (id, harness) => ({ id, harness, title: `${harness} tab`, model: "", permissionMode: "default", status: "waiting", created: at, modified: at });
    let seq = 0;
    const events = (tabId, harness) => {
      const event = (payload) => ({ id: `${tabId}-e${++seq}`, seq, sessionId: SESSION, tabId, harness, ts: at, payload });
      return [
        event({ type: "user_message", text: "slow:30:1500", queued: false }),
        event({ type: "turn_started" }),
        ...Array.from({ length: f.chatLinks ? 1 : 30 }, (_, i) => event({ type: "assistant_text", text: f.chatLinks ? "Visit [website](https://example.test/docs) or <https://example.test/auto>." : `chunk ${i + 1} of 30` })),
        event({ type: "permission_requested", requestId: `req-${tabId}`, toolUseId: `tool-${tabId}`, toolName: "Bash", input: { command: "touch /tmp/asked" }, options: [{ id: "allow", label: "Allow", kind: "allow_once" }, { id: "deny", label: "Deny", kind: "deny" }] }),
      ];
    };
    answers.list_sessions = [{ id: SESSION, projectPath: projects[0].path, cwd: projects[0].path, worktreeRemoved: false, title: "Local long session", created: at, modified: at, archived: false, pinned: false, tabs: [tab("lt-pty", "claude"), tab("lt-chat", "gemini")], activeTab: "lt-pty" }];
    answers.list_workspaces = [{ path: projects[0].path, name: "main", branch: "main", head: "abc", isMain: true, managed: false, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 }];
    answers.load_tab_events = ({ tabId }) => events(tabId, tabId === "lt-pty" ? "claude" : "gemini");
  }
  if (f.chatLinks) {
    const opened = window.__PW_LINK_OPENS__ = { system: [], terminalx: [] };
    const pages = [];
    answers.browser_pages = () => pages;
    answers["plugin:opener|open_url"] = ({ url }) => { opened.system.push(url); };
    answers.browser_open_tab = ({ workspace, url }) => {
      opened.terminalx.push({ workspace, url });
      const page = { id: `page-${pages.length}`, browserPageId: `page-${pages.length}`, profileId: "default", tabId: "browser-tab", url, title: "Website", workspacePath: workspace, created: new Date().toISOString(), active: true, index: pages.length };
      pages.push(page);
      window.__PW_STUB__.emit("browser_pages_changed", { pages });
      return page;
    };
  }
  // Fixture scripts loaded after this one add answers (a value, or a function
  // of the command's arguments) and emit native events through `__PW_STUB__`.
  let id = 1;
  const callbacks = new Map();
  const listening = new Map();
  window.__PW_STUB__ = {
    answers,
    fixture: f,
    emit(event, payload) {
      for (const { eventId, handler } of listening.get(event) ?? []) callbacks.get(handler)?.({ event, id: eventId, payload });
    },
  };
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      if (cmd === "plugin:event|listen") {
        const eventId = id++;
        listening.set(args.event, [...(listening.get(args.event) ?? []), { eventId, handler: args.handler }]);
        return eventId;
      }
      if (cmd === "plugin:event|unlisten") {
        listening.set(args.event, (listening.get(args.event) ?? []).filter((entry) => entry.eventId !== args.eventId));
        return null;
      }
      if (cmd in answers) return typeof answers[cmd] === "function" ? answers[cmd](args ?? {}) : answers[cmd];
      if (cmd.startsWith("plugin:")) return id++;
      return new Promise(() => undefined);
    },
    transformCallback: (callback) => {
      const handle = id++;
      callbacks.set(handle, callback);
      return handle;
    },
    unregisterCallback: (handle) => void callbacks.delete(handle),
    convertFileSrc: (p) => p,
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
})();
