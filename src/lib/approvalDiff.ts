import { diffLines, type DiffLine } from "./diff";

/**
 * One row of a file's diff in an approval card. `hunk` stands between two
 * parts of the file: its text is what the row says (the patch's own `@@`
 * context, or a label), and empty is a plain gap.
 */
export interface ApprovalLine {
  kind: "add" | "del" | "ctx" | "hunk";
  text: string;
}

/**
 * One file a held edit would change, as the card shows it. `write` is a
 * whole-file write whose current contents the request does not carry, so
 * every line reads as added.
 */
export interface ApprovalFile {
  path: string;
  /** Where a rename moves the file. */
  movePath?: string;
  kind: "create" | "update" | "delete" | "rename" | "write";
  lines: ApprovalLine[];
  added: number;
  removed: number;
  /** What the diff alone does not say, such as an edit applied at every match. */
  note?: string;
}

const PATCH_TOOLS = new Set(["apply_patch", "applypatch"]);

/**
 * The files a held edit would change, or null when the request is no edit
 * this can show exactly. A card then quotes the request whole instead: a
 * diff that left out part of a patch would misstate what is approved.
 */
export function approvalFiles(toolName: string | undefined, input: unknown): ApprovalFile[] | null {
  if (!input || typeof input !== "object") return null;
  const fields = input as Record<string, unknown>;
  const text = (key: string) => (typeof fields[key] === "string" ? (fields[key] as string) : null);
  switch (toolName) {
    case "Edit": {
      const path = text("file_path");
      if (!path || text("old_string") == null || text("new_string") == null) return null;
      return [fromEdits(path, [{ oldText: text("old_string")!, newText: text("new_string")!, all: fields.replace_all === true }])];
    }
    case "MultiEdit": {
      const path = text("file_path");
      const edits = Array.isArray(fields.edits) ? fields.edits : null;
      if (!path || !edits?.length) return null;
      const parts: { oldText: string; newText: string; all: boolean }[] = [];
      for (const edit of edits) {
        const e = (edit ?? {}) as Record<string, unknown>;
        if (typeof e.old_string !== "string" || typeof e.new_string !== "string") return null;
        parts.push({ oldText: e.old_string, newText: e.new_string, all: e.replace_all === true });
      }
      return [fromEdits(path, parts)];
    }
    case "Write": {
      const path = text("file_path");
      const content = text("content");
      if (!path || content == null) return null;
      const lines = splitLines(content).map((t): ApprovalLine => ({ kind: "add", text: t }));
      return [{ path, kind: "write", lines, added: lines.length, removed: 0 }];
    }
    default: {
      if (!toolName || !PATCH_TOOLS.has(toolName)) return null;
      const raw = rawPatch(input);
      const body = raw == null ? null : unwrapPatch(raw);
      return body == null ? null : parsePatch(body);
    }
  }
}

/** The patch text a Codex `apply_patch` request carries, as sent: whole, or from its argv. */
export function rawPatch(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const fields = input as Record<string, unknown>;
  for (const key of ["patch", "input", "command"]) {
    const value = fields[key];
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value) && value.every((v) => typeof v === "string") && value.length) {
      const argv = value as string[];
      // `["apply_patch", "<patch>"]`: the patch alone, so it can be read as one.
      if (argv.length === 2 && PATCH_TOOLS.has(argv[0])) return argv[1];
      return argv.join(" ");
    }
  }
  return null;
}

/**
 * The patch itself: bare, or after `apply_patch` and inside one heredoc.
 * Anything else around it (a `cd`, a second command) is not shown as a
 * diff, since it changes what the patch does.
 */
function unwrapPatch(raw: string): string | null {
  const text = raw.replace(/\r\n/g, "\n");
  if (text.split("\n").find((l) => l.trim())?.trim() === "*** Begin Patch") return text;
  const heredoc = /^\s*(?:apply_patch|applypatch)\s*<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[ \t]*\n([\s\S]*?)\n[ \t]*\2[ \t]*\n?\s*$/.exec(text);
  if (heredoc) return heredoc[3];
  const inline = /^\s*(?:apply_patch|applypatch)[ \t]+(\*\*\* Begin Patch[\s\S]*)$/.exec(text);
  return inline ? inline[1] : null;
}

/**
 * Codex's patch format, read as strictly as Codex reads it. A line this
 * does not recognise makes the whole patch unreadable (null), so a card
 * never shows a tidy diff of part of what it approves.
 */
