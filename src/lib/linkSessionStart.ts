/**
 * `terminalx://new` links (PRO-130): a session another app asks to start.
 * Nothing is created until the person says yes in the dialog (17.08) that
 * `askToStartFromLink` opens: it names the project, the branch the session
 * starts from, the issue and the prompt, all as the link gave them.
 *
 * A link names a project TerminalX already has open, by its path, or none
 * for the one last worked in; it never adds a folder. A session started
 * from a link starts the way a new one from the New Session form would, on
 * the agent, model and permission mode last chosen there, except that it is
 * never started in Bypass: what an outside link asks for runs with the
 * agent asking first.
 */
import { useSyncExternalStore } from "react";
import { BYPASS_MODE, FIRST_RUN_PERMISSION_MODE, pickerMode } from "@terminalx/portable/agentSettings";
import { api, errorMessage, issues, type Issue } from "@/lib/api";
import { showError } from "@/lib/errorToasts";
import { pipelineLaunchDefaults, pipelineSettings } from "@/lib/issuePipeline";
import { issuePromptWithComments, issueWorktreeName } from "@/lib/issueSession";
import { preparePipelineLaunch } from "@/lib/pipelineLaunch";
import { getPrefs } from "@/lib/prefs";
import { sendHeldFirstMessage } from "@/lib/sessionBackend";
import { getSessionStore, selectSession, upsertSession } from "@/lib/sessions";
import { whenSessionsLoaded } from "@/lib/tabDeepLink";
import { worktreeNameFromPrompt } from "@/lib/worktreeNames";
import type { NewSessionLink } from "@/lib/desktopLinks";
import type { Project } from "@/types/session";

/** A link's session, waiting for the person's yes. */
export interface LinkSessionRequest {
  id: number;
  link: NewSessionLink;
  project: Project;
  isGit: boolean;
  /** The branch it starts from: the link's, else the project's default once read; null while unknown. */
  branch: string | null;
  /** The link's Linear issue, once read. */
  issue: Issue | null;
  /** The issue or the default branch is still being read. */
  reading: boolean;
  /** Why the session cannot be started: the issue could not be read, no agent is installed. */
  blocked: string | null;
  /** Being started: nothing can be pressed. */
  busy: boolean;
  /** Why starting failed; the dialog stays open to say so. */
  error: string | null;
}

let request: LinkSessionRequest | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function set(next: LinkSessionRequest | null) {
  request = next;
  for (const listener of [...listeners]) listener();
}

/** Update the request `id` if it is still the one asked: a later link or a cancel makes an answer stale. */
function patch(id: number, change: Partial<LinkSessionRequest>) {
  if (request?.id === id) set({ ...request, ...change });
}

export function getLinkSessionRequest(): LinkSessionRequest | null {
  return request;
}

export function useLinkSessionRequest(): LinkSessionRequest | null {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => request, () => request);
}

const clean = (path: string) => path.replace(/\/+$/, "") || "/";

/** The project a link starts in: the one at its path, or the one last worked in. Never one it would add. */
export function projectForLink(link: Pick<NewSessionLink, "project">): Project | null {
  const store = getSessionStore();
  const open = store.projects.filter((project) => !project.archived);
  if (link.project) return open.find((project) => clean(project.path) === clean(link.project!)) ?? null;
  return open.find((project) => project.path === store.lastProject) ?? open[0] ?? null;
}

/**
 * Ask whether to start the session a `new` link describes. A link naming a
 * project TerminalX has not opened, or arriving before any project is open,
 * starts nothing and says why. A link that comes while another is being
 * asked about takes its place.
 */
