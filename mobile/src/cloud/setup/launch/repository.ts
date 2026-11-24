/**
 * The one repository a phone launch clones (the owner's decision on 25.07):
 * a GitHub URL, typed or pasted, with an optional branch or tag. The server
 * checks that it exists and can be cloned (preflight); the phone only makes
 * sure it is a GitHub repository's address before sending it.
 */

const PART = /^[A-Za-z0-9_.-]+$/;

/** Owner and name of a GitHub repository URL as typed or pasted, else null. */
export function parseRepository(typed: string): { owner: string; name: string } | null {
  let rest = typed.trim();
  if (!rest || /\s/.test(rest)) return null;
  rest = rest.replace(/^https:\/\//i, "").replace(/^www\./i, "");
  if (!/^github\.com\//i.test(rest)) return null;
  const parts = rest.slice("github.com/".length).replace(/\/+$/, "").split("/");
  if (parts.length !== 2) return null;
  const owner = parts[0]!;
  const name = parts[1]!.replace(/\.git$/i, "");
  if (!PART.test(owner) || !PART.test(name) || name === "." || name === "..") return null;
  return { owner, name };
}

/** The clone URL the server is sent: https://github.com/owner/name.git. */
export function cloneUrl(typed: string): string | null {
  const parsed = parseRepository(typed);
  return parsed ? `https://github.com/${parsed.owner}/${parsed.name}.git` : null;
}

/** The form's Repository value: github.com/acme/app. */
export function repositoryShown(typed: string): string {
  const parsed = parseRepository(typed);
  return parsed ? `github.com/${parsed.owner}/${parsed.name}` : typed.trim();
}

/** The repository as the review and the failed checks name it: acme/app. */
export function repositoryName(url: string): string | null {
  const parsed = parseRepository(url);
  return parsed ? `${parsed.owner}/${parsed.name}` : null;
}
