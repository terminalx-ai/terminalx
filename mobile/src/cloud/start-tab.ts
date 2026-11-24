import { modelNote } from "@terminalx/portable/agentSettings";
import { WorkspaceRpcError, type RuntimeAgentModel, type RuntimeAgentsReport, type WorkspaceConnectionState, type WorkspaceYou } from "@terminalx/portable/workspace";
import type { CloudRole } from "./api";
import { effortLabel, PHONE_DEFAULT_MODE, phoneMode, phoneModeLabel, phoneModes, type PhoneMode } from "./agent-settings";

/**
 * Starting a conversation, or adding an agent tab, in a running cloud
 * workspace from the phone (PRO-548, board 25.10). Both are live calls on
 * the workspace's connection (`session.create`, `session.addTab`), which a
 * phone may make only where the runtime says so (`you.canStart`, PRO-546),
 * and only in the narrow form: an agent, its model, effort and mode, and for
 * a conversation a title and a first message. The mode is always named and
 * is never Bypass (`agent-settings.ts`).
 */

/**
 * Two things the boards (25.09, 25.10) say that nobody has yet seen hold on
 * a real workspace. Each stays off until a check on a live workspace shows it,
 * and is then turned on here.
 *
 * - `emptyFirstMessageStartsAgent`: a conversation started with no first
 *   message has its agent running, waiting for one. On, the sheet says so
 *   under an empty message.
 * - `stopAndStartReplacesRuntime`: stopping a workspace and starting it again
 *   gives it a current runtime. On, a manager whose workspace's runtime is
 *   too old gets Stop workspace under the sentence that tells them to.
 */
export const PROVEN_BY_LIVE_CHECK = { emptyFirstMessageStartsAgent: false, stopAndStartReplacesRuntime: false };

/** What the phone says while starting one. PRO-548's wording table first, as the owner approved it on 2026-11-24. */
export const START_WORDS = {
  gone: "Not sent: this agent tab is no longer in the workspace.",
  goneButton: "New conversation",
  goneOther: "Ask the workspace's creator or an organization owner or admin to start a new one.",
  emptyTitle: "No conversation yet",
  emptyManager: "Start one with an agent.",
  emptyButton: "Start a conversation",
  emptyOther: "Only this workspace's creator or an organization owner or admin can start one.",
  old: "This workspace needs a newer runtime before a phone can start a conversation. Stop it and start it again.",
  refused: "Only this workspace's creator or an organization owner or admin can do that.",
  // Board 25.10's own, approved with it.
  newConversation: "New conversation",
  addTab: "Add agent tab",
  addTabUnder: "Opens beside the tab you are on.",
  startButton: "Start conversation",
  addButton: "Add tab",
  starting: "Starting…",
  adding: "Adding…",
  tryAgain: "Try again",
  placeholder: "What should the agent work on?",
  noMessage: "With no first message, the agent starts and waits for one.",
  reading: "Reading the agents in this workspace…",
  unread: "The agents in this workspace could not be read.",
  waking: "Starting the workspace. The choices appear when it is running.",
  noAnswer: "No answer came back. Try again: nothing is started twice.",
  offline: "Not connected to this workspace.",
  other: "That did not work. Try again in a moment.",
  notSignedIn: "Not signed in in this workspace",
  notInstalled: "Not installed in this workspace",
  signedIn: "Signed in",
  agentsSubtitle: "In this workspace",
  startAsk: "Start this workspace?",
  startAskText: "It is stopped. A new conversation starts it, and it is billed to the organization while it runs.",
  // PRO-547's open question 7, for a conversation's first message: the session exists, its prompt may not have gone.
  promptNotSent: "The agent started, but the first message may not have reached it.",
} as const;

/**
 * Whether this phone may start something in the workspace now:
 * `yes`, `old` (a runtime from before PRO-546, which says nothing of
 * `canStart`: it refuses a phone, whoever holds it), `no` (not a manager, or
 * the runtime says not now), or null while that is not known (not
 * connected, or the runtime has no member list yet).
 */
export type StartOffer = "yes" | "old" | "no";

export function startOffer(connection: WorkspaceConnectionState, you: WorkspaceYou | null | undefined, listedRole: CloudRole | null | undefined): StartOffer | null {
  if (connection.state !== "connected") return null;
  if (you?.listed === false) return null;
  const role = you?.role ?? listedRole ?? null;
  if (role !== "manager") return "no";
  if (you?.canStart === true) return "yes";
  if (you?.canStart === false) return "no";
  return "old";
}

