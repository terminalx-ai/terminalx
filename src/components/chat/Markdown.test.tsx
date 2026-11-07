// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fs, type LocalPathInfo } from "@/lib/api";
import { openBrowserTab } from "@/lib/browser";
import { openFile } from "@/lib/editors";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { Markdown } from "./Markdown";
import { setPrefs } from "@/lib/prefs";

vi.mock("@/lib/theme", () => ({ useTheme: () => ({ resolvedMode: "light" }) }));
vi.mock("@/lib/api", () => ({ fs: { inspectPath: vi.fn(), openPath: vi.fn() } }));
vi.mock("@/lib/browser", () => ({ openBrowserTab: vi.fn().mockResolvedValue("page") }));
vi.mock("@/lib/editors", () => ({ fileKind: () => "text", openFile: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn(), openUrl: vi.fn(), revealItemInDir: vi.fn() }));

const context = { sessionId: "render-origin", cwd: "/workspace" };
const textFile = (path: string, rel: string): LocalPathInfo => ({ path, root: path.slice(0, -rel.length - 1), rel, kind: "file", text: true });

beforeEach(() => {
  vi.clearAllMocks();
  setPrefs({ linkBrowser: "system" });
  vi.mocked(fs.inspectPath).mockImplementation(async (_base, path) => path.startsWith("/")
    ? textFile(path, path.split("/").pop()!)
    : ({ path: `/workspace/${path}`, root: "/workspace", rel: path, kind: "file", text: true }));
});
afterEach(cleanup);

