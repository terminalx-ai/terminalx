import { describe, expect, it } from "vitest";
import { approvalFiles, parsePatch, rawPatch } from "./approvalDiff";

const patch = (...body: string[]) => ["*** Begin Patch", ...body, "*** End Patch"].join("\n");

describe("parsePatch", () => {
  it("reads an update as its context, removed and added lines, with the gap between chunks", () => {
    const files = parsePatch(patch("*** Update File: src/slug.js", "@@ export function slugify(input) {", "-  return input.replace(/ /g, \"-\");", "+  return input", "+    .toLowerCase();", " }", "@@", "-const a = 1;", "+const a = 2;"));
    expect(files).toEqual([
      {
        path: "src/slug.js",
        kind: "update",
        added: 3,
        removed: 2,
        lines: [
          { kind: "hunk", text: "@@ export function slugify(input) {" },
          { kind: "del", text: "  return input.replace(/ /g, \"-\");" },
          { kind: "add", text: "  return input" },
          { kind: "add", text: "    .toLowerCase();" },
          { kind: "ctx", text: "}" },
          { kind: "hunk", text: "" },
          { kind: "del", text: "const a = 1;" },
          { kind: "add", text: "const a = 2;" },
        ],
      },
    ]);
  });

  it("reads an added file, a deleted file and a rename in one patch", () => {
    const files = parsePatch(patch("*** Add File: docs/new.md", "+# New", "+", "+Body", "*** Delete File: old.txt", "*** Update File: a.ts", "*** Move to: b.ts", "@@", " keep", "-x", "+y", "*** End of File"));
    expect(files?.map((f) => [f.kind, f.path, f.movePath, f.added, f.removed])).toEqual([
      ["create", "docs/new.md", undefined, 3, 0],
      ["delete", "old.txt", undefined, 0, 0],
      ["rename", "a.ts", "b.ts", 1, 1],
    ]);
    expect(files?.[0].lines.map((l) => l.text)).toEqual(["# New", "", "Body"]);
    // The opening `@@` of the first chunk says nothing, so it draws no row.
    expect(files?.[2].lines).toEqual([{ kind: "ctx", text: "keep" }, { kind: "del", text: "x" }, { kind: "add", text: "y" }]);
  });

  it("keeps a bare move as a rename, and an empty line in a chunk as an empty context line", () => {
    expect(parsePatch(patch("*** Update File: a.ts", "*** Move to: lib/a.ts"))).toEqual([{ path: "a.ts", movePath: "lib/a.ts", kind: "rename", lines: [], added: 0, removed: 0 }]);
    expect(parsePatch(patch("*** Update File: a.ts", " one", "", "-two"))?.[0].lines).toEqual([{ kind: "ctx", text: "one" }, { kind: "ctx", text: "" }, { kind: "del", text: "two" }]);
  });

  it("reads Windows line endings", () => {
    expect(parsePatch(patch("*** Update File: a.ts", "-x", "+y").replace(/\n/g, "\r\n"))?.[0].lines.map((l) => l.text)).toEqual(["x", "y"]);
  });

  it("refuses a patch it cannot read whole, rather than show part of it", () => {
    expect(parsePatch("*** Update File: a.ts\n-x\n+y")).toBeNull(); // no Begin
    expect(parsePatch("*** Begin Patch\n*** Update File: a.ts\n-x\n+y")).toBeNull(); // no End
    expect(parsePatch(patch("*** Update File: a.ts", "-x", "garbage", "+y"))).toBeNull();
    expect(parsePatch(patch("*** Frobnicate File: a.ts"))).toBeNull();
    expect(parsePatch(patch("*** Update File: a.ts"))).toBeNull(); // changes nothing
    expect(parsePatch(patch())).toBeNull();
    expect(parsePatch(`${patch("*** Update File: a.ts", "-x", "+y")}\nrm -rf ~`)).toBeNull();
  });
});

