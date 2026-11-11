// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fs } from "@/lib/api";
import { closeAllEditors, closeEditor, getEditors, openFile, setActiveEditor, setLastFocused } from "@/lib/editors";
import { liveEditorsFor } from "@/lib/editorViews";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EditorSplit } from "./EditorSplit";
import { useChatFind } from "@/components/chat/ChatFind";
import { buildTranscript } from "@/lib/transcript";
import { useShortcut } from "@/lib/hotkeys";

vi.mock("@/lib/api", () => ({
  fs: { openMedia: vi.fn(), closeMedia: vi.fn().mockResolvedValue(undefined), mtime: vi.fn(), readText: vi.fn(), writeText: vi.fn() },
  api: { headTree: vi.fn().mockResolvedValue(null) },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn().mockResolvedValue(true) }));
vi.mock("@/components/chat/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));

beforeEach(() => {
  setLastFocused("chat");
  // A save updates the version seen by the editor's periodic disk check.
  const mtimes = new Map<string, number>();
  vi.mocked(fs.mtime).mockImplementation(async (path) => mtimes.get(path) ?? 1);
  vi.mocked(fs.writeText).mockImplementation(async (path) => {
    mtimes.set(path, 2);
    return 2;
  });
  vi.mocked(fs.openMedia).mockResolvedValue({ token: "grant", url: "http://127.0.0.1:1234/grant", mtimeMs: 1 });
  vi.mocked(fs.readText).mockResolvedValue({ content: "<svg/>", binary: false, truncated: false, mtimeMs: 1, size: 6 });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(async () => { cleanup(); await closeAllEditors("split"); vi.restoreAllMocks(); vi.clearAllMocks(); });

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
