/**
 * The one router for `terminalx://` links (PRO-130). The native side parses
 * every link of this build's scheme (`desktop_links.rs`), keeps what it
 * validated until the webview takes it (`desktop_link_take`), and pings
 * `desktop_link_requested` when links arrive while the app runs; links that
 * launched the app are taken at start. Each one is `{ kind, … }` with only
 * its route's own fields, never the URL, except an `invalid` link, whose
 * text comes back for its toast to show and copy.
 *
 * Settings links (PRO-127), tab links (PRO-381), session, new-session and
 * browser links are all followed here; a route added later (a cloud
 * workspace's link) is one more case of `followDesktopLink`.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openBrowserTab } from "@/lib/browser";
import { copyText } from "@/lib/clipboard";
import { showError } from "@/lib/errorToasts";
import { askToStartFromLink } from "@/lib/linkSessionStart";
import { getSessionStore, selectSession } from "@/lib/sessions";
import { followSettingDeepLink, type OpenSettingsAt, type SettingDeepLink } from "@/lib/settingsDeepLink";
import { followTabDeepLink, whenSessionsLoaded, type TabDeepLink } from "@/lib/tabDeepLink";
import { isLocalKey } from "@/types/target";

export const DESKTOP_LINK_REQUESTED = "desktop_link_requested";
export const DESKTOP_LINK_TAKE = "desktop_link_take";

/** Why a link of this build's scheme cannot be followed. */
export type LinkProblem =
  | { reason: "unknownRoute"; route: string }
  | { reason: "malformed"; route: string }
  | { reason: "notWeb"; scheme: string };

/** A `new` link: a session to start once the person says yes. */
export interface NewSessionLink {
  kind: "new";
  /** The project's path; null for the project last worked in. */
  project: string | null;
  /** The branch the session starts from; null for the project's default. */
  branch: string | null;
  prompt: string | null;
  /** A Linear issue key (`PRO-130`) to work on. */
  linear: string | null;
}

export type DesktopLink =
  | ({ kind: "settings" } & SettingDeepLink)
  | ({ kind: "tab" } & TabDeepLink)
  | { kind: "session"; sessionId: string }
  | NewSessionLink
  | { kind: "browser"; url: string }
  | { kind: "invalid"; link: string; problem: LinkProblem };

/** What a link may open that only the app shell can: Settings, at a row. */
export interface DesktopLinkRoutes {
  openSettingsAt: OpenSettingsAt;
}

type Fields = Record<string, unknown>;

function exactly(value: Fields, keys: string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

const isString = (value: unknown): value is string => typeof value === "string";

/**
 * Characters a prompt from a link may not hold, as the native side checks
 * (`is_link_prompt`): controls other than line breaks and tabs, and
 * characters that draw nothing or reorder what is drawn, which would tell
 * the agent words the confirmation does not show.
 */
const HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\u{1D173}-\u{1D17A}\u{E0000}-\u{E0FFF}]/u;

/** A prompt a `new` link may carry: some text, and nothing in it the dialog would not show. */
export function isShownPrompt(prompt: string): boolean {
  return !!prompt.trim() && !HIDDEN.test(prompt);
}
const isOptionalString = (value: unknown): value is string | null => value === null || typeof value === "string";

function asProblem(value: unknown): LinkProblem | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const fields = value as Fields;
  if ((fields.reason === "unknownRoute" || fields.reason === "malformed") && exactly(fields, ["reason", "route"]) && isString(fields.route)) {
    return { reason: fields.reason, route: fields.route };
  }
  if (fields.reason === "notWeb" && exactly(fields, ["reason", "scheme"]) && isString(fields.scheme)) return { reason: "notWeb", scheme: fields.scheme };
  return null;
}

/** One link exactly as a route of the native side shapes it, or null: what the command returned is checked again here. */
export function asDesktopLink(value: unknown): DesktopLink | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const fields = value as Fields;
  switch (fields.kind) {
    case "settings":
      return exactly(fields, ["kind", "id", "enable"]) && isString(fields.id) && typeof fields.enable === "boolean" ? { kind: "settings", id: fields.id, enable: fields.enable } : null;
    case "tab":
      return exactly(fields, ["kind", "sessionId", "tabId"]) && isString(fields.sessionId) && isString(fields.tabId) ? { kind: "tab", sessionId: fields.sessionId, tabId: fields.tabId } : null;
    case "session":
      return exactly(fields, ["kind", "sessionId"]) && isString(fields.sessionId) ? { kind: "session", sessionId: fields.sessionId } : null;
    case "new": {
      if (!exactly(fields, ["kind", "project", "branch", "prompt", "linear"])) return null;
      const { project, branch, prompt, linear } = fields;
      if (!isOptionalString(project) || !isOptionalString(branch) || !isOptionalString(prompt) || !isOptionalString(linear)) return null;
      // Nothing to start: the native side never sends one, and none is started here.
      if (!prompt?.trim() && !linear) return null;
      if (prompt !== null && !isShownPrompt(prompt)) return null;
      return { kind: "new", project, branch, prompt, linear };
    }
    case "browser":
      return exactly(fields, ["kind", "url"]) && isString(fields.url) && /^https?:\/\//i.test(fields.url) ? { kind: "browser", url: fields.url } : null;
    case "invalid": {
      const problem = asProblem(fields.problem);
      return exactly(fields, ["kind", "link", "problem"]) && isString(fields.link) && problem ? { kind: "invalid", link: fields.link, problem } : null;
    }
    default:
      return null;
  }
}

