import { preparePipelineLaunch, preparePipelineContinuation } from "@/lib/pipelineLaunch";
import { agent, api, files, errorMessage, type ImageInput, onPromptDelivery } from "@/lib/api";
import { applyEvent } from "@/lib/agentEvents";
import { getDraftRevision, setDraft } from "@/lib/drafts";
import { addTab, archiveSession, getSessionStore, patchSession, selectSession, upsertSession } from "@/lib/sessions";
import { setSelectedAgent } from "@/lib/terminal";
import type { LaunchSettings } from "@/lib/useSessionAgent";
import type { ImageRef, FileRef } from "@/types/events";
import type { TabEntry } from "@/types/session";
import type { ContinuationContext } from "@terminalx/portable/continuation";

// The prompt is built the same way on the phone.
export * from "@terminalx/portable/continuation";

export interface PromptAttachments {
  images?: ImageRef[];
  files?: FileRef[];
}

/** The conversation a continuation started, and the workspace it is in. */
export interface Launched {
  sessionId: string;
  tab: TabEntry;
}

/**
 * How far a continuation got. Only "launch" may be retried: past it the
 * prompt has been sent, or may have been ("delivery"), and "archive" is a
 * handoff that arrived while the chat it moved could not be archived.
 * "input" is a handoff the new session has not taken but holds in its
 * input, where one Enter sends it; `seq` is the prompt that Enter is for,
 * and `error` what to tell a reader who is not looking at the dialog (#662).
 */
export type ContinuationResult =
  | { stage: "delivered"; launched: Launched }
  | { stage: "input"; launched: Launched; seq: number; error: string }
  | { stage: "launch" | "delivery" | "archive"; launched?: Launched; error: string };

export const IN_INPUT = "The handoff is in the new session's input but has not been sent yet. Press Enter there to send it.";

async function ensureAvailable(harness: string) {
  const providers = await api.listHarnesses();
  if (!providers.some((p) => p.id === harness && p.available)) throw new Error("The selected provider is no longer available on this host.");
}

/**
 * A launch request's tab and account (#980): the account goes beside the
 * tab, as the request takes it, and only when one was chosen, so a start
 * with one account sends what it always did.
 */
function onAccount(settings: LaunchSettings) {
  const { account, ...tab } = settings;
  return { tab, ...(account ? { account } : {}) };
}

/**
 * Add the handoff's tab to its session. On an account, through the request
 * that takes one, then shown as the session's `addTab` shows a tab.
 */
async function addHandoffTab(sessionId: string, settings: LaunchSettings): Promise<TabEntry> {
  if (!settings.account) return addTab(sessionId, settings.harness, settings.model, settings.effort, settings.permissionMode);
  const tab = await api.addTab(sessionId, { harness: settings.harness, model: settings.model, effort: settings.effort, permissionMode: settings.permissionMode }, settings.account);
  const session = getSessionStore().sessions.find((x) => x.id === sessionId);
  if (session) patchSession(sessionId, { tabs: [...session.tabs.filter((t) => t.id !== tab.id), tab], activeTab: tab.id });
  setSelectedAgent(sessionId, tab.id);
  return tab;
}

// A retry retains the same Launched object. Weak ownership survives launch failures
// without a listener to dispose or a tab-id registry that retains abandoned launches.
const seededDrafts = new WeakMap<Launched, number>();

function seedDraft(launched: Launched, prompt: string) {
  seededDrafts.set(launched, setDraft(launched.tab.id, prompt));
}

