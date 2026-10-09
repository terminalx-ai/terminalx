// Isolated host/guest fixtures for the local sharing layout checks.
(() => {
  const f = window.__PW_FIXTURE__;
  if (!f.localSharing) return;
  const { answers, emit } = window.__PW_STUB__;
  const person = { userId: "guest", displayName: "Alice", email: "alice@example.com", emailVerified: true };
  const settings = { audience: "anyone", role: "driver", people: [], expiresAt: Date.now() + 3600000, approveEachPerson: false, canApprove: false, maximumPeople: 8, singleUse: false };
  let share = { active: false, links: [], people: [], leases: [], notes: [], activity: [], queue: [] };
  const guest = () => ({ admitted: true, you: { person, role: settings.role, canApprove: false }, state: share });
  answers.account_status = { state: "signed-in", identity: { name: "Alice", email: person.email, organization: null, organizationId: null }, organizations: [], expiresAt: null, lastError: null };
  answers.cloud_catalog_load = { version: 1, createMemory: {}, orgs: {} };
  answers.session_share_status = () => share;
  answers.session_join_pending = f.localSharing === "guest" ? "https://terminalx.ai/join#fixture" : null;
  answers.session_share_create = ({ settings: next }) => {
    share = { ...share, active: true, links: [{ id: "link", settings: next, url: "https://terminalx.ai/join#secret-fixture", directOnly: true, revoked: false }] };
    return share;
  };
  answers.session_share_change = ({ action }) => { if (action === "stop") share = { ...share, active: false, links: [] }; return share; };
  answers.session_guest_join = () => {
    share = { ...share, active: true, people: [{ person, role: "driver", admitted: true, connections: 1, typing: false, viewing: ["tab"], linkIds: ["link"] }] };
    return { sessionId: "invited-session", connectionId: "connection", admitted: true };
  };
  const calls = window.__PW_SHARE_CALLS__ = [];
  answers.session_guest_send = ({ request }) => {
    calls.push(request);
    const result = request.method === "session.status" ? guest()
      : request.method === "session.tabs.list" ? { title: "Shared local session", tabs: [{ id: "tab", harness: "claude", title: "Agent", status: "idle" }] }
      : request.method === "terminal.read" ? { text: "Host terminal output\r\n", cols: 80, rows: 24 }
      : request.method === "session.tail" ? { hasMore: false, events: [{ id: "event", sessionId: "invited-session", tabId: "tab", harness: "claude", seq: 1, ts: new Date().toISOString(), payload: { type: "user_message", text: "Run the tests", queued: false, author: person } }] }
      : { accepted: true };
    queueMicrotask(() => emit("session_guest_message", { connectionId: "connection", message: { id: request.id, ok: true, result } }));
  };
  answers.session_guest_leave = () => undefined;
  window.__PW_SHARE_VIEWER__ = () => { settings.role = "viewer"; emit("session_guest_message", { connectionId: "connection", message: { method: "share.changed", params: guest() } }); };
})();
