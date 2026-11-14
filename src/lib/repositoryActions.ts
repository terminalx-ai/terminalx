/** Editor values, not a persisted repository-file schema. PRO-131/PRO-243 own that boundary. */
export interface RepositoryAction {
  id: string;
  name: string;
  icon: string;
  command: string;
  runAfterSetup: boolean;
  concurrent: boolean;
  hidden: boolean;
}

export interface RepositoryPreviewUrl {
  id: string;
  name: string;
  url: string;
}

type NamedEntry = { id: string; name: string };
const normalizedName = (name: string) => name.trim().normalize("NFKC").toLowerCase();

function nameError(entry: NamedEntry, entries: readonly NamedEntry[]): string | undefined {
  const name = normalizedName(entry.name);
  if (!name) return "Enter a name.";
  if (entries.some((other) => other.id !== entry.id && normalizedName(other.name) === name)) {
    return "Choose a unique name.";
  }
}

export function validateAction(action: RepositoryAction, actions: readonly RepositoryAction[]) {
  return {
    name: nameError(action, actions),
    command: action.command.trim() ? undefined : "Enter a command.",
  };
}

/** Preserve saved order for both the Run menu and its first visible/default action. */
export function visibleActions(actions: readonly RepositoryAction[]): RepositoryAction[] {
  return actions.filter((action) => !action.hidden);
}

export function moveRepositoryEntry<T extends { id: string }>(entries: readonly T[], id: string, direction: -1 | 1): T[] {
  const next = [...entries];
  const from = next.findIndex((entry) => entry.id === id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= next.length) return next;
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export type ExpandedPreviewUrl = { url: string; error?: never } | { url?: never; error: string };

/**
 * $PORT is the session's first port and $PORT_1..$PORT_9 the ports after it
 * (PRO-363: a block of 10, so $PORT_1 is the second). The caller supplies the
 * active session's allocated ports; there is no guessed localhost port or cloud
 * forwarding here. Omitting ports validates a template only.
 */
function resolvePreviewUrl(template: string, ports?: readonly number[]): ExpandedPreviewUrl {
  const input = template.trim();
  if (!input) return { error: "Enter a URL." };
  // URL() silently strips some whitespace/control characters. Reject them instead.
  if (/[\s\u0000-\u001f\u007f\\]/u.test(input)) return { error: "Use a URL without spaces or backslashes." };
  let error: string | undefined;
  const expanded = input.replace(/\$PORT[A-Za-z0-9_]*/g, (token) => {
    if (/^\$PORT_[1-9]\d+$/.test(token)) {
      error = "A workspace has 10 ports: use $PORT, then $PORT_1 to $PORT_9.";
      return token;
    }
    if (!/^\$PORT(?:_[1-9])?$/.test(token)) {
      error = "Use $PORT or $PORT_n, with n starting at 1.";
      return token;
    }
    const index = token === "$PORT" ? 0 : Number(token.slice(6));
    const port = ports === undefined ? 3000 : ports[index];
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      error = `No allocated port is available for ${token}.`;
      return token;
    }
    return String(port);
  });
  if (error) return { error };
  // Do not accept misspelled or unsupported variables as a literal browser host/path.
  if (expanded.includes("$")) return { error: "Use $PORT or $PORT_n for port variables; encode a literal $ as %24." };
  try {
    const url = new URL(expanded);
    if (!/^https?:\/\/[^/?#]/i.test(expanded) || !["http:", "https:"].includes(url.protocol) || !url.hostname) {
      return { error: "Enter an http:// or https:// URL." };
    }
    if (url.username || url.password) return { error: "Use a URL without embedded credentials." };
    return { url: url.href };
  } catch {
    return { error: "Enter a valid http:// or https:// URL." };
  }
}

export function expandPreviewUrl(template: string, ports: readonly number[] = []): ExpandedPreviewUrl {
  return resolvePreviewUrl(template, ports);
}

export function validatePreviewUrl(entry: RepositoryPreviewUrl, entries: readonly RepositoryPreviewUrl[]) {
  return { name: nameError(entry, entries), url: resolvePreviewUrl(entry.url).error };
}
