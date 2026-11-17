import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmInApp as ask } from "@/lib/confirm";
import { getTerminalState, selectSessionTab } from "@/lib/terminal";
import { conflictTabName, openConflict, setConflictCount, pruneReviewTabs, closeAllEditors, closeEditor, editorLinkContext, fileKind, getEditors, openDiff, openPr, openReviewStack, setDiffMode, serializeReviewTabs, restoreReviewTabs, openAttachment, openFile, setEditorDirty, setPaneCollapsed, setViewMode, toggleViewMode, isFileTab, isTabEditor } from "./editors";
// Unsaved changes are asked about in the app's own dialog (PRO-400), not a system alert.
vi.mock("@/lib/confirm", () => ({ confirmInApp: vi.fn() }));

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
    expect(getEditors().collapsed.s).toBe(true);
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
    const plain = openFile("s", "/repo", "plain.ts");
    openPr("s", "/repo", { url: "https://github.com/org/repo/pull/12", number: 12, head: "branch", scope: { kind: "local", cwd: "/repo" } });
    const id = openDiff("s", "/repo", "new.ts", { scope: "turn", oldPath: "old.ts", range: { base: "before", head: "after" } });
    await setDiffMode(id, "edit");
    setEditorDirty(id, true);
    setPaneCollapsed("s", true);
    const saved = serializeReviewTabs(getEditors());
    expect(localStorage.getItem("terminalx:review-tabs:v1")).toBe(saved);
    const restored = restoreReviewTabs(saved);
    // The session's file tab comes back too (PRO-402): where the file is, nothing typed in it.
    expect(restored.editors.map((e) => e.kind)).toEqual(["text", "pr", "diff"]);
    expect(restored.editors[0]).toMatchObject({ rel: "plain.ts", dirty: false, viewMode: "source" });
    expect(restored.editors[2]).toMatchObject({ dirty: false, diff: { mode: "diff", oldPath: "old.ts", range: { base: "before", head: "after" } } });
    // The session's active file is the file tab, which the file tree marks; the tab on screen is the tab strip's to restore.
    expect(restored.active.s).toBe(plain);
    expect(restored.collapsed.s).toBe(true);
    expect(restoreReviewTabs("bad JSON").editors).toEqual([]);
    expect(restoreReviewTabs(JSON.stringify({ editors: [null, { kind: "diff" }, { ...restored.editors[2], diff: { mode: "edit", scope: "turn", range: 12 } }] })).editors).toEqual([]);
  });
});


it("does not select a saved review when the active editor was a file", () => {
  openDiff("s", "/repo", "a.ts", { scope: "all", range: { base: "base", head: null } });
  const file = openFile("s", "/repo", "another.ts");
  expect(restoreReviewTabs(serializeReviewTabs(getEditors())).active.s).toBe(file);
});

describe("file tabs (PRO-402)", () => {
  it("opens a local session's file as a tab of the session and selects it, leaving the chat tab's selection to the strip", () => {
    const id = openFile("s", "/repo", "docs/scripts.md");
    expect(getEditors().editors.find((e) => e.id === id)).toMatchObject({ kind: "text", rel: "docs/scripts.md", viewMode: "preview" });
    expect(isFileTab(getEditors().editors[0])).toBe(true);
    expect(isTabEditor(getEditors().editors[0])).toBe(true);
    expect(getTerminalState().selected.s).toEqual({ kind: "review", id });
    expect(getEditors().lastFocused).toBe("editor");
    // Opening it again focuses the tab it has.
    selectSessionTab("s", { kind: "agent", id: "chat" });
    expect(openFile("s", "/repo", "docs/scripts.md")).toBe(id);
    expect(getEditors().editors).toHaveLength(1);
    expect(getTerminalState().selected.s).toEqual({ kind: "review", id });
  });

  it("keeps a cloud workspace's file and a checkout's in the editor pane", () => {
    selectSessionTab("s", { kind: "agent", id: "chat" });
    const cloud = openFile("s", "/repo", "a.ts", undefined, "/repo", "cloud:ws");
    const checkout = openFile("checkout:/repo", "/repo", "a.ts");
    // A cloud session has no panes of the workspace's tabs: a file a link in its chat opens stays in the pane too.
    const cloudSession = openFile("cloud:org:ws:one", "/repo", "a.ts");
    // Nor is a paired machine's session local: "not a cloud key" must never read as "this Mac" (PRO-346).
    const machineSession = openFile("machine:cs1uhCLEB_ttCYaQ:1_xp39fWQj0RTKD0:5b4c4c1e", "/repo", "a.ts");
    for (const id of [cloud, checkout, cloudSession, machineSession]) expect(isTabEditor(getEditors().editors.find((e) => e.id === id)!)).toBe(false);
    expect(getTerminalState().selected.s).toEqual({ kind: "agent", id: "chat" });
    expect(getTerminalState().selected["checkout:/repo"]).toBeUndefined();
    expect(getTerminalState().selected["cloud:org:ws:one"]).toBeUndefined();
    expect(restoreReviewTabs(serializeReviewTabs(getEditors())).editors).toEqual([]);
  });

  it("closes every file tab and leaves the session's reviews, and drops the selection of a closed file", async () => {
    const diff = openDiff("s", "/repo", "a.ts", { scope: "all", range: { base: "base", head: null } });
    openFile("s", "/repo", "one.ts");
    const two = openFile("s", "/repo", "two.png");
    expect(getTerminalState().selected.s).toEqual({ kind: "review", id: two });
    await closeAllEditors("s", true);
    expect(getEditors().editors.map((e) => e.id)).toEqual([diff]);
    expect(getTerminalState().selected.s).toBeUndefined();
  });

  it("does not restore a file tab that points outside its root or at a sent attachment", () => {
    const id = openFile("s", "/repo", "docs/scripts.md");
    const saved = JSON.parse(serializeReviewTabs(getEditors()));
    expect(restoreReviewTabs(JSON.stringify(saved)).editors.map((e) => e.id)).toEqual([id]);
    for (const bad of [{ rel: "../secret" }, { rel: "/etc/passwd" }, { attachment: { path: "/repo/docs/scripts.md" } }, { sessionId: "checkout:/repo" }, { kind: "binary" }]) {
      expect(restoreReviewTabs(JSON.stringify({ ...saved, editors: [{ ...saved.editors[0], ...bad }] })).editors).toEqual([]);
    }
  });
});

