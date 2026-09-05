import { afterEach, describe, expect, it, vi } from "vitest";
import { ask } from "@tauri-apps/plugin-dialog";
import { closeAllEditors, closeEditor, fileKind, getEditors, openFile, setEditorDirty, setPaneCollapsed, setViewMode, toggleViewMode } from "./editors";
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
});
