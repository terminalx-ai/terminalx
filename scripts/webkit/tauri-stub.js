// A Tauri bridge stub for WebKit layout checks: fixture answers for the sidebar;
// every other command stays pending. `window.__PW_FIXTURE__` picks the fixture.
// A Tauri bridge stub: fixture data for the sidebar, nothing else.
window.__PW_FIXTURE__ = window.__PW_FIXTURE__ || { cloud: true, localProjects: 3 };
(() => {
  const f = window.__PW_FIXTURE__;
  const ORG = "org-a";
  const now = Date.now();
  const projects = Array.from({ length: f.localProjects }, (_, i) => ({ path: `/repos/p${i}`, name: `local-${i}` }));
  const orgs = f.cloud ? [{ id: ORG, name: "Demo", role: "admin", isPersonal: false, cloud: { enabled: true, flags: {} } },
    ...Array.from({ length: 10 }, (_, i) => ({ id: `o${i}`, name: `Other ${i}`, role: "member", isPersonal: false, cloud: { enabled: true, flags: {} } }))] : [];
  const status = { state: "signed-in", identity: { name: "A", email: "a@b.c", organization: "Demo", organizationId: ORG }, expiresAt: null, lastError: null, context: { scope: "s", revision: "s:1" }, organizations: orgs };
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
    cloud_workspaces: { workspaces: catalog.orgs[ORG].workspaces, quota: { used: 2, limit: 3 } },
    cloud_workspace_repositories: { configured: true, repositories: [] },
    cloud_agent_cache_load: { tabs: {} },
    cloud_agent_outbox: [],
    cloud_agent_checkpoints: [],
    list_automations: [],
    automations_list: [],
    automation_issue_states: [],
    list_models: [],
    mobile_terminal_drivers: [],
    transcription_models: [],
    status_bar_settings: { visible: false },
  };
  let id = 1;
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd) => { if (cmd in answers) return answers[cmd]; if (cmd.startsWith("plugin:")) return id++; return new Promise(() => undefined); },
    transformCallback: () => id++,
    unregisterCallback: () => undefined,
    convertFileSrc: (p) => p,
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
})();