it("prunes restored review tabs for deleted sessions and removed worktrees after sessions load", () => {
  for (const session of ["kept", "deleted", "removed"]) openDiff(session, "/repo", "a.ts", { scope: "all", range: { base: "base", head: null } });
  pruneReviewTabs([{ id: "kept" }, { id: "removed", worktreeRemoved: true }]);
  expect(getEditors().editors.map((e) => e.sessionId)).toEqual(["kept"]);
  expect(restoreReviewTabs(localStorage.getItem("terminalx:review-tabs:v1")).editors.map((e) => e.sessionId)).toEqual(["kept"]);
});

it("labels uncommitted diffs accurately and rejects missing snapshot ranges", () => {
  openDiff("s", "/repo", "a.ts", { scope: "all", uncommitted: true, range: { base: "base", head: null } });
  expect(getEditors().editors[0].name).toBe("a.ts · Uncommitted changes");
  expect(() => openDiff("s", "/repo", "missing.ts", { scope: "turn", range: null })).toThrow("No snapshots");
  expect(getEditors().editors).toHaveLength(1);
});


it("keeps the file-pane selection independent from workspace reviews", async () => {
  const file = openFile("s", "/repo", "a.ts");
  const review = openDiff("s", "/repo", "b.ts", { scope: "all", range: { base: "base", head: null } });
  expect(getEditors().active.s).toBe(file);
  await closeAllEditors("s", true);
  expect(getEditors().editors.map((e) => e.id)).toEqual([review]);
});

describe("conflict tabs (PRO-293)", () => {
  const merge = { head: "1".repeat(40), mergeHead: "5".repeat(40) };

  it("opens one tab per conflicted file, titled with what is left, and points it at a newer merge on reopen", () => {
    const id = openConflict("s", "/repo", "/repo/apps/api/seats.ts", merge, 2);
    const entry = getEditors().editors.find((e) => e.id === id);
    expect(entry).toMatchObject({ kind: "conflict", rel: "apps/api/seats.ts", name: "seats.ts · 2 conflicts", conflict: { ...merge, conflicts: 2 } });
    setConflictCount(id, 1);
    expect(getEditors().editors.find((e) => e.id === id)?.name).toBe("seats.ts · 1 conflict");
    const next = { head: "2".repeat(40), mergeHead: "6".repeat(40) };
    expect(openConflict("s", "/repo", "apps/api/seats.ts", next, 3)).toBe(id);
    expect(getEditors().editors.filter((e) => e.kind === "conflict")).toHaveLength(1);
    expect(getEditors().editors.find((e) => e.id === id)).toMatchObject({ name: "seats.ts · 3 conflicts", conflict: { ...next, conflicts: 3 } });
    expect(() => openConflict("s", "/repo", "../outside.ts", merge, 1)).toThrow("outside the repository");
    expect(conflictTabName("a/b.ts", 0)).toBe("b.ts · 0 conflicts");
  });

  it("restores a conflict tab's locator with its count, and drops one that is malformed", () => {
    const id = openConflict("s", "/repo", "seats.ts", merge, 2);
    const saved = JSON.parse(serializeReviewTabs(getEditors()));
    const restored = restoreReviewTabs(JSON.stringify(saved));
    expect(restored.editors.find((e) => e.id === id)).toMatchObject({ kind: "conflict", name: "seats.ts · 2 conflicts", conflict: { ...merge, conflicts: 2 } });
    for (const conflict of [undefined, { ...merge, head: "not a commit", conflicts: 1 }, { ...merge, conflicts: -1 }]) {
      const bad = { ...saved, editors: saved.editors.map((e: { id: string }) => e.id === id ? { ...e, conflict } : e) };
      expect(restoreReviewTabs(JSON.stringify(bad)).editors.some((e) => e.id === id)).toBe(false);
    }
    const escaped = { ...saved, editors: saved.editors.map((e: { id: string }) => e.id === id ? { ...e, rel: "../x.ts" } : e) };
    expect(restoreReviewTabs(JSON.stringify(escaped)).editors.some((e) => e.id === id)).toBe(false);
  });
});

