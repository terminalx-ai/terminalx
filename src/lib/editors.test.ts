import { afterEach, describe, expect, it, vi } from "vitest";
import { ask } from "@tauri-apps/plugin-dialog";
import { closeAllEditors, closeEditor, editorLinkContext, fileKind, getEditors, openDiff, openPr, setDiffMode, serializeReviewTabs, restoreReviewTabs, openFile, setEditorDirty, setPaneCollapsed, setViewMode, toggleViewMode } from "./editors";
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

afterEach(async () => {
  vi.mocked(ask).mockResolvedValue(true);
  for (const e of getEditors().editors) await closeAllEditors(e.sessionId);
  vi.clearAllMocks();
});

describe("file opening boundary", () => {
  it.each([
    ["src/app.constructor", "text"], ["src/app.ts", "text"], ["src/app.mts", "text"], ["logo.SVG", "text"], ["README.md", "text"],
    ["images/透明 logo.PNG", "image"], ["photo.heic", "image"], ["design.psd", "image"],
    ["voice.MP3", "audio"], ["voice.wav", "audio"], ["voice.flac", "audio"],
    ["movie.mp4", "video"], ["movie.webm", "video"], ["movie.avi", "video"],
  ])("opens %s as %s even when requested with a line target", (rel, kind) => {
    const id = openFile("session", "/workspace", rel, { line: 7 });
    const entry = getEditors().editors.find((e) => e.id === id)!;
    expect(fileKind(rel)).toBe(kind);
    expect(entry.kind).toBe(kind);
    expect(entry.jump?.line).toBe(kind === "text" ? 7 : undefined);
  });

  it("focuses the existing asset, reopens a collapsed pane, and distinguishes project roots", () => {
    const id = openFile("session", "/one", "logo.png");
    openFile("session", "/one", "other.ts");
    setPaneCollapsed("session", true);
    expect(openFile("session", "/one", "logo.png")).toBe(id);
    expect(getEditors().active.session).toBe(id);
    expect(getEditors().collapsed.session).toBe(false);
    expect(openFile("session", "/two", "logo.png")).not.toBe(id);
    expect(getEditors().editors).toHaveLength(3);
  });

  it("cannot mark media dirty or force it into a source editor", async () => {
    const id = openFile("session", "/workspace", "corrupt.mp4");
    setEditorDirty(id, true);
    setViewMode(id, "preview");
    toggleViewMode(id);
    openFile("session", "/workspace", "corrupt.mp4", { line: 1 });
    expect(getEditors().editors[0]).toMatchObject({ kind: "video", dirty: false, viewMode: "source", jump: undefined });
    await closeEditor(id);
    expect(ask).not.toHaveBeenCalled();
  });

  it("preserves Markdown preview/source, SVG editing, and unsaved-buffer protection", async () => {
    const md = openFile("session", "/workspace", "README.md");
    expect(getEditors().editors[0].viewMode).toBe("preview");
    toggleViewMode(md);
    expect(getEditors().editors[0].viewMode).toBe("source");
    const svg = openFile("session", "/workspace", "logo.svg");
    setEditorDirty(svg, true);
    vi.mocked(ask).mockResolvedValue(false);
    await closeEditor(svg);
    expect(getEditors().editors.find((e) => e.id === svg)?.dirty).toBe(true);
    expect(ask).toHaveBeenCalledOnce();
  });

  it("stores the originating workspace separately from an outside file root", () => {
    const id = openFile("session", "/tmp", "Outside.md", undefined, "/workspace");
    const entry = getEditors().editors.find((candidate) => candidate.id === id)!;
    expect(entry).toMatchObject({ root: "/tmp", rel: "Outside.md", workspaceRoot: "/workspace" });
    expect(editorLinkContext(entry)).toEqual({ sessionId: "session", cwd: "/workspace", basePath: "/tmp" });
  });
});

