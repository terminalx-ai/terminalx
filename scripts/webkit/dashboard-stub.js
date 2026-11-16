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

// PRO-133/137: opt-in native transport fixture, not a production feature gate.
// The built app's real stores/controllers/components consume these exact DTOs.
(() => {
  const { answers, fixture, emit } = window.__PW_STUB__;
  if (!fixture.teamOverview) return;
  const now = Date.now();
  const orgId = "org-a";
  const person = (userId, displayName) => ({ userId, displayName, photoUrl: null });
  const me = person("u-me", "Alice");
  const bob = person("u-bob", "Bob");
  const cara = person("u-cara", "Cara");
  const state = window.__PW_TEAM__ = {
    calls: [], presence: "live", roster: fixture.emptyTeam ? [me] : [me, bob, cara],
    viewer: "u-me", refusal: "workspace_reassign_busy", followPending: null,
    inboxPending: null, queued: [], cursor: 0,
  };
  const session = (id, title, status, age) => {
    const at = new Date(now - age).toISOString();
    return { id, projectPath: "/repos/p0", cwd: "/repos/p0", title, created: at, modified: at, lastMessageAt: status === "idle" ? null : at,
      archived: false, pinned: false, tabs: [{ id: `${id}-t`, harness: "claude", model: "", permissionMode: "default", status, created: at, modified: at }], activeTab: `${id}-t` };
  };
  const item = (id, name, owner, following, role, lastActivityAt) => ({ following, latestOperation: null,
    workspace: { id, orgId, name, provider: "local-docker", state: "ready", accessMode: "organization", createdAt: 1, updatedAt: now,
      runtimeActivity: { online: true, reportedAt: now, pendingApprovals: id === "w-mine" ? 1 : 0, activeTurns: id === "w-org" ? 1 : 0 },
      lastActivityAt, createdBy: owner.userId, creator: owner, repositories: [], releaseDisposition: null,
      authority: "manage", you: { role, canApprove: false } } });
  state.rows = [item("w-mine", "Owned workspace", me, false, "manager", now - 180_000),
    item("w-shared", "Shared workspace", bob, true, "viewer", now - 60_000),
    item("w-org", "Organization workspace", cara, false, "manager", null)];
  if (fixture.privateWorkspace) state.rows[0].workspace.accessMode = "private";
  const sessions = {
    "w-mine": { sessions: [session("mine", "Owned task", "waiting", 30_000)], capabilities: ["session/2"], at: now },
    "w-shared": { sessions: [session("shared", "Shared task", "completed", 240_000)], capabilities: ["session/2"], at: now },
    // Running compute deliberately has no people present and no lastActivityAt.
    "w-org": { sessions: [session("org", "Organization task", "in_progress", 10_000)], capabilities: ["session/2"], at: now },
  };
  const quota = { used: 3, limit: 10 };
  answers.list_sessions = [session("local", "Local task", "idle", 120_000)];
  answers.session_summaries = [];
  answers.account_status = { ...answers.account_status, multiOrg: true, catalogFeed: true,
    context: { account: "account-a", scope: "account-a", revision: "account-a:1" }, organizations: answers.account_status.organizations.slice(0, 1) };
  answers.cloud_catalog_load = { version: 1, createMemory: {}, orgs: { [orgId]: { workspaces: state.rows, sessions, quota, repositories: [], fetchedAt: now } } };
  answers.cloud_catalog_feed = () => ({ viewerUserId: state.viewer, changed: true, cursor: String(++state.cursor), reset: true,
    organizations: [{ orgId, workspaces: structuredClone(state.rows), tombstones: [], quota }], deletedWorkspaceIds: [] });
  answers.cloud_workspaces = () => ({ workspaces: structuredClone(state.rows), quota });
  answers.cloud_catalog_save = null;
  answers.phase2_desktop_contracts_available = true;
  answers.organization_members = answers.organization_members_in = () => ({ members: state.roster.map((p) => ({ ...p, email: `${p.userId}@example.test`, role: p.userId === "u-me" ? "admin" : "member" })), pendingInvites: [], viewerRole: "admin", canManageMembers: true, canInvite: true, contextRevision: answers.account_status.context.revision });
  answers.desktop_presence_read = ({ input }) => {
    state.calls.push({ command: "desktop_presence_read", input });
    if (state.presence === "unavailable") throw { code: "presence_unavailable" };
    return { ttlSeconds: 45, activeMembers: state.presence === "expired" ? [] : [bob, bob],
      workspaces: state.rows.filter((row) => input.workspaceIds.includes(row.workspace.id)).map((row) => ({ workspaceId: row.workspace.id, owner: row.workspace.creator,
        activeMembers: state.presence !== "expired" && row.workspace.id === "w-shared" ? [bob] : [] })) };
  };
  answers.desktop_presence_put = () => ({ applied: true, ttlSeconds: 45 });
  answers.cloud_workspace_follow_put = ({ workspaceId, input }) => {
    state.calls.push({ command: "cloud_workspace_follow_put", workspaceId, input });
    return new Promise((resolve) => { state.followPending = () => { state.rows.find((r) => r.workspace.id === workspaceId).following = true; resolve({ workspaceId, following: true }); state.followPending = null; }; });
  };
  answers.cloud_workspace_follow_delete = ({ workspaceId }) => {
    state.rows.find((r) => r.workspace.id === workspaceId).following = false;
    return { workspaceId, following: false };
  };
  answers.cloud_workspace_reassign = ({ workspaceId, input }) => {
    state.calls.push({ command: "cloud_workspace_reassign", workspaceId, input: structuredClone(input) });
    if (state.refusal) throw { code: state.refusal };
    const row = state.rows.find((r) => r.workspace.id === workspaceId);
    row.workspace.createdBy = input.targetUserId;
    row.workspace.creator = state.roster.find((p) => p.userId === input.targetUserId);
    row.following = true;
    return { workspaceId, ownerId: input.targetUserId, previousOwnerId: input.expectedOwnerId, reassigned: true };
  };
  const nextInbox = () => state.queued.length ? Promise.resolve(state.queued.shift()) : new Promise((resolve) => { state.inboxPending = resolve; });
  answers.desktop_inbox_stream = answers.desktop_inbox = nextInbox;
  answers.desktop_inbox_receipts = () => ({ acknowledged: true });
  answers.cloud_workspace_read_marker = ({ sessionId, readAt }) => ({ sessionId, readAt });
  state.event = (type, payload = {}, workspaceId = "w-shared") => {
    const id = String(++state.cursor);
    const page = { v: 1, cursor: id, hasMore: false, events: [{ id, type, workspaceId, organizationId: orgId, payload, createdAt: new Date().toISOString() }] };
    if (state.inboxPending) { const resolve = state.inboxPending; state.inboxPending = null; resolve(page); }
    else state.queued.push(page);
  };
  state.switchAccount = () => {
    state.viewer = "u-other"; state.rows = []; state.roster = [];
    answers.cloud_catalog_load = { version: 1, createMemory: {}, orgs: {} };
    answers.account_status = { ...answers.account_status, identity: { ...answers.account_status.identity, email: "other@example.test" }, context: { account: "account-b", scope: "account-b", revision: "account-b:1" } };
    emit("account_status", answers.account_status);
  };
})();