describe("attachment tabs (PRO-290)", () => {
  const folder = "/Users/me/.terminalx/attachments/s1";
  it("open in a centre tab of the session, hung off its attachments folder as <folder>/<name>, read-only, markdown in Preview", () => {
    const id = openAttachment("s1", { path: `${folder}/k3f9qa/notes.md`, name: "notes.md" }, "2026-11-13T14:31:00Z", "/repo");
    expect(getEditors().editors.find((e) => e.id === id)).toMatchObject({
      root: folder, rel: "k3f9qa/notes.md", name: "notes.md", kind: "attachment", media: "text", viewMode: "preview", workspaceRoot: "/repo",
      attachment: { path: `${folder}/k3f9qa/notes.md`, sentAt: "2026-11-13T14:31:00Z" },
    });
    setEditorDirty(id, true);
    expect(getEditors().editors.find((e) => e.id === id)?.dirty).toBe(false);
    expect(getTerminalState().selected.s1).toEqual({ kind: "review", id });
    toggleViewMode(id);
    expect(getEditors().editors.find((e) => e.id === id)?.viewMode).toBe("source");
  });

  it("come back after a restart, and a forged one does not", () => {
    const id = openAttachment("s1", { path: `${folder}/k3f9qa/notes.md`, name: "notes.md" }, "2026-11-13T14:31:00Z");
    const saved = JSON.parse(serializeReviewTabs(getEditors()));
    expect(restoreReviewTabs(JSON.stringify(saved)).editors).toMatchObject([{ id, kind: "attachment", media: "text", attachment: { path: `${folder}/k3f9qa/notes.md` } }]);
    saved.editors[0].attachment.path = "/etc/passwd";
    expect(restoreReviewTabs(JSON.stringify(saved)).editors).toEqual([]);
  });

  it("focus the tab they already have; two folders' files of one name are two tabs; media keeps its kind", () => {
    const first = openAttachment("s1", { path: `${folder}/aaaaaa/plan.md`, name: "plan.md" });
    const second = openAttachment("s1", { path: `${folder}/bbbbbb/plan.md`, name: "plan.md" });
    const image = openAttachment("s1", { path: `${folder}/bbbbbb/shot.png`, name: "shot.png" });
    expect(new Set([first, second, image]).size).toBe(3);
    expect(getEditors().editors.find((e) => e.id === image)).toMatchObject({ kind: "attachment", media: "image" });
    expect(openAttachment("s1", { path: `${folder}/aaaaaa/plan.md`, name: "plan.md" })).toBe(first);
    expect(getEditors().editors).toHaveLength(3);
    expect(getTerminalState().selected.s1).toEqual({ kind: "review", id: first });
  });

  it("stay apart from an ordinary file tab of the same path", () => {
    const attachment = openAttachment("s1", { path: `${folder}/aaaaaa/plan.md`, name: "plan.md" });
    const plain = openFile("s1", folder, "aaaaaa/plan.md");
    expect(plain).not.toBe(attachment);
    expect(getEditors().editors.find((e) => e.id === plain)).not.toHaveProperty("attachment");
  });

  it("refuse a path that is not a stored file", () => {
    expect(() => openAttachment("s1", { path: "notes.md", name: "notes.md" })).toThrow();
    expect(() => openAttachment("s1", { path: `${folder}/../x/notes.md`, name: "notes.md" })).toThrow();
    expect(getEditors().editors).toHaveLength(0);
  });
});

describe("review stack (PRO-392)", () => {
  it("opens one Review tab per scope for every file, focused on the file opened, and restores it", () => {
    const first = openReviewStack("s", "/repo", "src/slug.js", { scope: "turn", range: { base: "base", head: "head" } });
    const again = openReviewStack("s", "/repo", "test/slug.test.js", { scope: "turn", range: { base: "base", head: "head" } });
    expect(again).toBe(first);
    const tabs = getEditors().editors.filter((e) => e.sessionId === "s");
    expect(tabs).toHaveLength(1);
    const entry = tabs[0]!;
    expect(entry).toMatchObject({ name: "Review · Latest turn", rel: "test/slug.test.js", kind: "diff", diff: { stack: true, focus: 1 } });
    expect(openReviewStack("s", "/repo", "a.ts", { scope: "all", range: { base: "b", head: null }, target: null, uncommitted: false })).not.toBe(first);
    expect(getEditors().editors.find((e) => e.id !== first && e.sessionId === "s")?.name).toBe("Review · All changes");
    const restored = restoreReviewTabs(serializeReviewTabs(getEditors())).editors.find((e) => e.id === first);
    expect(restored).toMatchObject({ kind: "diff", diff: { stack: true } });
  });
});