/** An agent as the sheet offers it: what can be chosen for it, and why it cannot be picked when it cannot. */
export interface StartAgent {
  id: string;
  name: string;
  models: RuntimeAgentModel[];
  /** The modes the agent lists that a phone may start it in; empty when it lists none (no row, `PHONE_DEFAULT_MODE` is sent). */
  modes: PhoneMode[];
  /** Why it cannot be picked here; null when it can. */
  blocked: string | null;
  /** The quiet line under its name. */
  detail: string | null;
}

/**
 * The runtime's agents (`runtime.agents`) as the sheet offers them: the
 * ones that can be picked first, in the runtime's order; then one whose login
 * there is known to be missing, and one the workspace has no CLI for, both
 * shown with the reason and not pickable. A login the runtime could not
 * read does not stop a pick.
 */
export function startAgents(report: RuntimeAgentsReport): StartAgent[] {
  const installed: StartAgent[] = report.agents.map((agent) => {
    const signedOut = agent.signIn === "signedOut";
    return {
      id: agent.id,
      name: agent.name,
      models: agent.models ?? [],
      modes: phoneModes(agent.modes ?? []).map((mode) => mode.id),
      blocked: signedOut ? START_WORDS.notSignedIn : null,
      detail: signedOut ? START_WORDS.notSignedIn : agent.signIn === "signedIn" ? START_WORDS.signedIn : null,
    };
  });
  const missing: StartAgent[] = (report.missing ?? []).map((agent) => ({ id: agent.id, name: agent.name, models: [], modes: [], blocked: START_WORDS.notInstalled, detail: START_WORDS.notInstalled }));
  return [...installed.filter((agent) => !agent.blocked), ...installed.filter((agent) => agent.blocked), ...missing];
}

/** What the sheet holds: the agent and its settings. `model` is "" for the agent's own default. */
export interface StartChoices {
  agent: string | null;
  model: string;
  effort: string | null;
  mode: PhoneMode;
}

const defaultModel = (agent: StartAgent): RuntimeAgentModel | null => agent.models.find((model) => model.isDefault) ?? agent.models[0] ?? null;
const defaultEffort = (model: RuntimeAgentModel | null): string | null => (!model ? null : model.defaultEffort && model.efforts.includes(model.defaultEffort) ? model.defaultEffort : model.efforts[0] ?? null);

/** The mode an agent starts in: the one asked for when the agent lists it, else Ask every time, else the first it lists. */
function modeFor(agent: StartAgent, wanted: PhoneMode): PhoneMode {
  if (!agent.modes.length) return PHONE_DEFAULT_MODE;
  if (agent.modes.includes(wanted)) return wanted;
  return agent.modes.includes(PHONE_DEFAULT_MODE) ? PHONE_DEFAULT_MODE : agent.modes[0]!;
}

/**
 * The sheet as it opens: the settings of the tab the person is on, else the
 * first agent that can be picked, its default model and that model's default
 * effort, and Ask every time. Never the runtime's `defaultMode`, which is
 * Bypass permissions for every agent.
 */
export function initialStartChoices(agents: readonly StartAgent[], from?: TabSettings | null): StartChoices {
  // The tab the person is on (25.10), where its agent can be picked here: its model and effort where offered, its
  // mode where it is one a phone may choose (Bypass permissions becomes Ask every time).
  const own = from ? agents.find((candidate) => candidate.id === from.agent && !candidate.blocked) : null;
  if (own && from) {
    const base = agentChoices(own, phoneMode(from.mode));
    const withModel = from.model && own.models.some((model) => model.id === from.model) ? chooseModel(agents, base, from.model) : base;
    const model = own.models.find((candidate) => candidate.id === withModel.model);
    return { ...withModel, effort: from.effort && model?.efforts.includes(from.effort) ? from.effort : withModel.effort };
  }
  const agent = agents.find((candidate) => !candidate.blocked) ?? null;
  return agent ? agentChoices(agent, PHONE_DEFAULT_MODE) : { agent: null, model: "", effort: null, mode: PHONE_DEFAULT_MODE };
}

/** What a tab runs, as the runtime lists it: where a new start's choices begin. */
export interface TabSettings { agent: string; model: string | null; effort: string | null; mode: string | null }