export async function askToStartFromLink(link: NewSessionLink): Promise<void> {
  await whenSessionsLoaded();
  const project = projectForLink(link);
  if (!project) {
    if (link.project) {
      showError("Open that folder as a project in TerminalX first, then open the link again", link.project, {
        title: "That link names a project TerminalX hasn't opened", key: "new-session-link", tone: "warning", icon: "link-off", detail: "line", copy: false,
      });
    } else {
      showError("Open a project first, then open the link again", undefined, {
        title: "No project to start that session in", key: "new-session-link", tone: "warning", icon: "link-off", copy: false,
      });
    }
    return;
  }
  const isGit = project.kind !== "folder";
  const id = nextId++;
  const noAgent = !getSessionStore().harnesses.some((harness) => harness.available);
  const readBranch = isGit && !link.branch;
  set({
    id, link, project, isGit,
    branch: isGit ? link.branch : null,
    issue: null,
    reading: readBranch || !!link.linear,
    // The probe answers a moment after launch: an empty list is not yet "none installed".
    blocked: noAgent && getSessionStore().harnesses.length ? "Install and sign in to an agent before starting a session." : null,
    busy: false,
    error: null,
  });
  const branch = readBranch
    ? api.workStatus(project.path).then((status) => patch(id, { branch: status.defaultBranch ?? null }), () => undefined)
    : Promise.resolve();
  const issue = link.linear
    ? issues.details(project.path, "linear", link.linear).then(
      (found) => patch(id, { issue: found }),
      (cause) => patch(id, { blocked: `${link.linear} could not be read: ${errorMessage(cause)}` }),
    )
    : Promise.resolve();
  await Promise.all([branch, issue]);
  patch(id, { reading: false });
}

/** "Cancel": nothing is started. */
export function cancelLinkSession(): void {
  if (request && !request.busy) set(null);
}

/** The permission mode a link's session starts in: the last one chosen, never Bypass. */
export function linkPermissionMode(lastMode: string): string {
  return pickerMode(lastMode)?.id === BYPASS_MODE || lastMode === BYPASS_MODE ? FIRST_RUN_PERMISSION_MODE : lastMode;
}

/**
 * "Create session": the session the link described, started as the New
 * Session form would start it, then opened. A failure leaves the dialog up
 * with what went wrong.
 */
export async function startLinkSession(): Promise<void> {
  const asked = request;
  if (!asked || asked.busy || asked.reading || asked.blocked) return;
  const { id, link, project, isGit, issue } = asked;
  if (link.linear && !issue) return;
  patch(id, { busy: true, error: null });
  try {
    const prefs = getPrefs();
    const harnesses = getSessionStore().harnesses.filter((harness) => harness.available);
    const harness = harnesses.find((candidate) => candidate.id === prefs.lastAgent) ?? harnesses[0];
    if (!harness) throw new Error("Install and sign in to an agent before starting a session.");
    const prompt = link.prompt?.trim() ?? "";
    const title = (issue ? `${issue.identifier} ${issue.title}` : prompt.split("\n")[0]).slice(0, issue ? 80 : 60);
    const named = issue ? issueWorktreeName(issue.identifier, issue.title) : worktreeNameFromPrompt(prompt);
    const worktreeName = isGit && named ? await api.previewWorkspaceName(project.path, named).catch(() => null) : null;
    const session = await api.createSession({
      projectPath: project.path,
      title,
      useWorktree: isGit,
      onMain: !isGit,
      worktreeName,
      baseRef: isGit ? link.branch : null,
      ...(issue ? { issue: { provider: issue.provider, id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url } } : {}),
      tab: {
        harness: harness.id,
        model: prefs.lastModel[harness.id] ?? "",
        effort: prefs.lastEffort[harness.id] ?? null,
        permissionMode: linkPermissionMode(prefs.lastMode),
      },
    });
    upsertSession(session);
    const tab = session.tabs[0];
    // From an issue the prompt is the issue itself, with the link's words after it, as `sessions create --issue` does.
    const first = issue ? [await issuePromptWithComments(project.path, issue), prompt].filter(Boolean).join("\n\n") : prompt;
    // The project's launch switches, as a new session from the form or the Issues page starts with them.
    const settings = pipelineSettings(project);
    const launched = settings.enabled && isGit ? await preparePipelineLaunch(session.id, tab.id, first, pipelineLaunchDefaults(settings, !!issue)).catch((cause) => {
      console.error("the link's session pipeline did not start", cause);
      return first;
    }) : first;
    set(null);
    selectSession(session.id);
    void sendHeldFirstMessage(session.id, tab.id, launched).catch((cause) => console.error("first send failed", cause));
  } catch (cause) {
    patch(id, { busy: false, error: errorMessage(cause) });
  }
}

/** Forget any request (tests). */
export function resetLinkSession(): void {
  set(null);
}
