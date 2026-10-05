import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`, invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/browser", () => ({ openBrowserTab: vi.fn() }));

import { TurnBlock } from "./TurnBlock";
import type { Turn } from "@/lib/transcript";
import { openUrl } from "@tauri-apps/plugin-opener";
import { setPrefs } from "@/lib/prefs";

afterEach(cleanup);

const turn = (images: { url: string; name?: string }[]): Turn =>
  ({ key: "t1", prompt: { text: "what is this?", images, ts: "2026-10-03T00:00:00Z", seq: 1 }, work: [], live: false }) as unknown as Turn;

it("activates bare links in prompts and queued messages without changing their text", async () => {
  setPrefs({ linkBrowser: "system", foldToolCalls: false });
  const value = turn([]);
  value.prompt!.text = "See https://example.com/prompt.";
  value.work = [{ kind: "queued", key: "q2", seq: 2, text: "Then https://example.com/queued" }];
  render(<TurnBlock turn={value} sessionId="s" cwd="/repo" stream={[]} working={false} />);
  const link = screen.getByRole("link", { name: "https://example.com/prompt" });
  fireEvent.click(link);
  expect(openUrl).toHaveBeenCalledWith("https://example.com/prompt");
  expect(screen.getByRole("link", { name: "https://example.com/queued" })).toBeDefined();
  expect(screen.getByText(/See/).textContent).toBe("See https://example.com/prompt.");
});

it("keeps link activation separate from expanding reasoning and tool output", () => {
  setPrefs({ linkBrowser: "system", foldToolCalls: false });
  const value = turn([]);
  value.work = [
    { kind: "reasoning", key: "r2", seq: 2, text: "Inspect https://example.com/thinking\nMore reasoning" },
    { kind: "tool", key: "t3", call: { callId: "fetch", name: "WebFetch", toolType: "web", input: { url: "https://example.com/fetch" }, seq: 3, result: { text: "See https://example.com/output", isError: false } } },
  ];
  const { container } = render(<TurnBlock turn={value} sessionId="s" cwd="/repo" stream={[]} working={false} />);
  fireEvent.click(screen.getByRole("link", { name: "https://example.com/thinking" }));
  expect(screen.queryByText(/More reasoning/)).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "https://example.com/fetch" }));
  expect(screen.queryByRole("link", { name: "https://example.com/output" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Expand reasoning" }));
  expect(screen.getByText(/More reasoning/)).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Expand tool output" }));
  expect(screen.getByRole("link", { name: "https://example.com/output" })).toBeDefined();
  expect(container.querySelector("button a")).toBeNull();
});

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
