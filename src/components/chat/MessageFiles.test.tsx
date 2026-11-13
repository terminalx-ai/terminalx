// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`, invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), revealItemInDir: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn().mockResolvedValue(true),
  save: vi.fn(async () => { mocks.order.push("save"); return "/Users/me/Downloads/notes.md"; }),
}));
vi.mock("@/lib/browser", () => ({ openBrowserTab: vi.fn() }));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => {}) }));
vi.mock("@/components/chat/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div data-testid="markdown-preview">{text}</div> }));
vi.mock("@/lib/api", () => ({
  errorMessage: String,
  fs: { openMedia: vi.fn(), closeMedia: vi.fn().mockResolvedValue(undefined), mtime: vi.fn().mockResolvedValue(1), readText: vi.fn(), writeText: vi.fn() },
  api: { headTree: vi.fn().mockResolvedValue(null), fileContentsAt: vi.fn() },
  attachments: { saveCopy: vi.fn(async () => { mocks.order.push("saveCopy"); }) },
}));

import { TurnBlock, SendingMessage } from "./TurnBlock";
import { EditorSplit } from "@/components/editor/EditorSplit";
import { TooltipProvider } from "@/components/ui/tooltip";
import { buildTranscript } from "@/lib/transcript";
import { closeAllEditors, getEditors } from "@/lib/editors";
import { setPrefs } from "@/lib/prefs";
import { getTerminalState } from "@/lib/terminal";
import { api, attachments, fs } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { save } from "@tauri-apps/plugin-dialog";
import type { AgentEvent } from "@/types/events";

const SESSION = "files";
const FOLDER = "/Users/me/.terminalx/attachments/files/k3f9qa";
const NOTES = { path: `${FOLDER}/notes.md`, name: "notes.md", mediaType: "text/markdown", size: 24 };
const SHOT = { path: `${FOLDER}/shot.png`, name: "shot.png", mediaType: "image/png", size: 2048 };
// 14:31 on this machine's clock, whatever its zone: the tab says the local time.
const SENT = new Date(2026, 10, 13, 14, 31, 5).toISOString();

const sent = (files: typeof NOTES[]): AgentEvent[] => [{
  id: "e1", seq: 1, sessionId: SESSION, tabId: "tab", harness: "claude", ts: SENT, messageTs: SENT,
  payload: { type: "user_message", text: "Please read these", files, queued: false },
}];

function Session({ files }: { files: typeof NOTES[] }) {
  const [turn] = buildTranscript(sent(files), false).turns;
  return (
    <TooltipProvider>
      <div style={{ width: 1200 }}>
        <TurnBlock turn={turn} sessionId={SESSION} cwd="/repo" stream={[]} working={false} />
        <EditorSplit sessionId={SESSION} active />
      </div>
    </TooltipProvider>
  );
}

beforeEach(() => {
  mocks.order = [];
  setPrefs({ foldToolCalls: false });
  vi.mocked(fs.readText).mockResolvedValue({ content: "# Notes\n\nThe plan.", binary: false, truncated: false, mtimeMs: 1, size: 18 });
  vi.mocked(fs.openMedia).mockResolvedValue({ token: "grant", url: "http://127.0.0.1:1234/grant", mtimeMs: 1 });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(async () => { cleanup(); await closeAllEditors(SESSION); vi.clearAllMocks(); });

it("draws a chip per attached file on the sent message", () => {
  render(<Session files={[NOTES, SHOT]} />);
  const message = screen.getByTestId("reader-message");
  const chips = within(message).getAllByTestId("file-chip");
  expect(chips.map((chip) => chip.textContent)).toEqual(["notes.md", "shot.png"]);
  expect(within(message).getByRole("button", { name: "Open notes.md" })).toBeDefined();
  expect(within(message).getByRole("button", { name: "Open shot.png" })).toBeDefined();
  expect(chips[0].getAttribute("title")).toBe("~/.terminalx/attachments/files/k3f9qa/notes.md");
});

it("opens a chip's file in a read-only tab: its path, when it was sent, Preview first with a Source toggle", async () => {
  render(<Session files={[NOTES, SHOT]} />);
  fireEvent.click(screen.getByRole("button", { name: "Open notes.md" }));
  const toolbar = await screen.findByTestId("attachment-toolbar");
  expect(getEditors().editors).toMatchObject([{ sessionId: SESSION, root: "/Users/me/.terminalx/attachments/files", rel: "k3f9qa/notes.md", kind: "attachment", media: "text", viewMode: "preview", attachment: { path: NOTES.path, sentAt: SENT } }]);
  expect(within(toolbar).getByTestId("attachment-path").textContent).toBe("~/.terminalx/attachments/files/k3f9qa/notes.md");
  expect(within(toolbar).getByTestId("attachment-path").getAttribute("title")).toBe(NOTES.path);
  expect(within(toolbar).getByTestId("attachment-sent").textContent).toBe("on your message · 14:31");
  // A centre tab of the session (screen 03.22), beside its agent tabs, not a file in the side pane.
  expect(getTerminalState().selected[SESSION]).toEqual({ kind: "review", id: getEditors().editors[0].id });
  expect(screen.getByRole("tabpanel", { name: "notes.md" })).toBeDefined();
  // The copy that was sent: no Save, no git gutter.
  expect(within(toolbar).queryByRole("button", { name: "Save" })).toBeNull();
  expect(fs.readText).toHaveBeenCalledWith(NOTES.path);
  expect((await screen.findByTestId("markdown-preview")).textContent).toBe("# Notes\n\nThe plan.");
  expect(api.headTree).not.toHaveBeenCalled();
  expect(within(toolbar).getByRole("radio", { name: "Preview" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(within(toolbar).getByRole("radio", { name: "Source" }));
  await waitFor(() => expect(screen.queryByTestId("markdown-preview")).toBeNull());
  expect(getEditors().editors[0].viewMode).toBe("source");
  const source = document.querySelector(".editor-pane .cm-content");
  expect(source?.getAttribute("contenteditable")).toBe("false");
  fireEvent.click(within(toolbar).getByRole("radio", { name: "Preview" }));
  expect((await screen.findByTestId("markdown-preview")).textContent).toContain("The plan.");
});

it("focuses the tab the file already has when its chip is clicked again", async () => {
  render(<Session files={[NOTES, SHOT]} />);
  fireEvent.click(screen.getByRole("button", { name: "Open notes.md" }));
  await screen.findByTestId("attachment-toolbar");
  fireEvent.click(screen.getByRole("button", { name: "Open shot.png" }));
  await waitFor(() => expect(getEditors().editors).toHaveLength(2));
  expect(getEditors().editors[1]).toMatchObject({ kind: "attachment", media: "image", rel: "k3f9qa/shot.png" });
  fireEvent.click(screen.getByRole("button", { name: "Open notes.md" }));
  expect(getEditors().editors).toHaveLength(2);
  expect(getTerminalState().selected[SESSION]).toEqual({ kind: "review", id: getEditors().editors[0].id });
});

it("Copy writes the file's contents; Download asks where, then saves a copy there", async () => {
  render(<Session files={[NOTES]} />);
  fireEvent.click(screen.getByRole("button", { name: "Open notes.md" }));
  const toolbar = await screen.findByTestId("attachment-toolbar");
  await screen.findByTestId("markdown-preview");
  fireEvent.click(within(toolbar).getByRole("button", { name: "Copy" }));
  await waitFor(() => expect(copyText).toHaveBeenCalledWith("# Notes\n\nThe plan."));
  await waitFor(() => expect(within(toolbar).getByRole("button", { name: "Copy" }).textContent).toBe("Copied"));
  expect(screen.getByRole("status").textContent).toBe("Copied");
  fireEvent.click(within(toolbar).getByRole("button", { name: "Download" }));
  await waitFor(() => expect(attachments.saveCopy).toHaveBeenCalledWith(NOTES.path, "/Users/me/Downloads/notes.md"));
  expect(save).toHaveBeenCalledWith({ defaultPath: "notes.md" });
  expect(mocks.order).toEqual(["save", "saveCopy"]);
  await waitFor(() => expect(within(toolbar).getByRole("button", { name: "Download" }).textContent).toBe("Saved"));
  expect(screen.getByRole("status").textContent).toBe("Saved a copy of notes.md");
});

it("Download chosen and cancelled, and a refused copy, say what happened", async () => {
  render(<Session files={[NOTES]} />);
  fireEvent.click(screen.getByRole("button", { name: "Open notes.md" }));
  const toolbar = await screen.findByTestId("attachment-toolbar");
  vi.mocked(save).mockResolvedValueOnce(null);
  fireEvent.click(within(toolbar).getByRole("button", { name: "Download" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(attachments.saveCopy).not.toHaveBeenCalled();
  vi.mocked(attachments.saveCopy).mockRejectedValueOnce("The folder is read-only.");
  fireEvent.click(within(toolbar).getByRole("button", { name: "Download" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Could not download notes.md: The folder is read-only.");
});

it("Copy on a media file copies its path; the image opens in the media surface", async () => {
  render(<Session files={[SHOT]} />);
  fireEvent.click(screen.getByRole("button", { name: "Open shot.png" }));
  const toolbar = await screen.findByTestId("attachment-toolbar");
  await screen.findByRole("img", { name: "shot.png" });
  expect(fs.openMedia).toHaveBeenCalledWith("/Users/me/.terminalx/attachments/files", "k3f9qa/shot.png");
  expect(fs.readText).not.toHaveBeenCalled();
  expect(within(toolbar).queryByRole("radiogroup")).toBeNull();
  fireEvent.click(within(toolbar).getByRole("button", { name: "Copy" }));
  await waitFor(() => expect(copyText).toHaveBeenCalledWith(SHOT.path));
});

it("names the files of a message that is still sending, without opening them", () => {
  render(<SendingMessage message={{ text: "Here", images: [], files: [{ name: "draft.md" }, { name: "data.csv" }] }} cwd="/repo" />);
  const chips = screen.getAllByTestId("file-chip");
  expect(chips.map((chip) => chip.textContent)).toEqual(["draft.md", "data.csv"]);
  expect(screen.queryByRole("button", { name: /Open/ })).toBeNull();
});

it("a cloud session's files are named, not opened: they are not on this computer", () => {
  const [turn] = buildTranscript(sent([NOTES]), false).turns;
  render(<TurnBlock turn={turn} sessionId={SESSION} stream={[]} working={false} />);
  expect(screen.getByTestId("file-chip").textContent).toBe("notes.md");
  expect(screen.queryByRole("button", { name: "Open notes.md" })).toBeNull();
});
