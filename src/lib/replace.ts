import { SearchQuery } from "@codemirror/search";
import type { ChangeSpec, EditorState } from "@codemirror/state";
import type { ReplaceTarget, TextHit } from "@/lib/api";
import { liveEditorsFor } from "@/lib/editorViews";

/**
 * Project-wide replacement, planned from search hits. A hit is one line of
 * one file; the reader can leave lines or whole files out. Files with an
 * open buffer are rewritten through the editor so the change is undoable and
 * never fights the buffer; everything else is rewritten on disk by the
 * backend, which shares the same regex and template rules.
 */
export interface ReplaceSpec {
  query: string;
  replacement: string;
  regex: boolean;
  caseSensitive: boolean;
}

/** The key a hit is excluded under. */
export function hitKey(h: { path: string; line: number }): string {
  return `${h.path}\n${h.line}`;
}

/**
 * Expand an editor-style template against a regex match: `$1`, `$&` for the
 * whole match, `$<name>`, and `$$` for a dollar sign. A group that does not
 * exist expands to nothing, as it does on the backend.
 */
export function expandReplacement(template: string, m: RegExpExecArray): string {
  return template.replace(/\$(\$|&|\d+|<([A-Za-z0-9_]+)>)/g, (_whole, tok: string, name?: string) => {
    if (tok === "$") return "$";
    if (tok === "&") return m[0];
    if (name) return m.groups?.[name] ?? "";
    return m[Number(tok)] ?? "";
  });
}

/**
 * Every match in a document as a change, limited to the given 1-based lines
 * when a filter is present. A literal query is taken as typed, so `\n` in
 * it is two characters, matching the backend.
 */
export function replaceInState(state: EditorState, spec: ReplaceSpec, lines?: Set<number>): { changes: ChangeSpec[]; count: number } {
  const changes: ChangeSpec[] = [];
  if (!spec.query) return { changes, count: 0 };
  const query = new SearchQuery({ search: spec.query, regexp: spec.regex, caseSensitive: spec.caseSensitive, literal: true });
  if (!query.valid) return { changes, count: 0 };
  const cursor = query.getCursor(state) as Iterator<{ from: number; to: number; match?: RegExpExecArray }>;
  for (let r = cursor.next(); !r.done; r = cursor.next()) {
    const { from, to, match } = r.value;
    if (lines && !lines.has(state.doc.lineAt(from).number)) continue;
    changes.push({ from, to, insert: spec.regex && match ? expandReplacement(spec.replacement, match) : spec.replacement });
  }
  return { changes, count: changes.length };
}

export interface ReplacePlan {
  targets: ReplaceTarget[];
  files: number;
  /** Matches on the lines kept, which can exceed the number of hits. */
  occurrences: number;
}

/**
 * Which files and lines to touch, from hits minus the excluded ones. A file
 * with nothing excluded is rewritten whole, so a capped result still means
 * "every match in that file".
 */
export function planReplace(hits: TextHit[], excluded: Set<string>): ReplacePlan {
  const byPath = new Map<string, { kept: number[]; dropped: boolean; occurrences: number }>();
  for (const h of hits) {
    let f = byPath.get(h.path);
    if (!f) {
      f = { kept: [], dropped: false, occurrences: 0 };
      byPath.set(h.path, f);
    }
    if (excluded.has(hitKey(h))) f.dropped = true;
    else {
      f.kept.push(h.line);
      f.occurrences += h.matches.length;
    }
  }
  const targets: ReplaceTarget[] = [];
  let occurrences = 0;
  for (const [path, f] of byPath) {
    if (!f.kept.length) continue;
    targets.push(f.dropped ? { path, lines: f.kept } : { path });
    occurrences += f.occurrences;
  }
  return { targets, files: targets.length, occurrences };
}

/** Targets with an open buffer go through the editor; the rest go to disk. */
export function splitTargets(targets: ReplaceTarget[], isLive: (path: string) => boolean): { live: ReplaceTarget[]; disk: ReplaceTarget[] } {
  const live: ReplaceTarget[] = [];
  const disk: ReplaceTarget[] = [];
  for (const t of targets) (isLive(t.path) ? live : disk).push(t);
  return { live, disk };
}

/**
 * Rewrite one file's open buffers. A buffer that was clean is saved so the
 * disk keeps up, as it would after ⌘S; a dirty one keeps its edits and stays
 * unsaved for the reader to decide about. Line numbers are the buffer's own,
 * which can drift from the listing's when a dirty buffer has gained or lost
 * lines. The count is per file, not per buffer, when the same file is open
 * in several sessions.
 */
export async function replaceInOpenBuffers(abs: string, spec: ReplaceSpec, lines?: Set<number>): Promise<{ count: number; unsaved: boolean }> {
  let count = 0;
  let unsaved = false;
  for (const ed of liveEditorsFor(abs)) {
    const wasDirty = ed.isDirty();
    const r = replaceInState(ed.view.state, spec, lines);
    if (!r.count) continue;
    ed.view.dispatch({ changes: r.changes, userEvent: "input.replace.all" });
    count = Math.max(count, r.count);
    if (wasDirty) unsaved = true;
    else await ed.save();
  }
  return { count, unsaved };
}
