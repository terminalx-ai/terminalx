import { describe, expect, it } from "vitest";
import type { Token } from "marked";
import type { ToolCall, Turn, WorkItem } from "@terminalx/portable/transcript";
import { markdownBlocks, textChunks } from "./markdown-blocks";
import { callCommand, callDescription, callsLabel, commandFirstLine, deliveryNote, messageDelivery, turnRows, type TurnRow } from "./transcript-rows";

const turn: Turn = { key: "t1", seq: 1, ts: "", prompt: { text: "Prompt", seq: 1, ts: "" }, work: [], toolCount: 0, editedFiles: 0, live: false };
const visibleText = (token: Token): string => "tokens" in token && token.tokens?.length ? token.tokens.map(visibleText).join("") : token.type === "br" ? "\n" : "text" in token ? token.text : token.raw;

describe("transcript virtualization units", () => {
  it("breaks a long turn into independently keyed blocks without losing content", () => {
    const text = "Paragraph one.\n\nParagraph two.\n\nParagraph three.";
    const rows = turnRows({ ...turn, work: [
      { kind: "text", key: "a2", seq: 2, text },
      { kind: "reasoning", key: "r3", seq: 3, text: "Thinking.\n".repeat(300) },
    ], finalText: "**Final answer**" });
    expect(rows[0]).toMatchObject({ kind: "prompt", text: "Prompt", startsTurn: true });
    expect(rows.filter((row) => row.kind === "markdown").map((row) => visibleText(row.token))).toEqual(["Paragraph one.", "Paragraph two.", "Paragraph three.", "Final answer"]);
    expect(rows.flatMap((row) => row.kind === "work" && row.item.kind === "reasoning" ? [row.item.text] : []).join("")).toBe("Thinking.\n".repeat(300));
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    expect(rows.filter((row) => row.startsTurn)).toHaveLength(1);
  });

  it("draws a message the agent took mid-turn as the reader's, where it was taken (#551)", () => {
    const rows = turnRows({ ...turn, work: [
      { kind: "text", key: "a2", seq: 2, text: "Building." },
      { kind: "message", key: "m3", seq: 3, text: "use the staging config" },
      { kind: "queued", key: "q4", seq: 4, text: "and then deploy" },
    ] });
    expect(rows.map((row) => [row.kind, row.kind === "prompt" ? row.text : row.kind === "work" ? row.item.kind : ""])).toEqual([
      ["prompt", "Prompt"],
      ["markdown", ""],
      ["prompt", "use the staging config"],
      ["prompt", "and then deploy"],
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it("keeps existing keys when output streams and earlier context arrives", () => {
    const work = { kind: "text" as const, key: "a2", seq: 2, text: "First paragraph.\n\nSecond" };
    const before = turnRows({ ...turn, work: [work] });
    const after = turnRows({ ...turn, work: [{ ...work, text: `${work.text} paragraph.\n\nThird.` }] });
    expect(after.slice(0, before.length).map((row) => row.key)).toEqual(before.map((row) => row.key));
    const orphan = turnRows({ ...turn, key: "t2", seq: 2, prompt: undefined, work: [work] });
    expect(orphan[0].key).toBe(before[1].key);
  });
});

describe("large individual messages", () => {
  it("bounds prompt/reasoning text by characters and lines, preserving Unicode and whitespace", () => {
    for (const text of ["word ".repeat(3000), "line\n".repeat(300), "🚀".repeat(3000), "x".repeat(5000)]) {
      const chunks = textChunks(text);
      expect(chunks.join("")).toBe(text);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(1600);
        expect(chunk.split("\n").length).toBeLessThanOrEqual(33);
        expect(chunk.isWellFormed()).toBe(true);
      }
    }
  });

  it("splits fenced code without dropping lines or its language", () => {
    const code = "const value = 42;\n".repeat(300);
    const blocks = markdownBlocks(`\`\`\`ts\n${code}\`\`\``);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.every((token) => token.type === "code" && token.lang === "ts")).toBe(true);
    expect(blocks.map(visibleText).join("")).toBe(code.trimEnd());
  });

  it("retains inline formatting and reference links across a split paragraph", () => {
    const text = "formatted words ".repeat(400).trimEnd();
    const blocks = markdownBlocks(`**${text}** [Reference][ref]\n\n[ref]: https://example.com/path`);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.map(visibleText).join("")).toBe(`${text} Reference`);
    const tokens = blocks.flatMap((token) => "tokens" in token ? token.tokens ?? [] : []);
    expect(tokens.filter((token) => token.type === "strong").length).toBeGreaterThan(1);
    expect(tokens.find((token) => token.type === "link")).toMatchObject({ href: "https://example.com/path" });
  });

  it("keeps ordered list numbering and table headers when splitting large structures", () => {
    const list = markdownBlocks(Array.from({ length: 100 }, (_, i) => `${i + 5}. Item ${i}`).join("\n"));
    expect(list).toHaveLength(100);
    expect(list.map((token) => token.type === "list" ? token.start : null)).toEqual(Array.from({ length: 100 }, (_, i) => i + 5));
    const table = markdownBlocks(`| Name | Value |\n| --- | --- |\n${Array.from({ length: 100 }, (_, i) => `| Row ${i} | ${i} |`).join("\n")}`);
    expect(table.length).toBeGreaterThan(1);
    expect(table.every((token) => token.type === "table" && token.header[0].text === "Name" && token.rows.length <= 8)).toBe(true);
    expect(table.flatMap((token) => token.type === "table" ? token.rows : [])).toHaveLength(100);
  });
});

describe("what became of a message on its way to the agent (#722)", () => {
  it("says it under the last row of the message, and nowhere else", () => {
    const long = "word ".repeat(2_000).trim();
    const rows = turnRows({ ...turn, prompt: { text: long, seq: 1, ts: "", replaced: true }, work: [
      { kind: "message", key: "m3", seq: 3, text: "what the agent received", sent: "what was sent" },
      { kind: "message", key: "m4", seq: 4, text: "as sent" },
    ] });
    const prompts = rows.filter((row) => row.kind === "prompt");
    const notes = prompts.map((row) => (row.kind === "prompt" ? row.note : undefined));
    const promptRows = textChunks(long).length;
    expect(promptRows).toBeGreaterThan(1);
    expect(notes.slice(0, promptRows - 1).every((note) => note === undefined)).toBe(true);
    expect(notes[promptRows - 1]).toMatch(/^Not answered/);
    expect(notes[promptRows]).toMatch(/^Changed on the way/);
    expect(notes[promptRows + 1]).toBeUndefined();
  });

  it("puts what is in the agent's input box ahead of a change, and a replacement ahead of both", () => {
    expect(deliveryNote({})).toBeUndefined();
    expect(deliveryNote({ inputOccupied: true, sent: "x" })).toMatch(/input box already has text in it/);
    expect(deliveryNote({ inputOccupied: true, inputChoice: true })).toMatch(/asking a question in its terminal/);
    expect(deliveryNote({ replaced: true, inputOccupied: true })).toMatch(/^Not answered/);
    expect(deliveryNote({ withdrawn: true })).toMatch(/^Not sent/);
    expect(deliveryNote({ withdrawn: true, unconfirmed: true })).toMatch(/^Delivery was not confirmed/);
  });

  it("gives a running compaction no row (the conversation's running line stands for it), and every other one its row (#644)", () => {
    const compaction = (state: "item_started" | "completed" | "unknown" | "stopped") =>
      ({ kind: "compaction" as const, key: `k-${state}`, seq: 2, lifecycle: { turnId: "turn", itemId: state, state, generation: 1, retrying: false } });
    const rows = turnRows({ ...turn, work: [compaction("item_started"), compaction("unknown"), compaction("completed"), compaction("stopped")] });
    expect(rows.map((row) => row.key)).toEqual(["prompt:1:0", "k-unknown", "k-completed", "k-stopped"]);
  });
});

describe("a prompt's images", () => {
  it("ride on the first of its rows, and only there", () => {
    const images = [{ url: "/Users/me/.terminalx/attachments/s/shot.png", name: "shot.png" }];
    const rows = turnRows({ ...turn, prompt: { text: `${"word ".repeat(4000)}`, seq: 1, ts: "", images } });
    const prompts = rows.filter((row) => row.kind === "prompt");
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts[0]).toMatchObject({ images });
    expect(prompts.slice(1).some((row) => row.kind === "prompt" && row.images)).toBe(false);
    // An image sent with no words is still a row.
    expect(turnRows({ ...turn, prompt: { text: "", seq: 1, ts: "", images } })[0]).toMatchObject({ kind: "prompt", images });
  });
});