async function deliver(launched: Launched, prompt: string, onDelivering?: () => void, attachments?: { images?: ImageInput[]; files?: FileRef[] }): Promise<ContinuationResult> {
  // Remove only our prepared draft before send can publish a user message.
  // The actual prompt may include pipeline instructions added after creation.
  const seedRevision = seededDrafts.get(launched);
  seededDrafts.delete(launched);
  const ownsDraft = seedRevision !== undefined && getDraftRevision(launched.tab.id) === seedRevision;
  const removedRevision = ownsDraft ? setDraft(launched.tab.id, "") : undefined;
  try {
    onDelivering?.();
    // Native confirmed delivery is text-only. Attachment retries must use the
    // normal composer path, which validates files and forwards image data.
    const out = attachments?.images?.length || attachments?.files?.length
      ? await agent.send(launched.sessionId, launched.tab.id, prompt, attachments.images, false, undefined, attachments.files)
      : await agent.send(launched.sessionId, launched.tab.id, prompt, undefined, true);
    for (const event of out.events) applyEvent(event);
    // In the agent's input, not in the composer: it is there to send, once.
    const seq = out.events[0]?.seq;
    if (out.inInput && seq !== undefined) return { stage: "input", launched, seq, error: IN_INPUT };
    return { stage: "delivered", launched };
  } catch (e) {
    const edited = removedRevision === undefined || getDraftRevision(launched.tab.id) !== removedRevision;
    const recovery = edited
      ? "Your composer edits have been preserved."
      : "The prepared prompt is in its composer.";
    if (!edited) forgetOnceDelivered(launched, setDraft(launched.tab.id, prompt));
    return { stage: "delivery", launched, error: `The new session opened, but context delivery failed or could not be confirmed. Check its chat and terminal before retrying. ${recovery}${attachments?.images?.length || attachments?.files?.length ? " Attachments remain in the original prompt; retry from that prompt to include them again." : ""} ${errorMessage(e)}` };
  }
}

/**
 * A handoff reported undelivered can still arrive: the reader presses Enter
 * in its terminal, or the agent takes it late (#662). The prompt put back in
 * the composer for a retry would then be sent twice, so it goes once the
 * agent has the handoff, unless the reader has changed it since.
 */
function forgetOnceDelivered(launched: Launched, revision: number) {
  let delivered = false;
  let stop: (() => void) | undefined;
  void onPromptDelivery(launched.sessionId, launched.tab.id, (stage) => {
    if (stage !== "delivered" || delivered) return;
    delivered = true;
    if (getDraftRevision(launched.tab.id) === revision) setDraft(launched.tab.id, "");
    stop?.();
  }).then((unlisten) => {
    stop = unlisten;
    if (delivered) unlisten();
  });
}

/** A tab is created once, with exactly the chosen settings. A failed launch
 * can retry that tab; an uncertain delivery leaves the prompt in its composer
 * for the reader to check/retry. */
export async function launchContinuation(
  context: ContinuationContext, settings: LaunchSettings, prompt: string,
  onCreated: (launched: Launched) => void, existing?: Launched, onDelivering?: () => void,
  purpose: "continue" | "review" = "continue",
  attachments?: PromptAttachments,
): Promise<ContinuationResult> {
  let launched = existing;
  let images: ImageInput[] | undefined;
  try {
    images = attachments?.images ? await Promise.all(attachments.images.map(async (image) => {
      const input = await files.readImage(image.url).catch((error) => {
        throw new Error(`Cannot retry attachment “${image.name ?? image.url}”: ${errorMessage(error)}`);
      });
      if (!input) throw new Error(`Cannot retry attachment “${image.name ?? image.url}”: the image is unavailable or unsupported.`);
      return { ...input, name: image.name ?? input.name };
    })) : undefined;
    await ensureAvailable(settings.harness);
    if (!launched) {
      const tab = await addHandoffTab(context.sessionId, settings);
      launched = { sessionId: context.sessionId, tab };
      seedDraft(launched, prompt);
      onCreated(launched);
    }
    // A second opinion is independent of the source's issue automation.
    if (purpose === "continue") prompt = await preparePipelineContinuation(launched.sessionId, launched.tab.id, prompt, settings.pipeline);
    await agent.ensureStarted(launched.sessionId, launched.tab.id);
  } catch (e) {
    return { stage: "launch", launched, error: `Could not start the new session: ${errorMessage(e)}` };
  }
  return deliver(launched, prompt, onDelivering, attachments ? { images, files: attachments.files } : undefined);
}

