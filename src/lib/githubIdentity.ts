import { useEffect, useState } from "react";
import { issues, type GithubIdentity } from "@/lib/api";
import { getDataPrivacy, PRIVACY_MESSAGE, subscribeDataPrivacy, useDataPrivacy } from "@/lib/dataPrivacy";

/**
 * The GitHub account a folder is connected to, as the header names it. The
 * backend asks GitHub itself, which takes a moment, so answers are kept here
 * per folder and every header showing the same folder shares one.
 */
const known = new Map<string, { identity: GithubIdentity; generation: number }>();
let generation = 0;
const pending = new Map<string, Promise<GithubIdentity>>();
const listeners = new Set<() => void>();
// Retain local metadata, but retire pending answers across policy transitions.
subscribeDataPrivacy(() => {
  ++generation;
  pending.clear();
});

const canon = (path: string) => path.replace(/\/+$/, "");

function fetchIdentity(path: string, refresh = false): Promise<GithubIdentity> {
  if (!getDataPrivacy().ready) return Promise.reject(new Error("Could not verify data privacy mode"));
  const asked = generation;
  const key = canon(path);
  const inFlight = pending.get(key);
  if (inFlight && !refresh) return inFlight;
  const promise = issues
    .githubIdentity(key, refresh || known.get(key)?.generation !== generation)
    .then((identity) => {
      if (asked !== generation || pending.get(key) !== promise) throw new Error(PRIVACY_MESSAGE);
      // Only a real answer is kept; anything else (a stub, a refusal) is asked again next time.
      if (identity && typeof identity === "object") {
        known.set(key, { identity, generation: asked });
        for (const listener of listeners) listener();
      }
      return identity;
    })
    .finally(() => {
      if (pending.get(key) === promise) pending.delete(key);
    });
  pending.set(key, promise);
  return promise;
}

/** Ask GitHub again for a folder, for a header's refresh. */
export function refreshGithubIdentity(path: string): Promise<GithubIdentity> {
  return fetchIdentity(path, true);
}

/** The account for `path`, once known; `undefined` while it is being looked up, or with no path. */
export function useGithubIdentity(path: string | null): GithubIdentity | undefined {
  const key = path ? canon(path) : null;
  const privacy = useDataPrivacy();
  const [, bump] = useState(0);
  useEffect(() => {
    if (!key) return;
    const listener = () => bump((n) => n + 1);
    listeners.add(listener);
    if (privacy.ready && known.get(key)?.generation !== generation) {
      // Native identity still returns local repository/email metadata while on.
      // A restored policy must refresh its prior metadata-only answer.
      fetchIdentity(key).catch(() => {
        /* outside a webview, or the folder is gone: the header shows nothing */
      });
    }
    return () => {
      listeners.delete(listener);
    };
  }, [key, privacy]);
  return key ? known.get(key)?.identity : undefined;
}

/** The picture GitHub serves for an account or organisation, at about `size` device pixels. */
export function githubAvatarUrl(login: string, size = 32): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=${Math.max(32, Math.ceil(size / 32) * 32)}`;
}

/** One line for the account chip's tooltip. */
export function describeGithubIdentity(identity: GithubIdentity): string {
  const parts: string[] = [];
  if (identity.login) {
    parts.push(identity.source === "ssh" ? `Pushes from this folder land on GitHub as ${identity.login} (its SSH key).` : `The GitHub CLI here is signed in as ${identity.login}.`);
  }
  if (identity.email) parts.push(`Commits are made as ${identity.email}.`);
  if (identity.repo) parts.push(`Remote: ${identity.repo}.`);
  return parts.join(" ");
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
