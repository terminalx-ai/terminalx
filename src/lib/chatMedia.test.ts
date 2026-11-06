import { describe, expect, it } from "vitest";
import { chatMediaKind, mediaMentions } from "./chatMedia";

describe("the media a message names", () => {
  it("finds local pictures, videos and drawings however they are written, once each", () => {
    const text = [
      "Yes—here’s the generated image: [Open image](/Users/me/.codex/generated_images/t/exec-1.png).",
      "![chart](out/chart.svg) and the clip is `renders/demo.mp4`.",
      "Again: /Users/me/.codex/generated_images/t/exec-1.png, plus file:///tmp/My%20Shot.jpeg",
      "Online ones stay links: https://example.com/a.png",
      "Not media: src/app.ts, notes.pdf, image.png.bak",
    ].join("\n");
    expect(mediaMentions(text)).toEqual([
      "/Users/me/.codex/generated_images/t/exec-1.png",
      "out/chart.svg",
      "renders/demo.mp4",
      "/tmp/My Shot.jpeg",
    ]);
  });

  it("knows what it can draw", () => {
    expect(["a.PNG", "b.svg", "c.webm", "d.mp3", "e.ts"].map(chatMediaKind)).toEqual(["image", "svg", "video", "audio", null]);
  });
});