export function parsePatch(text: string): ApprovalFile[] | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (lines[i]?.trim() !== "*** Begin Patch") return null;
  i++;
  const files: ApprovalFile[] = [];
  let ended = false;
  while (i < lines.length) {
    const line = lines[i];
    const marker = line.trim();
    if (marker === "*** End Patch") {
      ended = true;
      i++;
      break;
    }
    let m: RegExpExecArray | null;
    if ((m = /^\*\*\* Add File: (.+)$/.exec(marker))) {
      i++;
      const out: ApprovalLine[] = [];
      while (i < lines.length && lines[i].startsWith("+")) out.push({ kind: "add", text: lines[i++].slice(1) });
      files.push({ path: m[1].trim(), kind: "create", lines: out, added: out.length, removed: 0 });
    } else if ((m = /^\*\*\* Delete File: (.+)$/.exec(marker))) {
      i++;
      files.push({ path: m[1].trim(), kind: "delete", lines: [], added: 0, removed: 0 });
    } else if ((m = /^\*\*\* Update File: (.+)$/.exec(marker))) {
      i++;
      const file: ApprovalFile = { path: m[1].trim(), kind: "update", lines: [], added: 0, removed: 0 };
      const move = /^\*\*\* Move to: (.+)$/.exec(lines[i]?.trim() ?? "");
      if (move) {
        file.movePath = move[1].trim();
        file.kind = "rename";
        i++;
      }
      let chunks = 0;
      while (i < lines.length) {
        const row = lines[i];
        if (row.trim() === "*** End of File") {
          i++;
          continue;
        }
        if (row.startsWith("***")) break;
        if (row.startsWith("@@")) {
          const context = row.slice(2).trim();
          // A bare `@@` that opens the first chunk says nothing; between chunks it marks the gap.
          if (context || chunks > 0) file.lines.push({ kind: "hunk", text: context ? `@@ ${context}` : "" });
          chunks++;
          i++;
          continue;
        }
        const sign = row[0];
        if (row === "" || sign === " ") file.lines.push({ kind: "ctx", text: row.slice(1) });
        else if (sign === "+") {
          file.lines.push({ kind: "add", text: row.slice(1) });
          file.added++;
        } else if (sign === "-") {
          file.lines.push({ kind: "del", text: row.slice(1) });
          file.removed++;
        } else return null;
        if (chunks === 0) chunks = 1;
        i++;
      }
      // Codex refuses an update that changes nothing; a bare move is still a rename.
      if (!file.lines.length && !file.movePath) return null;
      files.push(file);
    } else if (!marker && files.length) {
      i++;
    } else {
      return null;
    }
  }
  if (!ended || !files.length) return null;
  // Nothing may follow the end of the patch.
  if (lines.slice(i).some((l) => l.trim())) return null;
  return files;
}

/** Claude's Edit and MultiEdit: each old/new pair as its own part of one file. */
function fromEdits(path: string, edits: { oldText: string; newText: string; all: boolean }[]): ApprovalFile {
  const lines: ApprovalLine[] = [];
  edits.forEach((edit, index) => {
    if (edits.length > 1) lines.push({ kind: "hunk", text: `Edit ${index + 1} of ${edits.length}${edit.all ? " · every match" : ""}` });
    lines.push(...removalsFirst(diffLines(edit.oldText, edit.newText).map(fromDiffLine)));
  });
  const added = lines.filter((l) => l.kind === "add").length;
  const removed = lines.filter((l) => l.kind === "del").length;
  const note = edits.length === 1 && edits[0].all ? "Replaces every match in the file" : undefined;
  return { path, kind: "update", lines, added, removed, ...(note ? { note } : {}) };
}

/** `diffLines` marks the unchanged lines it folds as a numberless context row. */
function fromDiffLine(line: DiffLine): ApprovalLine {
  if (line.kind === "ctx" && line.oldNo == null && line.newNo == null) return { kind: "hunk", text: line.text };
  return { kind: line.kind, text: line.text };
}

/**
 * Within each run of changed lines, the removed before the added, as a
 * patch reads. `diffLines` may give a replacement's new line first; the
 * run says the same either way.
 */
function removalsFirst(lines: ApprovalLine[]): ApprovalLine[] {
  const out: ApprovalLine[] = [];
  let run: ApprovalLine[] = [];
  const flush = () => {
    out.push(...run.filter((l) => l.kind === "del"), ...run.filter((l) => l.kind === "add"));
    run = [];
  };
  for (const line of lines) {
    if (line.kind === "add" || line.kind === "del") run.push(line);
    else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out;
}

/** A file's lines; the newline that ends the last one starts no line of its own. */
function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}
