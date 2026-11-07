import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { refreshDataPrivacy, setDataPrivacy } from "@/lib/dataPrivacy";
import { closeAllEditors, getEditors, openFile } from "@/lib/editors";
import { localGitSource } from "@/lib/gitSource";
import { FileDiff } from "@/components/changes/FileDiff";
import { MediaPane } from "./MediaPane";

const native = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (original) => ({ ...(await original<object>()), invoke: native }));

beforeEach(async () => {
  Element.prototype.scrollTo = vi.fn();
  native.mockImplementation(async (command, args) => {
    if (command === "data_privacy_status") return { enabled: false, managed: false };
    if (command === "data_privacy_set") return { enabled: args.enabled, managed: false };
    if (command === "diff_media_content") return { data: btoa(args.path), mime: "image/png" };
    if (command === "file_contents_at") return { before: '<svg xmlns="http://www.w3.org/2000/svg"/>', after: '<svg xmlns="http://www.w3.org/2000/svg"><script>throw 1</script></svg>' };
    if (command === "open_media_file") return { token: args.rel, url: args.rel === "remote.png" ? "https://example.test/remote.png" : "http://127.0.0.1:1234/grant", mtimeMs: 1 };
    if (command === "file_mtime") return 1;
    if (command === "close_media_file") return;
    throw new Error(`Unexpected native command: ${command}`);
  });
  await refreshDataPrivacy();
  let revision = 0;
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => `blob:revision-${++revision}`), revokeObjectURL: vi.fn() }));
});
afterEach(async () => {
  cleanup();
  await closeAllEditors("privacy-media");
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function enable(managed: boolean) {
  native.mockResolvedValueOnce({ enabled: true, managed });
  await act(() => refreshDataPrivacy());
}

it.each([false, true])("keeps local before/after image revisions and independent zoom with privacy enabled (managed=%s)", async (managed) => {
  await enable(managed);
  const { unmount } = render(<FileDiff source={localGitSource("/repo")} path="new.png" oldPath="old.png" base="base" head="head" />);
  const before = await screen.findByRole("region", { name: "Before" });
  const after = screen.getByRole("region", { name: "After" });
  const oldImage = await within(before).findByRole("img");
  const newImage = await within(after).findByRole("img");
  expect(oldImage.getAttribute("src")).not.toBe(newImage.getAttribute("src"));
  for (const img of [oldImage, newImage]) {
    Object.defineProperties(img, { naturalWidth: { value: 800 }, naturalHeight: { value: 400 } });
    fireEvent.load(img);
  }
  fireEvent.click(within(after).getByRole("button", { name: "Actual size" }));
  fireEvent.click(within(after).getByRole("button", { name: "Zoom in" }));
  expect(newImage.style.width).toBe("1000px");
  expect(oldImage.style.maxHeight).toBe("100%");
  expect(native).toHaveBeenCalledWith("diff_media_content", { cwd: "/repo", path: "old.png", tree: "base" });
  expect(native).toHaveBeenCalledWith("diff_media_content", { cwd: "/repo", path: "new.png", tree: "head" });
  expect(native.mock.calls.some(([command]) => command.startsWith("cloud_"))).toBe(false);
  unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(oldImage.getAttribute("src"));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(newImage.getAttribute("src"));
});

it.each([false, true])("keeps rendered/raw SVG revisions as local image documents with privacy enabled (managed=%s)", async (managed) => {
  await enable(managed);
  const { container } = render(<FileDiff source={localGitSource("/repo")} path="vector.svg" base="base" head="head" />);
  expect(await screen.findAllByRole("img")).toHaveLength(2);
  expect(container.querySelector("svg script")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Raw SVG" }));
  expect(container.querySelector(".cm-content")?.textContent).toContain("<script>throw 1</script>");
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Rendered SVG" }));
  expect(await screen.findAllByRole("img")).toHaveLength(2);
  expect(native).toHaveBeenCalledWith("file_contents_at", { cwd: "/repo", path: "vector.svg", base: "base", head: "head" });
});

it("withdraws external image sources while retaining loopback media and restores them when disabled", async () => {
  const entry = (rel: string) => {
    const id = openFile("privacy-media", "/repo", rel);
    return getEditors().editors.find((editor) => editor.id === id)!;
  };
  render(<><MediaPane entry={entry("local.png")} visible /><MediaPane entry={entry("remote.png")} visible /></>);
  await screen.findByRole("img", { name: "remote.png" });
  await screen.findByRole("img", { name: "local.png" });
  await act(() => setDataPrivacy(true));
  expect(screen.queryByRole("img", { name: "remote.png" })).toBeNull();
  expect(screen.getByRole("img", { name: "local.png" }).getAttribute("src")).toBe("http://127.0.0.1:1234/grant");
  await act(() => setDataPrivacy(false));
  expect(screen.getByRole("img", { name: "remote.png" }).getAttribute("src")).toBe("https://example.test/remote.png");
  expect(native.mock.calls.filter(([command]) => command === "open_media_file")).toHaveLength(2);
});