describe("approvalFiles", () => {
  const body = patch("*** Update File: README.md", "@@", "-hello", "+hello raccoon");

  it("finds Codex's patch however the request carries it", () => {
    for (const input of [
      { command: body },
      { patch: body },
      { input: body },
      { command: ["apply_patch", body] },
      { command: `apply_patch <<'EOF'\n${body}\nEOF\n` },
      { command: `apply_patch <<EOF\n${body}\nEOF` },
      { command: `apply_patch ${body}` },
    ]) {
      expect(approvalFiles("apply_patch", input)?.map((f) => [f.path, f.added, f.removed]), JSON.stringify(input)).toEqual([["README.md", 1, 1]]);
    }
  });

  it("does not read a patch out of a command that does more than apply it", () => {
    expect(approvalFiles("apply_patch", { command: `cd /elsewhere && apply_patch <<'EOF'\n${body}\nEOF` })).toBeNull();
    expect(approvalFiles("apply_patch", { command: `apply_patch <<'EOF'\n${body}\nEOF\nrm -rf ~` })).toBeNull();
    // A shell command holding a patch is still a command.
    expect(approvalFiles("Bash", { command: body })).toBeNull();
    expect(approvalFiles("apply_patch", { command: "apply_patch" })).toBeNull();
    expect(approvalFiles("apply_patch", undefined)).toBeNull();
  });

  it("quotes the patch whole for a card that cannot read it", () => {
    expect(rawPatch({ command: body })).toBe(body);
    expect(rawPatch({ command: ["apply_patch", body] })).toBe(body);
    expect(rawPatch({ command: ["sh", "-c", "x"] })).toBe("sh -c x");
    expect(rawPatch({})).toBeNull();
  });

  it("diffs Claude's Edit, noting an edit made at every match", () => {
    const [file] = approvalFiles("Edit", { file_path: "/w/a.ts", old_string: "const a = 1;\nconst b = 2;", new_string: "const a = 1;\nconst b = 3;", replace_all: true })!;
    expect(file).toMatchObject({ path: "/w/a.ts", kind: "update", added: 1, removed: 1, note: "Replaces every match in the file" });
    expect(file.lines).toEqual([{ kind: "ctx", text: "const a = 1;" }, { kind: "del", text: "const b = 2;" }, { kind: "add", text: "const b = 3;" }]);
    expect(approvalFiles("Edit", { file_path: "/w/a.ts", new_string: "x" })).toBeNull();
  });

  it("diffs each of a MultiEdit's edits under its own label", () => {
    const [file] = approvalFiles("MultiEdit", { file_path: "/w/a.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "", replace_all: true }] })!;
    expect(file.lines).toEqual([
      { kind: "hunk", text: "Edit 1 of 2" },
      { kind: "del", text: "a" },
      { kind: "add", text: "b" },
      { kind: "hunk", text: "Edit 2 of 2 · every match" },
      { kind: "del", text: "c" },
    ]);
    expect([file.added, file.removed, file.note]).toEqual([1, 2, undefined]);
    expect(approvalFiles("MultiEdit", { file_path: "/w/a.ts", edits: [{ old_string: "a" }] })).toBeNull();
    expect(approvalFiles("MultiEdit", { file_path: "/w/a.ts", edits: [] })).toBeNull();
  });

  it("shows Claude's Write as the whole new contents", () => {
    expect(approvalFiles("Write", { file_path: "/w/n.txt", content: "one\ntwo\n" })).toEqual([{ path: "/w/n.txt", kind: "write", lines: [{ kind: "add", text: "one" }, { kind: "add", text: "two" }], added: 2, removed: 0 }]);
    expect(approvalFiles("Write", { file_path: "/w/empty.txt", content: "" })?.[0].lines).toEqual([]);
    expect(approvalFiles("Write", { file_path: "/w/n.txt" })).toBeNull();
  });
});