describe("rendered chat links", () => {
  it("activates URLs inside inline code and fenced code, and copies the destination", async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: copy }, configurable: true });
    render(<Markdown text={'`https://example.test/inline`\n\n```js\nconst url = "https://example.test/code?q=1#part";\n```'} linkContext={context} />);
    const code = await screen.findByRole("link", { name: "https://example.test/code?q=1#part" });
    fireEvent.click(code);
    expect(openUrl).toHaveBeenCalledWith("https://example.test/code?q=1#part");
    expect(screen.getByRole("link", { name: "https://example.test/inline" })).toBeDefined();
    fireEvent.contextMenu(code);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy link" }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith("https://example.test/code?q=1#part"));
    expect(document.querySelector("pre code")?.textContent).toBe('const url = "https://example.test/code?q=1#part";');
  });

  it("opens and copies links on cloud transcripts that have no local workspace", async () => {
    setPrefs({ linkBrowser: "terminalx" });
    render(<Markdown text="[Docs](https://example.test/cloud)" />);
    fireEvent.click(screen.getByRole("link", { name: "Docs" }));
    expect(openUrl).toHaveBeenCalledWith("https://example.test/cloud");
    expect(openBrowserTab).not.toHaveBeenCalled();
  });
  it("offers the chooser for Markdown links and autolinks in ask mode", async () => {
    setPrefs({ linkBrowser: "ask" });
    render(<Markdown text={'[site](https://example.test)\n\n<https://example.test/auto>'} linkContext={context} />);
    for (const name of ["site", "https://example.test/auto"]) {
      fireEvent.click(await screen.findByRole("link", { name }));
      const chooser = await screen.findByRole("dialog", { name: "Open website link" });
      expect(openBrowserTab).not.toHaveBeenCalled();
      fireEvent.keyDown(chooser, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
  });

  it("routes Markdown links and rendered autolinks through the same captured context", async () => {
    render(<Markdown text={'[source](src/index.ts:12:3)\n\n<http://localhost:4173/path?q=1#result>'} linkContext={context} />);
    fireEvent.click(await screen.findByRole("link", { name: "source" }));
    await waitFor(() => expect(openFile).toHaveBeenCalledWith("render-origin", "/workspace", "src/index.ts", { line: 12, col: 3 }, "/workspace"));

    fireEvent.click(screen.getByRole("link", { name: "http://localhost:4173/path?q=1#result" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledExactlyOnceWith("http://localhost:4173/path?q=1#result"));
    expect(openBrowserTab).not.toHaveBeenCalled();
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
    fireEvent.click(await screen.findByRole("link", { name: "web" }), { shiftKey: true, metaKey: true });
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
    await waitFor(() => expect(openUrl).toHaveBeenCalledExactlyOnceWith("https://example.test/path"));
    const middle = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    link.dispatchEvent(middle);
    expect(middle.defaultPrevented).toBe(true);
    await waitFor(() => expect(openUrl).toHaveBeenCalledTimes(2));
    expect(openBrowserTab).not.toHaveBeenCalled();
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

describe("Codex file citations (#776)", () => {
  const output = ':codex-file-citation{path="/abs/path/report.xlsx" artifact_kind="workbook" purpose="output"}';
  const workbook: LocalPathInfo = { path: "/abs/path/report.xlsx", root: "/abs/path", rel: "report.xlsx", kind: "file", text: false };

  it("renders an output citation on its own line as one file chip that opens and reveals the file", async () => {
    vi.mocked(fs.inspectPath).mockResolvedValue(workbook);
    const { container } = render(<Markdown text={`Here is the summary workbook.\n\n${output}`} linkContext={context} />);
    const link = await screen.findByRole("link", { name: "report.xlsx" });
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(link.dataset.fileChip).toBe("true");
    expect(link.getAttribute("title")).toBe("/abs/path/report.xlsx");
    expect(link.closest("p")?.textContent).toBe("report.xlsx");
    expect(container.textContent?.replace(/\s+/g, " ")).toBe("Here is the summary workbook. report.xlsx");
    expect(container.textContent).not.toContain("codex-file-citation");

    fireEvent.click(link);
    await waitFor(() => expect(fs.openPath).toHaveBeenCalledWith("/abs/path/report.xlsx"));
    expect(fs.inspectPath).toHaveBeenCalledWith("/workspace", "/abs/path/report.xlsx");
    expect(openFile).not.toHaveBeenCalled();

    fireEvent.contextMenu(link);
    expect(await screen.findByRole("menuitem", { name: "Open with default application" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reveal in file manager" }));
    await waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith("/abs/path/report.xlsx"));
  });

  it("renders a source citation inside its sentence with its locator, leaving the prose around it alone", async () => {
    render(<Markdown text={'The review of :codex-file-citation{path="/abs/report.xlsx" sheet="Revenue Model" range="C27" purpose="source"} is due *Friday*; see also :codex-file-citation{path="/abs/review.pdf" page_number="3" purpose="source"}.'} linkContext={context} />);
    const cell = await screen.findByRole("link", { name: "report.xlsx · Revenue Model!C27" });
    expect(cell.dataset.fileChip).toBeUndefined();
    expect(screen.getByRole("link", { name: "review.pdf · p. 3" })).toBeTruthy();
    expect(cell.closest("p")?.textContent).toBe("The review of report.xlsx · Revenue Model!C27 is due Friday; see also review.pdf · p. 3.");
    expect(cell.closest("p")?.querySelector("em")?.textContent).toBe("Friday");
  });

  it("renders a Google Drive citation as one web link with a short label, not an autolink of its URL", async () => {
    const url = "https://docs.google.com/spreadsheets/d/1AbC_d-Ef/edit#gid=0";
    render(<Markdown text={`:codex-file-citation{path="${url}" purpose="output"}`} linkContext={context} />);
    const link = await screen.findByRole("link", { name: "Google Sheets file" });
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(link.getAttribute("title")?.split("\n")[0]).toBe(url);
    fireEvent.click(link);
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(url);
  });

  it("gives a path with spaces, _, *, # or non-ASCII characters the destination of the same Markdown link", async () => {
    const path = "/abs/my *draft* _final_ #2 Отчёт.xlsx";
    render(<Markdown text={`:codex-file-citation{path="${path}" purpose="source"} or [same](<${path}>)`} linkContext={context} />);
    fireEvent.click(await screen.findByRole("link", { name: "my *draft* _final_ #2 Отчёт.xlsx" }));
    fireEvent.click(screen.getByRole("link", { name: "same" }));
    await waitFor(() => expect(fs.inspectPath).toHaveBeenCalledTimes(2));
    expect(vi.mocked(fs.inspectPath).mock.calls).toEqual([["/workspace", path], ["/workspace", path]]);
  });

  it("links a citation on a transcript without a workspace", async () => {
    render(<Markdown text={output} />);
    expect((await screen.findByRole("link", { name: "report.xlsx" })).getAttribute("title")).toBe("/abs/path/report.xlsx");
  });

  it("keeps the marker literal in code, in a link's text, and when it is malformed", async () => {
    const text = [
      "`" + output + "`",
      "```\n" + output + "\n```",
      ':codex-file-citation{purpose="output"} and :codex-file-citation{path="/abs/a.xlsx" and \\:codex-file-citation{path="/abs/b.xlsx"}',
      `[see ${output}](README.md)`,
    ].join("\n\n");
    const { container } = render(<Markdown text={text} linkContext={context} />);
    expect(container.querySelector("p code")?.textContent).toBe(output);
    expect(container.querySelector("pre code")?.textContent).toBe(output);
    expect(container.textContent).toContain(':codex-file-citation{purpose="output"} and :codex-file-citation{path="/abs/a.xlsx" and :codex-file-citation{path="/abs/b.xlsx"}');
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual([`see ${output}`]);
  });

  it("still completes unfinished Markdown while streaming without reading into a citation's path", async () => {
    const cited = ':codex-file-citation{path="/abs/*draft_ [v2] `final`.xlsx" purpose="source"}';
    const { container, rerender } = render(<Markdown text={`See ${cited} and **bold`} streaming linkContext={context} />);
    expect(screen.getByRole("link", { name: "*draft_ [v2] `final`.xlsx" })).toBeTruthy();
    expect(container.querySelector('[data-streamdown="strong"]')?.textContent).toBe("bold");
    expect(container.textContent).toBe("See *draft_ [v2] `final`.xlsx and bold");
    // remend returns early once it closes an unfinished link; the citation still comes back whole.
    rerender(<Markdown text={`See ${cited} and [docs](README`} streaming linkContext={context} />);
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["*draft_ [v2] `final`.xlsx", "docs"]);
    expect(container.textContent).toBe("See *draft_ [v2] `final`.xlsx and docs");
  });

  it("holds back a citation while it streams, then shows it whole", async () => {
    const { container, rerender } = render(<Markdown text={'Here it is.\n\n:codex-file-citation{path="https://docs.google.com/spreadsheets/d/1Ab'} streaming linkContext={context} />);
    expect(container.textContent).toBe("Here it is.");
    expect(screen.queryByRole("link")).toBeNull();
    rerender(<Markdown text={'Here it is.\n\n:codex-file-ci'} streaming linkContext={context} />);
    expect(container.textContent).toBe("Here it is.");
    rerender(<Markdown text={`Here it is.\n\n${output}`} streaming linkContext={context} />);
    expect((await screen.findByRole("link", { name: "report.xlsx" })).dataset.fileChip).toBe("true");
    rerender(<Markdown text={`Here it is.\n\n${output}`} linkContext={context} />);
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
});


it("blocks remote image loads in untrusted PR prose while preserving the image description", () => {
  const { container } = render(<Markdown text="![build screenshot](https://untrusted.example/track.png)" remoteImages={false} />);
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByText("build screenshot (image blocked)")).toBeTruthy();
});
