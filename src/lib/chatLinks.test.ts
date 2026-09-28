import { beforeEach, describe, expect, it, vi } from "vitest";
import { fs, type LocalPathInfo } from "@/lib/api";
import { openBrowserTab } from "@/lib/browser";
import { editorLinkContext, getEditors, openFile } from "@/lib/editors";
import { openUrl } from "@tauri-apps/plugin-opener";
import { openChatLink, parseChatLink } from "./chatLinks";

vi.mock("@/lib/api", () => ({ fs: { inspectPath: vi.fn(), openPath: vi.fn() } }));
vi.mock("@/lib/browser", () => ({ openBrowserTab: vi.fn() }));
vi.mock("@/lib/editors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/editors")>();
  return {
    ...actual,
    fileKind: (path: string) => /\.(?:png|mp3|mp4)$/i.test(path) ? (path.endsWith(".png") ? "image" : path.endsWith(".mp3") ? "audio" : "video") : "text",
    openFile: vi.fn(actual.openFile),
  };
});
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn(), openUrl: vi.fn(), revealItemInDir: vi.fn() }));

const context = { sessionId: "origin-session", cwd: "/workspace" };
const info = (patch: Partial<LocalPathInfo> = {}): LocalPathInfo => ({
  path: "/workspace/src/index.ts",
  root: "/workspace",
  rel: "src/index.ts",
  kind: "file",
  text: true,
  ...patch,
});

beforeEach(() => vi.clearAllMocks());

describe("chat link parsing", () => {
  it.each([
    ["src/index.ts:12:3", { path: "src/index.ts", line: 12, col: 3 }],
    ["C:\\repo\\src\\index.ts:12:3", { path: "C:\\repo\\src\\index.ts", line: 12, col: 3 }],
    ["\\\\server\\share\\source.ts:9:4", { path: "\\\\server\\share\\source.ts", line: 9, col: 4 }],
    ["src/index.ts:12", { path: "src/index.ts", line: 12 }],
    ["README.md:12", { path: "README.md", line: 12 }],
    ["main.rs:12:3", { path: "main.rs", line: 12, col: 3 }],
    ["src/report%3A12", { path: "src/report:12" }],
    ["src/report%23L12", { path: "src/report#L12" }],
  ])("parses %s without treating encoded delimiters as references", (href, expected) => {
    expect(parseChatLink(href)).toMatchObject({ kind: "local", ...expected });
  });

  it("keeps file URL fragments distinct from encoded filename characters", () => {
    expect(parseChatLink("file:///tmp/note.md#L12C3")).toMatchObject({ kind: "local", path: "/tmp/note.md", line: 12, col: 3 });
    expect(parseChatLink("file:///tmp/report%23L12")).toMatchObject({ kind: "local", path: "/tmp/report#L12", line: undefined });
    expect(parseChatLink("file:///tmp/report%3A12")).toMatchObject({ kind: "local", path: "/tmp/report:12", line: undefined });
  });

  it("preserves web ports, queries, and fragments and rejects executable schemes", () => {
    const url = "http://localhost:4173/path?q=a%20b#result";
    expect(parseChatLink(url)).toEqual({ kind: "web", href: url });
    expect(parseChatLink("javascript:alert(1)")).toMatchObject({ kind: "rejected" });
    expect(parseChatLink("data:text/html,boom")).toMatchObject({ kind: "rejected" });
    expect(parseChatLink("ftp://example.test:21")).toMatchObject({ kind: "rejected" });
  });
});

describe("chat link routing", () => {
  it("opens web URLs in the captured session workspace", async () => {
    const destination = parseChatLink("https://example.test/a?q=1#x");
    await openChatLink(destination, context);
    expect(openBrowserTab).toHaveBeenCalledWith("origin-session", "/workspace", "https://example.test/a?q=1#x");
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("opens text and media internally with line references", async () => {
    vi.mocked(fs.inspectPath).mockResolvedValue(info());
    await openChatLink(parseChatLink("src/index.ts:12:3"), context);
    expect(fs.inspectPath).toHaveBeenCalledWith("/workspace", "src/index.ts");
    expect(openFile).toHaveBeenCalledWith("origin-session", "/workspace", "src/index.ts", { line: 12, col: 3 }, "/workspace");

    vi.mocked(fs.inspectPath).mockResolvedValue(info({ path: "/tmp/图 像.png", root: "/tmp", rel: "图 像.png", text: false }));
    await openChatLink(parseChatLink("file:///tmp/%E5%9B%BE%20%E5%83%8F.png"), context);
    expect(openFile).toHaveBeenLastCalledWith("origin-session", "/tmp", "图 像.png", undefined, "/workspace");
  });

  it("keeps the originating workspace when an outside Markdown preview opens web and nested file links", async () => {
    vi.mocked(fs.inspectPath).mockResolvedValueOnce(info({ path: "/tmp/Outside.md", root: "/tmp", rel: "Outside.md" }));
    await openChatLink(parseChatLink("/tmp/Outside.md"), context);
    const entry = getEditors().editors.find((candidate) => candidate.rel === "Outside.md")!;
    const previewContext = editorLinkContext(entry);

    expect(previewContext).toEqual({ sessionId: "origin-session", cwd: "/workspace", basePath: "/tmp" });
    await openChatLink(parseChatLink("https://example.test/from-preview"), previewContext);
    expect(openBrowserTab).toHaveBeenLastCalledWith("origin-session", "/workspace", "https://example.test/from-preview");

    vi.mocked(fs.inspectPath).mockResolvedValueOnce(info({ path: "/tmp/nested/Next.md", root: "/tmp/nested", rel: "Next.md" }));
    await openChatLink(parseChatLink("nested/Next.md"), previewContext);
    expect(fs.inspectPath).toHaveBeenLastCalledWith("/tmp", "nested/Next.md");
    expect(openFile).toHaveBeenLastCalledWith("origin-session", "/tmp/nested", "Next.md", undefined, "/workspace");
  });

  it.each(["report.pdf", "proposal.docx", "archive.zip"])('sends unsupported document "%s" to the native opener', async (rel) => {
    vi.mocked(fs.inspectPath).mockResolvedValue(info({ path: `/tmp/${rel}`, root: "/tmp", rel, text: true }));
    await openChatLink(parseChatLink(`/tmp/${rel}`), context);
    expect(fs.openPath).toHaveBeenCalledWith(`/tmp/${rel}`);
    expect(openFile).not.toHaveBeenCalled();
  });

  it("opens folders with the native file manager and surfaces missing targets", async () => {
    vi.mocked(fs.inspectPath).mockResolvedValue(info({ path: "/tmp/output", root: "/tmp", rel: "output", kind: "directory", text: false }));
    await openChatLink(parseChatLink("/tmp/output"), context);
    expect(fs.openPath).toHaveBeenCalledWith("/tmp/output");

    vi.mocked(fs.inspectPath).mockRejectedValue(new Error("Destination is unavailable"));
    await expect(openChatLink(parseChatLink("missing.txt"), context)).rejects.toThrow("unavailable");
  });

  it("uses registered system handlers only for supported application schemes", async () => {
    await openChatLink(parseChatLink("mailto:hello@example.test"), context);
    expect(openUrl).toHaveBeenCalledWith("mailto:hello@example.test");
    await expect(openChatLink(parseChatLink("javascript:alert(1)"), context)).rejects.toThrow("not allowed");
  });
});
