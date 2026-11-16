import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileDiff } from "./FileDiff";
import { setPrefs } from "@/lib/prefs";
import type { GitSource } from "@/lib/gitSource";
import { copyText } from "@/lib/clipboard";

vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => {}) }));
vi.mock("@/components/editor/PdfSurface", () => ({ default: ({ data }: { data: string }) => <div data-testid="pdf">{data}</div> }));
const source = { key: "local:/repo", fileContentsAt: vi.fn(), mediaContentAt: vi.fn(), errorMessage: String } as unknown as GitSource;
const props = { source, path: "file.ts", base: "base", head: "head" };
beforeEach(() => {
  setPrefs({ diffMode: "unified", diffHideWhitespace: false, diffWrap: true, diffWrapFiles: {} });
  vi.mocked(source.fileContentsAt).mockResolvedValue({ before: "  const x = 1;\n", after: "const x=1;\n" });
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:fixture"), revokeObjectURL: vi.fn() }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
const openMenu = () => {
  fireEvent.pointerDown(screen.getByRole("button", { name: "View options" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
  return screen.getByRole("menu");
};

it("hides whitespace highlights without changing the displayed or copied new text", async () => {
  const { container } = render(<FileDiff {...props} />);
  await screen.findByRole("button", { name: "Copy file contents" });
  // The header and the editor are not drawn in the same step: the button is
  // there once the file is read, the editor once its effect has run.
  await waitFor(() => expect(container.querySelector(".cm-changedLine")).not.toBeNull());
  fireEvent.click(within(openMenu()).getByRole("menuitemcheckbox", { name: "Hide whitespace changes" }));
  expect(container.querySelector(".cm-changedLine")).toBeNull();
  expect(container.querySelector(".cm-content")?.textContent).toContain("const x=1;");
  fireEvent.click(screen.getByRole("button", { name: "Copy file contents" }));
  await screen.findByText("Copied file");
  expect(copyText).toHaveBeenCalledWith("const x=1;\n");
  fireEvent.click(screen.getByRole("radio", { name: "Split" }));
  expect(container.querySelectorAll(".cm-content")).toHaveLength(2);
  expect(container.querySelector(".cm-changedLine")).toBeNull();
});

it("wraps lines from View options for this file and the next, dropping this file's own override", async () => {
  setPrefs({ diffWrapFiles: { [JSON.stringify(["local:/repo", "file.ts"])]: false } });
  const { container, rerender } = render(<FileDiff {...props} />);
  await screen.findByRole("button", { name: "Copy file contents" });
  await waitFor(() => expect(container.querySelector(".cm-content")).not.toBeNull());
  expect(container.querySelector(".cm-lineWrapping")).toBeNull();
  const wrap = within(openMenu()).getByRole("menuitemcheckbox", { name: "Wrap lines" });
  expect(wrap.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(wrap);
  expect(container.querySelector(".cm-lineWrapping")).not.toBeNull();
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Wrap lines" }));
  expect(container.querySelector(".cm-lineWrapping")).toBeNull();
  rerender(<FileDiff {...props} path="other.ts" />);
  await screen.findByRole("button", { name: "Copy file contents" });
  await waitFor(() => expect(container.querySelector(".cm-content")).not.toBeNull());
  expect(container.querySelector(".cm-lineWrapping")).toBeNull();
});

it.each(["png", "pdf"])("reads both binary revisions of a renamed %s, never as text", async (ext) => {
  vi.mocked(source.mediaContentAt!).mockImplementation(async (path) => ({ data: btoa(path), mime: ext === "pdf" ? "application/pdf" : "image/png" }));
  const { unmount } = render(<FileDiff {...props} path={`new.${ext}`} oldPath={`old.${ext}`} />);
  const before = await screen.findByRole("region", { name: "Before" });
  const after = screen.getByRole("region", { name: "After" });
  if (ext === "pdf") {
    expect((await within(before).findByTestId("pdf")).textContent).toBe(btoa("old.pdf"));
    expect((await within(after).findByTestId("pdf")).textContent).toBe(btoa("new.pdf"));
  } else {
    expect(await within(before).findByRole("img")).toBeTruthy();
    expect(await within(after).findByRole("img")).toBeTruthy();
  }
  expect(source.mediaContentAt).toHaveBeenCalledWith(`old.${ext}`, "base");
  expect(source.mediaContentAt).toHaveBeenCalledWith(`new.${ext}`, "head");
  expect(source.fileContentsAt).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Copy file contents" })).toBeNull();
  unmount();
  if (ext === "png") expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
});

it("offers rendered and raw SVG and releases object URLs", async () => {
  vi.mocked(source.fileContentsAt).mockResolvedValue({ before: null, after: '<svg xmlns="http://www.w3.org/2000/svg"><script>throw 1</script></svg>' });
  const { container } = render(<FileDiff {...props} path="new.svg" />);
  await screen.findByRole("img");
  expect(screen.getByText("File does not exist in this revision.")).toBeTruthy();
  expect(container.querySelector("svg script")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Raw SVG" }));
  expect(container.querySelector(".cm-content")?.textContent).toContain("<script>throw 1</script>");
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
});

it("drops late old-file reads and reports a failed read with retry", async () => {
  let resolve!: (value: { before: string; after: string }) => void;
  vi.mocked(source.fileContentsAt).mockReturnValueOnce(new Promise((r) => { resolve = r; }));
  const { rerender } = render(<FileDiff {...props} />);
  vi.mocked(source.fileContentsAt).mockRejectedValueOnce(new Error("unavailable"));
  rerender(<FileDiff {...props} path="second.ts" />);
  await screen.findByRole("alert");
  await act(async () => resolve({ before: "stale", after: "stale" }));
  expect(screen.queryByRole("button", { name: "Copy file contents" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("button", { name: "Copy file contents" });
  expect(screen.queryByText("stale")).toBeNull();
  vi.mocked(copyText).mockRejectedValueOnce(new Error("clipboard denied"));
  fireEvent.click(screen.getByRole("button", { name: "Copy file contents" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Could not copy"));
});

it("shows a file over the preview limit as a calm empty state, never red text or a Retry, and does not copy the marker", async () => {
  vi.mocked(source.fileContentsAt).mockResolvedValue({ before: "old", after: "<file too large to show>" });
  const onOpenFile = vi.fn();
  render(<FileDiff {...props} path="src-tauri/gen/schemas/macOS-schema.json" onOpenFile={onOpenFile} size={2.4 * 1024 * 1024} />);
  const state = await screen.findByTestId("changes-empty-state");
  expect(state.textContent).toContain("No diff to show");
  expect(state.textContent).toContain("src-tauri/gen/schemas/macOS-schema.json is 2.4 MB, over the text preview limit, so the diff isn't drawn.");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(state.querySelector(".text-destructive")).toBeNull();
  expect(screen.getByText("2.4 MB")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Copy file contents" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open file" }));
  expect(onOpenFile).toHaveBeenCalledTimes(1);
});

it.each(["png", "svg"])("reports an unavailable historical %s object without claiming the file was absent, and retries after it is fetched", async (extension) => {
  const unavailable = new Error("Revision is unavailable locally. Fetch the missing objects in the workspace before comparing this revision.");
  if (extension === "png") {
    vi.mocked(source.mediaContentAt!).mockImplementation(async (_path, tree) => {
      if (tree === "base") throw unavailable;
      return { data: btoa("after"), mime: "image/png" };
    });
  } else vi.mocked(source.fileContentsAt).mockRejectedValueOnce(unavailable);
  render(<FileDiff {...props} path={`image.${extension}`} />);
  expect((await screen.findByRole("alert")).textContent).toContain("unavailable locally");
  expect(screen.queryByText("File does not exist in this revision.")).toBeNull();
  expect(screen.queryByRole("region", { name: "Before" })).toBeNull();
  if (extension === "png") {
    vi.mocked(source.mediaContentAt!).mockImplementation(async (_path, tree) => ({ data: btoa(tree ?? "working"), mime: "image/png" }));
  } else vi.mocked(source.fileContentsAt).mockResolvedValue({ before: "<svg/>", after: "<svg/>" });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findAllByRole("img")).toHaveLength(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each(["file.ts", "image.png"])("keeps Discard in the %s diff's View options alongside its viewer", async (path) => {
  vi.mocked(source.mediaContentAt!).mockResolvedValue({ data: btoa("image"), mime: "image/png" });
  const onDiscard = vi.fn();
  render(<FileDiff {...props} path={path} onDiscard={onDiscard} />);
  if (path.endsWith(".ts")) await screen.findByRole("button", { name: "Copy file contents" });
  else await screen.findByRole("region", { name: "After" });
  fireEvent.click(within(openMenu()).getByRole("menuitem", { name: `Discard changes to ${path}` }));
  expect(onDiscard).toHaveBeenCalledTimes(1);
});

it("offers one stage action for each Git hunk in the diff header", async () => {
  const hunkSource = { ...source, hunkCount: vi.fn().mockResolvedValue(2), applyHunk: vi.fn() } as unknown as GitSource;
  const onHunk = vi.fn();
  render(<FileDiff {...props} source={hunkSource} staging={{ staged: false, onHunk }} />);
  fireEvent.click(await screen.findByRole("button", { name: "Stage hunk 2" }));
  expect(onHunk).toHaveBeenCalledWith(1);
});
