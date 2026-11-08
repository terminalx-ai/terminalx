import { Change, diff } from "@codemirror/merge";
import { getPrefs, setPrefs, usePrefs } from "./prefs";

export type DiffMode = "unified" | "split";
export const diffFileKey = (source: string, path: string) => JSON.stringify([source, path]);

export function setFileWrap(key: string, wrap: boolean | undefined) {
  const overrides = { ...getPrefs().diffWrapFiles };
  if (wrap === undefined) delete overrides[key];
  else overrides[key] = wrap;
  setPrefs({ diffWrapFiles: overrides });
}

export function useDiffOptions(fileKey?: string) {
  const prefs = usePrefs();
  const override = fileKey ? prefs.diffWrapFiles[fileKey] : undefined;
  return { mode: prefs.diffMode, hideWhitespace: prefs.diffHideWhitespace, wrap: override ?? prefs.diffWrap, defaultWrap: prefs.diffWrap, override };
}

/** Like git diff -w: ignore horizontal ASCII whitespace, retain line boundaries.
 * Offsets map the normalized comparison back into the untouched documents. */
function normalized(text: string) {
  let value = "";
  const offsets: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (/[ \t\r\f\v]/.test(text[i])) continue;
    offsets.push(i);
    value += text[i];
  }
  offsets.push(text.length);
  return { value, offsets };
}

export function whitespaceDiff(before: string, after: string): readonly Change[] {
  const a = normalized(before), b = normalized(after);
  return diff(a.value, b.value, { scanLimit: 500, timeout: 1000 }).map((c) =>
    new Change(a.offsets[c.fromA], a.offsets[c.toA], b.offsets[c.fromB], b.offsets[c.toB]));
}
