import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { FIRST_RUN_PERMISSION_MODE, pickerMode, useModels } from "@/lib/models";
import { usePickerModels } from "@/lib/cloudModels";
import { chooseMode } from "@/lib/dialogs";
import { getPrefs, setPrefs, usePrefs, type Prefs } from "@/lib/prefs";
import { tabAccount, type ModelInfo } from "@/lib/api";
import { agentAccounts, resolveAccount, showsAccounts, switchesIn, takesAccounts, type AgentAccount, type AgentAccounts, type LaunchAccountChoice } from "@/lib/agentAccounts";
import { useStatus } from "@/lib/status";
import type { HarnessInfo, TabEntry } from "@/types/session";
import { startingAgent, type AgentReadinessMap } from "@/lib/agentReadiness";

/** One launch: the agent, its model and effort, and the permission mode it starts in. */
export interface LaunchSettings {
  harness: string;
  model: string;
  effort: string | null;
  permissionMode: string;
  /**
   * The agent account it starts on (#980), chosen in the picker or carried
   * from the conversation a handoff continues. Absent: the project's
   * default, then the agent's, as the runtime resolves it.
   */
  account?: string | null;
  pipeline?: import("@/lib/pipelineLaunch").PipelineLaunch;
}

/**
 * A form that keeps its own launch settings (a cloud workspace's first agent,
 * another agent tab in one): nothing it picks is saved as a preference.
 */
export interface ControlledLaunch {
  value: LaunchSettings;
  onChange: (next: LaunchSettings) => void;
  /** Keep unknown saved models visible until the reader replaces them. */
  preserveUnavailableModel?: boolean;
  /** Offer null explicitly instead of displaying the model's default effort. */
  allowDefaultEffort?: boolean;
  /** The surface supplies a persistent unattended-run warning. */
  bypassWarning?: boolean;
}

/** What New Session would launch with now: where a controlled form starts. */
export function launchDefaults(prefs: Prefs = getPrefs()): LaunchSettings {
  return {
    harness: prefs.lastAgent,
    model: prefs.lastModel[prefs.lastAgent] ?? "",
    effort: prefs.lastEffort[prefs.lastAgent] ?? null,
    permissionMode: prefs.lastMode,
  };
}

/** A tab's settings, as what it was last asked to run, pending or not. */
export function launchSettingsOf(tab: TabEntry): LaunchSettings {
  const account = tabAccount(tab);
  return {
    harness: tab.harness,
    model: tab.requestedModel || tab.model,
    effort: tab.requestedEffort ?? tab.effort ?? null,
    permissionMode: tab.requestedPermissionMode || tab.permissionMode,
    ...(account ? { account } : {}),
  };
}

/**
 * Where a start's mode lands when the picker does not offer it: one its agent
 * reported (Claude Code's `dontAsk`, a Codex approval and sandbox, a mode set
 * in the terminal). Never the saved mode, which may be looser than the source
 * (Bypass): the new session asks before anything until the reader picks.
 */
const UNOFFERED_START_MODE = "manual";

/**
 * Where a handoff's form starts: its source conversation's settings, each
 * kept only while it is valid, else the saved preference for the provider,
 * else its default. The provider must be installed, the model one it lists,
 * the effort one that model takes. The mode is never swapped for a looser one
 * (see `UNOFFERED_START_MODE`). `null` when no provider is installed.
 */
export function handoffStart(source: LaunchSettings, harnesses: HarnessInfo[], models: ModelInfo[], prefs: Prefs = getPrefs()): LaunchSettings | null {
  const installed = (id: string) => harnesses.some((h) => h.id === id && h.available);
  const harness = [source.harness, prefs.lastAgent].find(installed) ?? harnesses.find((h) => h.available)?.id;
  if (!harness) return null;
  const own = harness === source.harness;
  const listed = models.filter((m) => m.harness === harness);
  const model = [own ? source.model : undefined, prefs.lastModel[harness]]
    .map((wanted) => (wanted ? listed.find((m) => m.id === wanted) : undefined))
    .find(Boolean) ?? listed.find((m) => m.isDefault) ?? listed[0];
  // Nothing valid saved: null, so the form shows the model's own default.
  const effort = [own ? source.effort : undefined, prefs.lastEffort[harness]].find((wanted) => !!wanted && !!model?.efforts.includes(wanted)) ?? null;
  const permissionMode = source.permissionMode
    ? (pickerMode(source.permissionMode)?.id ?? UNOFFERED_START_MODE)
    : (pickerMode(prefs.lastMode)?.id ?? FIRST_RUN_PERMISSION_MODE);
  // The source's account goes with its own agent only: another agent's accounts are its own.
  return { harness, model: model?.id ?? "", effort, permissionMode, ...(own && source.account ? { account: source.account } : {}) };
}

