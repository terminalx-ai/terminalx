import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@/types/session";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { getDraft, setDraft } from "./drafts";
import { addTerminalSelection, inlineTerminalSelection, terminalChatTarget, TERMINAL_SELECTION_INLINE_LIMIT as LIMIT } from "./terminalSelection";

beforeEach(() => { invoke.mockReset(); setDraft("agent-a", ""); setDraft("agent-b", ""); });

describe("terminal selections", () => {
  it("keeps the inclusive threshold inline and attaches the next character", () => {
    expect(inlineTerminalSelection("x".repeat(LIMIT))).toBe(`\`\`\`text\n${"x".repeat(LIMIT)}\n\`\`\``);
    expect(inlineTerminalSelection("x".repeat(LIMIT + 1))).toBeNull();
    expect(inlineTerminalSelection(" ")).toBe("");
    expect(inlineTerminalSelection("error\n```\n~~~\n`````")).toBe("``````text\nerror\n```\n~~~\n`````\n``````");
  });

  it("appends literal output to the target draft without sending or touching other tabs", async () => {
    setDraft("agent-a", "Explain this");
    setDraft("agent-b", "unrelated");
    await addTerminalSelection("s1", "agent-a", "error: broken\n  at line 3", () => true);
    expect(getDraft("agent-a")).toBe("Explain this\n\n```text\nerror: broken\n  at line 3\n```");
    expect(getDraft("agent-b")).toBe("unrelated");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("saves long output as a session attachment and preserves edits made during the save", async () => {
    let finish!: (path: string) => void;
    invoke.mockReturnValue(new Promise<string>((resolve) => { finish = resolve; }));
    const text = "x".repeat(LIMIT + 1);
    const adding = addTerminalSelection("s1", "agent-a", text, () => true);
    setDraft("agent-a", "Edited while saving");
    setDraft("agent-b", "Now reading another tab");
    finish("/private/attachments/s1/terminal.txt");
    await adding;
    expect(invoke).toHaveBeenCalledWith("save_terminal_selection", { sessionId: "s1", tabId: "agent-a", text });
    expect(getDraft("agent-a")).toBe("Edited while saving\n\n@/private/attachments/s1/terminal.txt");
    expect(getDraft("agent-b")).toBe("Now reading another tab");
  });

  it("leaves the draft intact when saving fails or the destination closes", async () => {
    setDraft("agent-a", "Keep me");
    invoke.mockRejectedValueOnce(new Error("disk full"));
    await expect(addTerminalSelection("s1", "agent-a", "x".repeat(LIMIT + 1), () => true)).rejects.toThrow("disk full");
    invoke.mockResolvedValueOnce("/private/attachment.txt");
    await expect(addTerminalSelection("s1", "agent-a", "x".repeat(LIMIT + 1), () => false)).rejects.toThrow("closed");
    expect(getDraft("agent-a")).toBe("Keep me");
  });

  it("targets the selected agent, then the session's active agent while a shell is selected", () => {
    const session = { activeTab: "agent-a", tabs: [{ id: "agent-a" }, { id: "agent-b" }, { id: "shell", front: "terminal" }] } as SessionEntry;
    expect(terminalChatTarget(session, { kind: "agent", id: "agent-b" })?.id).toBe("agent-b");
    expect(terminalChatTarget(session, { kind: "terminal", id: "pane" })?.id).toBe("agent-a");
    expect(terminalChatTarget({ ...session, activeTab: "shell" })?.id).toBe("agent-a");
    expect(terminalChatTarget({ ...session, tabs: [] })).toBeUndefined();
  });
});
