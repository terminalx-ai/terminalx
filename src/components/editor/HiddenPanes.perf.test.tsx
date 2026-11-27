import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, fs } from "@/lib/api";
import { closeAllEditors, openDiff, openFile, setActiveEditor } from "@/lib/editors";
import { liveEditorsFor } from "@/lib/editorViews";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EditorSplit } from "./EditorSplit";
import { DiffEditorPane } from "./DiffEditorPane";

vi.mock("@/lib/api", () => ({
  errorMessage: String,
  fs: {
    openMedia: vi.fn(),
    closeMedia: vi.fn().mockResolvedValue(undefined),
    mtime: vi.fn().mockResolvedValue(1),
    readText: vi.fn().mockResolvedValue({ content: "hello\n", binary: false, truncated: false, mtimeMs: 1, size: 6 }),
    writeText: vi.fn().mockResolvedValue(2),
  },
  api: {
    headTree: vi.fn().mockResolvedValue(null),
    fileContentsAt: vi.fn().mockResolvedValue({ before: "old\n", after: "new\n" }),
    diffMediaContent: vi.fn(),
    changesBetween: vi.fn().mockResolvedValue([]),
    reviewRange: vi.fn(),
  },
  git: { discard: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("@/components/chat/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));

const CHECKOUT = "checkout:/lazy-workspace";

afterEach(async () => {
  cleanup();
  await closeAllEditors(CHECKOUT);
  vi.clearAllMocks();
});

describe("P-43 hidden pane deferral", () => {
  it("does not mount CodeMirror or read files for hidden tabs in EditorSplit until selected", async () => {
    const first = openFile(CHECKOUT, "/lazy-workspace", "a.ts");
    const second = openFile(CHECKOUT, "/lazy-workspace", "b.ts");
    // Only `second` is active initially.
    render(<TooltipProvider><EditorSplit sessionId={CHECKOUT} active /></TooltipProvider>);
    await waitFor(() => expect(liveEditorsFor("/lazy-workspace/b.ts")).toHaveLength(1));
    expect(liveEditorsFor("/lazy-workspace/a.ts")).toHaveLength(0);
    expect(vi.mocked(fs.readText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fs.readText)).toHaveBeenCalledWith("/lazy-workspace/b.ts");

    act(() => setActiveEditor(CHECKOUT, first));
    await waitFor(() => expect(liveEditorsFor("/lazy-workspace/a.ts")).toHaveLength(1));
    expect(vi.mocked(fs.readText)).toHaveBeenCalledWith("/lazy-workspace/a.ts");
    expect(second).not.toBe(first);
  });

  it("defers DiffEditorPane git IPC until the pane becomes visible", async () => {
    const id = openDiff(CHECKOUT, "/lazy-workspace", "app.ts", { scope: "turn", range: { base: "b", head: "h" } });
    const entry = {
      id,
      sessionId: CHECKOUT,
      kind: "diff" as const,
      root: "/lazy-workspace",
      workspaceRoot: "/lazy-workspace",
      rel: "app.ts",
      name: "app.ts",
      dirty: false,
      viewMode: "source" as const,
      diff: { scope: "turn" as const, range: { base: "b", head: "h" }, mode: "diff" as const },
    };
    const view = render(<TooltipProvider><DiffEditorPane entry={entry} visible={false} /></TooltipProvider>);
    expect(vi.mocked(api.fileContentsAt)).not.toHaveBeenCalled();
    expect(vi.mocked(api.changesBetween)).not.toHaveBeenCalled();

    view.rerender(<TooltipProvider><DiffEditorPane entry={entry} visible /></TooltipProvider>);
    await waitFor(() => expect(vi.mocked(api.fileContentsAt)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.changesBetween)).toHaveBeenCalledTimes(1);
  });
});
