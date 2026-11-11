// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, fs, git } from "@/lib/api";
import { closeAllEditors, closeEditor, getEditors, openFile, openDiff, setActiveEditor, setLastFocused } from "@/lib/editors";
import { ask } from "@tauri-apps/plugin-dialog";
import { liveEditorsFor } from "@/lib/editorViews";
import { selectSessionTab } from "@/lib/terminal";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setPrefs } from "@/lib/prefs";
import { copyText } from "@/lib/clipboard";
import { EditorSplit } from "./EditorSplit";
import { useChatFind } from "@/components/chat/ChatFind";
import { buildTranscript } from "@/lib/transcript";
import { useShortcut } from "@/lib/hotkeys";

vi.mock("@/lib/api", () => ({
  errorMessage: String,
  fs: { openMedia: vi.fn(), closeMedia: vi.fn().mockResolvedValue(undefined), mtime: vi.fn().mockResolvedValue(1), readText: vi.fn(), writeText: vi.fn().mockResolvedValue(2) },
  api: { headTree: vi.fn().mockResolvedValue(null), fileContentsAt: vi.fn(), diffMediaContent: vi.fn(), changesBetween: vi.fn().mockResolvedValue([]), reviewRange: vi.fn() },
  git: { discard: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn().mockResolvedValue(true) }));
vi.mock("@/components/chat/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => {}) }));
vi.mock("./PdfSurface", () => ({ default: ({ data }: { data: string }) => <div data-testid="pdf">{data}</div> }));

beforeEach(() => {
  setLastFocused("chat");
  setPrefs({ diffMode: "unified", diffHideWhitespace: false, diffWrap: true, diffWrapFiles: {} });
  vi.mocked(fs.mtime).mockResolvedValue(1);
  vi.mocked(fs.openMedia).mockResolvedValue({ token: "grant", url: "http://127.0.0.1:1234/grant", mtimeMs: 1 });
  vi.mocked(fs.readText).mockResolvedValue({ content: "<svg/>", binary: false, truncated: false, mtimeMs: 1, size: 6 });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(async () => { cleanup(); await closeAllEditors("split"); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it("dispatches media before text reading and keeps SVG save behavior while navigating existing tabs", async () => {
  const image = openFile("split", "/workspace", "photo.png");
  const { container } = render(<TooltipProvider><EditorSplit sessionId="split" active /></TooltipProvider>);
  await screen.findByRole("img", { name: "photo.png" });
  expect(fs.readText).not.toHaveBeenCalled();
  await waitFor(() => expect(getEditors().lastFocused).toBe("editor"));
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  let svg = "";
  act(() => { svg = openFile("split", "/workspace", "logo.svg"); });
  await waitFor(() => expect(liveEditorsFor("/workspace/logo.svg")).toHaveLength(1));
  act(() => liveEditorsFor("/workspace/logo.svg")[0].view.dispatch({ changes: { from: 0, to: 6, insert: '<svg id="edited"/>' } }));
  expect(getEditors().editors.find((e) => e.id === svg)?.dirty).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(fs.writeText).toHaveBeenCalledWith("/workspace/logo.svg", '<svg id="edited"/>'));
  act(() => { expect(openFile("split", "/workspace", "photo.png")).toBe(image); });
  expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
  expect(fs.readText).toHaveBeenCalledTimes(1);
  expect(liveEditorsFor("/workspace/photo.png")).toEqual([]);
});

it("pauses a player when a different tab is selected and unloads it on tab close", async () => {
  const video = openFile("split", "/workspace", "movie.mp4");
  const image = openFile("split", "/workspace", "photo.png");
  setActiveEditor("split", video);
  const { container } = render(<TooltipProvider><EditorSplit sessionId="split" active /></TooltipProvider>);
  await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
  const player = container.querySelector("video")!;
  vi.mocked(player.pause).mockClear();
  act(() => setActiveEditor("split", image));
  expect(player.pause).toHaveBeenCalledOnce();
  await act(() => closeEditor(video));
  expect(player.hasAttribute("src")).toBe(false);
  expect(fs.closeMedia).toHaveBeenCalledWith("grant");
});

it("keeps the diff, entire file, and unsaved editor mounted across guarded mode changes and session tab selection", async () => {
  vi.mocked(api.fileContentsAt).mockResolvedValue({ before: "old\n", after: "new\n" });
  vi.mocked(fs.readText).mockResolvedValue({ content: "new\n", binary: false, truncated: false, mtimeMs: 1, size: 4 });
  const id = openDiff("split", "/workspace", "app.ts", { scope: "turn", range: { base: "before", head: "after" } });
  const { container } = render(<TooltipProvider><EditorSplit sessionId="split" active /></TooltipProvider>);
  await screen.findByRole("radio", { name: "Edit" });
  await waitFor(() => expect(container.querySelector(".diff-pane .cm-scroller")).not.toBeNull());
  expect(screen.queryByRole("separator")).toBeNull();
  expect(document.activeElement?.contains(screen.getByTestId("diff-editor"))).toBe(true);
  expect(getEditors().lastFocused).toBe("editor");
  expect(container.querySelectorAll(".diff-pane")).toHaveLength(1);
  const diff = container.querySelector(".diff-pane")!;
  const scroller = diff.querySelector(".cm-scroller")!;
  scroller.scrollTop = 125;
  fireEvent.click(screen.getByRole("radio", { name: "Entire file" }));
  expect(screen.getByRole("radio", { name: "Entire file" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
  await waitFor(() => expect(liveEditorsFor("/workspace/app.ts")).toHaveLength(1));
  const editor = liveEditorsFor("/workspace/app.ts")[0].view;
  act(() => editor.dispatch({ changes: { from: 0, to: 3, insert: "unsaved" } }));
  vi.mocked(ask).mockResolvedValueOnce(false);
  fireEvent.click(screen.getByRole("radio", { name: "Diff" }));
  await waitFor(() => expect(ask).toHaveBeenCalled());
  expect(getEditors().editors.find((e) => e.id === id)).toMatchObject({ dirty: true, diff: { mode: "edit" } });
  vi.mocked(ask).mockResolvedValue(true);
  fireEvent.click(screen.getByRole("radio", { name: "Diff" }));
  await waitFor(() => expect(screen.getByRole("radio", { name: "Diff" }).getAttribute("aria-checked")).toBe("true"));
  expect(container.querySelector(".diff-pane")).toBe(diff);
  expect(scroller.scrollTop).toBe(125);
  expect(editor.state.doc.toString()).toBe("unsaved\n");
  let other = "";
  act(() => { other = openFile("split", "/workspace", "other.ts"); });
  await act(() => closeEditor(other));
  act(() => setActiveEditor("split", id));
  expect(liveEditorsFor("/workspace/app.ts")[0].view).toBe(editor);
  expect(editor.state.doc.toString()).toBe("unsaved\n");
  act(() => selectSessionTab("split", { kind: "agent", id: "agent" }));
  expect(screen.queryByRole("tabpanel")).toBeNull();
  act(() => setActiveEditor("split", id));
  expect(liveEditorsFor("/workspace/app.ts")[0].view).toBe(editor);
  fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(fs.writeText).toHaveBeenCalledWith("/workspace/app.ts", "unsaved\n"));
});

it("warns on external changes and protects a dirty buffer on re-entering Edit", async () => {
  vi.mocked(api.fileContentsAt).mockResolvedValue({ before: "old", after: "new" });
  vi.mocked(fs.readText).mockResolvedValue({ content: "new", binary: false, truncated: false, mtimeMs: 1, size: 3 });
  openDiff("split", "/workspace", "warning.ts", { scope: "all", range: { base: "base", head: "head" } });
  render(<TooltipProvider><EditorSplit sessionId="split" active /></TooltipProvider>);
  fireEvent.click(await screen.findByRole("radio", { name: "Edit" }));
  await waitFor(() => expect(liveEditorsFor("/workspace/warning.ts")).toHaveLength(1));
  const editor = liveEditorsFor("/workspace/warning.ts")[0].view;
  act(() => editor.dispatch({ changes: { from: 0, insert: "mine" } }));
  fireEvent.click(screen.getByRole("radio", { name: "Diff" }));
  await waitFor(() => expect(screen.getByRole("radio", { name: "Diff" }).getAttribute("aria-checked")).toBe("true"));
  vi.mocked(fs.mtime).mockResolvedValue(2);
  vi.mocked(fs.readText).mockResolvedValue({ content: "external", binary: false, truncated: false, mtimeMs: 2, size: 8 });
  fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
  await screen.findByText("This file changed on disk while you were editing.");
  expect(editor.state.doc.toString()).toBe("minenew");
  expect(fs.writeText).not.toHaveBeenCalled();
});

it("recovers the before path for a renamed file opened by a turn chip", async () => {
  vi.mocked(api.fileContentsAt).mockImplementation(async (_root, path) => path === "new.ts" ? { before: null, after: "new code" } : { before: "old code", after: null });
  vi.mocked(api.changesBetween).mockResolvedValue([{ path: "new.ts", oldPath: "old.ts", status: "renamed", additions: 1, deletions: 1 }]);
  openDiff("split", "/workspace", "new.ts", { scope: "turn", range: { base: "before", head: "after" } });
  const { container } = render(<TooltipProvider><EditorSplit sessionId="split" active /></TooltipProvider>);
  await screen.findByRole("radio", { name: "Edit" });
  expect(api.fileContentsAt).toHaveBeenCalledWith("/workspace", "old.ts", "before", "after");
  await waitFor(() => expect(container.querySelector(".diff-pane")?.textContent).toContain("old code"));
  expect(container.querySelector(".diff-pane")?.textContent).toContain("new code");
});


it("does not compare a large-file placeholder with working-file contents", async () => {
  vi.mocked(api.fileContentsAt).mockResolvedValue({ before: "old", after: "<file too large to show>" });
  openDiff("split", "/workspace", "large.ts", { scope: "turn", range: { base: "before", head: "after" } });
  render(<TooltipProvider><EditorSplit sessionId="split" active /></TooltipProvider>);
  await screen.findByRole("radio", { name: "Edit" });
  expect(screen.queryByText(/differs from this snapshot/)).toBeNull();
  expect(fs.readText).not.toHaveBeenCalled();
});


it("retains unsaved review edits when another session unmounts the entire view", async () => {
  vi.mocked(api.fileContentsAt).mockResolvedValue({ before: "old", after: "new" });
  vi.mocked(fs.readText).mockResolvedValue({ content: "new", binary: false, truncated: false, mtimeMs: 1, size: 3 });
  const id = openDiff("split", "/workspace", "session.ts", { scope: "turn", range: { base: "before", head: "after" } });
  const first = render(<TooltipProvider><EditorSplit sessionId="split" active /></TooltipProvider>);
  fireEvent.click(await screen.findByRole("radio", { name: "Edit" }));
  await waitFor(() => expect(liveEditorsFor("/workspace/session.ts")).toHaveLength(1));
  act(() => liveEditorsFor("/workspace/session.ts")[0].view.dispatch({ changes: { from: 0, to: 3, insert: "unsaved" } }));
  first.unmount();
  expect(getEditors().editors.find((e) => e.id === id)?.dirty).toBe(true);
  vi.mocked(fs.mtime).mockResolvedValue(2);
  vi.mocked(fs.readText).mockResolvedValue({ content: "external", binary: false, truncated: false, mtimeMs: 2, size: 8 });
  render(<TooltipProvider><EditorSplit sessionId="split" active /></TooltipProvider>);
  await waitFor(() => expect(liveEditorsFor("/workspace/session.ts")).toHaveLength(1));
  expect(liveEditorsFor("/workspace/session.ts")[0].view.state.doc.toString()).toBe("unsaved");
  expect(getEditors().editors.find((e) => e.id === id)?.dirty).toBe(true);
  await screen.findByText("This file changed on disk while you were editing.");
});

it("shares persisted diff options, file wrapping and exact-text copying with the centre tab", async () => {
  vi.mocked(api.fileContentsAt).mockResolvedValue({ before: "  const x = 1;\n", after: "const x=1;\n" });
  openDiff("split", "/workspace", "options.ts", { scope: "turn", range: { base: "before", head: "after" } });
  const first = render(<TooltipProvider><EditorSplit sessionId="split" active /></TooltipProvider>);
  await screen.findByRole("button", { name: "Copy file" });
  expect(first.container.querySelector(".cm-changedLine")).not.toBeNull();
  fireEvent.click(screen.getByLabelText("Hide whitespace changes"));
  expect(first.container.querySelector(".cm-changedLine")).toBeNull();
  fireEvent.change(screen.getByLabelText("Wrap lines for this file"), { target: { value: "false" } });
  expect(first.container.querySelector(".cm-lineWrapping")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Split" }));
  expect(first.container.querySelectorAll(".cm-content")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Copy file" }));
  await screen.findByText("Copied file");
  expect(copyText).toHaveBeenCalledWith("const x=1;\n");
  expect(api.fileContentsAt).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("radio", { name: "Entire file" }));
  const entire = first.container.querySelectorAll(".diff-pane")[1];
  expect(entire.textContent).toContain("const x=1;");
  expect(entire.querySelector(".cm-lineWrapping")).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "Diff" }));
  first.unmount();
  const second = render(<TooltipProvider><EditorSplit sessionId="split" active /></TooltipProvider>);
  await screen.findByRole("button", { name: "Copy file" });
  expect(screen.getByRole("button", { name: "Split" }).getAttribute("aria-pressed")).toBe("true");
  expect((screen.getByLabelText("Hide whitespace changes") as HTMLInputElement).checked).toBe(true);
  expect(second.container.querySelectorAll(".cm-content")).toHaveLength(2);
  expect(second.container.querySelector(".cm-lineWrapping")).toBeNull();
});

it("discards a live comparison from the centre diff header and refreshes it, but never a fixed snapshot", async () => {
  vi.mocked(api.fileContentsAt).mockResolvedValue({ before: "old\n", after: "new\n" });
  vi.mocked(api.reviewRange).mockResolvedValue({ base: "merge-base", head: "fresh", target: "main" });
  const id = openDiff("split", "/workspace", "live.ts", { scope: "all", range: { base: "merge-base", head: "snapshot" }, target: "main" });
  const view = render(<TooltipProvider><EditorSplit sessionId="split" active /></TooltipProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Discard changes to live.ts" }));
  expect(git.discard).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Discard" }));
  await waitFor(() => expect(git.discard).toHaveBeenCalledWith("/workspace", "live.ts", "merge-base", undefined));
  await waitFor(() => expect(getEditors().editors.find((e) => e.id === id)).toMatchObject({ diff: { range: { base: "merge-base", head: "fresh" } } }));
  view.unmount();
  await act(() => closeEditor(id));
  const fixed = openDiff("split", "/workspace", "fixed.ts", { scope: "turn", range: { base: "before", head: "after" }, turnLabel: "Commit 5be01f4" });
  expect(getEditors().editors.find((e) => e.id === fixed)?.name).toBe("fixed.ts · Commit 5be01f4");
  render(<TooltipProvider><EditorSplit sessionId="split" active /></TooltipProvider>);
  await screen.findByRole("radio", { name: "Edit" });
  expect(screen.queryByRole("button", { name: "Discard changes to fixed.ts" })).toBeNull();
});

it.each(["png", "pdf", "svg"])("keeps both revisions of a renamed %s visible in a centre diff", async (ext) => {
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: vi.fn(() => "blob:fixture"), revokeObjectURL: vi.fn() }));
  vi.mocked(api.diffMediaContent).mockImplementation(async (_root, path, tree) => ({ data: btoa(`${path}:${tree}`), mime: ext === "pdf" ? "application/pdf" : "image/png" }));
  vi.mocked(api.fileContentsAt).mockImplementation(async (_root, path) => ({ before: path === "old.svg" ? '<svg id="before"/>' : null, after: '<svg id="after"/>' }));
  openDiff("split", "/workspace", `new.${ext}`, { scope: "turn", oldPath: `old.${ext}`, range: { base: "before", head: "after" } });
  render(<TooltipProvider><EditorSplit sessionId="split" active /></TooltipProvider>);
  const before = await screen.findByRole("region", { name: "Before" });
  const after = screen.getByRole("region", { name: "After" });
  if (ext === "pdf") {
    expect((await within(before).findByTestId("pdf")).textContent).toBe(btoa("old.pdf:before"));
    expect((await within(after).findByTestId("pdf")).textContent).toBe(btoa("new.pdf:after"));
  } else {
    expect(await within(before).findByRole("img")).toBeTruthy();
    expect(await within(after).findByRole("img")).toBeTruthy();
  }
  if (ext === "svg") {
    expect(api.diffMediaContent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Raw SVG" }));
    expect(document.querySelector(".diff-pane")?.textContent).toContain('id="before"');
    expect(document.querySelector(".diff-pane")?.textContent).toContain('id="after"');
  } else {
    expect(api.diffMediaContent).toHaveBeenCalledWith("/workspace", `old.${ext}`, "before");
    expect(api.diffMediaContent).toHaveBeenCalledWith("/workspace", `new.${ext}`, "after");
    expect(api.fileContentsAt).not.toHaveBeenCalled();
    expect(screen.queryByRole("radio", { name: "Edit" })).toBeNull();
  }
});

const emptyTranscript = buildTranscript([], false);
function SearchableChat({ label }: { label: string }) {
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const find = useChatFind({ root, scroller, transcript: emptyTranscript, footerHeight: 0 });
  return <div ref={root} data-find-scope="chat">{find.bar}<div ref={scroller} /><textarea aria-label={label} /></div>;
}

it("routes Cmd+F to the focused chat, actual file editor, or terminal regardless of registration order", async () => {
  const terminalFind = vi.fn();
  function TerminalFind() {
    const frame = useRef<HTMLDivElement>(null);
    // PRO-246 (#837) registers this same focused-frame contract on files.find.
    useShortcut("files.find", () => {
      if (!frame.current?.contains(document.activeElement)) return false;
      terminalFind();
    });
    return <div ref={frame} className="terminal-host"><textarea aria-label="Terminal" /></div>;
  }
  openFile("split", "/workspace", "code.ts");
  render(<TooltipProvider><SearchableChat label="First chat" /><EditorSplit sessionId="split" active /><SearchableChat label="Second chat" /><TerminalFind /></TooltipProvider>);
  await waitFor(() => expect(liveEditorsFor("/workspace/code.ts")).toHaveLength(1));
  const editor = liveEditorsFor("/workspace/code.ts")[0].view;
  const first = screen.getByRole("textbox", { name: "First chat" });
  first.focus();
  fireEvent.keyDown(first, { key: "f", ctrlKey: true });
  expect(screen.getByRole("search", { name: "Find in chat" }).parentElement).toBe(first.parentElement);
  expect(document.querySelector(".cm-find")).toBeNull();
  act(() => editor.focus());
  fireEvent.keyDown(editor.contentDOM, { key: "f", ctrlKey: true });
  expect(await screen.findByRole("textbox", { name: "Find" })).toBeTruthy();
  expect(screen.getAllByRole("search", { name: "Find in chat" })).toHaveLength(1);
  const terminal = screen.getByRole("textbox", { name: "Terminal" });
  terminal.focus();
  fireEvent.keyDown(terminal, { key: "f", ctrlKey: true });
  expect(terminalFind).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(terminal);
  const second = screen.getByRole("textbox", { name: "Second chat" });
  second.focus();
  fireEvent.keyDown(second, { key: "f", ctrlKey: true });
  expect(screen.getAllByRole("search", { name: "Find in chat" })).toHaveLength(2);
  expect(document.activeElement?.parentElement?.closest('[data-find-scope="chat"]')).toBe(second.parentElement);
});
