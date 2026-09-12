// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fs, type LocalPathInfo } from "@/lib/api";
import { openBrowserTab } from "@/lib/browser";
import { openFile } from "@/lib/editors";
import { Markdown } from "./Markdown";

vi.mock("@/lib/theme", () => ({ useTheme: () => ({ resolvedMode: "light" }) }));
vi.mock("@/lib/api", () => ({ fs: { inspectPath: vi.fn(), openPath: vi.fn() } }));
vi.mock("@/lib/browser", () => ({ openBrowserTab: vi.fn().mockResolvedValue("page") }));
vi.mock("@/lib/editors", () => ({ fileKind: () => "text", openFile: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn(), openUrl: vi.fn(), revealItemInDir: vi.fn() }));

const context = { sessionId: "render-origin", cwd: "/workspace" };
const textFile = (path: string, rel: string): LocalPathInfo => ({ path, root: path.slice(0, -rel.length - 1), rel, kind: "file", text: true });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fs.inspectPath).mockImplementation(async (_base, path) => path.startsWith("/")
    ? textFile(path, path.split("/").pop()!)
    : ({ path: `/workspace/${path}`, root: "/workspace", rel: path, kind: "file", text: true }));
});
afterEach(cleanup);

describe("rendered chat links", () => {
  it("routes Markdown links and rendered autolinks through the same captured context", async () => {
    render(<Markdown text={'[source](src/index.ts:12:3)\n\n<http://localhost:4173/path?q=1#result>'} linkContext={context} />);
    fireEvent.click(await screen.findByRole("link", { name: "source" }));
    await waitFor(() => expect(openFile).toHaveBeenCalledWith("render-origin", "/workspace", "src/index.ts", { line: 12, col: 3 }, "/workspace"));

    fireEvent.click(screen.getByRole("link", { name: "http://localhost:4173/path?q=1#result" }));
    await waitFor(() => expect(openBrowserTab).toHaveBeenCalledWith("render-origin", "/workspace", "http://localhost:4173/path?q=1#result"));
  });

  it("preserves file URL line fragments and encoded literal delimiters through Streamdown", async () => {
    render(<Markdown text={'[jump](file:///tmp/note.md#L12C3) [literal](file:///tmp/report%23L12)'} linkContext={context} />);
    fireEvent.click(await screen.findByRole("link", { name: "jump" }));
    await waitFor(() => expect(fs.inspectPath).toHaveBeenCalledWith("/workspace", "/tmp/note.md"));
    expect(openFile).toHaveBeenCalledWith("render-origin", "/tmp", "note.md", { line: 12, col: 3 }, "/workspace");

    fireEvent.click(screen.getByRole("link", { name: "literal" }));
    await waitFor(() => expect(fs.inspectPath).toHaveBeenCalledWith("/workspace", "/tmp/report#L12"));
    expect(openFile).toHaveBeenLastCalledWith("render-origin", "/tmp", "report#L12", undefined, "/workspace");
  });

  it("routes reference-style file URLs and relative line targets without changing image definitions", async () => {
    render(<Markdown text={'[note][note-ref] [source][source-ref]\n\n![pixel][pixel-ref]\n\n[note-ref]: file:///tmp/note.md#L12\n[source-ref]: src/index.ts:7:2\n[pixel-ref]: data:image/gif;base64,R0lGODlhAQABAAAAACw='} linkContext={context} />);
    fireEvent.click(await screen.findByRole("link", { name: "note" }));
    await waitFor(() => expect(openFile).toHaveBeenCalledWith("render-origin", "/tmp", "note.md", { line: 12, col: undefined }, "/workspace"));
    fireEvent.click(screen.getByRole("link", { name: "source" }));
    await waitFor(() => expect(openFile).toHaveBeenCalledWith("render-origin", "/workspace", "src/index.ts", { line: 7, col: 2 }, "/workspace"));
    // The definition was not converted into a routed link; Streamdown retains
    // ownership of image safety and may block this deliberately tiny payload.
    expect(document.body.textContent).toContain("[Image blocked: pixel]");
  });

  it("routes top-level file line references and honors the first CommonMark definition", async () => {
    render(<Markdown text={'[readme](README.md:12) [main](main.rs:12:3) [first][same]\n\n[same]: first.md:4\n[same]: second.md:9'} linkContext={context} />);
    fireEvent.click(await screen.findByRole("link", { name: "readme" }));
    fireEvent.click(screen.getByRole("link", { name: "main" }));
    fireEvent.click(screen.getByRole("link", { name: "first" }));
    await waitFor(() => expect(openFile).toHaveBeenCalledTimes(3));
    expect(openFile).toHaveBeenNthCalledWith(1, "render-origin", "/workspace", "README.md", { line: 12, col: undefined }, "/workspace");
    expect(openFile).toHaveBeenNthCalledWith(2, "render-origin", "/workspace", "main.rs", { line: 12, col: 3 }, "/workspace");
    expect(openFile).toHaveBeenNthCalledWith(3, "render-origin", "/workspace", "first.md", { line: 4, col: undefined }, "/workspace");
  });

  it("keeps the chat workspace when following a web link from an outside Markdown preview", async () => {
    const { rerender } = render(<Markdown text="[outside](/tmp/Outside.md)" linkContext={context} />);
    fireEvent.click(await screen.findByRole("link", { name: "outside" }));
    await waitFor(() => expect(openFile).toHaveBeenCalledWith("render-origin", "/tmp", "Outside.md", undefined, "/workspace"));

    const previewContext = { ...context, basePath: "/tmp" };
    rerender(<Markdown text="[web](https://example.test/from-preview) [nested](nested/Next.md)" linkContext={previewContext} />);
    fireEvent.click(await screen.findByRole("link", { name: "web" }));
    await waitFor(() => expect(openBrowserTab).toHaveBeenCalledWith("render-origin", "/workspace", "https://example.test/from-preview"));
    fireEvent.click(screen.getByRole("link", { name: "nested" }));
    await waitFor(() => expect(fs.inspectPath).toHaveBeenLastCalledWith("/tmp", "nested/Next.md"));
  });

  it("keeps the routed link across streaming-to-static rendering and opens once per activation", async () => {
    const { rerender } = render(<Markdown text="Visit [docs](README.md)" streaming linkContext={context} />);
    expect(await screen.findByRole("link", { name: "docs" })).toBeTruthy();
    rerender(<Markdown text="Visit [docs](README.md)" linkContext={context} />);
    fireEvent.click(await screen.findByRole("link", { name: "docs" }));
    await waitFor(() => expect(fs.inspectPath).toHaveBeenCalledTimes(1));
    expect(openFile).toHaveBeenCalledTimes(1);
  });

  it("keeps a settled anchor, its focus, and its open context menu mounted while the stream tail changes", async () => {
    let resolve!: (value: LocalPathInfo) => void;
    vi.mocked(fs.inspectPath).mockReturnValue(new Promise((done) => { resolve = done; }));
    const settled = "[settled](README.md)\n\n" + "a".repeat(3100) + "\n\n";
    const { container, rerender } = render(<Markdown text={`${settled}first tail`} streaming linkContext={context} />);
    const before = await screen.findByRole("link", { name: "settled" });
    before.focus();
    rerender(<Markdown text={`${settled}second tail`} streaming linkContext={context} />);
    const focused = container.querySelector<HTMLAnchorElement>("a")!;
    expect(focused).toBe(before);
    expect(document.activeElement).toBe(before);

    fireEvent.contextMenu(before);
    expect(await screen.findByRole("menuitem", { name: "Checking destination…" })).toBeTruthy();

    rerender(<Markdown text={`${settled}changed tail`} streaming linkContext={context} />);
    const after = container.querySelector<HTMLAnchorElement>("a")!;
    expect(after).toBe(before);
    expect(screen.getByRole("menuitem", { name: "Checking destination…" })).toBeTruthy();
    resolve({ path: "/workspace/README.md", root: "/workspace", rel: "README.md", kind: "file", text: true });
    expect(await screen.findByRole("menuitem", { name: "Open internally" })).toBeTruthy();
  });

  it("routes keyboard-generated and middle-click activations exactly once each", async () => {
    render(<Markdown text="[site](https://example.test/path)" linkContext={context} />);
    const link = await screen.findByRole("link", { name: "site" });
    link.focus();
    link.click(); // Native click with detail=0 is the activation browsers emit for Enter on an anchor.
    await waitFor(() => expect(openBrowserTab).toHaveBeenCalledTimes(1));
    const middle = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    link.dispatchEvent(middle);
    expect(middle.defaultPrevented).toBe(true);
    await waitFor(() => expect(openBrowserTab).toHaveBeenCalledTimes(2));
  });

  it("blocks script links and displays a useful error instead of navigating", async () => {
    render(<Markdown text="[unsafe](javascript:alert(1))" linkContext={context} />);
    fireEvent.click(await screen.findByRole("link", { name: "unsafe" }));
    expect((await screen.findByRole("alert")).textContent).toContain("javascript: are not allowed");
    expect(openBrowserTab).not.toHaveBeenCalled();
    expect(fs.inspectPath).not.toHaveBeenCalled();
  });

  it("leaves raw HTML links under Streamdown's sanitizer instead of routing them", async () => {
    render(<Markdown text={'<a href="javascript:alert(1)">raw unsafe</a>'} linkContext={context} />);
    expect(screen.queryByRole("link", { name: "raw unsafe" })).toBeNull();
    expect(document.body.textContent).toContain("raw unsafe");
    expect(openBrowserTab).not.toHaveBeenCalled();
  });
});
