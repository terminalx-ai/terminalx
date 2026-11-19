import { EFFORT_LABEL, PERMISSION_MODES, effortChoices, modeLabel, modelForTab, modelGroups, modelOptionText, pendingSettingsNote, pickerMode, runningModelName, type ModelInfo } from "@terminalx/portable/agentSettings";
import { continuationPrompt, type ContextMode } from "@terminalx/portable/continuation";
import type { AgentEvent, RecoveryKind } from "@terminalx/portable/events";
import { CONTINUE_PROMPT, RECOVERY_PROMPT, recoveryFromEvents, recoveryOffer, type RecoveryOffer } from "@terminalx/portable/recovery";
import { canRetry, connectionProblem, isTransportError, problemText } from "../transport/connection-errors";
import type { ContinueResult, HostApi, NewTabSettings, TabControls } from "./host-api";
import { HostRefusal } from "./host-refusal";

/**
 * The session controls the phone offers, as the desktop does: the same recovery
 * offer, pickers and pending note, built from the same shared rules, and the same
 * operations, which the Mac checks against this phone's grant.
 */

/**
 * What stopped the tab and what can be done about it, as the desktop's banner
 * says. `tab`: what the Mac says the tab runs; a native Codex tab (#644) is
 * never sent to a terminal it does not have.
 */
export function recoveryState(events: AgentEvent[], asks: number, tab?: Pick<TabControls, "transport"> | null): { kind: RecoveryKind | null; offer: RecoveryOffer } {
  const kind = recoveryFromEvents(events);
  const native = tab?.transport === "experimentalCodexStdio";
  // Signing an agent in is done in its terminal, which the phone does not open.
  return { kind, offer: recoveryOffer(kind, { asks, canResend: true, canSendContinue: true, canSignIn: false, native }) };
}

/** What the tab runs and the choices its pickers offer: the desktop composer's. */
export function settingsView(tab: TabControls, all: ModelInfo[]) {
  const models = all.filter((model) => model.harness === tab.harness);
  const model = modelForTab(models, tab.model);
  const efforts = effortChoices(model, tab.effort);
  return {
    models,
    groups: modelGroups(models),
    model,
    modelName: model ? runningModelName(model) : tab.model || "Default",
    effortName: tab.effort && efforts.length ? (EFFORT_LABEL[tab.effort] ?? tab.effort) : null,
    efforts: efforts.map((id) => ({ id, label: EFFORT_LABEL[id] ?? id, pending: id === tab.requestedEffort })),
    modeName: modeLabel(tab.permissionMode),
    modes: PERMISSION_MODES.map((mode) => ({ ...mode, current: pickerMode(tab.permissionMode)?.id === mode.id, pending: !!tab.requestedPermissionMode && pickerMode(tab.requestedPermissionMode)?.id === mode.id })),
    modelOption: (choice: ModelInfo) => ({ label: modelOptionText(choice, models), pending: choice.id === tab.requestedModel }),
    note: pendingSettingsNote(tab, models, tab.status === "in_progress"),
  };
}

/**
 * Resuming a stopped conversation on the Mac (#1290): Retry safely, Continue
 * here, Resend last prompt and Continue in new session. Each waits for the
 * connection while the phone reconnects (as a request made right after a
 * return from the background does), is sent once, and says in plain words
 * what failed and what to do next.
 */
export type ResumeAction = "retry-safely" | "continue-here" | "resend" | "continue-new";
/** The step that failed: `connect` (never sent: no connection), `stop`, `model`, `send`, `prepare` or `open` (Continue in new session's two). */
export type ResumeStep = "connect" | "stop" | "model" | "send" | "prepare" | "open";
/**
 * `next`: what the screen offers. `reconnect`: connect again, then try again;
 * `retry`: try again; `wait`: nothing yet, the Mac may still be doing it; `mac`: something to do on the Mac.
 * `pending`: the Mac did not answer in time and may still be doing it: shown as under way, not as a failure.
 */
