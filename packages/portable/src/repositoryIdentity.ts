// Repository identity (PRO-54): one `host/owner/name` key, lower case, for
// every spelling of a repository, so a local checkout can be matched to the
// organization repository a cloud workspace was built from.
// - Ported from terminalx-saas `normalizeRepositoryIdentity`
//   (apps/api/src/services/cloudWorkspaces/workspaceConfig). Every input the
//   server accepts gives the same identity here, and every input it rejects is
//   rejected here too, except the forms below.
// - The server takes https URLs and bare `host/owner/name`. `git remote
//   get-url origin` can also print ssh (`ssh://git@host/owner/name.git`) and
//   scp-style (`git@host:owner/name.git`) remotes, and ends with a newline.
//   Those are rewritten to `host/owner/name` first, then checked by the same
//   rules as the server.
// - A URL with credentials in it is refused, never stripped, so a token in a
//   remote is never carried into an identity.

/** Same limit as the server's `maxRepositoryIdentityLength`. */
export const MAX_REPOSITORY_IDENTITY_LENGTH = 300;

const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;

/** `ssh://`, `git+ssh://` or `ssh+git://`, an optional user and port, then the path. */
const SSH_URL = /^(?:ssh|git\+ssh|ssh\+git):\/\/(?:[^@/:\s]+@)?([^@/:\s]+)(?::\d{1,5})?(\/.*)$/i;

/** scp-style `[user@]host:path`: a colon before any slash, and no scheme. */
const SCP_LIKE = /^(?:[^@/:\s]+@)?([^@/:\s]+):(?!\/\/)([^:]*)$/;

/** The server's rules, unchanged. */
function normalizeServerForm(value: string): string | null {
  if (value.length > MAX_REPOSITORY_IDENTITY_LENGTH) return null;
  let host: string;
  let path: string;
  if (/^https:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.username || url.password || url.search || url.hash) return null;
      host = url.hostname;
      path = url.pathname;
    } catch {
      return null;
    }
  } else {
    const [first, ...rest] = value.split("/");
    host = first ?? "";
    path = rest.join("/");
  }
  const parts = path
    .replace(/^\/+/, "")
    .replace(/\.git$/i, "")
    .split("/");
  if (
    !/^[a-z0-9.-]{1,253}$/i.test(host) ||
    parts.length !== 2 ||
    !parts.every((part) => SEGMENT.test(part) && part !== "." && part !== "..")
  )
    return null;
  return `${host}/${parts[0]}/${parts[1]}`.toLowerCase();
}

/**
 * `host/owner/name` in lower case, or null when `value` does not name exactly
 * one repository. Accepts what the server accepts plus ssh and scp-style
 * remotes, as printed by `git remote get-url origin`.
 */
export function normalizeRepositoryIdentity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length > MAX_REPOSITORY_IDENTITY_LENGTH) return null;
  const ssh = SSH_URL.exec(text);
  if (ssh) return normalizeServerForm(`${ssh[1]}${ssh[2]}`);
  // `C:/path` is a Windows drive, not a host, as git itself decides.
  if (!text.includes("://") && !/^[A-Za-z]:/.test(text)) {
    const scp = SCP_LIKE.exec(text);
    if (scp) return normalizeServerForm(`${scp[1]}/${scp[2]}`);
  }
  return normalizeServerForm(text);
}
