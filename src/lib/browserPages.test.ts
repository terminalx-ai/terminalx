import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@/lib/api", () => ({ browser: { pages: vi.fn(), openTab: vi.fn(), closePage: vi.fn(), activatePage: vi.fn(), navigate: vi.fn(), screencast: vi.fn() } }));
vi.mock("@/lib/terminal", () => ({ setSelectedBrowser: vi.fn(), clearSelectedBrowser: vi.fn() }));

const { pagesFor, sameWorkspace, subscribeFrames } = await import("@/lib/browser");
const { browserPageLabel, peerOrder } = await import("@/lib/sessionTabs");

const page = (id: string, workspacePath: string | null, created: string, title = "", url = "https://example.com/a") => ({
  id,
  browserPageId: id,
  profileId: "default",
  tabId: "t1",
  url,
  title,
  workspacePath,
  created,
  active: false,
  index: 0,
});

describe("browser pages in the tab model", () => {
  it("scopes pages to a workspace, tolerating the /private alias macOS adds", () => {
    const pages = [page("bp-1", "/Users/dev/repo", "2026-01-02T00:00:00Z"), page("bp-2", "/private/tmp/ws", "2026-01-03T00:00:00Z"), page("bp-3", null, "2026-01-04T00:00:00Z")];
    expect(pagesFor(pages, "/Users/dev/repo").map((p) => p.id)).toEqual(["bp-1"]);
    expect(pagesFor(pages, "/tmp/ws/").map((p) => p.id)).toEqual(["bp-2"]);
    expect(sameWorkspace("/a/b", "/a/c")).toBe(false);
  });

  it("interleaves browser pages with agents and shells by creation time", () => {
    const session = {
      id: "s1",
      projectPath: "/repo",
      cwd: "/repo",
      worktreeRemoved: false,
      title: "s",
      created: "",
      modified: "",
      archived: false,
      pinned: false,
      tabs: [{ id: "agent-1", harness: "claude", model: "", permissionMode: "default", status: "idle" as const, created: "2026-01-01T00:00:00Z", modified: "" }],
      activeTab: "agent-1",
    };
    const panes = [{ id: "shell-1", sessionId: "s1", title: "Terminal 1", created: "2026-01-03T00:00:00Z", exited: false, exitCode: null }];
    const order = peerOrder(session, panes, [page("bp-1", "/repo", "2026-01-02T00:00:00Z")]);
    expect(order.map((tab) => `${tab.kind}:${tab.id}`)).toEqual(["agent:agent-1", "browser:bp-1", "terminal:shell-1"]);
  });

  it("labels a page by title, then host, then a placeholder", () => {
    expect(browserPageLabel({ title: "Docs", url: "https://x.dev" })).toBe("Docs");
    expect(browserPageLabel({ title: "", url: "https://x.dev/path" })).toBe("x.dev");
    expect(browserPageLabel({ title: "about:blank", url: "about:blank" })).toBe("New tab");
    expect(browserPageLabel({ title: "", url: "file:///tmp/site/index.html" })).toBe("index.html");
  });

  it("replays the latest frame to a late subscriber and drops it on unsubscribe", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeFrames("bp-9", (frame) => seen.push(frame.data));
    expect(seen).toEqual([]);
    unsubscribe();
  });
});
