// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAllEditors, getEditors, openFile } from "@/lib/editors";
import { registerFileSource, type FileSource, type FileState } from "@/lib/workspaceFiles";
import { EditorPane } from "./EditorPane";

vi.mock("@/lib/api", () => ({ api: { headTree: vi.fn(), fileContentsAt: vi.fn() }, fs: {} }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

const SESSION = "cloud:org-1:ws-1";
const KEY = SESSION;

/** A cloud workspace's files in memory, with the runtime's conditional writes and change notifications. */
class FakeCloud implements FileSource {
  readonly key = KEY;
  readonly kind = "cloud" as const;
  files = new Map<string, { text: string; version: number }>();
  listeners = new Set<(paths: string[] | null) => void>();
  writes: { rel: string; text: string; base: string | undefined }[] = [];
  constructor(readonly readOnly = false) {}

  private state(rel: string): FileState | null {
    const file = this.files.get(rel);
    return file ? { version: `v${file.version}`, etag: `etag:${file.text}` } : null;
  }
  listDir = async () => [];
  readText = async (rel: string) => {
    const file = this.files.get(rel);
    if (!file) throw Object.assign(new Error("not_found"), { code: "not_found" });
    return { content: file.text, size: file.text.length, binary: false, truncated: false, ...this.state(rel)! };
  };
  writeText = async (rel: string, text: string, base: string | undefined) => {
    this.writes.push({ rel, text, base });
    const current = this.state(rel);
    if (base !== undefined && current?.etag !== base) throw Object.assign(new Error("conflict"), { code: "conflict" });
    this.files.set(rel, { text, version: (this.files.get(rel)?.version ?? 0) + 1 });
    return this.state(rel)!;
  };
  stat = async (rel: string) => this.state(rel);
  watch = (listener: (paths: string[] | null) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  /** Someone else (an agent in the workspace) edits the file. */
  agentWrites(rel: string, text: string) {
    this.files.set(rel, { text, version: (this.files.get(rel)?.version ?? 0) + 1 });
    for (const listener of this.listeners) listener([rel]);
  }
  reconnected() {
    for (const listener of this.listeners) listener(null);
  }
}

let cloud: FakeCloud;
let unregister: () => void;

beforeEach(() => {
  cloud = new FakeCloud();
  cloud.files.set("src/main.rs", { text: "fn main() {}\n", version: 1 });
  unregister = registerFileSource(cloud);
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON() {} }) as DOMRect;
});

afterEach(async () => {
  cleanup();
  unregister();
  const { ask } = await import("@tauri-apps/plugin-dialog");
  vi.mocked(ask).mockResolvedValue(true);
  await closeAllEditors(SESSION);
});

function open(rel = "src/main.rs") {
  const id = openFile(SESSION, `cloud://${KEY}`, rel, undefined, `cloud://${KEY}`, KEY);
  return getEditors().editors.find((entry) => entry.id === id)!;
}

function view(container: HTMLElement): EditorView {
  const dom = container.querySelector(".cm-editor") as HTMLElement;
  return EditorView.findFromDOM(dom)!;
}

async function mount(rel = "src/main.rs") {
  const entry = open(rel);
  const rendered = render(<EditorPane entry={entry} visible />);
  await ready(rendered.container);
  return { ...rendered, entry };
}

/** The editor is shown (and follows the file) once it is ready. */
async function ready(container: HTMLElement) {
  await waitFor(() => expect(container.querySelector(".editor-pane:not(.hidden) .cm-editor")).not.toBeNull());
}

function type(container: HTMLElement, text: string) {
  const editor = view(container);
  act(() => editor.dispatch({ changes: { from: editor.state.doc.length, insert: text } }));
}

describe("a cloud workspace file in the editor", () => {
  it("saves conditionally on the content it was read at", async () => {
    const { container } = await mount();
    expect(screen.getByTestId("editor-cloud-file")).toBeTruthy();
    expect(screen.queryByLabelText("Reveal in Finder")).toBeNull();
    type(container, "// mine\n");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(cloud.files.get("src/main.rs")!.text).toBe("fn main() {}\n// mine\n"));
    expect(cloud.writes[0]!.base).toBe("etag:fn main() {}\n");
    await waitFor(() => expect(getEditors().editors[0]!.dirty).toBe(false));
  });

  it("follows an agent's edit while clean, and asks while dirty", async () => {
    const { container } = await mount();
    act(() => cloud.agentWrites("src/main.rs", "fn main() { agent(); }\n"));
    await waitFor(() => expect(view(container).state.doc.toString()).toBe("fn main() { agent(); }\n"));

    type(container, "// mine\n");
    act(() => cloud.agentWrites("src/main.rs", "fn main() { agent2(); }\n"));
    await screen.findByText("This file changed on disk while you were editing.");
    expect(view(container).state.doc.toString()).toBe("fn main() { agent(); }\n// mine\n");
  });

  it("never overwrites a concurrent edit without an explicit choice", async () => {
    const { container } = await mount();
    type(container, "// mine\n");
    // The agent's change lands without a notification reaching us first.
    cloud.files.set("src/main.rs", { text: "fn main() { agent(); }\n", version: 9 });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByTestId("editor-conflict");
    expect(cloud.files.get("src/main.rs")!.text).toBe("fn main() { agent(); }\n");
    expect(getEditors().editors[0]!.dirty).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Overwrite with mine" }));
    await waitFor(() => expect(cloud.files.get("src/main.rs")!.text).toBe("fn main() {}\n// mine\n"));
    // The overwrite was still conditional, on the version it chose to replace.
    expect(cloud.writes.at(-1)!.base).toBe("etag:fn main() { agent(); }\n");
    await waitFor(() => expect(screen.queryByTestId("editor-conflict")).toBeNull());
  });

  it("can take theirs instead", async () => {
    const { container } = await mount();
    type(container, "// mine\n");
    cloud.files.set("src/main.rs", { text: "theirs\n", version: 9 });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard mine and reload" }));
    await waitFor(() => expect(view(container).state.doc.toString()).toBe("theirs\n"));
    expect(getEditors().editors[0]!.dirty).toBe(false);
  });

  it("keeps an unsaved buffer across a reconnect and while the workspace is closed", async () => {
    const { container, entry, unmount } = await mount();
    type(container, "// unsaved\n");
    // Reconnected: nothing changed on the runtime, so nothing is reloaded.
    act(() => cloud.reconnected());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view(container).state.doc.toString()).toBe("fn main() {}\n// unsaved\n");
    expect(screen.queryByText("This file changed on disk while you were editing.")).toBeNull();

    // The workspace page closes: the source goes away, the text is kept.
    act(() => unregister());
    expect(await screen.findByText(/Open the cloud workspace to read main.rs/)).toBeTruthy();
    unmount();
    expect(getEditors().editors[0]!.dirty).toBe(true);

    // Reopened, after an agent changed the file meanwhile.
    cloud.files.set("src/main.rs", { text: "fn main() { agent(); }\n", version: 5 });
    unregister = registerFileSource(cloud);
    const again = render(<EditorPane entry={getEditors().editors.find((e) => e.id === entry.id)!} visible />);
    await ready(again.container);
    expect(view(again.container).state.doc.toString()).toBe("fn main() {}\n// unsaved\n");
    await screen.findByText("This file changed on disk while you were editing.");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByTestId("editor-conflict");
    expect(cloud.files.get("src/main.rs")!.text).toBe("fn main() { agent(); }\n");
  });

  it("is read-only for a participant", async () => {
    unregister();
    cloud = new FakeCloud(true);
    cloud.files.set("src/main.rs", { text: "fn main() {}\n", version: 1 });
    unregister = registerFileSource(cloud);
    const { container } = await mount();
    expect(screen.getByText("read-only")).toBeTruthy();
    expect(view(container).state.readOnly).toBe(true);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
