import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const { openImageViewer } = vi.hoisted(() => ({ openImageViewer: vi.fn() }));
vi.mock("@/lib/imageViewer", () => ({ openImageViewer }));

const { ChatMedia } = await import("./ChatMedia");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const context = { sessionId: "s1", cwd: "/repo" };

describe("media in the chat", () => {
  it("draws a picture, a video and a drawing it can read, and nothing for one it cannot", async () => {
    invoke.mockImplementation(async (command: string, args: Record<string, string>) => {
      if (command === "inspect_local_path") {
        if (args.path.includes("missing")) throw new Error("not found");
        const path = args.path.startsWith("/") ? args.path : `/repo/${args.path}`;
        const at = path.lastIndexOf("/");
        return { path, root: path.slice(0, at), rel: path.slice(at + 1), kind: "file", text: false };
      }
      if (command === "open_media_file") return { token: `t-${args.rel}`, url: `http://127.0.0.1:9/t-${args.rel}`, mtimeMs: 1 };
      if (command === "read_text_file") return { content: "<svg/>", mtimeMs: 1, size: 6, binary: false, truncated: false };
      if (command === "close_media_file") return undefined;
      throw new Error(`Unexpected command: ${command}`);
    });
    const { unmount } = render(<ChatMedia paths={["/gen/shot.png", "clip.mp4", "chart.svg", "missing.png"]} context={context} />);
    const picture = await screen.findByRole("img", { name: "shot.png" });
    expect(picture.getAttribute("src")).toBe("http://127.0.0.1:9/t-shot.png");
    expect((await screen.findByRole("img", { name: "chart.svg" })).getAttribute("src")).toBe("data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E");
    await vi.waitFor(() => expect(document.querySelector("video")?.getAttribute("src")).toBe("http://127.0.0.1:9/t-clip.mp4"));
    expect(screen.getAllByTestId("chat-media-item")).toHaveLength(3);

    // A picture opens in the image viewer, with its file for Open in default app.
    fireEvent.click(screen.getByRole("button", { name: "View shot.png" }));
    expect(openImageViewer).toHaveBeenCalledWith([expect.objectContaining({ name: "shot.png", path: "/gen/shot.png" })]);

    // The files it opened are let go with the message.
    unmount();
    expect(invoke).toHaveBeenCalledWith("close_media_file", { token: "t-shot.png" });
    expect(invoke).toHaveBeenCalledWith("close_media_file", { token: "t-clip.mp4" });
  });
});
