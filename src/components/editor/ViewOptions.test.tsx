// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fs } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { closeAllEditors, getEditors, openFile, setViewMode, type FileEditorEntry } from "@/lib/editors";
import { getPrefs, setPrefs } from "@/lib/prefs";
import { registerFileSource, type FileSource } from "@/lib/workspaceFiles";
import { save } from "@tauri-apps/plugin-dialog";
import { EditorPane } from "./EditorPane";

vi.mock("@/lib/api", () => ({
  errorMessage: String,
  fs: { mtime: vi.fn().mockResolvedValue(1), readText: vi.fn(), writeText: vi.fn(), readWholeText: vi.fn(), exportFile: vi.fn().mockResolvedValue(1) },
  api: { headTree: vi.fn().mockResolvedValue(null), fileContentsAt: vi.fn() },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn().mockResolvedValue(true), save: vi.fn() }));
vi.mock("@/components/chat/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div data-testid="preview">{text}</div> }));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => {}) }));

const SESSION = "view-options";
const TEXT = "\tindented line\nsecond  line with spaces\n";

beforeEach(() => {
  setPrefs({ editorWrap: false, editorShowWhitespace: false });
  vi.mocked(fs.readText).mockResolvedValue({ content: TEXT, binary: false, truncated: false, mtimeMs: 1, size: TEXT.length });
});
afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  await closeAllEditors(SESSION);
});

function entryFor(rel: string, root = "/workspace", source?: string): FileEditorEntry {
  const id = openFile(SESSION, root, rel, undefined, root, source);
  return getEditors().editors.find((entry): entry is FileEditorEntry => entry.id === id && entry.kind !== "diff" && entry.kind !== "pr")!;
}

async function mount(rel = "notes.txt", root?: string, source?: string) {
  const entry = entryFor(rel, root, source);
  const rendered = render(<EditorPane entry={entry} visible />);
  await waitFor(() => expect(rendered.container.querySelector(".editor-pane .cm-editor")).not.toBeNull());
  await waitFor(() => expect(screen.getByRole("button", { name: "View options" }).hasAttribute("disabled")).toBe(false));
  return { ...rendered, entry };
}