const bash = (id: string, command: string, extra: Partial<ToolCall> = {}): ToolCall => ({ callId: id, name: "Bash", toolType: "shell", input: { command }, title: command, seq: 2, result: { text: "", isError: false }, ...extra });
const tool = (call: ToolCall): WorkItem => ({ kind: "tool", call, key: `c${call.callId}` });
const shape = (rows: TurnRow[]) => rows.map((row) => row.kind === "calls" ? `calls:${row.calls.map((call) => call.callId).join("+")}` : row.kind === "work" ? `work:${row.item.kind}` : row.kind);

// Design 22.03: commands fold into one line that opens to the agent's words, then the command.
describe("a run of tool calls folds into one row", () => {
  it("folds consecutive calls, and anything that is not a call between them starts a new run", () => {
    const rows = turnRows({ ...turn, work: [
      tool(bash("a", "date")), tool(bash("b", "tail -6 build.log")),
      { kind: "text", key: "x", seq: 3, text: "Two checks still run." },
      tool(bash("c", "gh pr checks")),
      { kind: "reasoning", key: "r", seq: 4, text: "Wait for macOS." },
      tool(bash("d", "sleep 60")), tool({ callId: "e", name: "Read", toolType: "file_read", input: { file_path: "a.ts" }, seq: 5 }),
    ] });
    expect(shape(rows)).toEqual(["prompt", "calls:a+b", "markdown", "calls:c", "work:reasoning", "calls:d+e"]);
    expect(rows[1].startsTurn).toBe(false);
  });

  it("keeps a run's key as calls join it, so a row being drawn is not remounted", () => {
    const one = turnRows({ ...turn, work: [tool(bash("a", "date"))] });
    const two = turnRows({ ...turn, work: [tool(bash("a", "date")), tool(bash("b", "ls"))] });
    expect(one[1].key).toBe("calls:a");
    expect(two.map((row) => row.key)).toEqual(["prompt:1:0", "calls:a"]);
  });

  it("joins the calls groupWork folded with the calls around them", () => {
    const reads = ["r1", "r2", "r3", "r4"].map((id): ToolCall => ({ callId: id, name: "Read", toolType: "file_read", input: { file_path: `${id}.ts` }, seq: 3 }));
    const rows = turnRows({ ...turn, work: [tool(bash("a", "ls")), { kind: "tool_group", name: "Read", calls: reads, key: "gr1" }, tool(bash("b", "pnpm test"))] });
    expect(shape(rows)).toEqual(["prompt", "calls:a+r1+r2+r3+r4+b"]);
    expect(rows[1].kind === "calls" && callsLabel(rows[1].calls)).toBe("Ran 2 commands, read 4 files");
  });

  it("leaves a call a safety check held on a row of its own, ending the run before it (#775)", () => {
    const held = bash("h", "rm -rf build", { result: { text: "", isError: false, safetyCheck: "Approved past Claude's dangerous-removal check" } });
    const rows = turnRows({ ...turn, work: [tool(bash("a", "ls")), tool(held), tool(bash("b", "pwd")), tool(bash("c", "date"))] });
    expect(shape(rows)).toEqual(["prompt", "calls:a", "calls:h", "calls:b+c"]);
  });

  it("a running compaction, which has no row, does not split a run", () => {
    const compaction: WorkItem = { kind: "compaction", key: "k", seq: 3, lifecycle: { turnId: "t", itemId: "k", state: "item_started", generation: 1, retrying: false } };
    expect(shape(turnRows({ ...turn, work: [tool(bash("a", "ls")), compaction, tool(bash("b", "pwd"))] }))).toEqual(["prompt", "calls:a+b"]);
  });
});

