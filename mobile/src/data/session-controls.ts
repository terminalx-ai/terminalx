import { EFFORT_LABEL, PERMISSION_MODES, effortChoices, modeLabel, modelForTab, modelGroups, modelOptionText, pendingSettingsNote, pickerMode, runningModelName, type ModelInfo } from "@terminalx/portable/agentSettings";
import { continuationPrompt, type ContextMode } from "@terminalx/portable/continuation";
import type { AgentEvent, RecoveryKind } from "@terminalx/portable/events";
import { CONTINUE_PROMPT, RECOVERY_PROMPT, recoveryFromEvents, recoveryOffer, type RecoveryOffer } from "@terminalx/portable/recovery";
import type { ContinueResult, HostApi, NewTabSettings, SendResult, TabControls } from "./host-api";

/**
 * The session controls the phone offers, as the desktop does: the same recovery
 * offer, pickers and pending note, built from the same shared rules, and the same
 * operations, which the Mac checks against this phone's grant.
 */

/** What stopped the tab and what can be done about it, as the desktop's banner says. */
export function recoveryState(events: AgentEvent[], asks: number): { kind: RecoveryKind | null; offer: RecoveryOffer } {
  const kind = recoveryFromEvents(events);
  // Signing an agent in is done in its terminal, which the phone does not open.
  return { kind, offer: recoveryOffer(kind, { asks, canResend: true, canSendContinue: true, canSignIn: false }) };
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

/** "Retry safely": stop what is running, optionally on another model, then a turn that checks before it acts. */
export async function retrySafely(api: HostApi, sessionId: string, tabId: string, model?: string): Promise<SendResult> {
  const stopped = await api.stop(sessionId, tabId);
  if (!stopped.done) return { sent: false, message: stopped.message };
  if (model) {
    const switched = await api.setModel(sessionId, tabId, model);
    if (!switched.done) return { sent: false, message: switched.message };
  }
  return api.sendSession(tabId, RECOVERY_PROMPT);
}

/** "Continue here": the agent carries on in the same conversation, with nothing stopped. */
export function continueHere(api: HostApi, tabId: string): Promise<SendResult> {
  return api.sendSession(tabId, CONTINUE_PROMPT);
}

/** "Continue in new session": a new tab in this session, handed this conversation's context as the desktop hands it. */
export async function continueInNewTab(api: HostApi, sessionId: string, tabId: string, settings: NewTabSettings, mode: ContextMode): Promise<ContinueResult> {
  let prompt: string;
  try {
    prompt = continuationPrompt(await api.prepareContinuation(sessionId, tabId), mode);
  } catch (error) {
    return { started: false, message: error instanceof Error ? error.message : String(error) };
  }
  return api.continueInNewTab(sessionId, tabId, settings, prompt);
}