describe("review tabs", () => {
  it("keeps files, different snapshots, scopes and repositories distinct; reopening focuses without resetting Edit", async () => {
    const file = openFile("s", "/repo", "a.ts");
    const diff = openDiff("s", "/repo", "a.ts", { scope: "turn", range: { base: "base", head: "head" } });
    await setDiffMode(diff, "edit");
    setEditorDirty(diff, true);
    setPaneCollapsed("s", true);
    expect(openDiff("s", "/repo", "a.ts", { scope: "turn", range: { base: "base", head: "head" } })).toBe(diff);
    expect(getEditors().editors.find((e) => e.id === diff)).toMatchObject({ kind: "diff", dirty: true, name: "a.ts · Latest turn", diff: { mode: "edit" } });
    expect(getEditors().collapsed.s).toBe(false);
    expect(openDiff("s", "/repo", "a.ts", { scope: "turn", range: { base: "next", head: "later" } })).not.toBe(diff);
    expect(openDiff("s", "/repo", "a.ts", { scope: "all", range: { base: "base", head: "head" } })).not.toBe(diff);
    expect(openFile("s", "/repo", "a.ts")).toBe(file);
    const pr = { url: "https://github.com/org/repo/pull/12", number: 12, head: "branch", scope: { kind: "local" as const, cwd: "/repo" } };
    const tab = openPr("s", "/repo", pr);
    expect(openPr("s", "/repo", pr)).toBe(tab);
    expect(openPr("s", "/repo", { ...pr, url: "https://github.com/org/other/pull/12" })).not.toBe(tab);
    expect(getEditors().editors.find((e) => e.id === tab)?.name).toBe("PR #12");
  });

  it("guards leaving Edit and closing a dirty diff, retaining the buffer's dirty state after switching", async () => {
    const id = openDiff("s", "/repo", "a.ts", { scope: "all", range: { base: "base", head: null } });
    await setDiffMode(id, "edit");
    setEditorDirty(id, true);
    vi.mocked(ask).mockResolvedValue(false);
    await setDiffMode(id, "diff");
    expect(getEditors().editors[0]).toMatchObject({ dirty: true, diff: { mode: "edit" } });
    await closeAllEditors("s");
    expect(getEditors().editors).toHaveLength(1);
    vi.mocked(ask).mockResolvedValue(true);
    await setDiffMode(id, "diff");
    expect(getEditors().editors[0]).toMatchObject({ dirty: true, diff: { mode: "diff" } });
    await closeEditor(id);
    expect(getEditors().editors).toHaveLength(0);
    expect(ask).toHaveBeenCalledTimes(4);
  });

  it("restores review locators, selected tab and collapsed state without restoring stale dirty buffers", async () => {
    openFile("s", "/repo", "plain.ts");
    openPr("s", "/repo", { url: "https://github.com/org/repo/pull/12", number: 12, head: "branch", scope: { kind: "local", cwd: "/repo" } });
    const id = openDiff("s", "/repo", "new.ts", { scope: "turn", oldPath: "old.ts", range: { base: "before", head: "after" } });
    await setDiffMode(id, "edit");
    setEditorDirty(id, true);
    setPaneCollapsed("s", true);
    const saved = serializeReviewTabs(getEditors());
    expect(localStorage.getItem("terminalx:review-tabs:v1")).toBe(saved);
    const restored = restoreReviewTabs(saved);
    expect(restored.editors.map((e) => e.kind)).toEqual(["pr", "diff"]);
    expect(restored.editors[1]).toMatchObject({ dirty: false, diff: { mode: "diff", oldPath: "old.ts", range: { base: "before", head: "after" } } });
    expect(restored.active.s).toBe(id);
    expect(restored.collapsed.s).toBe(true);
    expect(restoreReviewTabs("bad JSON").editors).toEqual([]);
    expect(restoreReviewTabs(JSON.stringify({ editors: [null, { kind: "diff" }, { ...restored.editors[1], diff: { mode: "edit", scope: "turn", range: 12 } }] })).editors).toEqual([]);
  });
});
