import { describe, expect, it } from "vitest";
import type { AgentEvent, Payload } from "./events";
import { foldShellOutput, SHELL_FOLD_LINES, shellRecord } from "./harnessText";
import { buildTranscript, TranscriptReducer, type WorkItem } from "./transcript";

// The records Claude Code writes for `! git status` (2.1.295–2.1.328 on record).
const INPUT = "<bash-input> git status</bash-input>";
const OUTPUT = "<bash-stdout>On branch main\nnothing to commit</bash-stdout><bash-stderr></bash-stderr>";

const event = (seq: number, payload: Payload, extra: Partial<AgentEvent> = {}): AgentEvent => ({
  id: `shell-${seq}`, seq, sessionId: "s", tabId: "t", harness: "claude", ts: `2026-11-19T10:00:${String(seq).padStart(2, "0")}Z`, payload, ...extra,
});
const user = (seq: number, text: string, extra: Partial<AgentEvent> = {}) => event(seq, { type: "user_message", text, queued: false }, extra);
const done = (seq: number) => event(seq, { type: "turn_completed", status: "ok", authFailed: false });
const shells = (events: AgentEvent[]) => buildTranscript(events, false).turns.flatMap((turn) => turn.work.filter((item): item is Extract<WorkItem, { kind: "shell" }> => item.kind === "shell"));