/** The links a take returned that are links; anything else in it is dropped. */
export function asDesktopLinks(value: unknown): DesktopLink[] {
  return Array.isArray(value) ? value.map(asDesktopLink).filter((link): link is DesktopLink => link !== null) : [];
}

/** Follow one link to where it points, or say why it can't be. */
export async function followDesktopLink(link: DesktopLink, routes: DesktopLinkRoutes): Promise<void> {
  switch (link.kind) {
    case "settings":
      return followSettingDeepLink({ id: link.id, enable: link.enable }, routes.openSettingsAt);
    case "tab":
      await followTabDeepLink({ sessionId: link.sessionId, tabId: link.tabId });
      return;
    case "session":
      await followSessionLink(link.sessionId);
      return;
    case "new":
      return askToStartFromLink(link);
    case "browser":
      return openBrowserLink(link.url);
    case "invalid":
      showInvalidLink(link.link, link.problem);
  }
}

/**
 * Follow links for as long as the returned stop is not called: those that
 * launched the app, then each that arrives, in order. Links are taken after
 * the listener is in place, so one arriving in between still waits for the
 * take; and taken links are followed even if stop came first (StrictMode's
 * remount), since the native side hands each link out only once.
 */
export function bootDesktopLinks(routes: DesktopLinkRoutes): () => void {
  let following = Promise.resolve();
  const take = () =>
    void invoke<unknown>(DESKTOP_LINK_TAKE)
      .then((value) => {
        for (const link of asDesktopLinks(value)) {
          following = following.then(() => followDesktopLink(link, routes)).catch((error) => console.error("follow a link", error));
        }
      })
      .catch(() => undefined);
  const subscription = listen(DESKTOP_LINK_REQUESTED, take).then(
    (unlisten) => { take(); return unlisten; },
    () => { take(); return () => undefined; },
  );
  return () => void subscription.then((unlisten) => unlisten());
}

// ---- session links

/** Show the session a link names, as it was last left, or say it is gone. */
export async function followSessionLink(sessionId: string): Promise<boolean> {
  await whenSessionsLoaded();
  const session = getSessionStore().sessions.find((candidate) => candidate.id === sessionId);
  if (!session) {
    showError("It may have been deleted, or the link is from another Mac", undefined, { title: "No session matches that link", key: "session-link", tone: "warning", icon: "link-off", copy: false });
    return false;
  }
  if (getSessionStore().selectedSessionId !== session.id) selectSession(session.id);
  return true;
}

// ---- browser links

/** Open a page from a link in a Browser tab of the session on screen. */
export async function openBrowserLink(url: string): Promise<void> {
  await whenSessionsLoaded();
  const store = getSessionStore();
  const session = isLocalKey(store.selectedSessionId)
    ? store.sessions.find((candidate) => candidate.id === store.selectedSessionId && !candidate.archived && !candidate.worktreeRemoved)
    : undefined;
  if (!session) {
    showError("Browser links open in the selected session's Browser tab. Select a session on this Mac, then open the link again", url, {
      title: "Open a session to see that page", key: "browser-link", tone: "warning", icon: "globe-lock", detail: "line", copy: false,
    });
    return;
  }
  try {
    await openBrowserTab(session.id, session.cwd, url);
  } catch (error) {
    showError("Couldn't open the page from the link", error, { key: "browser-link" });
  }
}

// ---- links that cannot be followed (06.16)

/** The scheme a link was written in, for the toast's title: `terminalx`, or the dev build's. */
function schemeOf(link: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(link)?.[1];
  return scheme ? scheme.toLowerCase() : "terminalx";
}

/** Say why a link can't be followed, with the link itself to check and copy. */
export function showInvalidLink(link: string, problem: LinkProblem): void {
  const shown = { key: "desktop-link", detail: "line" as const, copy: false };
  if (problem.reason === "notWeb") {
    const what = problem.scheme === "file" ? "a local file" : `a ${problem.scheme}: address`;
    showError(`This one asks for ${what}, which the TerminalX browser doesn't open`, link, {
      ...shown, title: "Browser links need an http:// or https:// URL", tone: "warning", icon: "globe-lock",
    });
    return;
  }
  const why = problem.reason === "unknownRoute"
    ? problem.route ? `TerminalX doesn't know the route “${problem.route}”. ` : "This link names no route. "
    : `This ${problem.route} link is missing something, or has a part TerminalX can't use. `;
  showError(`${why}Check the link, or ask whoever sent it for a new one`, link, {
    ...shown,
    title: `That ${schemeOf(link)}:// link isn't valid`,
    tone: "error",
    icon: "link-off",
    actions: [{ label: "Copy link", icon: "copy", keepOpen: true, run: () => copyText(link) }],
  });
}