// ------------------------------------------------------------ agent accounts (#980)

/**
 * Each agent's accounts as last read, shared by every launch form and tab
 * mark, so a tab strip of many tabs asks once. `null`: not read, or the read
 * failed; then nothing about accounts is shown, as before accounts.
 */
const accountViews = new Map<string, { view: AgentAccounts | null; at: number }>();
const accountReads = new Map<string, Promise<AgentAccounts | null>>();
const accountListeners = new Set<() => void>();
const notifyAccounts = () => accountListeners.forEach((listener) => listener());

/**
 * Read `harness`'s accounts again unless they were read within `maxAgeMs`.
 * A failed read keeps what was read before.
 */
export function refreshAgentAccounts(harness: string, maxAgeMs = 0): Promise<AgentAccounts | null> {
  if (!takesAccounts(harness)) return Promise.resolve(null);
  const known = accountViews.get(harness);
  if (known && Date.now() - known.at < maxAgeMs) return Promise.resolve(known.view);
  const running = accountReads.get(harness);
  if (running) return running;
  // A reply that is not an agent's accounts (an older desktop, a refused call) is no list: nothing is offered.
  const read = Promise.resolve().then(() => agentAccounts.list(harness)).then(
    (reply) => {
      const view = reply && Array.isArray(reply.accounts) ? reply : null;
      accountViews.set(harness, { view, at: Date.now() });
      return view;
    },
    () => known?.view ?? null,
  ).finally(() => { accountReads.delete(harness); notifyAccounts(); });
  accountReads.set(harness, read);
  return read;
}

/** An agent's accounts as a change returned them (a default set in a project's settings). */
export function takeAgentAccounts(view: AgentAccounts) {
  accountViews.set(view.agent, { view, at: Date.now() });
  notifyAccounts();
}

/** Forget every read: tests start from nothing. */
export function forgetAgentAccounts() {
  accountViews.clear();
  accountReads.clear();
  notifyAccounts();
}

/**
 * `harness`'s accounts, read when it changes (and again when older than
 * `maxAgeMs`); `null` for an agent without accounts or before the read.
 */
export function useAgentAccounts(harness: string | null | undefined, maxAgeMs = 0): AgentAccounts | null {
  const id = harness && takesAccounts(harness) ? harness : null;
  const view = useSyncExternalStore(
    (listener) => { accountListeners.add(listener); return () => { accountListeners.delete(listener); }; },
    () => (id ? accountViews.get(id)?.view ?? null : null),
  );
  useEffect(() => { if (id) void refreshAgentAccounts(id, maxAgeMs); }, [id, maxAgeMs]);
  return view;
}

/**
 * The account automatic switching (#981) would start a new session of
 * `harness` on instead of `accountId`, and why, asked of the runtime again
 * as usage changes. `null` when nothing would move it, or with the setting
 * off; the runtime decides again when the session starts.
 */
export function useLaunchAccountChoice(harness: string | null, view: AgentAccounts | null, projectId: string | null, accountId: string | null): LaunchAccountChoice | null {
  const [choice, setChoice] = useState<LaunchAccountChoice | null>(null);
  const { usage } = useStatus();
  const asks = !!harness && !!accountId && switchesIn(view, projectId);
  const revision = usage?.revision ?? 0;
  useEffect(() => {
    if (!asks || !harness) { setChoice(null); return; }
    let live = true;
    Promise.resolve().then(() => agentAccounts.launchChoice(harness, projectId, accountId)).then(
      (answer) => { if (live) setChoice(answer && view?.accounts.some((account) => account.id === answer.account) ? answer : null); },
      () => { if (live) setChoice(null); },
    );
    return () => { live = false; };
  }, [asks, harness, projectId, accountId, revision, view]);
  return asks ? choice : null;
}

