import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileDiff } from "./FileDiff";
import { DiffOptions } from "./DiffOptions";
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

it("hides whitespace highlights without changing the displayed or copied new text", async () => {
  const { container } = render(<><DiffOptions /><FileDiff {...props} /></>);
  await screen.findByRole("button", { name: "Copy file" });
  // The header and the editor are not drawn in the same step: the button is
  // there once the file is read, the editor once its effect has run.
  await waitFor(() => expect(container.querySelector(".cm-changedLine")).not.toBeNull());
  fireEvent.click(screen.getByLabelText("Hide whitespace changes"));
  expect(container.querySelector(".cm-changedLine")).toBeNull();
  expect(container.querySelector(".cm-content")?.textContent).toContain("const x=1;");
  fireEvent.click(screen.getByRole("button", { name: "Copy file" }));
  await screen.findByText("Copied file");
  expect(copyText).toHaveBeenCalledWith("const x=1;\n");
  fireEvent.click(screen.getByRole("button", { name: "Split" }));
  expect(container.querySelectorAll(".cm-content")).toHaveLength(2);
  expect(container.querySelector(".cm-changedLine")).toBeNull();
});

it("applies file wrap overrides independently of the global default", async () => {
  const { container, rerender } = render(<><DiffOptions /><FileDiff {...props} /></>);
  const select = await screen.findByLabelText("Wrap lines for this file");
  await waitFor(() => expect(container.querySelector(".cm-lineWrapping")).not.toBeNull());
  fireEvent.change(select, { target: { value: "false" } });
  expect(container.querySelector(".cm-lineWrapping")).toBeNull();
  rerender(<><DiffOptions /><FileDiff {...props} path="other.ts" /></>);
  await screen.findByLabelText("Wrap lines for this file");
  await waitFor(() => expect(container.querySelector(".cm-lineWrapping")).not.toBeNull());
  fireEvent.click(screen.getByLabelText("Wrap lines by default"));
  expect(container.querySelector(".cm-lineWrapping")).toBeNull();
  fireEvent.change(screen.getByLabelText("Wrap lines for this file"), { target: { value: "true" } });
  expect(container.querySelector(".cm-lineWrapping")).not.toBeNull();
  fireEvent.change(screen.getByLabelText("Wrap lines for this file"), { target: { value: "default" } });
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
  expect(screen.queryByRole("button", { name: "Copy file" })).toBeNull();
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
  expect(screen.queryByRole("button", { name: "Copy file" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("button", { name: "Copy file" });
  expect(screen.queryByText("stale")).toBeNull();
  vi.mocked(copyText).mockRejectedValueOnce(new Error("clipboard denied"));
  fireEvent.click(screen.getByRole("button", { name: "Copy file" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Could not copy"));
});

it("does not copy a truncation marker as file contents", async () => {
  vi.mocked(source.fileContentsAt).mockResolvedValue({ before: "old", after: "<file too large to show>" });
  render(<FileDiff {...props} />);
  expect((await screen.findByRole("alert")).textContent).toContain("exceeds the text preview limit");
  expect(screen.queryByRole("button", { name: "Copy file" })).toBeNull();
});


it.each(["file.ts", "image.png"])("keeps Discard in the %s diff header alongside its viewer", async (path) => {
  vi.mocked(source.mediaContentAt!).mockResolvedValue({ data: btoa("image"), mime: "image/png" });
  const onDiscard = vi.fn();
  render(<FileDiff {...props} path={path} onDiscard={onDiscard} />);
  if (path.endsWith(".ts")) await screen.findByRole("button", { name: "Copy file" });
  else await screen.findByRole("region", { name: "After" });
  fireEvent.click(screen.getByRole("button", { name: `Discard changes to ${path}` }));
  expect(onDiscard).toHaveBeenCalledTimes(1);
});
