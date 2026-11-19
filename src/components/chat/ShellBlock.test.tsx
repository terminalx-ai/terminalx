import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => path, invoke: vi.fn() }));
const { copyText } = vi.hoisted(() => ({ copyText: vi.fn(async () => {}) }));
vi.mock("@/lib/clipboard", () => ({ copyText }));

import { TurnBlock } from "./TurnBlock";
import { buildTranscript } from "@terminalx/portable/transcript";
import { SHELL_FOLD_LINES } from "@terminalx/portable/harnessText";
import type { AgentEvent } from "@terminalx/portable/events";

afterEach(cleanup);

const user = (seq: number, text: string): AgentEvent => ({ id: `e${seq}`, seq, ts: "2026-11-19T10:00:00Z", sessionId: "s", tabId: "t", harness: "claude", payload: { type: "user_message", text, queued: false } });
const draw = (...records: string[]) => {
  const [turn] = buildTranscript(records.map((text, i) => user(i + 1, text)), false).turns;
  return render(<TurnBlock turn={turn} sessionId="s" stream={[]} working={false} />);
};

describe("a Claude Code `!` command in the chat (#1294)", () => {
  it("draws one shell block with the command and its output, and no tags", () => {
    const { container } = draw("<bash-input> git status</bash-input>", "<bash-stdout>On branch main</bash-stdout><bash-stderr></bash-stderr>");
    const block = screen.getByTestId("shell-block");
    expect(block.textContent).toContain("$ git status");
    expect(within(block).getByTestId("shell-stdout").textContent).toBe("On branch main");
    expect(within(block).queryByTestId("shell-stderr")).toBeNull();
    expect(container.textContent).not.toContain("<bash-");
    expect(screen.queryByTestId("reader-message")).toBeNull();
  });

  it("marks stderr and a failing exit code, and draws nothing for empty stdout", () => {
    draw("<bash-input>cat missing</bash-input>", "<bash-stdout></bash-stdout><bash-stderr>cat: missing: No such file</bash-stderr><bash-exit-code>1</bash-exit-code>");
    expect(screen.queryByTestId("shell-stdout")).toBeNull();
    expect(screen.getByTestId("shell-stderr").className).toContain("text-destructive");
    expect(screen.getByTestId("shell-exit").textContent).toBe("exit 1");
  });

  it("folds long output behind Show more", () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    draw("<bash-input>seq 40</bash-input>", `<bash-stdout>${long}</bash-stdout><bash-stderr></bash-stderr>`);
    const stdout = screen.getByTestId("shell-stdout");
    expect(stdout.textContent?.split("\n")).toHaveLength(SHELL_FOLD_LINES);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(stdout.textContent).toBe(long);
    expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("has no Show more for short output", () => {
    draw("<bash-input>pwd</bash-input>", "<bash-stdout>/repo</bash-stdout><bash-stderr></bash-stderr>");
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("copies the command and its output", async () => {
    draw("<bash-input>pwd</bash-input>", "<bash-stdout>/repo</bash-stdout><bash-stderr>warn</bash-stderr>");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy command and output" })));
    expect(copyText).toHaveBeenCalledWith("$ pwd\n/repo\nwarn");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("leaves a message that mentions the tags in a code fence as the reader's message", () => {
    draw("Look:\n```\n<bash-input>ls</bash-input>\n```");
    expect(screen.queryByTestId("shell-block")).toBeNull();
    expect(screen.getByTestId("reader-message").textContent).toContain("<bash-input>ls</bash-input>");
  });
});
