import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffEditorEntry } from "@/lib/editors";

const mocks = vi.hoisted(() => ({
  changesBetween: vi.fn(),
  fileContentsAt: vi.fn(),
  diffPaneMounts: 0,
  diffPaneUnmounts: 0,
}));

vi.mock("@/lib/gitSource", () => ({
  localGitSource: (cwd: string) => ({
    key: `local:${cwd}`,
    changesBetween: mocks.changesBetween,
    fileContentsAt: mocks.fileContentsAt,
    reviewRange: vi.fn(),
    errorMessage: String,
  }),
}));
vi.mock("@/lib/sessions", () => ({
  useSessionStore: () => ({ sessions: [] }),
}));
vi.mock("@/components/changes/ReviewComments", () => ({
  ReviewCommentsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/changes/ReviewThreads", () => ({
  useSessionThreads: () => null,
}));
vi.mock("@/lib/viewedChanges", () => ({
  useViewedChanges: () => ({ status: () => ({ viewed: false, changed: false }), set: vi.fn() }),
}));
vi.mock("@/components/changes/DiffPane", async () => {
  const React = await import("react");
  return {
    DiffPane: ({ path }: { path: string }) => {
      React.useEffect(() => {
        mocks.diffPaneMounts++;
        return () => { mocks.diffPaneUnmounts++; };
      }, []);
      return <div data-testid={`diff-pane-${path}`}>{path}</div>;
    },
  };
});

const { REVIEW_RECYCLE_THRESHOLD, ReviewStackPane } = await import("./ReviewStackPane");

type ObserverEntry = { target: Element; callback: IntersectionObserverCallback };
let observers: ObserverEntry[] = [];

class FakeIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "0px";
  readonly thresholds = [0];
  private cb: IntersectionObserverCallback;
  private targets = new Set<Element>();
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
  }
  observe(target: Element) {
    this.targets.add(target);
    observers.push({ target, callback: this.cb });
  }
  unobserve(target: Element) {
    this.targets.delete(target);
    observers = observers.filter((entry) => entry.target !== target || entry.callback !== this.cb);
  }
  disconnect() {
    observers = observers.filter((entry) => entry.callback !== this.cb);
    this.targets.clear();
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

function emitIntersection(target: Element, isIntersecting: boolean) {
  for (const entry of observers) {
    if (entry.target === target) {
      entry.callback([{ target, isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
    }
  }
}

beforeEach(() => {
  observers = [];
  mocks.diffPaneMounts = 0;
  mocks.diffPaneUnmounts = 0;
  mocks.changesBetween.mockResolvedValue([
    { path: "a.ts", status: "modified", additions: 2, deletions: 1 },
    { path: "b.ts", status: "modified", additions: 3, deletions: 0 },
  ]);
  mocks.fileContentsAt.mockResolvedValue({ before: "old", after: "new" });
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ReviewStackPane off-screen editor recycling (P-41)", () => {
  it("unmounts off-screen DiffPane views in large reviews and remounts them without refetching when scrolled back", async () => {
    mocks.changesBetween.mockResolvedValue(
      Array.from({ length: REVIEW_RECYCLE_THRESHOLD + 1 }, (_, i) => ({
        path: i === 0 ? "a.ts" : `file-${i}.ts`,
        status: "modified" as const,
        additions: 2,
        deletions: 1,
      })),
    );
    const entry: DiffEditorEntry = {
      id: "review-1",
      kind: "diff",
      sessionId: "s1",
      root: "/repo",
      workspaceRoot: "/repo",
      rel: "a.ts",
      name: "Review",
      dirty: false,
      viewMode: "source",
      diff: { stack: true, scope: "all", mode: "diff", range: { base: "base", head: "head" } },
    };
    render(<ReviewStackPane entry={entry} visible />);
    const sectionA = await screen.findByRole("region", { name: "a.ts" });
    expect(screen.queryByTestId("diff-pane-a.ts")).toBeNull();

    // Scroll sectionA into view -> mounts DiffPane and fetches content once.
    act(() => emitIntersection(sectionA, true));
    await screen.findByTestId("diff-pane-a.ts");
    expect(mocks.diffPaneMounts).toBe(1);
    const fetches = mocks.fileContentsAt.mock.calls.length;

    // Scroll sectionA far off-screen -> unmounts DiffPane and renders height placeholder.
    act(() => emitIntersection(sectionA, false));
    await waitFor(() => expect(screen.queryByTestId("diff-pane-a.ts")).toBeNull());
    expect(mocks.diffPaneUnmounts).toBe(1);

    // Scroll sectionA back into view -> remounts DiffPane immediately without refetching.
    act(() => emitIntersection(sectionA, true));
    await screen.findByTestId("diff-pane-a.ts");
    expect(mocks.fileContentsAt.mock.calls.length).toBe(fetches);
  });

  it("keeps loaded DiffPane views mounted in smaller reviews so comments and lines remain reachable", async () => {
    const entry: DiffEditorEntry = {
      id: "review-small",
      kind: "diff",
      sessionId: "s1",
      root: "/repo",
      workspaceRoot: "/repo",
      rel: "a.ts",
      name: "Review",
      dirty: false,
      viewMode: "source",
      diff: { stack: true, scope: "all", mode: "diff", range: { base: "base", head: "head" } },
    };
    render(<ReviewStackPane entry={entry} visible />);
    const sectionA = await screen.findByRole("region", { name: "a.ts" });
    act(() => emitIntersection(sectionA, true));
    await screen.findByTestId("diff-pane-a.ts");

    act(() => emitIntersection(sectionA, false));
    expect(screen.getByTestId("diff-pane-a.ts")).toBeTruthy();
    expect(mocks.diffPaneUnmounts).toBe(0);
  });
});