export interface ResumeFailure { action: ResumeAction; step: ResumeStep; code: string; text: string; next: "reconnect" | "retry" | "wait" | "mac"; pending: boolean }
export type ResumeResult = { done: true; note?: string } | { done: false; failure: ResumeFailure };

const ACTION_NAME: Record<ResumeAction, string> = {
  "retry-safely": "Retry safely",
  "continue-here": "Continue here",
  resend: "Resend last prompt",
  "continue-new": "Continue in new session",
};

/** A line for the connection log: what was resumed, the step and the code, never the message's text. */
export function resumeLogDetail(failure: ResumeFailure): string {
  return `${ACTION_NAME[failure.action]} · step ${failure.step} · code ${failure.code}`;
}

/** What the Mac said when it refused a step. `after`: an earlier step was done (the agent stopped), which the words say. */
function refused(action: ResumeAction, step: ResumeStep, result: { message: string; code?: string }, after = false): ResumeResult {
  const what = step === "stop" ? "stop the agent" : step === "model" ? "switch the model" : step === "prepare" ? "prepare the handoff" : step === "open" ? "open the new conversation" : action === "resend" ? "send the prompt again" : "send the prompt";
  const said = result.message.trim() ? ` It said: ${result.message.trim().replace(/\.?$/, ".")}` : "";
  const text = `${after ? "The agent was stopped, but your" : "Your"} Mac did not ${what}.${said} Try again, or open the session on the Mac to see more.`;
  return { done: false, failure: { action, step, code: result.code ?? "refused", text, next: "retry", pending: false } };
}

/** A failure that was not the Mac's answer: the connection's (said by what it means for the resume), or this phone's. */
function failed(action: ResumeAction, step: ResumeStep, cause: unknown, after = false): ResumeResult {
  const problem = connectionProblem(cause);
  const lead = after ? "The agent was stopped, but the resume was not finished" : "Not resumed";
  if (problem === null) {
    if (cause instanceof HostRefusal) return refused(action, step, cause, after);
    if (isTransportError(cause)) return { done: false, failure: { action, step, code: "transport", text: `${lead}: the connection to your Mac failed. Reconnect, then try again.`, next: "reconnect", pending: false } };
    return { done: false, failure: { action, step, code: "client_error", text: `${lead}: something on this phone stopped the request. Try again.`, next: "retry", pending: false } };
  }
  if (problem === "no-answer" && (step === "send" || step === "open")) {
    // The resume itself reached the Mac and may still be running there: sending it again could resume twice.
    return { done: false, failure: { action, step, code: problem, text: "Your Mac has not answered yet, so the resume may still be under way. It shows in the conversation when it starts; check there before trying again.", next: "wait", pending: true } };
  }
  if (problem === "no-answer") {
    // A step before the resume (stop, model, prepare) got no answer: the resume itself was never asked for.
    const what = step === "stop" ? "stopping the agent" : step === "model" ? "switching the model" : "preparing the handoff";
    return { done: false, failure: { action, step, code: problem, text: `${lead}: your Mac didn't answer in time while ${what}, so the resume was not sent. Try again.`, next: "retry", pending: false } };
  }
  if (cause instanceof Error && ["Host is disconnected", "Relay connection unavailable"].includes(cause.message)) {
    // Never sent: the connection was not back in time.
    return { done: false, failure: { action, step: after ? step : "connect", code: problem, text: `${lead}: ${problemText(problem)} before it could be sent. Reconnect, then try again.`, next: "reconnect", pending: false } };
  }
  if (!canRetry(problem)) return { done: false, failure: { action, step, code: problem, text: `${lead}: ${problemText(problem)}.`, next: "mac", pending: false } };
  // Lost while the request was on its way: it may or may not have reached the Mac.
  return { done: false, failure: { action, step, code: problem, text: `${lead}: ${problemText(problem)} while resuming, so it may or may not have reached your Mac. Reconnect and check the conversation before trying again.`, next: "reconnect", pending: false } };
}

