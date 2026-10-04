import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`, invoke: vi.fn() }));

import { TurnBlock } from "./TurnBlock";
import type { Turn } from "@/lib/transcript";

afterEach(cleanup);

const turn = (images: { url: string; name?: string }[]): Turn =>
  ({ key: "t1", prompt: { text: "what is this?", images, ts: "2026-10-03T00:00:00Z", seq: 1 }, work: [], live: false }) as unknown as Turn;

describe("a prompt's images", () => {
  it("show as thumbnails for a tab that runs on this computer", () => {
    const { container } = render(<TurnBlock turn={turn([{ url: "/Users/me/.terminalx/attachments/s/shot.png", name: "shot.png" }])} sessionId="s" cwd="/repo" stream={[]} working={false} />);
    expect(container.querySelector("img")?.getAttribute("src")).toContain("asset://localhost/");
    expect(screen.queryByTestId("prompt-image-name")).toBeNull();
  });

  it("show by name for a cloud tab, whose file is on the workspace and not here", () => {
    const { container } = render(
      <TurnBlock turn={turn([{ url: "/home/terminalx/.terminalx/attachments/s/shot.png", name: "shot.png" }, { url: "/home/terminalx/.terminalx/attachments/s/1.png" }])} sessionId="s" stream={[]} working={false} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getAllByTestId("prompt-image-name").map((chip) => chip.textContent)).toEqual(["shot.png", "Image"]);
  });
});
