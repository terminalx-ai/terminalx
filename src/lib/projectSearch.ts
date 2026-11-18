/**
 * Search in files from outside its dialog (PRO-299): `openProjectSearch`
 * opens the dialog of the session in front, as ⇧⌘F would, and with a query
 * fills it in and runs it. The newest mounted dialog takes the call, the
 * same rule the shortcut follows.
 */
type Opener = (query?: string) => void;

const openers: Opener[] = [];

/** Called by `ProjectSearch` while it is mounted; returns the unregister. */
export function registerProjectSearch(open: Opener): () => void {
  openers.push(open);
  return () => {
    const i = openers.lastIndexOf(open);
    if (i >= 0) openers.splice(i, 1);
  };
}

/**
 * Open search in files, filled in with `query` and run when one is given
 * (an empty or missing query keeps what the field held). Returns false when
 * no search dialog is mounted to take it.
 */
export function openProjectSearch(query?: string): boolean {
  const open = openers[openers.length - 1];
  if (!open) return false;
  open(query);
  return true;
}

/** The match toggles, which stay as they were left for the next search. */
export interface SearchToggles {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

const KEY = "terminalx.projectSearch.toggles";
const OFF: SearchToggles = { caseSensitive: false, wholeWord: false, regex: false };

export function loadSearchToggles(): SearchToggles {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<SearchToggles> | null;
    if (!raw || typeof raw !== "object") return { ...OFF };
    return { caseSensitive: raw.caseSensitive === true, wholeWord: raw.wholeWord === true, regex: raw.regex === true };
  } catch {
    return { ...OFF };
  }
}

export function saveSearchToggles(toggles: SearchToggles): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(toggles));
  } catch {
    // Storage can be unavailable; the toggles still hold for this window.
  }
}

const NAMES: [keyof SearchToggles, string][] = [
  ["caseSensitive", "Match case"],
  ["wholeWord", "Whole word"],
  ["regex", "Regex"],
];

/** The names of the toggles that are on, in the order the dialog shows them. */
export function togglesOn(toggles: SearchToggles): string[] {
  return NAMES.filter(([k]) => toggles[k]).map(([, name]) => name);
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** A second search, run for a query that found nothing, to say what it was near. */
export interface NearQuery {
  query: string;
  regex: boolean;
  /** True when it is the same text with every toggle off: turning them off finds it. */
  byToggles: boolean;
}

/**
 * What to look for when a search finds nothing (design 07.09). First the same
 * text with the toggles off, when any is on. Then its words in whatever case
 * and with or without a separator, so `archive_script` is found as
 * `archiveScript`; only for a query that is plainly a name.
 */
export function nearQueries(query: string, toggles: SearchToggles): NearQuery[] {
  const text = query.trim();
  if (!text) return [];
  const near: NearQuery[] = [];
  if (togglesOn(toggles).length) near.push({ query: text, regex: false, byToggles: true });
  if (/^[A-Za-z0-9_\-. ]+$/.test(text)) {
    const words = text.split(/[_\-. ]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
    if (words.length > 1) near.push({ query: words.join("[_\\-. ]?"), regex: true, byToggles: false });
  }
  return near;
}

/** A near match as the code writes it: the first match on the line, widened to the whole name around it. */
export function nearText(hit: { text: string; matches: [number, number][] }): string | null {
  const match = hit.matches[0];
  if (!match) return null;
  let [start, end] = match;
  const name = /[A-Za-z0-9_$]/;
  while (start > 0 && name.test(hit.text[start - 1])) start--;
  while (end < hit.text.length && name.test(hit.text[end])) end++;
  const text = hit.text.slice(start, end).trim();
  return text && text.length <= 80 ? text : null;
}