/**
 * The same preferences and valid launch choices for every new-session surface.
 * With `controlled`, the choices are the form's own and preferences are only
 * read, for the saved model and effort of an agent switched to.
 */
export function useSessionAgent(harnesses: HarnessInfo[], here = true, modelClient?: WorkspaceRpcClient | null, controlled?: ControlledLaunch, readiness?: AgentReadinessMap | null, projectId?: string | null) {
  const prefs = usePrefs();
  const [pickedAgent, setPickedAgent] = useState<string | null>(null);
  // An account picked here, per agent: a choice for this start, never saved (the defaults are Settings').
  const [pickedAccount, setPickedAccount] = useState<Record<string, string>>({});
  // A model picked in this form, per agent. On a list that is only this
  // computer's (`foreign`), a pinned version nobody picked here, such as the
  // saved one, is not sent: the machine runs its own default (#1580).
  const [pickedModel, setPickedModel] = useState<Record<string, string>>({});
  // The bypass confirmation answers later: it must change the value as it is then.
  const latest = useRef(controlled);
  latest.current = controlled;
  const chosen = controlled?.value;
  const preferred = harnesses.find((h) => h.id === (chosen ? chosen.harness : prefs.lastAgent));
  // A cloud or controlled form owns its choice. For a local start, a missing
  // default should not hide the agent that is already installed. Derive this
  // without replacing the saved provider/model preferences during discovery.
  const localDefaults = !chosen && here && readiness !== undefined;
  const eligible = (state: "ready" | "unknown") => harnesses.filter((h) => h.available && readiness?.[h.id]?.state === state);
  const ready = localDefaults ? eligible("ready") : [];
  const unknown = localDefaults ? eligible("unknown") : [];
  // Known logins win over an unknown probe, including a saved unknown agent: `startingAgent` is the rule.
  const harness = localDefaults
    ? startingAgent(harnesses, readiness, prefs.lastAgent, pickedAgent)
    : (!chosen && here && !preferred?.available ? harnesses.find((h) => h.available) : preferred) ?? preferred ?? harnesses[0] ?? null;
  const catalog = useModels(controlled?.preserveUnavailableModel ? undefined : harness?.id);
  const listed = controlled?.preserveUnavailableModel ? catalog.filter((m) => m.harness === harness?.id) : catalog;
  const picker = usePickerModels(listed, !here, modelClient, harness?.id);
  const models = harness ? picker.models : [];
  const savedModel = harness ? (chosen ? chosen.model : prefs.lastModel[harness.id]) : undefined;
  // A retired model, another provider's id, or a local pin unavailable in the
  // cloud must never reach the launch payload. Keep prefs intact while loading.
  const unavailableModel = controlled?.preserveUnavailableModel && savedModel && !models.some((m) => m.id === savedModel) ? savedModel : null;
  const offered = unavailableModel ? null : models.find((m) => m.id === savedModel) ?? models.find((m) => m.isDefault) ?? models[0] ?? null;
  const agentDefault = !!offered && picker.foreign && !offered.alias && pickedModel[harness?.id ?? ""] !== offered.id;
  const model = agentDefault ? null : offered;
  const savedEffort = harness ? (chosen ? chosen.effort : prefs.lastEffort[harness.id]) : undefined;
  const effort = savedEffort && model?.efforts.includes(savedEffort)
    ? savedEffort
    : controlled?.allowDefaultEffort ? null
    : model?.defaultEffort && model.efforts.includes(model.defaultEffort)
      ? model.defaultEffort
      : model?.efforts[0] ?? null;
  // A mode the picker cannot read, saved or the form's, is no choice: the new chat starts where a fresh profile does.
  const mode = pickerMode(chosen ? chosen.permissionMode : prefs.lastMode)?.id ?? FIRST_RUN_PERMISSION_MODE;
  // Accounts are this Mac's (#980): a cloud workspace signs its agents in itself.
  const accounts = useAgentAccounts(here && harness ? harness.id : null);
  // The picker shows only with more than one account; with one, nothing is chosen or sent, as before accounts.
  const accountsShown = showsAccounts(accounts);
  const asked = harness ? (chosen ? chosen.account : pickedAccount[harness.id]) : undefined;
  const resolved: AgentAccount | null = accountsShown && accounts && harness
    ? resolveAccount(accounts, { accountId: asked, projectId })
    : null;
  // Nothing picked by hand, and that account full: automatic switching's choice, and why (#981).
  const automatic = useLaunchAccountChoice(here && harness && !asked ? harness.id : null, accounts, projectId ?? null, resolved?.id ?? null);
  const account = (automatic && accounts?.accounts.find((candidate) => candidate.id === automatic.account)) || resolved;

  const change = (patch: Partial<LaunchSettings>) => {
    const current = latest.current;
    if (current) current.onChange({ ...current.value, ...patch });
  };

  return {
    harnesses,
    harness,
    readiness,
    here,
    models,
    refreshModels: picker.refresh,
    model,
    modelId: unavailableModel ?? model?.id ?? "",
    unavailableModel,
    /** No model is sent: the machine has not said what it runs and none was picked here, so it uses its own default. */
    agentDefault,
    allowDefaultEffort: controlled?.allowDefaultEffort ?? false,
    effort,
    mode,
    /** The agent's accounts, when it has more than one; else `null` and no picker. */
    accounts: accountsShown ? accounts : null,
    /** The account the launch starts on, as the picker shows it. */
    account,
    /**
     * What a launch request carries as `account`: the account shown, or
     * nothing with one account. When the account shown is automatic
     * switching's choice (#981), the one it moves off: the runtime decides
     * again as the tab starts, moves it, and says so in the conversation
     * and the switch log.
     */
    accountId: automatic && account?.id === automatic.account ? resolved?.id : account?.id,
    /** Why automatic switching chose `account` rather than the default (#981), or `null`. */
    accountReason: automatic && account?.id === automatic.account ? automatic.reason : null,
    selectAccount: (id: string) => {
      if (!harness || !accounts?.accounts.some((candidate) => candidate.id === id)) return;
      if (controlled) change({ account: id });
      else setPickedAccount((picked) => ({ ...picked, [harness.id]: id }));
    },
    // Like New Session, only explicit choices are persisted, per provider.
    selectHarness: (id: string) => {
      if (!controlled) {
        if (localDefaults && ![...ready, ...unknown].some((h) => h.id === id)) return;
        setPickedAgent(id);
        setPrefs({ lastAgent: id });
      }
      // Another agent starts on its own saved model and effort, as it would on New Session.
      else if (id !== harness?.id) {
        if (!controlled.preserveUnavailableModel) {
          change({ harness: id, model: prefs.lastModel[id] ?? "", effort: prefs.lastEffort[id] ?? null, account: undefined });
          return;
        }
        const available = catalog.filter((m) => m.harness === id);
        const next = available.find((m) => m.id === prefs.lastModel[id]) ?? available.find((m) => m.isDefault) ?? available[0];
        const saved = prefs.lastEffort[id];
        change({ harness: id, model: next?.id ?? "", effort: saved && next?.efforts.includes(saved) ? saved : null, account: undefined });
      }
    },
    selectModel: (id: string) => {
      const next = models.find((m) => m.id === id);
      if (!harness || !next) return;
      setPickedModel((picked) => ({ ...picked, [harness.id]: id }));
      if (!controlled) setPrefs({ lastModel: { ...prefs.lastModel, [harness.id]: id } });
      // Only an effort picked here or saved carries over, where the new model takes it; else that model's default applies, as on New Session.
      else change({ model: id, effort: chosen?.effort && next.efforts.includes(chosen.effort) ? chosen.effort : null });
    },
    selectEffort: (value: string) => {
      if (controlled?.allowDefaultEffort && value === "") {
        change({ effort: null });
        return;
      }
      if (!harness || !model?.efforts.includes(value)) return;
      if (!controlled) setPrefs({ lastEffort: { ...prefs.lastEffort, [harness.id]: value } });
      else change({ effort: value });
    },
    // Bypass is confirmed once unless the controlled surface supplies its own warning.
    selectMode: (id: string) => controlled?.bypassWarning ? change({ permissionMode: id }) : chooseMode(harness?.id ?? "", id, (picked) => (latest.current ? change({ permissionMode: picked }) : setPrefs({ lastMode: picked }))),
  };
}