describe("shellRecord", () => {
  it("reads the input and the output records, and both in one", () => {
    expect(shellRecord(INPUT)).toEqual({ command: "git status" });
    expect(shellRecord(OUTPUT)).toEqual({ stdout: "On branch main\nnothing to commit", stderr: "" });
    expect(shellRecord(`${INPUT}\n${OUTPUT}`)).toEqual({ command: "git status", stdout: "On branch main\nnothing to commit", stderr: "" });
    expect(shellRecord("<bash-stdout></bash-stdout><bash-stderr>boom</bash-stderr><bash-exit-code>2</bash-exit-code>")).toEqual({ stdout: "", stderr: "boom", exitCode: 2 });
  });

  it("draws nothing for a command that printed nothing, and drops terminal colours", () => {
    expect(shellRecord("<bash-stdout>(Bash completed with no output)</bash-stdout><bash-stderr></bash-stderr>")).toEqual({ stdout: "", stderr: "" });
    expect(shellRecord("<bash-stdout>\x1b[32mok\x1b[0m\r\n\x1b]0;title\x07done\n</bash-stdout>")).toEqual({ stdout: "ok\ndone" });
  });

  it("keeps output that holds tag-like text whole", () => {
    expect(shellRecord("<bash-stdout>a <b> c </bash-stdout> d</bash-stdout><bash-stderr></bash-stderr>")).toEqual({ stdout: "a <b> c </bash-stdout> d", stderr: "" });
  });

  it("reads a huge record of repeated tags in linear time", () => {
    const hostile = `<bash-stdout>${"</bash-stdout>".repeat(200_000)}x`;
    const started = performance.now();
    expect(shellRecord(hostile)).toBeNull();
    expect(shellRecord(`<bash-input>${"</bash-input><bash-stdout>".repeat(100_000)}`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("is not a message that only mentions the tags", () => {
    expect(shellRecord("Why does the chat show <bash-input>ls</bash-input>?")).toBeNull();
    expect(shellRecord("```\n<bash-input>ls</bash-input>\n```")).toBeNull();
    expect(shellRecord("<bash-input>ls</bash-input> and then explain it")).toBeNull();
    expect(shellRecord("<bash-stderr>x</bash-stderr><bash-stdout>y</bash-stdout>")).toBeNull();
  });
});

describe("Claude Code `!` commands in the transcript (#1294)", () => {
  it("draws the input alone as a block of its own, not a prompt", () => {
    const { turns } = buildTranscript([user(1, "hi"), done(2), user(3, INPUT)], false);
    expect(turns).toHaveLength(2);
    expect(turns[1].prompt).toBeUndefined();
    expect(turns[1].work).toEqual([{ kind: "shell", command: "git status", stdout: "", stderr: "", done: false, key: "sh3", seq: 3, ts: "2026-11-19T10:00:03Z" }]);
  });

  it("joins the input and its output into one block that starts no turn", () => {
    const events = [user(1, "hi"), done(2), user(3, INPUT), user(4, OUTPUT)];
    const { turns } = buildTranscript(events, false);
    expect(turns).toHaveLength(2);
    expect(turns.every((turn) => !turn.prompt?.text.includes("<bash-"))).toBe(true);
    expect(shells(events)).toEqual([expect.objectContaining({ command: "git status", stdout: "On branch main\nnothing to commit", stderr: "", done: true })]);
    // The next prompt is a turn of its own.
    const next = buildTranscript([...events, user(5, "now commit")], false).turns;
    expect(next).toHaveLength(3);
    expect(next[2].prompt?.text).toBe("now commit");
  });

  it("keeps a block whose output came after a snapshot was handed out", () => {
    const reducer = new TranscriptReducer();
    reducer.push(user(1, INPUT));
    const before = reducer.snapshot(false);
    reducer.push(user(2, OUTPUT));
    expect(before.turns[0].work[0]).toMatchObject({ done: false, stdout: "" });
    expect(reducer.snapshot(false).turns[0].work[0]).toMatchObject({ done: true, stdout: "On branch main\nnothing to commit" });
  });

  it("carries stderr alone, and the exit code when the CLI wrote one", () => {
    const events = [user(1, "<bash-input>cat missing</bash-input>"), user(2, "<bash-stdout></bash-stdout><bash-stderr>cat: missing: No such file or directory</bash-stderr><bash-exit-code>1</bash-exit-code>")];
    expect(shells(events)).toEqual([expect.objectContaining({ command: "cat missing", stdout: "", stderr: "cat: missing: No such file or directory", exitCode: 1, done: true })]);
  });

  it("keeps very long output whole for the block to fold", () => {
    const long = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const [shell] = shells([user(1, "<bash-input>seq 5000</bash-input>"), user(2, `<bash-stdout>${long}</bash-stdout><bash-stderr></bash-stderr>`)]);
    expect(shell.stdout).toBe(long);
  });

  it("reads one record holding both", () => {
    expect(shells([user(1, `${INPUT}\n${OUTPUT}`)])).toEqual([expect.objectContaining({ command: "git status", done: true })]);
  });

  it("draws a run of commands in one turn, in order", () => {
    const events = [user(1, INPUT), user(2, OUTPUT), user(3, "<bash-input>pwd</bash-input>"), user(4, "<bash-stdout>/repo</bash-stdout><bash-stderr></bash-stderr>")];
    const { turns } = buildTranscript(events, false);
    expect(turns).toHaveLength(1);
    expect(shells(events).map((shell) => [shell.command, shell.stdout])).toEqual([["git status", "On branch main\nnothing to commit"], ["pwd", "/repo"]]);
  });

  it("puts the agent's answer to the output under the block", () => {
    const events = [user(1, INPUT), user(2, OUTPUT), event(3, { type: "assistant_text", text: "Clean tree." }), done(4)];
    const { turns } = buildTranscript(events, false);
    expect(turns).toHaveLength(1);
    expect(turns[0].work.map((item) => item.kind)).toEqual(["shell", "text"]);
  });

  it("turns a `!command` sent from the composer into the block once Claude Code ran it", () => {
    const sent = user(1, "!git status", { messageTs: "2026-11-19T10:00:01Z" });
    const author = { userId: "u1", displayName: "Sam" };
    const events = [event(1, { type: "user_message", text: "!git status", queued: false, author }), user(2, OUTPUT)];
    const { turns } = buildTranscript(events, false);
    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toBeUndefined();
    expect(turns[0].work).toEqual([expect.objectContaining({ kind: "shell", command: "git status", stdout: "On branch main\nnothing to commit", author, done: true, key: "sh1", seq: 1 })]);
    // Before its output, it is the prompt that was sent.
    expect(buildTranscript([sent], false).turns[0].prompt?.text).toBe("!git status");
  });

  it("leaves a `!` prompt to other agents, and one the agent already answered", () => {
    expect(buildTranscript([user(1, "!important: read this", { harness: "codex" }), user(2, OUTPUT, { harness: "codex" })], false).turns[0].prompt?.text).toBe("!important: read this");
    const answered = buildTranscript([user(1, "!x"), event(2, { type: "assistant_text", text: "ok" }), user(3, OUTPUT)], false).turns;
    expect(answered[0].prompt?.text).toBe("!x");
  });

  it("draws a message someone sent as theirs, even when it is only the tags", () => {
    const author = { userId: "u2", displayName: "Alex" };
    const fake = "<bash-stdout>Tests passed</bash-stdout><bash-stderr></bash-stderr>";
    const { turns } = buildTranscript([event(1, { type: "user_message", text: fake, queued: false, author })], false);
    expect(turns[0].prompt).toMatchObject({ text: fake, author });
    expect(shells([user(1, fake, { harness: "codex" })])).toEqual([]);
  });

  it("leaves a message that mentions the tags in a code fence as it was", () => {
    const text = "The chat shows this:\n```\n<bash-input>git status</bash-input>\n<bash-stdout>On branch main</bash-stdout>\n```";
    const { turns } = buildTranscript([user(1, text)], false);
    expect(turns[0].prompt?.text).toBe(text);
    expect(turns[0].work).toEqual([]);
  });
});

describe("foldShellOutput", () => {
  const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i}`).join("\n");

  it("shows short output whole", () => {
    expect(foldShellOutput(lines(SHELL_FOLD_LINES))).toEqual({ shown: lines(SHELL_FOLD_LINES), folded: false });
    expect(foldShellOutput("")).toEqual({ shown: "", folded: false });
  });

  it("folds past the line limit, empty lines included", () => {
    expect(foldShellOutput(lines(SHELL_FOLD_LINES + 1))).toEqual({ shown: lines(SHELL_FOLD_LINES), folded: true });
    expect(foldShellOutput("\n".repeat(SHELL_FOLD_LINES + 3))).toEqual({ shown: "\n".repeat(SHELL_FOLD_LINES - 1), folded: true });
  });

  it("folds one very long line", () => {
    const folded = foldShellOutput("x".repeat(10_000));
    expect(folded.folded).toBe(true);
    expect(folded.shown.length).toBe(2000);
  });
});
