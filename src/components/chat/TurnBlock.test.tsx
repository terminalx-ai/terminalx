import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`, invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/browser", () => ({ openBrowserTab: vi.fn() }));

import { TurnBlock } from "./TurnBlock";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Turn } from "@/lib/transcript";
import { openUrl } from "@tauri-apps/plugin-opener";
import { setPrefs } from "@/lib/prefs";

afterEach(cleanup);

const turn = (images: { url: string; name?: string }[]): Turn =>
  ({ key: "t1", prompt: { text: "what is this?", images, ts: "2026-10-03T00:00:00Z", seq: 1 }, work: [], live: false }) as unknown as Turn;

it("shows verified sender attribution on prompts and queued inputs", () => {
  const value = turn([]);
  value.prompt!.author = { userId: "alice", displayName: "Alice" };
  value.work = [{ kind: "queued", key: "q2", seq: 2, text: "Follow up", author: { userId: "bob", displayName: "Bob" } }];
  render(<TurnBlock turn={value} sessionId="s" stream={[]} working={false} />);
  expect(screen.getByText("Alice").getAttribute("data-user-id")).toBe("alice");
  expect(screen.getByText("Bob:").getAttribute("data-user-id")).toBe("bob");
});

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

describe("a message queued behind the running turn", () => {
  it("offers Send now where the backend can interrupt for it, and nowhere else", () => {
    const queued: Turn = { ...turn([]), live: true, work: [{ kind: "queued", text: "also run this on localhost again", key: "q9", seq: 9 }] };
    const sendNow = vi.fn();
    render(<TooltipProvider><TurnBlock turn={queued} sessionId="s" stream={[]} working onSendQueuedNow={sendNow} /></TooltipProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(sendNow).toHaveBeenCalledWith(9);
    cleanup();
    render(<TurnBlock turn={queued} sessionId="s" stream={[]} working />);
    expect(screen.getByTestId("queued-message").textContent).toContain("also run this on localhost again");
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
  });

  it("is the reader's message once the agent has taken it, with nothing left to send now", () => {
    const taken: Turn = { ...turn([]), live: true, work: [{ kind: "message", text: "use the staging config", key: "m9", seq: 9, author: { userId: "sam", displayName: "Sam" } }] };
    render(<TooltipProvider><TurnBlock turn={taken} sessionId="s" stream={[]} working onSendQueuedNow={vi.fn()} /></TooltipProvider>);
    expect(screen.getAllByTestId("reader-message").map((bubble) => bubble.textContent)).toEqual([expect.stringContaining("what is this?"), "Samuse the staging config"]);
    expect(screen.queryByTestId("queued-message")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
  });
});

// #551: folded away with the tool calls, the message looked as if it was never sent.
describe("a finished turn with tool calls folded", () => {
  const finished = (): Turn =>
    ({
      ...turn([]),
      completed: { status: "ok", ts: "2026-10-03T00:01:00Z" },
      toolCount: 2,
      work: [
        { kind: "tool", key: "ca", call: { callId: "a", name: "Bash", toolType: "shell", input: { command: "make build" }, seq: 2, result: { text: "built", isError: false } } },
        { kind: "queued", key: "q3", seq: 3, text: "held for the next turn" },
        { kind: "tool", key: "cb", call: { callId: "b", name: "Read", toolType: "read", input: { file_path: "staging.toml" }, seq: 4, result: { text: "ok", isError: false } } },
        { kind: "message", key: "m5", seq: 5, text: "use the staging config" },
        { kind: "text", key: "a6", seq: 6, text: "Switched to staging." },
      ],
    }) as unknown as Turn;

  it("keeps the reader's words, waiting or taken, in view and in order with the answer", () => {
    for (const foldToolCalls of [true, false]) {
      setPrefs({ foldToolCalls });
      const { container } = render(<TurnBlock turn={finished()} sessionId="s" stream={[]} working={false} />);
      expect(screen.getByText("use the staging config")).toBeDefined();
      expect(screen.getByTestId("queued-message").textContent).toContain("held for the next turn");
      const text = container.textContent ?? "";
      expect(text.indexOf("held for the next turn")).toBeLessThan(text.indexOf("use the staging config"));
      expect(text.indexOf("use the staging config")).toBeLessThan(text.indexOf("Switched to staging."));
      // Folded, the tool calls are behind the summary line and the reader's words are not.
      expect(screen.queryByText("make build") === null).toBe(foldToolCalls);
      cleanup();
    }
  });
});

describe("a compaction", () => {
  const summary = "This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. Primary Request and Intent:\n   Open an issue for the banner.";
  // Compacted while idle: the line is all the turn holds.
  const compacted = (extra: object = {}): Turn =>
    ({ key: "t2", seq: 2, ts: "2026-10-09T09:57:48Z", work: [{ kind: "compaction", preTokens: 219942, postTokens: 13790, key: "k2", seq: 2, ...extra }], toolCount: 0, editedFiles: 0, live: false }) as Turn;

  it("folds its summary under the line, collapsed, and never as a message anybody sent (#524)", () => {
    setPrefs({ foldToolCalls: true });
    const { container } = render(<TurnBlock turn={compacted({ summary })} sessionId="s" stream={[]} working={false} />);
    const line = screen.getByRole("button", { name: /Context compacted from 220k to 14k tokens/ });
    expect(line.getAttribute("aria-expanded")).toBe("false");
    expect(line.textContent).toContain("Show summary");
    expect(screen.queryByTestId("compaction-summary")).toBeNull();
    expect(container.querySelector(".shadow-card")).toBeNull();

    fireEvent.click(line);
    expect(line.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("compaction-summary").textContent).toBe(summary);
    expect(line.textContent).toContain("Hide summary");
    fireEvent.click(line);
    expect(screen.queryByTestId("compaction-summary")).toBeNull();
  });

  it("is a plain line when there is no summary to show", () => {
    render(<TurnBlock turn={compacted()} sessionId="s" stream={[]} working={false} />);
    expect(screen.getByText(/Context compacted from 220k to 14k tokens/)).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

it("lists the files a finished turn changed, folding the rest, and hides them when turned off", () => {
  setPrefs({ turnChanges: true, foldToolCalls: false });
  const value = turn([]);
  const edit = (path: string) => ({ kind: "tool", key: path, call: { callId: path, name: "Edit", toolType: "file_edit", input: { file_path: path }, edits: [{ path, kind: "update", oldText: "a", newText: "b\nc" }], result: { text: "" } } });
  value.work = ["/repo/a.css", "/repo/b.html", "/repo/c.ts", "/repo/d.ts"].map(edit) as Turn["work"];
  value.completed = { status: "ok", ts: "2026-10-03T00:00:01Z" };
  const { rerender } = render(<TooltipProvider><TurnBlock turn={value} sessionId="s" cwd="/repo" stream={[]} working={false} /></TooltipProvider>);
  const row = screen.getByTestId("turn-changes");
  expect(row.textContent).toBe("a.css+2 −1b.html+2 −1+2 more+4 −2");
  fireEvent.click(screen.getByText("+2 more"));
  expect(screen.getByTestId("turn-changes").textContent).toContain("d.ts");
  setPrefs({ turnChanges: false });
  rerender(<TooltipProvider><TurnBlock turn={{ ...value }} sessionId="s" cwd="/repo" stream={[]} working={false} /></TooltipProvider>);
  expect(screen.queryByTestId("turn-changes")).toBeNull();
});
