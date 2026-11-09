import { describe, expect, it } from "vitest";
import { createChatSearchIndex, markdownSearchText, MAX_CHAT_MATCHES, searchText, searchTranscript } from "./chatSearch";
import { buildTranscript, type Transcript, type Turn } from "./transcript";

const turn = (key: string): Turn => ({ key, seq: 1, ts: "", work: [], toolCount: 0, editedFiles: 0, live: false });
const transcript = (turns: Turn[]): Transcript => ({ ...buildTranscript([], false), turns });
const options = { matchCase: false, includeToolOutput: true };

describe("transcript search", () => {
  it("finds every occurrence in prompts, answers, thinking, absorbed/queued prompts and grouped tool output, in order", () => {
    const t = turn("t");
    t.prompt = { seq: 1, ts: "", text: "Needle needle" };
    t.work = [
      { kind: "reasoning", key: "r", seq: 2, text: "a needle" },
      { kind: "message", key: "m", seq: 3, text: "NEEDLE" },
      { kind: "tool_group", key: "g", name: "Read", calls: [
        { seq: 4, callId: "c1", name: "Read", toolType: "file_read", input: {}, result: { isError: false, text: "unrelated" } },
        { seq: 5, callId: "c2", name: "Read", toolType: "file_read", input: {}, result: { isError: false, text: "needle" } },
      ] },
      { kind: "text", key: "a", seq: 6, text: "The **needle** is in `file.ts`." },
      { kind: "queued", key: "q", seq: 7, text: "needle?" },
    ];
    const index = createChatSearchIndex()(transcript([t]));
    const matches = searchTranscript(index, "needle", options);
    expect(matches.map((match) => match.section.id.split(":").at(-1))).toEqual(["message%3A1", "message%3A1", "r", "message%3A3", "output%3Ac2", "a", "message%3A7"]);
    expect(matches.slice(0, 2).map((m) => [m.from, m.to, m.occurrence])).toEqual([[0, 6, 0], [7, 13, 1]]);
    expect(matches[4].section.disclosures).toEqual(["t/fold", "t/group:c1", "t/call:c2"]);
    expect(searchTranscript(index, "needle", { ...options, matchCase: true })).toHaveLength(5);
    expect(searchTranscript(index, "needle", { ...options, includeToolOutput: false })).toHaveLength(6);
    expect(searchTranscript(index, "", options)).toEqual([]);
    expect(searchTranscript(index, "  ", options)).toEqual([]);
  });

  it("searches visible Markdown words across formatting, entities, tables and code; not markup or link destinations", () => {
    const source = "# Error **in** [file](https://hidden.test)\n\nA &amp; B and `a.*b`\n\n| Path | Status |\n| --- | --- |\n| x.ts | failed |\n\n```ts\nconst value = 1;\n```";
    expect(markdownSearchText(source)).toBe("Error in file A & B and a.*b Path Status x.ts failed const value = 1;");
    const t = { ...turn("t"), work: [{ kind: "text" as const, key: "a", seq: 2, text: source }] };
    const index = createChatSearchIndex()(transcript([t]));
    expect(searchTranscript(index, "Error in file", options)).toHaveLength(1);
    expect(searchTranscript(index, "a.*b", options)).toHaveLength(1);
    expect(searchTranscript(index, "hidden.test", options)).toHaveLength(0);
  });

  it("keeps Unicode offsets and treats special characters literally", () => {
    const t = { ...turn("t"), prompt: { seq: 1, ts: "", text: "İ Σ σ ς 😀 a.*b [file]" } };
    const index = createChatSearchIndex()(transcript([t]));
    expect(searchTranscript(index, "σ", options).map((m) => [m.from, m.to])).toEqual([[2, 3], [4, 5], [6, 7]]);
    expect(searchTranscript(index, "😀", options)[0]).toMatchObject({ from: 8, to: 10 });
    expect(searchTranscript(index, "[file]", options)).toHaveLength(1);
  });

  it("preserves boundary spaces and Unicode offsets when collapsing mixed whitespace", () => {
    const text = "\tİ\r\nΣ  \u00a0😀\u2028a.*b\uFEFF";
    expect(searchText(text)).toBe(" İ Σ 😀 a.*b ");
    expect(searchText("")).toBe("");
    expect(searchText("\t\r\n\u00a0")).toBe(" ");
    expect(searchText("already normalized\u200b")).toBe("already normalized\u200b");
    const t = { ...turn("t"), prompt: { seq: 1, ts: "", text } };
    const index = createChatSearchIndex()(transcript([t]));
    expect(searchTranscript(index, "σ", options)[0]).toMatchObject({ from: 3, to: 4 });
    expect(searchTranscript(index, "😀", options)[0]).toMatchObject({ from: 5, to: 7 });
    expect(searchTranscript(index, "\r\n a.*b\t", options)[0]).toMatchObject({ from: 7, to: 13 });
  });

  it("indexes error summaries and the agent's details separately", () => {
    const t = turn("failed");
    t.work = [{ kind: "error", key: "err", seq: 1, text: "request failed", detail: "missing credential" }];
    t.completed = { status: "error", ts: "" };
    t.finalText = "Launch failed";
    t.detail = "missing executable";
    const matches = searchTranscript(createChatSearchIndex()(transcript([t])), "missing", options);
    expect(matches.map((match) => match.section.id)).toEqual(["chat-find:failed:err%3Adetail", "chat-find:failed:failure-detail"]);
    expect(matches[0].section.disclosures).toEqual(["failed/fold"]);
  });

  it("indexes output beyond the display truncation and reuses settled turns when new output arrives", () => {
    const first = turn("first");
    first.work = [{ kind: "tool", key: "read", call: { callId: "read", seq: 2, name: "Read", toolType: "file_read", input: {}, result: { isError: false, text: "x".repeat(25000) + "needle" } } }];
    const index = createChatSearchIndex();
    const before = index(transcript([first]));
    const after = index(transcript([first, { ...turn("second"), prompt: { seq: 3, ts: "", text: "new needle" } }]));
    expect(after[0]).toBe(before[0]);
    expect(searchTranscript(after, "needle", options)).toHaveLength(2);
  });

  it("answers queries over a prepared 2,000-turn transcript in under 100 ms", () => {
    const turns = Array.from({ length: 2000 }, (_, i) => ({
      ...turn(`t${i}`),
      prompt: { seq: i * 3, ts: "", text: `Inspect file ${i}.ts` },
      work: [
        { kind: "text" as const, key: `a${i}`, seq: i * 3 + 1, text: `The **error** in file ${i}.ts is fixed.\n\n` + "Ordinary explanation. ".repeat(40) },
        { kind: "tool" as const, key: `c${i}`, call: { callId: `c${i}`, seq: i * 3 + 2, name: "Read", toolType: "file_read", input: {}, result: { isError: false, text: "tool output\n".repeat(200) + "error" } } },
      ],
    }));
    const index = createChatSearchIndex()(transcript(turns));
    const started = performance.now();
    const matches = searchTranscript(index, "error", options);
    const elapsed = performance.now() - started;
    expect(matches).toHaveLength(4000);
    expect(elapsed).toBeLessThan(100);
    expect(searchTranscript(index, "o", options)).toHaveLength(MAX_CHAT_MATCHES);
  });
});
