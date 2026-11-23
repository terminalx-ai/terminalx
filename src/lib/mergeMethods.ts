import type { PrMergeMethods } from "@terminalx/portable/workspaceGit";

/** A pull request merge method the panel's merge menu offers (design 05.10). */
export type MergeMethod = "merge" | "squash" | "rebase";

/** In the menu's order: squash first, as most repositories default to it. */
export const MERGE_METHODS: MergeMethod[] = ["squash", "rebase", "merge"];

export function mergeMethodLabel(method: MergeMethod): string {
  return method === "squash" ? "Squash and merge" : method === "rebase" ? "Rebase and merge" : "Merge commit";
}

const CHOICE = "terminalx.mergeMethod:";
const MERGED = "terminalx.mergedWith:";

/** `https://github.com/acme/app/pull/7` → `github.com/acme/app`. */
export function repositoryOf(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/pull\/\d+\/?$/, "").toLowerCase();
}

function read(key: string): MergeMethod | null {
  try {
    const value = localStorage.getItem(key);
    return value === "merge" || value === "squash" || value === "rebase" ? value : null;
  } catch {
    return null;
  }
}

function write(key: string, method: MergeMethod) {
  try { localStorage.setItem(key, method); } catch { /* a convenience only */ }
}

/** Whether the repository lets this method be used; unknown (an older runtime) allows all. */
export function methodAllowed(methods: PrMergeMethods | null | undefined, method: MergeMethod): boolean {
  return !methods || methods[method];
}

export function repositoryDefault(methods: PrMergeMethods | null | undefined): MergeMethod | null {
  const value = methods?.default?.toLowerCase();
  return value === "merge" || value === "squash" || value === "rebase" ? value : null;
}

/**
 * The method the menu ticks: the last one chosen here for this repository, else the repository's default, else the
 * first the repository allows.
 */
export function currentMergeMethod(url: string, methods: PrMergeMethods | null | undefined): MergeMethod {
  const chosen = read(CHOICE + repositoryOf(url));
  if (chosen && methodAllowed(methods, chosen)) return chosen;
  const fallback = repositoryDefault(methods);
  if (fallback && methodAllowed(methods, fallback)) return fallback;
  return MERGE_METHODS.find((method) => methodAllowed(methods, method)) ?? "squash";
}

/** Remember the choice for the repository, and how this pull request merged, for its merged card. */
export function noteMerge(url: string, method: MergeMethod) {
  write(CHOICE + repositoryOf(url), method);
  write(MERGED + url.toLowerCase(), method);
}

/** How this pull request was merged, when it was merged from here. */
export function rememberedMergeMethod(url: string): MergeMethod | null {
  return read(MERGED + url.toLowerCase());
}
