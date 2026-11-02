import { preparePipelineLaunch, preparePipelineContinuation } from "@/lib/pipelineLaunch";
import { agent, api, errorMessage, onPromptDelivery } from "@/lib/api";
import { applyEvent } from "@/lib/agentEvents";
import { getDraftRevision, setDraft } from "@/lib/drafts";
import { addTab, archiveSession, selectSession, upsertSession } from "@/lib/sessions";
import type { LaunchSettings } from "@/lib/useSessionAgent";
import type { TabEntry } from "@/types/session";
import type { ContinuationContext } from "@terminalx/portable/continuation";

// The prompt is built the same way on the phone.
export * from "@terminalx/portable/continuation";

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

// A retry retains the same Launched object. Weak ownership survives launch failures
// without a listener to dispose or a tab-id registry that retains abandoned launches.
const seededDrafts = new WeakMap<Launched, number>();

function seedDraft(launched: Launched, prompt: string) {
  seededDrafts.set(launched, setDraft(launched.tab.id, prompt));
}

async function deliver(launched: Launched, prompt: string, onDelivering?: () => void): Promise<ContinuationResult> {
  // Remove only our prepared draft before send can publish a user message.
  // The actual prompt may include pipeline instructions added after creation.
  const seedRevision = seededDrafts.get(launched);
  seededDrafts.delete(launched);
  const ownsDraft = seedRevision !== undefined && getDraftRevision(launched.tab.id) === seedRevision;
  const removedRevision = ownsDraft ? setDraft(launched.tab.id, "") : undefined;
  try {
    onDelivering?.();
    const out = await agent.send(launched.sessionId, launched.tab.id, prompt, undefined, true);
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
    return { stage: "delivery", launched, error: `The new session opened, but context delivery failed or could not be confirmed. Check its chat and terminal before retrying. ${recovery} ${errorMessage(e)}` };
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
): Promise<ContinuationResult> {
  let launched = existing;
  try {
    await ensureAvailable(settings.harness);
    if (!launched) {
      const tab = await addTab(context.sessionId, settings.harness, settings.model, settings.effort, settings.permissionMode);
      launched = { sessionId: context.sessionId, tab };
      seedDraft(launched, prompt);
      onCreated(launched);
    }
    prompt = await preparePipelineContinuation(launched.sessionId, launched.tab.id, prompt, settings.pipeline);
    await agent.ensureStarted(launched.sessionId, launched.tab.id);
  } catch (e) {
    return { stage: "launch", launched, error: `Could not start the new session: ${errorMessage(e)}` };
  }
  return deliver(launched, prompt, onDelivering);
}

/** Where a chat moving into a project starts again: in place, or in a new worktree. */
export interface ProjectDestination {
  projectPath: string;
  worktree: boolean;
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
      const session = await api.createSession({ projectPath: to.projectPath, title: chat.title, useWorktree: to.worktree, onMain: !to.worktree, tab: settings });
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