describe("what a folded run says", () => {
  it("counts the calls by kind, in the order the agent used them", () => {
    expect(callsLabel([bash("a", "date"), bash("b", "ls")])).toBe("Ran 2 commands");
    expect(callsLabel([{ callId: "e", name: "Edit", toolType: "file_edit", input: {}, seq: 1, result: { text: "", isError: false } }, bash("a", "pnpm test")])).toBe("Edited a file, ran a command");
    expect(callsLabel([bash("a", "date"), bash("b", "sleep 60", { result: undefined })])).toBe("Ran 2 commands · running");
    expect(callsLabel([bash("a", "date"), bash("b", "sleep 60", { result: undefined, abandoned: true })])).toBe("Ran 2 commands · stopped");
  });

  it("names a single call in the agent's own words", () => {
    expect(callsLabel([bash("a", "tail -6 /tmp/x/tasks/build.log", { input: { command: "tail -6 /tmp/x/tasks/build.log", description: "Read the last lines of the task log" } })])).toBe("Read the last lines of the task log");
    expect(callsLabel([bash("a", "ls")])).toBe("Ran a command");
  });

  it("describes a call by what the agent said of it, then its title, then its kind", () => {
    expect(callDescription(bash("a", "date", { input: { command: "date", description: "Check the time" } }))).toBe("Check the time");
    expect(callDescription(bash("a", "date", { input: { command: ["bash", "-lc", "date"], justification: "To know when the checks started" } }))).toBe("To know when the checks started");
    expect(callDescription({ callId: "w", name: "WebFetch", toolType: "web", input: { url: "https://example.com" }, title: "Fetch the release notes", seq: 1 })).toBe("Fetch the release notes");
    expect(callDescription(bash("a", "date"))).toBe("Ran a command");
    expect(callDescription({ callId: "r", name: "Read", toolType: "file_read", input: { file_path: "a.ts" }, title: "Read", seq: 1 })).toBe("Read a file");
  });

  it("gives the command whole, and its first line with a mark when there is more", () => {
    expect(callCommand(bash("a", "for p in 1 2; do\n  echo $p\ndone"))).toBe("for p in 1 2; do\n  echo $p\ndone");
    expect(callCommand(bash("a", "", { input: { command: ["/bin/zsh", "-lc", "git status --short"] } }))).toBe("git status --short");
    expect(callCommand(bash("a", "", { input: { command: ["rg", "-n", "TODO"] } }))).toBe("rg -n TODO");
    expect(callCommand({ callId: "r", name: "Read", toolType: "file_read", input: { file_path: "src/a.ts" }, seq: 1 })).toBe("src/a.ts");
    expect(callCommand({ callId: "p", name: "TodoWrite", toolType: "plan", input: { todos: [] }, seq: 1 })).toBeUndefined();
    expect(commandFirstLine("date '+%H:%M'")).toEqual({ line: "date '+%H:%M'", cut: false });
    expect(commandFirstLine("for p in 1 2; do\n  echo $p\ndone\n")).toEqual({ line: "for p in 1 2; do …", cut: true });
  });
});

