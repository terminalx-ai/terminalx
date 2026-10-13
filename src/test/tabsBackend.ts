import type { BrowserPage, ClosedTab, TabLayout } from "@/lib/api";
import type { SessionEntry, TabEntry, TabStatus } from "@/types/session";

/**
 * A stand-in for the backend, for tests of tabs across a workspace: it keeps
 * sessions, shells, browser pages, tab layouts and closed tabs the way the
 * real one does, and announces what the real one announces. Tests mock
 * `@tauri-apps/api/core` and `@tauri-apps/api/event` with `invoke` and
 * `listen` from here, then drive the real stores.
 *
 * The fixture is one project with two checkouts:
 *
 * - the worktree `FEATURE`, shared by sessions `a` (agent tabs a1 idle,
 *   a2 working, a3 waiting) and `b` (agent tab b1, an unread reply), with a
 *   browser page `page-feature`;
 * - the project's own checkout `MAIN`, with session `other` (agent tab o1)
 *   and a browser page `page-main`.
 *
 * Nothing of `MAIN` belongs in `FEATURE`'s row of tabs.
 */
export const PROJECT = "/repo";
export const MAIN = "/repo";
export const FEATURE = "/repo/.worktrees/feature";

const at = (second: number) => new Date(Date.UTC(2026, 9, 1, 10, 0, second)).toISOString();

export function tab(id: string, second: number, patch: Partial<TabEntry> = {}): TabEntry {
  return { id, harness: "claude", title: null, model: "opus", permissionMode: "default", status: "idle" as TabStatus, created: at(second), modified: at(second), ...patch };
}

export function session(id: string, cwd: string, tabs: TabEntry[], patch: Partial<SessionEntry> = {}): SessionEntry {
  return { id, projectPath: PROJECT, cwd, worktreeRemoved: false, title: `Session ${id}`, created: at(0), modified: at(0), archived: false, pinned: false, tabs, activeTab: tabs[0]?.id ?? null, ...patch };
}

export function page(id: string, workspacePath: string, second: number, patch: Partial<BrowserPage> = {}): BrowserPage {
  return { id, browserPageId: id, profileId: "default", tabId: id, url: `https://example.test/${id}`, title: `Page ${id}`, workspacePath, created: at(second), active: false, index: 0, ...patch };
}

interface Call {
  command: string;
  args: Record<string, unknown>;
}

