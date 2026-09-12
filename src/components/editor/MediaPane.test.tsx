// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fs } from "@/lib/api";
import { liveEditorsFor } from "@/lib/editorViews";
import { getEditors, openFile, closeAllEditors } from "@/lib/editors";
import { MediaPane } from "./MediaPane";

vi.mock("@/lib/api", () => ({ fs: { openMedia: vi.fn(), closeMedia: vi.fn(), mtime: vi.fn(), readText: vi.fn(), writeText: vi.fn(), openPath: vi.fn() } }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn().mockResolvedValue(undefined), revealItemInDir: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn();
  vi.mocked(fs.openMedia).mockResolvedValue({ token: "grant", url: "http://127.0.0.1:1234/grant", mtimeMs: 1 });
  vi.mocked(fs.closeMedia).mockResolvedValue(undefined);
  vi.mocked(fs.mtime).mockResolvedValue(1);
  vi.mocked(fs.openPath).mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(async () => { cleanup(); await closeAllEditors("media-test"); vi.restoreAllMocks(); vi.clearAllMocks(); });
function entry(rel: string) {
  const id = openFile("media-test", "/workspace", rel);
  return getEditors().editors.find((e) => e.id === id)!;
}

describe("media surfaces", () => {
  it.each(["transparent 图.png", "voice.mp3", "movie.mp4"])("never reads or saves %s as text", async (rel) => {
    const e = entry(rel);
    const { container } = render(<MediaPane entry={e} visible />);
    await waitFor(() => expect(container.querySelector("img,audio,video")).not.toBeNull());
    fireEvent.keyDown(container.firstChild!, { key: "s", metaKey: true });
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(fs.readText).not.toHaveBeenCalled();
    expect(fs.writeText).not.toHaveBeenCalled();
    expect(liveEditorsFor(`/workspace/${rel}`)).toEqual([]);
    expect(getEditors().editors[0].dirty).toBe(false);
  });

  it("fits images, zooms, and returns to fit", async () => {
    render(<MediaPane entry={entry("transparent.png")} visible />);
    const img = await screen.findByRole("img");
    Object.defineProperties(img, { naturalWidth: { value: 800 }, naturalHeight: { value: 400 } });
    fireEvent.load(img);
    fireEvent.click(screen.getByRole("button", { name: "Actual size" }));
    expect(img.style.width).toBe("800px");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(img.style.width).toBe("1000px");
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect(img.style.maxHeight).toBe("100%");
  });

  it.each(["voice.wav", "movie.mp4"])("pauses %s when hidden and releases its decoder and grant on close", async (rel) => {
    const e = entry(rel);
    const { container, rerender, unmount } = render(<MediaPane entry={e} visible />);
    await waitFor(() => expect(container.querySelector("audio,video")).not.toBeNull());
    const player = container.querySelector<HTMLMediaElement>("audio,video")!;
    expect(player.autoplay).toBe(false);
    expect(player.controls).toBe(true);
    expect(player.preload).toBe("metadata");
    rerender(<MediaPane entry={e} visible={false} />);
    expect(player.pause).toHaveBeenCalled();
    unmount();
    expect(player.hasAttribute("src")).toBe(false);
    expect(player.load).toHaveBeenCalled();
    expect(fs.closeMedia).toHaveBeenCalledWith("grant");
  });

  it("releases a grant whose open completes after the tab closes", async () => {
    let resolve!: (f: Awaited<ReturnType<typeof fs.openMedia>>) => void;
    vi.mocked(fs.openMedia).mockReturnValue(new Promise((r) => { resolve = r; }));
    const { unmount } = render(<MediaPane entry={entry("movie.mp4")} visible />);
    unmount();
    await act(async () => resolve({ token: "late", url: "url", mtimeMs: 1 }));
    expect(fs.closeMedia).toHaveBeenCalledWith("late");
  });

  it("shows a decoder failure with retry and reveal, and unloads playback", async () => {
    const { container } = render(<MediaPane entry={entry("broken.mp4")} visible />);
    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    const player = container.querySelector("video")!;
    fireEvent.error(player);
    expect(screen.getByRole("alert").textContent).toContain("broken.mp4");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open with default application" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open with default application" }));
    expect(fs.openPath).toHaveBeenCalledWith("/workspace/broken.mp4");
    expect(screen.getAllByRole("button", { name: "Reveal file" })).toHaveLength(2);
    expect(player.hasAttribute("src")).toBe(false);
  });

  it("reports a default-application fallback failure", async () => {
    vi.mocked(fs.openPath).mockRejectedValueOnce(new Error("No registered handler"));
    const { container } = render(<MediaPane entry={entry("broken.mp4")} visible />);
    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    fireEvent.error(container.querySelector("video")!);
    fireEvent.click(screen.getByRole("button", { name: "Open with default application" }));
    await waitFor(() => expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("No registered handler"))).toBe(true));
  });

  it("reports missing files and reloads externally changed files with a fresh grant", async () => {
    vi.mocked(fs.mtime).mockResolvedValue(2);
    render(<MediaPane entry={entry("photo.png")} visible />);
    await screen.findByText(/File changed on disk/);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(fs.openMedia).toHaveBeenCalledTimes(2));
    expect(fs.closeMedia).toHaveBeenCalledWith("grant");
    cleanup();
    vi.mocked(fs.openMedia).mockRejectedValue(new Error("No such file"));
    render(<MediaPane entry={entry("missing.png")} visible />);
    expect((await screen.findByRole("alert")).textContent).toContain("missing.png");
  });
});