/** Where a chat moving into a project starts again: in place, or in a new worktree. */
export interface ProjectDestination {
  projectPath: string;
  worktree: boolean;
  /** Keep the source checkout/worktree when it belongs to this project. */
  cwd?: string;
}

/**
 * Carry a chat into a project: a new session there, with exactly the chosen
 * settings, is handed the chat's context and takes the chat's place in the
 * list. The session is created once; a failed start retries it. The chat is
 * archived only once the new session has started, so a move that cannot
 * start leaves the chat where it was. A chat that cannot be archived does not
 * hold the handoff back: the context is still sent, and the result says the
 * chat is still listed.
 */
export async function moveChatToProject(
  chat: { id: string; title: string },
  to: ProjectDestination,
  settings: LaunchSettings,
  prompt: string,
  onCreated: (launched: Launched) => void,
  existing?: Launched,
  onDelivering?: () => void,
): Promise<ContinuationResult> {
  let launched = existing;
  try {
    await ensureAvailable(settings.harness);
    if (!launched) {
      const session = await api.createSession({ projectPath: to.projectPath, title: chat.title, useWorktree: to.worktree, onMain: !to.worktree, ...(to.cwd ? { cwd: to.cwd } : {}), ...onAccount(settings) });
      upsertSession(session);
      selectSession(session.id);
      const tab = session.tabs[0];
      if (!tab) throw new Error("The new session has no agent conversation.");
      launched = { sessionId: session.id, tab };
      seedDraft(launched, prompt);
      onCreated(launched);
    }
    prompt = await preparePipelineLaunch(launched.sessionId, launched.tab.id, prompt, settings.pipeline);
    await agent.ensureStarted(launched.sessionId, launched.tab.id);
  } catch (e) {
    const kept = launched ? " The chat has not been archived." : "";
    return { stage: "launch", launched, error: `Could not start the new session: ${errorMessage(e)}${kept}` };
  }
  let unarchived: string | null = null;
  try {
    await archiveSession(chat.id, true);
  } catch (e) {
    unarchived = `The chat could not be archived, so it is still in the list: ${errorMessage(e)}`;
  }
  const result = await deliver(launched, prompt, onDelivering);
  if (!unarchived) return result;
  return result.stage === "delivered"
    ? { stage: "archive", launched, error: `The new session started and has the chat's context. ${unarchived}` }
    : { ...result, error: `${result.error} ${unarchived}` };
}

/** Continue in a different destination without changing or archiving the source. */
export async function launchContinuationInDestination(
  context: ContinuationContext, to: ProjectDestination | null, settings: LaunchSettings, prompt: string,
  onCreated: (launched: Launched) => void, existing?: Launched, onDelivering?: () => void,
): Promise<ContinuationResult> {
  let launched = existing;
  try {
    await ensureAvailable(settings.harness);
    if (!launched) {
      const session = to
        ? await api.createSession({ projectPath: to.projectPath, title: context.title, useWorktree: to.worktree, onMain: !to.worktree, ...(to.cwd ? { cwd: to.cwd } : {}), ...onAccount(settings) })
        : await api.createQuickChat({ title: context.title, ...onAccount(settings) });
      upsertSession(session);
      selectSession(session.id);
      const tab = session.tabs[0];
      if (!tab) throw new Error("The new session has no agent conversation.");
      launched = { sessionId: session.id, tab };
      seedDraft(launched, prompt);
      onCreated(launched);
    }
    // This destination owns its own automation; never transfer the source's authority.
    prompt = await preparePipelineLaunch(launched.sessionId, launched.tab.id, prompt, settings.pipeline);
    await agent.ensureStarted(launched.sessionId, launched.tab.id);
  } catch (e) {
    return { stage: "launch", launched, error: `Could not start the new session: ${errorMessage(e)}` };
  }
  return deliver(launched, prompt, onDelivering);
}