function agentChoices(agent: StartAgent, mode: PhoneMode): StartChoices {
  const model = defaultModel(agent);
  return { agent: agent.id, model: model?.id ?? "", effort: defaultEffort(model), mode: modeFor(agent, mode) };
}

/** Another agent: its own defaults, and the mode kept where it lists it. One that cannot be picked changes nothing. */
export function chooseAgent(agents: readonly StartAgent[], choices: StartChoices, id: string): StartChoices {
  const agent = agents.find((candidate) => candidate.id === id);
  if (!agent || agent.blocked) return choices;
  return agentChoices(agent, choices.mode);
}

/** Another model keeps the effort only where the new model offers it. */
export function chooseModel(agents: readonly StartAgent[], choices: StartChoices, id: string): StartChoices {
  const model = agents.find((candidate) => candidate.id === choices.agent)?.models.find((candidate) => candidate.id === id);
  if (!model) return choices;
  return { ...choices, model: model.id, effort: choices.effort && model.efforts.includes(choices.effort) ? choices.effort : defaultEffort(model) };
}

/** What the four rows show. `model` null: the agent's default, nothing to choose. `effort` and `mode` null: no row. */
export function startRows(agents: readonly StartAgent[], choices: StartChoices): { agent: string; model: string | null; effort: string | null; mode: string | null } {
  const agent = agents.find((candidate) => candidate.id === choices.agent) ?? null;
  const model = agent?.models.find((candidate) => candidate.id === choices.model) ?? null;
  return {
    agent: agent?.name ?? "None",
    model: model?.label ?? null,
    effort: model?.efforts.length && choices.effort ? effortLabel(choices.effort) : null,
    mode: agent?.modes.length ? phoneModeLabel(choices.mode) : null,
  };
}

/** The choices of the pickers over the sheet. */
export function modelChoices(agent: StartAgent) {
  const all = agent.models.map((model) => ({ ...model, harness: agent.id }));
  return all.map((model) => ({ id: model.id, label: model.label, detail: modelNote(model, all, false) ?? undefined }));
}

export function effortChoices(model: RuntimeAgentModel) {
  return model.efforts.map((effort) => ({ id: effort, label: effortLabel(effort) }));
}

/** What the runtime is asked to start the agent with: always a mode, never Bypass; no model for the agent's default. */
export function startParams(agents: readonly StartAgent[], choices: StartChoices): { agent: string; model?: string; effort?: string; mode: PhoneMode } {
  const agent = agents.find((candidate) => candidate.id === choices.agent && !candidate.blocked);
  if (!agent) throw new Error("No agent is chosen.");
  const model = agent.models.find((candidate) => candidate.id === choices.model);
  const effort = model && choices.effort && model.efforts.includes(choices.effort) ? choices.effort : undefined;
  return { agent: agent.id, ...(model ? { model: model.id } : {}), ...(effort ? { effort } : {}), mode: modeFor(agent, choices.mode) };
}

/** The most a launched tab's title holds (`title_of` in `cloud_agents/launch.rs`). */
const TITLE_MAX = 80;

/**
 * What a new conversation is called: the first line of its message, as the
 * runtime names a launched tab (`title_of`), else the next "Agent N", as a
 * tab added with no message reads in the strip.
 */
export function conversationTitle(text: string, tabCount: number): string {
  const line = (text.split("\n")[0] ?? "").trim();
  if (!line) return `Agent ${tabCount + 1}`;
  const chars = [...line];
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join("")}…` : line;
}

/**
 * What became of a start that did not succeed. `refused` and `other` are the
 * runtime's answer, so the next try is a new request; `no-answer` and
 * `offline` may have started it, so the next try is the same request, which
 * the runtime answers with what it already started.
 */
export type StartFailure = { kind: "refused" | "other" | "no-answer" | "offline"; text: string };

export function startFailure(error: unknown, connected: boolean): StartFailure {
  if (error instanceof WorkspaceRpcError && error.code !== "outcome_unknown") {
    if (error.code === "forbidden") return { kind: "refused", text: START_WORDS.refused };
    return { kind: "other", text: START_WORDS.other };
  }
  return connected ? { kind: "no-answer", text: START_WORDS.noAnswer } : { kind: "offline", text: START_WORDS.offline };
}

/** Whether a failure keeps the request: asking again is then the same request. */
export const keepsRequest = (failure: StartFailure): boolean => failure.kind === "no-answer" || failure.kind === "offline";