// Design 22.03: the send feedback is under the message: a tick when the Mac has it, "Queued" while it waits.
describe("where the reader's message is", () => {
  const deliveries = (rows: TurnRow[]) => rows.flatMap((row) => row.kind === "prompt" ? [row.delivery ?? null] : []);

  it("ticks a prompt and a message the agent took, on the last of their rows only", () => {
    const long = "word ".repeat(2_000).trim();
    const rows = turnRows({ ...turn, prompt: { text: long, seq: 1, ts: "" }, work: [{ kind: "message", key: "m3", seq: 3, text: "use staging" }] });
    const chunks = textChunks(long).length;
    expect(deliveries(rows)).toEqual([...Array(chunks - 1).fill(null), "delivered", "delivered"]);
  });

  it("says Queued under a message waiting for the agent, and under one waiting on the agent's input box", () => {
    const rows = turnRows({ ...turn, work: [
      { kind: "queued", key: "q1", seq: 2, text: "and then deploy" },
      { kind: "message", key: "m2", seq: 3, text: "after the text in the box", inputOccupied: true },
    ] });
    expect(deliveries(rows)).toEqual(["delivered", "queued", "queued"]);
    expect(rows[1]).toMatchObject({ kind: "prompt", text: "and then deploy", delivery: "queued" });
  });

  it("claims nothing for a message never sent or whose delivery was not confirmed, and says why", () => {
    const rows = turnRows({ ...turn, prompt: { text: "Prompt", seq: 1, ts: "", unconfirmed: true }, work: [{ kind: "queued", key: "q1", seq: 2, text: "stopped first", withdrawn: true }] });
    expect(deliveries(rows)).toEqual([null, null]);
    expect(rows.map((row) => row.kind === "prompt" ? row.note : undefined)).toEqual([expect.stringMatching(/^Delivery was not confirmed/), expect.stringMatching(/^Not sent/)]);
  });

  it("still ticks a message the Mac had that changed on the way, or that the agent passed over", () => {
    expect(messageDelivery({ sent: "what was typed" }, false)).toBe("delivered");
    expect(messageDelivery({ replaced: true }, false)).toBe("delivered");
    expect(messageDelivery({}, true)).toBe("queued");
  });
});