export interface TabsBackend {
  sessions: SessionEntry[];
  pages: BrowserPage[];
  /** Shell panes that are open, by id. */
  shells: Map<string, { sessionId: string; title: string | null; cwd: string }>;
  /** Shells in the middle of a command. */
  busy: Set<string>;
  layouts: Record<string, TabLayout>;
  closed: ClosedTab[];
  calls: Call[];
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen: (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>;
  emit: (event: string, payload: unknown) => void;
  /** The arguments of every call of `command`, in order. */
  callsOf: (command: string) => Record<string, unknown>[];
  reset: () => void;
}

function fixture() {
  return {
    sessions: [
      session("a", FEATURE, [
        tab("a1", 1, { title: "Refactor the authentication middleware to use the new token service" }),
        tab("a2", 2, { harness: "codex", title: "Fix flaky test", status: "in_progress" }),
        tab("a3", 3, { title: "Review", status: "waiting", providerSessionId: "conversation-a3" }),
      ], { worktreeName: "feature", branch: "feature" }),
      session("b", FEATURE, [tab("b1", 5, { harness: "codex", title: "Docs", status: "completed" })], { worktreeName: "feature", branch: "feature", modified: at(1) }),
      session("other", MAIN, [tab("o1", 4, { title: "A tab of another workspace" })]),
    ],
    pages: [page("page-feature", FEATURE, 6), page("page-main", MAIN, 7)],
  };
}

function create(): TabsBackend {
  const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();
  let seq = 0;
  const backend: TabsBackend = {
    ...fixture(),
    shells: new Map(),
    busy: new Set(),
    layouts: {},
    closed: [],
    calls: [],
    emit(event, payload) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler({ payload });
    },
    async listen(event, handler) {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      set.add(handler);
      return () => void set.delete(handler);
    },
    callsOf: (command) => backend.calls.filter((call) => call.command === command).map((call) => call.args),
    reset() {
      Object.assign(backend, fixture());
      backend.shells = new Map();
      backend.busy = new Set();
      backend.layouts = {};
      backend.closed = [];
      backend.calls = [];
    },
    async invoke(command, args = {}) {
      backend.calls.push({ command, args });
      const find = (id: unknown) => backend.sessions.find((candidate) => candidate.id === id);
      const tabState = () => ({ workspaces: backend.layouts, closed: backend.closed });
      const announceSession = (id: unknown) => {
        const entry = find(id);
        if (entry) backend.emit("session_updated", structuredClone(entry));
      };
      switch (command) {
        case "list_projects":
          return { projects: [{ path: PROJECT, name: "Repo" }], lastSelected: PROJECT };
        case "list_sessions":
          return structuredClone(backend.sessions);
        case "list_harnesses":
          return [{ id: "claude", name: "Claude Code", available: true }, { id: "codex", name: "Codex", available: true }, { id: "gemini", name: "Gemini", available: false }];
        case "list_workspaces":
          return [];
        case "tab_state":
          return structuredClone(tabState());
        case "set_tab_layout": {
          const { workspace, layout } = args as { workspace: string; layout: TabLayout };
          backend.layouts = { ...backend.layouts, [workspace]: structuredClone(layout) };
          const rank = new Map(layout.order.map((key, index) => [key, index]));
          for (const entry of backend.sessions) entry.tabs.sort((x, y) => (rank.get(`agent:${x.id}`) ?? Infinity) - (rank.get(`agent:${y.id}`) ?? Infinity));
          backend.emit("tab_state_changed", structuredClone(tabState()));
          return null;
        }
        case "add_tab": {
          const { sessionId, tab: wanted } = args as { sessionId: string; tab: { harness: string; model: string; effort: string | null; permissionMode: string } };
          const added = tab(`new-${++seq}`, 30 + seq, { harness: wanted.harness, model: wanted.model, effort: wanted.effort, permissionMode: wanted.permissionMode });
          const entry = find(sessionId)!;
          entry.tabs.push(added);
          entry.activeTab = added.id;
          return structuredClone(added);
        }
        case "remove_tab": {
          const { sessionId, tabId } = args as { sessionId: string; tabId: string };
          const entry = find(sessionId)!;
          const closing = entry.tabs.find((candidate) => candidate.id === tabId);
          if (!closing) return null;
          entry.tabs = entry.tabs.filter((candidate) => candidate.id !== tabId);
          if (entry.activeTab === tabId) entry.activeTab = entry.tabs.at(-1)?.id ?? null;
          backend.closed = [...backend.closed, { sessionId, tab: closing, closedAt: new Date(Date.UTC(2026, 9, 2, 0, 0, ++seq)).toISOString() }];
          backend.emit("tab_state_changed", structuredClone(tabState()));
          return null;
        }
        case "reopen_tab": {
          const { sessionId, tabId } = args as { sessionId: string; tabId: string };
          const closed = backend.closed.find((candidate) => candidate.sessionId === sessionId && candidate.tab.id === tabId);
          if (!closed) throw new Error(`tab ${tabId} is not a closed tab`);
          backend.closed = backend.closed.filter((candidate) => candidate !== closed);
          const entry = find(sessionId)!;
          // The pane it lived in went when it was closed, and a hand-started agent with it.
          const back = { ...closed.tab, status: "idle" as TabStatus, pane: null, front: closed.tab.front === "by_hand" ? ("agent" as const) : closed.tab.front };
          entry.tabs.push(back);
          entry.activeTab = back.id;
          backend.emit("tab_state_changed", structuredClone(tabState()));
          return structuredClone(back);
        }
        case "rename_tab": {
          const { sessionId, tabId, title } = args as { sessionId: string; tabId: string; title: string | null };
          const renamed = find(sessionId)?.tabs.find((candidate) => candidate.id === tabId);
          // The reader's own title is the tab's name whatever runs in it.
          if (renamed) Object.assign(renamed, { title, titlePinned: title != null });
          announceSession(sessionId);
          return null;
        }
        case "set_active_tab": {
          const entry = find(args.sessionId);
          if (entry) entry.activeTab = args.tabId as string;
          return null;
        }
        case "pty_spawn":
          backend.shells.set(args.id as string, { sessionId: String(args.id).split(":")[0], title: (args.title as string | null) ?? null, cwd: args.cwd as string });
          return null;
        case "pty_kill":
          backend.shells.delete(args.id as string);
          return null;
        case "pty_shells":
          return [...backend.shells].map(([id, shell]) => ({ id, sessionId: shell.sessionId, title: shell.title, cwd: shell.cwd, exited: false }));
        case "pty_busy":
          return (args.ids as string[]).filter((id) => backend.busy.has(id));
        case "browser_pages":
          return structuredClone(backend.pages);
        case "browser_open_tab": {
          const opened = page(`page-new-${++seq}`, args.workspace as string, 40 + seq, { url: (args.url as string | null) ?? "about:blank", title: "" });
          backend.pages = [...backend.pages, opened];
          backend.emit("browser_pages_changed", { pages: structuredClone(backend.pages) });
          return { browserPageId: opened.id, url: opened.url, title: opened.title };
        }
        case "browser_close_page":
          backend.pages = backend.pages.filter((candidate) => candidate.id !== args.pageId);
          backend.emit("browser_pages_changed", { pages: structuredClone(backend.pages) });
          return null;
        default:
          // Everything else a tab test may touch answers nothing: starting an agent's CLI, activating a page, a detach.
          return null;
      }
    },
  };
  return backend;
}

export const backend = create();
