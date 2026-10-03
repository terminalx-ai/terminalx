import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dragDropListener, write, readImage, droppedText } = vi.hoisted(() => ({
  droppedText: vi.fn(async (): Promise<string | null> => "echo dragged"),
  dragDropListener: vi.fn(),
  write: vi.fn(async (_id: string, _data: string) => {}),
  readImage: vi.fn(async (path: string) => ({ mediaType: "image/png", data: "AAAA", name: path.split("/").pop()! })),
}));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: dragDropListener }) }));
vi.mock("@/lib/terminalWebgl", () => ({ showWebgl: vi.fn(), hideWebgl: vi.fn() }));
// A local pane's xterm attaches to its output and detaches when it is disposed; only what it types matters here.
vi.mock("@/lib/api", () => {
  const quiet = () => vi.fn(async () => {});
  return {
    pty: { write, resize: quiet(), attach: quiet(), detach: quiet(), detachAll: quiet(), ack: quiet() },
    files: { readImage, droppedText },
  };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { useRef, useState } from "react";
import { AttachmentThumbs, DropHint, useImageAttachments } from "@/components/chat/useImageAttachments";
import { TerminalView } from "./TerminalView";
import { disposeInstance, peekInstance, type TerminalInstance } from "@/lib/terminal";

type DragEvent = { payload: { type: string; paths?: string[]; position?: { x: number; y: number } } };

/** The pane's own xterm, a real one: the paste goes the way a typed key does, and the program's paste mode is the terminal's own. */
const local = () => peekInstance("p1")!;

/** A terminal somebody else wires, as every cloud terminal is. */
function remote(): TerminalInstance {
  const el = document.createElement("div");
  const term = new Terminal({ allowProposedApi: true });
  term.open(el);
  term.onData((data) => void write("p1", data));
  return { el, term, fit: {} } as never;
}

/** Feed the program's output to the terminal and wait until it is parsed. */
const output = (inst: TerminalInstance, data: string) => new Promise<void>((done) => inst.term.write(data, done));

async function mount(props: Partial<Parameters<typeof TerminalView>[0]> = {}) {
  const view = render(<TerminalView id="p1" visible {...props} />);
  const inst = local();
  await waitFor(() => expect(dragDropListener).toHaveBeenCalledOnce());
  const onDrag = dragDropListener.mock.calls[0][0] as (e: DragEvent) => Promise<void>;
  const frame = view.getByTestId("terminal-drop-target");
  // jsdom lays nothing out: the pointer is over the terminal when the test says so.
  const over = (el: Element | null) => (document.elementFromPoint = () => el);
  over(frame);
  return { inst, view, frame, over, drag: (payload: DragEvent["payload"]) => act(() => onDrag({ payload: { position: { x: 5, y: 5 }, ...payload } })) };
}

beforeEach(() => {
  vi.clearAllMocks();
  // xterm asks for the pixel ratio when it is opened; jsdom has no matchMedia.
  window.matchMedia ??= (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) as never;
  dragDropListener.mockResolvedValue(vi.fn());
  disposeInstance("p1");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** A composer's drop handling beside a terminal, as an agent tab and a shell tab are in one window. */
function ComposerBesideTerminal() {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const attach = useImageAttachments({ textareaRef: ref, draft, onDraftChange: setDraft });
  return (
    <>
      <div data-testid="composer" {...attach.dropZoneProps}>
        <DropHint dragging={attach.dragging} />
        <AttachmentThumbs attach={attach} />
        <textarea ref={ref} value={draft} onChange={(e) => setDraft(e.target.value)} />
      </div>
      <TerminalView id="p1" visible />
    </>
  );
}

describe("a window with a composer and a terminal", () => {
  async function mountBoth() {
    render(<ComposerBesideTerminal />);
    // One subscription for the webview, whoever is listening.
    await waitFor(() => expect(dragDropListener).toHaveBeenCalledOnce());
    const onDrag = dragDropListener.mock.calls[0][0] as (e: DragEvent) => Promise<void>;
    let under: Element | null = null;
    document.elementFromPoint = () => under;
    return {
      over: (testId: string | null) => (under = testId ? screen.getByTestId(testId) : document.body),
      drag: (payload: DragEvent["payload"]) => act(() => onDrag({ payload: { position: { x: 5, y: 5 }, ...payload } })),
    };
  }

  it("a drop on the terminal types the path and attaches nothing", async () => {
    const { over, drag } = await mountBoth();
    over("terminal-drop-target");
    await drag({ type: "enter", paths: ["/tmp/shot.png"] });
    expect(screen.getByText("Drop to type the file's path")).toBeTruthy();
    expect(screen.queryByText("Drop images to attach, other files to mention")).toBeNull();
    await drag({ type: "drop", paths: ["/tmp/shot.png"] });
    expect(write).toHaveBeenCalledExactlyOnceWith("p1", "/tmp/shot.png ");
    expect(readImage).not.toHaveBeenCalled();
    expect(screen.queryByAltText("shot.png")).toBeNull();
    expect(screen.getByTestId("composer").querySelector("textarea")!.value).toBe("");
  });

  it("a drop on the composer, or on neither, still attaches and types nothing", async () => {
    const { over, drag } = await mountBoth();
    over("composer");
    await drag({ type: "enter", paths: ["/tmp/shot.png"] });
    expect(screen.getByText("Drop images to attach, other files to mention")).toBeTruthy();
    expect(screen.queryByText("Drop to type the file's path")).toBeNull();
    await drag({ type: "drop", paths: ["/tmp/shot.png"] });
    expect(await screen.findByAltText("shot.png")).toBeTruthy();

    over(null);
    await drag({ type: "drop", paths: ["/tmp/other.png"] });
    expect(await screen.findByAltText("other.png")).toBeTruthy();
    expect(write).not.toHaveBeenCalled();
  });
});

describe("dropping on a terminal", () => {
  it("types the quoted paths at the cursor, with no Enter", async () => {
    const { drag } = await mount();
    await drag({ type: "drop", paths: ["/tmp/a.png", "/tmp/my shot's $HOME `x`.png"] });
    expect(write).toHaveBeenCalledExactlyOnceWith("p1", "/tmp/a.png /tmp/my\\ shot\\'s\\ \\$HOME\\ \\`x\\`.png ");
    expect(write.mock.calls.flat().join("")).not.toMatch(/[\r\n]/);
  });

  it("brackets the paste when the program asked for it", async () => {
    const { drag, inst } = await mount();
    await output(inst, "\x1b[?2004h");
    await drag({ type: "drop", paths: ["/tmp/a b.png"] });
    expect(write).toHaveBeenCalledExactlyOnceWith("p1", "\x1b[200~/tmp/a\\ b.png \x1b[201~");
  });

  it("never types a raw newline or escape from a file's name", async () => {
    const { drag } = await mount();
    await drag({ type: "drop", paths: ["/tmp/a\nrm -rf x\x1b[201~.txt"] });
    expect(write).toHaveBeenCalledExactlyOnceWith("p1", "/tmp/a$'\\n'rm\\ -rf\\ x$'\\x1b'\\[201\\~.txt ");
  });

  it("shows a drop target while a file is over it", async () => {
    const { drag, over } = await mount();
    await drag({ type: "enter", paths: ["/tmp/a.png"] });
    expect(screen.getByText("Drop to type the file's path")).toBeTruthy();
    over(document.body);
    await drag({ type: "over" });
    expect(screen.queryByText("Drop to type the file's path")).toBeNull();
    over(screen.getByTestId("terminal-drop-target"));
    await drag({ type: "over" });
    expect(screen.getByText("Drop to type the file's path")).toBeTruthy();
    await drag({ type: "leave" });
    expect(screen.queryByText("Drop to type the file's path")).toBeNull();
  });

  it("ignores a drop that lands elsewhere, and a hidden terminal takes none", async () => {
    const { drag, over, view } = await mount();
    over(document.body);
    await drag({ type: "drop", paths: ["/tmp/a.png"] });
    expect(write).not.toHaveBeenCalled();

    over(view.getByTestId("terminal-drop-target"));
    view.rerender(<TerminalView id="p1" visible={false} />);
    await drag({ type: "drop", paths: ["/tmp/a.png"] });
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses files with the reason and types nothing", async () => {
    const { drag } = await mount({ dropRefusal: { files: "Files can't be dropped on a cloud terminal yet." } });
    await drag({ type: "enter", paths: ["/tmp/a.png"] });
    expect(screen.getByText("Files can't be dropped on a cloud terminal yet.")).toBeTruthy();
    await drag({ type: "drop", paths: ["/tmp/a.png"] });
    expect(write).not.toHaveBeenCalled();
    // The reason stays up after the drop, so a quick drop is not a silent one.
    expect(screen.getByRole("status").textContent).toBe("Files can't be dropped on a cloud terminal yet.");
  });

  it("pastes text dragged in from another app, which arrives as a drop with no paths", async () => {
    const { drag, inst } = await mount();
    await drag({ type: "enter", paths: [] });
    expect(screen.getByText("Drop to paste the text")).toBeTruthy();
    await output(inst, "\x1b[?2004h");
    await drag({ type: "drop", paths: [] });
    expect(write).toHaveBeenCalledExactlyOnceWith("p1", "\x1b[200~echo dragged\x1b[201~");
  });

  it("strips control characters from dragged text, so it cannot leave the bracketed paste", async () => {
    droppedText.mockResolvedValueOnce("ls\x1b[201~\rwhoami\n");
    const { drag, inst } = await mount();
    await output(inst, "\x1b[?2004h");
    await drag({ type: "drop", paths: [] });
    // One paste, one end marker, and it is the terminal's own.
    expect(write).toHaveBeenCalledExactlyOnceWith("p1", "\x1b[200~ls[201~\rwhoami\x1b[201~");
  });

  it("refuses more than a megabyte of dragged text, and says so", async () => {
    droppedText.mockResolvedValueOnce("x".repeat(1024 * 1024 + 1));
    const { drag } = await mount();
    await drag({ type: "drop", paths: [] });
    expect(write).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("That is too much text to drop on a terminal (over 1 MB).");
  });

  it("types multi-line dragged text as one line when the program has no bracketed paste", async () => {
    droppedText.mockResolvedValueOnce("echo one\r\nrm -rf x\x1b\nlast\n");
    const { drag } = await mount();
    await drag({ type: "drop", paths: [] });
    expect(write).toHaveBeenCalledExactlyOnceWith("p1", "echo one rm -rf x last");
  });

  it("a terminal that is not on this computer takes neither files nor text unless it says so", async () => {
    const inst = remote();
    const { drag } = await mount({ create: () => inst });
    await drag({ type: "enter", paths: ["/Users/me/a.png"] });
    expect(screen.getByText(/can't be dropped on a cloud terminal/)).toBeTruthy();
    await drag({ type: "drop", paths: ["/Users/me/a.png"] });
    expect(screen.getByRole("status").textContent).toMatch(/can't be dropped on a cloud terminal/);
    await drag({ type: "drop", paths: [] });
    expect(screen.getByRole("status").textContent).toBe("Nothing can be dropped on this terminal.");
    // Taken only to be thrown away: the text does not stay readable after a refused drop.
    expect(droppedText).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
  });

  it("types nothing when a drop carries neither files nor text", async () => {
    droppedText.mockResolvedValueOnce(null);
    const { drag } = await mount();
    await drag({ type: "drop", paths: [] });
    expect(write).not.toHaveBeenCalled();
  });

  it("throws the dragged text away for someone who cannot type there", async () => {
    const { drag } = await mount({ dropRefusal: { files: "View only.", text: "View only." } });
    await drag({ type: "drop", paths: [] });
    // Taken only to be thrown away: the text does not stay readable after a refused drop.
    expect(droppedText).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("View only.");
  });

  it("pastes dropped text as text", async () => {
    const { frame } = await mount();
    const dataTransfer = { types: ["text/plain"], getData: () => "echo hi", files: [] };
    fireEvent.dragOver(frame, { dataTransfer });
    expect(screen.getByText("Drop to paste the text")).toBeTruthy();
    fireEvent.drop(frame, { dataTransfer });
    await waitFor(() => expect(write).toHaveBeenCalledExactlyOnceWith("p1", "echo hi"));
    expect(screen.queryByText("Drop to paste the text")).toBeNull();
  });

  it("refuses dropped text for someone who cannot type there", async () => {
    const { frame } = await mount({ dropRefusal: { files: "View only.", text: "View only." } });
    fireEvent.drop(frame, { dataTransfer: { types: ["text/plain"], getData: () => "echo hi", files: [] } });
    expect(write).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("View only.");
  });
});
