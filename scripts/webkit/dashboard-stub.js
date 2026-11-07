// Synthetic sessions only. Loaded after tauri-stub.js by the dashboard layout
// check; the real stores, dashboard, cards, menus and styles still run.
(() => {
  const { answers, fixture } = window.__PW_STUB__;
  const count = fixture.dashboardCount;
  const now = Date.now();
  const states = { needs: "waiting", working: "in_progress", done: "completed", "not-started": "idle" };
  const projects = answers.list_projects.projects;
  const session = (kind, column, index) => {
    const id = `${kind}-${column}-${index}`;
    const at = new Date(now - (index + 1) * 60_000).toISOString();
    const projectPath = projects[index % projects.length].path;
    return {
      id, projectPath, cwd: projectPath, worktreeName: "synthetic-layout-check-branch",
      title: `${kind} ${column} session ${String(index + 1).padStart(2, "0")}`,
      created: at, modified: at, archived: false, pinned: false, worktreeRemoved: false,
      lastMessageAt: column === "not-started" ? null : at,
      issue: { provider: "github", id, identifier: "#200", title: "Synthetic layout issue", url: "https://example.com/issues/200" },
      tabs: ["claude", "codex"].map((harness) => ({ id: `${id}-${harness}`, harness, model: "", permissionMode: "default", status: states[column], created: at, modified: at })),
      activeTab: `${id}-claude`,
    };
  };
  const locals = Object.keys(states).flatMap((column) => Array.from({ length: count }, (_, i) => session("Local", column, i)));
  answers.list_sessions = locals;
  answers.session_summaries = locals.map((s) => ({ sessionId: s.id, tabId: s.activeTab, lastPrompt: s.lastMessageAt ? "Check the synthetic layout" : null, lastReply: s.lastMessageAt ? "Layout review is complete" : null, waitingOn: "Approve the synthetic check", updatedAt: s.modified }));
  answers.list_harnesses.push({ id: "codex", name: "Codex", available: true });
  answers.account_status.organizations = answers.account_status.organizations.slice(0, 1);
  const workspaces = Object.keys(states).map((column) => ({
    workspace: {
      id: column, orgId: "org-a", name: `Synthetic ${column}`, provider: "box", state: "ready", accessMode: "private",
      createdAt: now, updatedAt: now, releaseDisposition: null, repositories: [],
      runtimeActivity: { online: true, reportedAt: now, pendingApprovals: column === "needs" ? count : 0, activeTurns: column === "working" ? count : 0 },
    },
    latestOperation: null,
  }));
  const sessions = Object.fromEntries(Object.keys(states).map((column) => [column, {
    sessions: Array.from({ length: count }, (_, i) => session("Cloud", column, i)), capabilities: ["session/2"], at: now,
  }]));
  const quota = { used: 4, limit: 10 };
  answers.cloud_catalog_load = { version: 1, createMemory: {}, orgs: { "org-a": { workspaces, sessions, repositories: [], quota, fetchedAt: now } } };
  answers.cloud_workspaces = { workspaces, quota };
  answers.pr_associations_batch = ({ sessionKeys }) => Object.fromEntries(sessionKeys.map((id) => [id, []]));
  window.__PW_DASHBOARD_ACTIONS__ = [];
  answers.stop_tab = (args) => { window.__PW_DASHBOARD_ACTIONS__.push(args); };
})();
