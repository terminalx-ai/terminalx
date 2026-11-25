import type { NewSessionAccount, NewSessionAgent, NewSessionModel, NewSessionOptions, NewSessionRequest } from "./host-api";

/** Where a new session runs: a quick chat, or a project's new worktree or checkout. */
export type Where = { quick: true } | { projectId: string; useWorktree: boolean };

/** What the phone's new-session form holds, as the Mac's new-session view does. */
export interface NewSessionChoices {
  where: Where | null;
  agent: string | null;
  model: string;
  effort: string | null;
  mode: string;
  /**
   * The account picked for the agent (#980), or null to start on the
   * project's default, then the agent's, as the Mac resolves it.
   */
  account?: string | null;
  title: string;
  text: string;
}

/**
 * The form as it opens: the project last used on the Mac (or a quick chat when
 * there is none), the first installed agent and its default model, effort and
 * the mode the Mac offers (`defaultMode`): Ask every time, where a fresh
 * profile's new-session view starts, never Bypass unasked (PRO-162).
 */
export function initialChoices(options: NewSessionOptions): NewSessionChoices {
  const project = options.projects.find((candidate) => candidate.lastUsed) ?? options.projects[0];
  const where: Where = project ? { projectId: project.id, useWorktree: project.git } : { quick: true };
  const agent = options.agents.find((candidate) => candidate.available) ?? null;
  return { where, ...agentDefaults(agent), mode: options.defaultMode, title: "", text: "" };
}

/** An agent's own defaults: its default model, and that model's default effort. */
export function agentDefaults(agent: NewSessionAgent | null): Pick<NewSessionChoices, "agent" | "model" | "effort" | "account"> {
  const model = agent ? defaultModel(agent) : null;
  // Another agent's accounts are its own: a pick does not carry over.
  return { agent: agent?.id ?? null, model: model?.id ?? "", effort: model ? defaultEffort(model) : null, account: null };
}

function defaultModel(agent: NewSessionAgent): NewSessionModel | null {
  return agent.models.find((model) => model.isDefault) ?? agent.models[0] ?? null;
}

function defaultEffort(model: NewSessionModel): string | null {
  return model.defaultEffort && model.efforts.includes(model.defaultEffort) ? model.defaultEffort : model.efforts[0] ?? null;
}

/** Choosing a model keeps the effort only when the new model offers it. */
export function chooseModel(choices: NewSessionChoices, agent: NewSessionAgent, modelId: string): NewSessionChoices {
  const model = agent.models.find((candidate) => candidate.id === modelId);
  if (!model) return choices;
  return { ...choices, model: model.id, effort: choices.effort && model.efforts.includes(choices.effort) ? choices.effort : defaultEffort(model) };
}

/** The agent's accounts to choose from: only when it has more than one on the Mac. */
export function accountsOf(agent: NewSessionAgent | null): NewSessionAccount[] | null {
  return agent?.accounts && agent.accounts.length > 1 ? agent.accounts : null;
}

/**
 * The account the session starts on, as the Mac resolves it: the one
 * picked, else the project's default, else the agent's, each only while
 * listed. `null` when the agent offers no choice.
 */
export function chosenAccount(choices: NewSessionChoices, agent: NewSessionAgent | null): NewSessionAccount | null {
  const accounts = accountsOf(agent);
  if (!accounts || !agent) return null;
  const projectId = choices.where && "projectId" in choices.where ? choices.where.projectId : null;
  const candidates = [choices.account, projectId ? agent.projectDefaults?.[projectId] : undefined, agent.defaultAccount, "local"];
  return candidates.map((id) => accounts.find((account) => account.id === id)).find(Boolean) ?? accounts[0];
}

/** Why the form cannot be started yet, or null when it can. */
export function blocked(choices: NewSessionChoices, options: NewSessionOptions): string | null {
  if (!choices.where) return "Choose a project or a quick chat.";
  if ("projectId" in choices.where) {
    const projectId = choices.where.projectId;
    const project = options.projects.find((candidate) => candidate.id === projectId);
    if (!project) return "That project is no longer on this computer.";
    if (choices.where.useWorktree && !project.git) return `${project.name} is not a Git repository, so it has no worktrees.`;
  }
  const agent = options.agents.find((candidate) => candidate.id === choices.agent);
  if (!agent) return "Choose an agent.";
  if (!agent.available) return `${agent.name} is not installed on this computer.`;
  if (!choices.text.trim()) return "Write the first message.";
  return null;
}

/** What the Mac is asked to start. */
export function request(choices: NewSessionChoices, options?: NewSessionOptions): NewSessionRequest {
  if (!choices.where || !choices.agent) throw new Error("The new session is not complete.");
  // With several accounts the one shown is the one asked for; with one, nothing is named, as before accounts.
  const account = options ? chosenAccount(choices, options.agents.find((agent) => agent.id === choices.agent) ?? null) : null;
  return {
    ...(account ? { account: account.id } : {}),
    where: choices.where,
    agent: choices.agent,
    model: choices.model,
    effort: choices.effort,
    mode: choices.mode,
    title: choices.title,
    text: choices.text,
  };
}
