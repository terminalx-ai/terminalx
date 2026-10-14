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
    issue_pipelines_list: [],
    automation_issue_states: [],
    list_models: [],
    mobile_terminal_drivers: [],
    transcription_models: [],
    // Dictation is there, with the saved input left at the system default: the composer shows the mic and its input picker.
    dictation_available: true,
    transcription_preferences: { model: "", inputDevice: null, muteWhileRecording: false },
    status_bar_settings: { visible: false },
    // How the workspaces' tabs are arranged: nothing saved, and what a page saves is kept and announced as the backend does.
    tab_state: { workspaces: {}, closed: [] },
    set_tab_layout: ({ workspace, layout }) => {
      answers.tab_state = { ...answers.tab_state, workspaces: { ...answers.tab_state.workspaces, [workspace]: layout } };
      setTimeout(() => window.__PW_STUB__.emit("tab_state_changed", answers.tab_state), 0);
      return null;
    },
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
  // `floating`: this page is the floating chat window, on screen. With
  // `localSession` it was asked to show that session's chat tab; without, it
  // opens on its start screen.
  if (f.floating) {
    answers.floating_status = { shortcut: null, alwaysOnTop: false, retentionDays: 0, shortcutError: null };
    answers.floating_visible = true;
    answers.floating_take_pending = f.localSession ? { sessionId: "local-s1", tabId: "lt-chat" } : null;
  }
  // `mergedCleanup`: the removal that follows a merged pull request (#432) is
  // on. The first project has worktrees whose pull requests merged: one that
  // is about to go, ones that are kept (with a short and a long reason, and by
  // the reader), and one a pass has just removed. Settings lists removals.
  if (f.mergedCleanup) {
    const root = projects[0].path;
    const long = "432-setting-delete-the-workspace-and-its-branches-automatically-once-the-pull-request-is-merged";
    const tree = (name, patch = {}) => ({ path: `${root}/.raccoon/worktrees/${name}`, name, branch: `raccoon/${name}`, head: "abc", isMain: false, managed: true, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0, state: "merged", ...patch });
    const pr = (number) => ({ number, title: "Fix the login redirect", url: `https://github.com/acme/app/pull/${number}`, head: "a".repeat(40) });
    const status = (name, patch) => ({ projectPath: root, path: tree(name).path, name, branch: `raccoon/${name}`, pr: pr(62), phase: "kept", reason: null, detail: null, due: null, fresh: false, sessions: [], record: null, ...patch });
    const record = (id, name, minutes, patch = {}) => ({ id, removedAt: new Date(now - minutes * 60_000).toISOString(), projectPath: root, path: tree(name).path, name, branch: `raccoon/${name}`, commit: "abcdef0123456789abcdef0123456789abcdef01", pr: pr(60), localBranch: { outcome: "deleted" }, remoteBranch: { outcome: "deleted" }, sessionsKept: [], sessionsDeleted: [], blocked: null, ...patch });
    const state = window.__PW_MERGED__ = { settings: { enabled: true, projects: { [projects[1]?.path ?? "/none"]: false }, deleteConversations: false, graceMinutes: 10 }, held: [], restored: [], headBranch: 0 };
    answers.list_workspaces = ({ projectPath }) =>
      projectPath === root
        ? [{ ...tree("main"), path: root, name: "main", branch: "main", isMain: true, managed: false, state: "clean" }, tree("quiet-amber-fox"), tree("wip-red-bee", { state: "uncommitted", uncommitted: 2, additions: 12, deletions: 3 }), tree(long), tree("kept-grey-cat")]
        : [];
    answers.merged_cleanup_settings = () => state.settings;
    answers.set_merged_cleanup_settings = ({ patch }) => {
      const { project, ...rest } = patch;
      const own = { ...state.settings.projects };
      if (project) project.enabled === null ? delete own[project.key] : (own[project.key] = project.enabled);
      return (state.settings = { ...state.settings, ...rest, projects: own });
    };
    answers.merged_cleanup_sweep = () => ({ unreadable: projects[2] ? [{ projectPath: projects[2].path, reason: "GitHub CLI (gh) is not installed or not on PATH." }] : [], statuses: [
      status("quiet-amber-fox", state.held.includes(tree("quiet-amber-fox").path) ? { phase: "held" } : { phase: "scheduled", fresh: true, due: new Date(Date.now() + 8 * 60_000).toISOString() }),
      status("wip-red-bee", { reason: "2 uncommitted files", detail: "It has 1 modified file, 1 untracked file." }),
      status(long, { reason: "an agent is running in \"Deploy the staging environment and verify that the rollout finished everywhere\"" }),
      status("kept-grey-cat", { phase: "held" }),
      ...(state.restored.length ? [] : [status("gone-blue-jay", { phase: "removed", record: record("removal-0", "gone-blue-jay", 0, { remoteBranch: { outcome: "moved", at: "b".repeat(40) } }) })]),
    ] });
    answers.merged_cleanup_hold = ({ path, held }) => { held ? state.held.push(path) : (state.held = state.held.filter((kept) => kept !== path)); return null; };
    answers.merged_cleanup_records = () => [
      record("removal-0", "gone-blue-jay", 0, { remoteBranch: { outcome: "moved", at: "b".repeat(40) }, restoredAt: state.restored.includes("removal-0") ? new Date().toISOString() : null }),
      record("removal-1", long, 45, { remoteBranch: { outcome: "kept", reason: "it could not be deleted: fatal: unable to access 'https://github.com/a-rather-long-organization-name/a-project-with-a-very-long-descriptive-name.git/': The requested URL returned error: 403" } }),
      record("removal-2", "old-green-eel", 60 * 26, { blocked: "The branch raccoon/old-green-eel exists again, at another commit." }),
      record("removal-3", "back-pink-emu", 60 * 50, { restoredAt: new Date(now - 60 * 49 * 60_000).toISOString(), blocked: "It was brought back already." }),
    ];
    answers.merged_cleanup_restore = ({ id }) => { state.restored.push(id); return { record: record(id, "gone-blue-jay", 0), notes: ["The session \"Fix the login redirect\" has been used since and stays under the project."] }; };
    answers.github_head_branch_setting = ({ projectPath }) => ({ repository: projectPath === root ? "a-rather-long-organization-name/a-project-with-a-very-long-descriptive-name" : "acme/site", enabled: projectPath !== root || state.headBranch > 0, admin: true });
    answers.github_enable_head_branch_deletion = () => { state.headBranch++; return { repository: "a-rather-long-organization-name/a-project-with-a-very-long-descriptive-name", enabled: true, admin: true }; };
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
    metadata: { currentWindow: { label: f.floating ? "floating" : "main" }, currentWebview: { label: f.floating ? "floating" : "main", windowLabel: f.floating ? "floating" : "main" } },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
})();