/**
 * One action at a time: `enter` is false while one runs, until `leave`.
 * Taps that land before the controls redraw as busy are turned away here, so a
 * resume is never sent twice. Nothing is drawn from it, so it is not React state.
 */
export function oneAtATime(): { enter(): boolean; leave(): void } {
  let running = false;
  return {
    enter: () => {
      if (running) return false;
      running = true;
      return true;
    },
    leave: () => {
      running = false;
    },
  };
}

/** "Retry safely": stop what is running, optionally on another model, then a turn that checks before it acts. */
export async function retrySafely(api: HostApi, sessionId: string, tabId: string, model?: string): Promise<ResumeResult> {
  await api.awaitConnected();
  let step: ResumeStep = "stop";
  try {
    const stopped = await api.stop(sessionId, tabId);
    if (!stopped.done) return refused("retry-safely", "stop", stopped);
    if (model) {
      step = "model";
      const switched = await api.setModel(sessionId, tabId, model);
      if (!switched.done) return refused("retry-safely", "model", switched, true);
    }
    step = "send";
    const sent = await api.sendSession(tabId, RECOVERY_PROMPT);
    return sent.sent ? { done: true } : refused("retry-safely", "send", sent, true);
  } catch (cause) {
    return failed("retry-safely", step, cause, step !== "stop");
  }
}

/** "Continue here": the agent carries on in the same conversation, with nothing stopped. */
export async function continueHere(api: HostApi, tabId: string): Promise<ResumeResult> {
  await api.awaitConnected();
  try {
    const sent = await api.sendSession(tabId, CONTINUE_PROMPT);
    return sent.sent ? { done: true } : refused("continue-here", "send", sent);
  } catch (cause) {
    return failed("continue-here", "send", cause);
  }
}

/** "Resend last prompt": the prompt the agent never received, as it was sent. */
export async function resendLast(api: HostApi, sessionId: string, tabId: string): Promise<ResumeResult> {
  await api.awaitConnected();
  try {
    const sent = await api.resendUnsent(sessionId, tabId);
    return sent.sent ? { done: true } : refused("resend", "send", sent);
  } catch (cause) {
    return failed("resend", "send", cause);
  }
}

/**
 * "Continue in new session": a new tab in this session, handed this
 * conversation's context as the desktop hands it. `tabId` in the result is
 * the new tab, once it exists, with a note when the handoff was not confirmed.
 */
export async function continueInNewTab(api: HostApi, sessionId: string, tabId: string, settings: NewTabSettings, mode: ContextMode): Promise<ResumeResult & { tabId?: string }> {
  await api.awaitConnected();
  let context: Awaited<ReturnType<HostApi["prepareContinuation"]>>;
  try {
    context = await api.prepareContinuation(sessionId, tabId);
  } catch (cause) {
    return failed("continue-new", "prepare", cause);
  }
  let prompt: string;
  try {
    prompt = continuationPrompt(context, mode);
  } catch (cause) {
    // The Mac answered, but not with what this handoff needs (the complete history, say): its reason, and another way.
    const reason = cause instanceof Error && cause.message.trim() ? `${cause.message.trim().replace(/\.?$/, ".")} ` : "";
    return { done: false, failure: { action: "continue-new", step: "prepare", code: "context_unavailable", text: `Not continued: ${reason}Choose a shorter handoff, or continue on the Mac.`, next: "retry", pending: false } };
  }
  let result: ContinueResult;
  try {
    result = await api.continueInNewTab(sessionId, tabId, settings, prompt);
  } catch (cause) {
    return failed("continue-new", "open", cause);
  }
  if (!result.started) return refused("continue-new", "open", result);
  const note = result.delivered ? undefined : result.inInput
    ? "The handoff is in the new conversation's input but has not been sent yet."
    : `The new conversation opened, but the handoff could not be confirmed. ${result.message ?? ""}`.trim();
  return { done: true, tabId: result.tabId, ...(note ? { note } : {}) };
}
