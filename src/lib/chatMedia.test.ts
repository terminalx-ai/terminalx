import { describe, expect, it } from "vitest";
import { chatMediaKind, isSafeWorkspaceMediaPath, mediaMentions } from "./chatMedia";

describe("the media a message names", () => {
  it("finds workspace-confined pictures, videos and drawings, rejecting traversal and outside absolute paths", () => {
    const text = [
      "In-workspace absolute: [Open image](/repo/out/exec-1.png).",
      "![chart](out/chart.svg) and the clip is `renders/demo.mp4`.",
      "Duplicate: /repo/out/exec-1.png",
      "Outside absolute must be ignored: /Users/me/Desktop/secret.png and file:///tmp/My%20Shot.jpeg",
      "Traversal must be ignored: ../../etc/secret.png and sub/../../leak.svg",
      "Online ones stay links: https://example.com/a.png",
      "Not media: src/app.ts, notes.pdf, image.png.bak",
    ].join("\n");
    expect(mediaMentions(text, "/repo")).toEqual([
      "/repo/out/exec-1.png",
      "out/chart.svg",
      "renders/demo.mp4",
    ]);
    // Without a workspace base, only clean relative paths (no absolute paths, no `..`) are accepted.
    expect(mediaMentions(text)).toEqual([
      "out/chart.svg",
      "renders/demo.mp4",
    ]);
  });

  it("knows what it can draw and enforces S-25 path confinement", () => {
    expect(["a.PNG", "b.svg", "c.webm", "d.mp3", "e.ts"].map(chatMediaKind)).toEqual(["image", "svg", "video", "audio", null]);
    expect(isSafeWorkspaceMediaPath("out/chart.svg", "/repo")).toBe(true);
    expect(isSafeWorkspaceMediaPath("/repo/out/chart.svg", "/repo")).toBe(true);
    expect(isSafeWorkspaceMediaPath("/Users/me/.raccoon/attachments/s1/abc/img.png", "/repo")).toBe(true);
    expect(isSafeWorkspaceMediaPath("../secret.png", "/repo")).toBe(false);
    expect(isSafeWorkspaceMediaPath("/etc/secret.png", "/repo")).toBe(false);
    expect(isSafeWorkspaceMediaPath("/repo-other/img.png", "/repo")).toBe(false);
  });
});