const view = (container: HTMLElement) => EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
const openMenu = () => {
  fireEvent.pointerDown(screen.getByRole("button", { name: "View options" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
  return screen.getByRole("menu");
};

it("lists the four items in order, in Preview and in Source", async () => {
  const { entry } = await mount("README.md");
  for (const mode of ["preview", "source"] as const) {
    act(() => setViewMode(entry.id, mode));
    const menu = openMenu();
    expect(within(menu).getByText("View options")).toBeTruthy();
    const items = [...menu.querySelectorAll("[role^=menuitem]")].map((item) => item.textContent?.trim());
    expect(items).toEqual(["Wrap lines", "Show whitespace", expect.stringMatching(/^Copy file contents.+C$/), "Download"]);
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  }
});

it("wraps lines and shows whitespace at once, and the next file opens the same way", async () => {
  const first = await mount();
  expect(first.container.querySelector(".cm-lineWrapping")).toBeNull();
  expect(first.container.querySelector(".cm-highlightTab, .cm-highlightSpace")).toBeNull();

  fireEvent.click(within(openMenu()).getByRole("menuitemcheckbox", { name: "Wrap lines" }));
  // A toggle keeps the menu open, so both can be set in one visit.
  expect(screen.getByRole("menuitemcheckbox", { name: "Wrap lines" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Show whitespace" }));
  expect(first.container.querySelector(".cm-lineWrapping")).not.toBeNull();
  await waitFor(() => expect(first.container.querySelector(".cm-highlightTab")).not.toBeNull());
  expect(getPrefs()).toMatchObject({ editorWrap: true, editorShowWhitespace: true });
  first.unmount();

  const next = await mount("other.txt");
  expect(next.container.querySelector(".cm-lineWrapping")).not.toBeNull();
  expect(next.container.querySelector(".cm-highlightTab")).not.toBeNull();
  fireEvent.click(within(openMenu()).getByRole("menuitemcheckbox", { name: "Wrap lines" }));
  expect(next.container.querySelector(".cm-lineWrapping")).toBeNull();
  // Separate from the diff view's own wrap choice.
  expect(getPrefs().diffWrap).toBe(true);
});

it("copies the buffer, unsaved edits included, from the menu and with ⌥⌘C", async () => {
  const { container } = await mount();
  act(() => view(container).dispatch({ changes: { from: 0, insert: "new " } }));
  fireEvent.click(within(openMenu()).getByRole("menuitem", { name: /Copy file contents/ }));
  await waitFor(() => expect(copyText).toHaveBeenCalledWith(`new ${TEXT}`));
  expect(await screen.findByText("Copied the file's contents")).toBeTruthy();

  vi.mocked(copyText).mockClear();
  view(container).focus();
  // Mod is Ctrl off macOS, as in jsdom.
  fireEvent.keyDown(view(container).contentDOM, { key: "c", code: "KeyC", altKey: true, ctrlKey: true });
  await waitFor(() => expect(copyText).toHaveBeenCalledWith(`new ${TEXT}`));
});

it("copies the whole file when only its start is shown", async () => {
  vi.mocked(fs.readText).mockResolvedValue({ content: "start", binary: false, truncated: true, mtimeMs: 1, size: 9_000_000 });
  vi.mocked(fs.readWholeText).mockResolvedValue("start and the rest");
  await mount("big.log");
  fireEvent.click(screen.getByRole("button", { name: "Copy file contents" }));
  await waitFor(() => expect(copyText).toHaveBeenCalledWith("start and the rest"));
  expect(fs.readWholeText).toHaveBeenCalledWith("/workspace/big.log");
});

it("says so when a copy fails", async () => {
  vi.mocked(copyText).mockRejectedValueOnce(new Error("pasteboard busy"));
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Copy file contents" }));
  expect(await screen.findByText(/Could not copy the file: .*pasteboard busy/)).toBeTruthy();
});

it("downloads a local file byte for byte, or its unsaved buffer, to the chosen place", async () => {
  vi.mocked(save).mockResolvedValue("/Users/me/Downloads/notes.txt");
  const { container } = await mount("docs/notes.txt");
  fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "Download" }));
  await waitFor(() => expect(fs.exportFile).toHaveBeenCalledWith("/Users/me/Downloads/notes.txt", { from: "/workspace/docs/notes.txt" }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "notes.txt" }));
  expect(await screen.findByText("Saved a copy to /Users/me/Downloads/notes.txt")).toBeTruthy();

  act(() => view(container).dispatch({ changes: { from: 0, insert: "draft " } }));
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  await waitFor(() => expect(fs.exportFile).toHaveBeenLastCalledWith("/Users/me/Downloads/notes.txt", { content: `draft ${TEXT}` }));
});

it("writes nothing when the save dialog is cancelled", async () => {
  vi.mocked(save).mockResolvedValue(null);
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(fs.exportFile).not.toHaveBeenCalled();
});

it("downloads a cloud workspace's file as its text", async () => {
  const key = "cloud:org-1:ws-1";
  const cloud: FileSource = {
    key,
    kind: "cloud",
    readOnly: true,
    listDir: async () => [],
    readText: async () => ({ content: "remote text\n", size: 12, binary: false, truncated: false, version: "v1", etag: "e1" }),
    writeText: async () => ({ version: "v2" }),
    stat: async () => ({ version: "v1", etag: "e1" }),
    watch: () => () => {},
  };
  const unregister = registerFileSource(cloud);
  try {
    vi.mocked(save).mockResolvedValue("/Users/me/Downloads/main.rs");
    await mount("src/main.rs", `cloud://${key}`, key);
    expect(screen.queryByRole("button", { name: "Reveal in Finder" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(fs.exportFile).toHaveBeenCalledWith("/Users/me/Downloads/main.rs", { content: "remote text\n" }));
  } finally {
    unregister();
  }
});
