import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { continuationPrompt, type ContextMode } from "@terminalx/portable/continuation";
import type { RuntimeSessionUsage, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import type { PrCheck } from "@/lib/api";
import { actionsRuns } from "@/lib/checks";
import { fixErrorsPrompt } from "@/lib/fixCheckErrors";
import type { MachinePr } from "@/lib/machineSessionBranch";
import { getPrefs } from "@/lib/prefs";
import type { SendResult } from "@/lib/sessionBackend";

/**
 * A machine session's cost, Continue in a new tab and Fix check errors
 * (`machine/10`, PRO-408, docs/MACHINES.md "As built (PRO-403 to PRO-408)").
 *
 * - Cost: each tab's tokens and estimated cost come with the machine's
 *   session list (`TabEntry.usage`) and, with several accounts for one agent
 *   there, the account it runs on (`TabEntry.accountLabel`); `session.usage`
 *   reads them again from the agents' transcripts on the machine, with how
 *   each agent signs in there and the machine's usage windows.
 * - Continue in a new tab: `session.prepareContinuation` gives the tab's
 *   context with the machine's own transcript path; a new agent tab of the
 *   session on the machine (`session.addTab`) is sent the prompt, and its
 *   agent reads that file there.
 * - Fix check errors: the session's pull request and its failed checks are
 *   read through the machine's `git/1` (`git.prs`); `session.checkFailures`
 *   saves the failed logs with the machine's `gh` in the session's
 *   attachments folder there, and the tab is sent the prompt naming that file.
 *
 * No path of the machine is opened on this computer and nothing of this
 * computer's `gh` or transcripts is used.
 */

export const MACHINE_SESSION_AGENTS = "machine/10";

/** What `CloudSessionModel.usage` is for a machine session. */
export interface MachineSessionUsage {
  /** The machine granted `machine/10`; without it only the totals in the session list are known. */
  served: boolean;
  /** The last read, as `terminalx sessions usage` reports it on the machine. */
  read: RuntimeSessionUsage | null;
  error: string | null;
  loading: boolean;
  /** Read it again on the machine: its transcripts are counted again there. */
  refresh(): Promise<RuntimeSessionUsage | null>;
}

/** The session pull request's failed GitHub Actions checks, as the machine's `git.prs` read them. */
export interface MachineFailingChecks {
  prUrl: string;
  prNumber: number;
  /** One per failed Actions run. */
  checks: PrCheck[];
}

/** What `CloudSessionModel.checks` is for a machine session. */
export interface MachineSessionChecks {
  /** The machine reads failed logs (`machine/10`) and this computer manages it. */
  served: boolean;
  /** The open pull request's failed Actions checks; null when it has none or there is no open pull request. */
  failing: MachineFailingChecks | null;
  /** Why Fix check errors cannot run now; null when it can. */
  blocked: string | null;
  /**
   * Save the failed logs on the machine and send the agent tab `tabId` the
   * Fix check errors prompt naming them. `prUrl` defaults to `failing`'s.
   * Resolves to what to tell the person.
   */
  fix(tabId: string, prUrl?: string): Promise<string>;
}

/** What `CloudSessionModel.continueInNewTab` is given. */
export interface MachineContinueInput {
  /** The tab whose conversation the new one carries on. */
  sourceTabId: string;
  agent: string;
  model?: string;
  effort?: string | null;
  mode?: string;
  /** "focused" (recent history) unless the whole saved transcript is asked for. */
  context?: ContextMode;
}

/** The pull request's failed Actions runs; null for one not open or without any. */
export function failingChecksOf(pr: MachinePr | null | undefined): MachineFailingChecks | null {
  if (!pr || pr.state !== "OPEN") return null;
  const checks = actionsRuns(pr, true);
  return checks.length ? { prUrl: pr.url, prNumber: pr.number, checks } : null;
}

/** Why `machine/10` work cannot be done now; null when it can. */
export function agentsBlocked(input: { name: string; connected: boolean; served: boolean; manage: boolean; what: string }): string | null {
  if (!input.connected) return `${input.what} works once ${input.name} is back`;
  if (!input.served) return `${input.name} runs an older TerminalX. Update it to use ${input.what} from here.`;
  if (!input.manage) return `Only a computer paired with ${input.name} can use ${input.what}`;
  return null;
}

/**
 * Continue `sourceTabId`'s conversation in a new agent tab of the session on
 * the machine. The context is read there first, so nothing is added when the
 * conversation has nothing to carry on.
 */
export async function continueMachineTab(input: {
  client: WorkspaceRpcClient;
  sessionId: string;
  request: MachineContinueInput;
  addTab(params: { agent: string; model?: string; effort?: string | null; mode?: string }): Promise<string>;
  send(tabId: string, text: string): Promise<SendResult>;
}): Promise<{ tabId: string; queued: boolean }> {
  const { client, sessionId, request } = input;
  const context = await client.prepareContinuation(sessionId, request.sourceTabId);
  // Throws, before any tab is added, when there is no usable context.
  const prompt = continuationPrompt(context, request.context ?? "focused");
  const tabId = await input.addTab({ agent: request.agent, model: request.model, effort: request.effort, mode: request.mode });
  const sent = await input.send(tabId, prompt);
  return { tabId, queued: sent.queued };
}

/** Save `prUrl`'s failed logs on the machine and send `tabId` the prompt naming them. */
export async function fixMachineChecks(input: {
  client: WorkspaceRpcClient;
  name: string;
  sessionId: string;
  tabId: string;
  prUrl: string;
  instructions: string;
  send(tabId: string, text: string): Promise<SendResult>;
}): Promise<string> {
  const attachment = await input.client.checkFailures(input.sessionId, input.tabId, input.prUrl);
  const outcome = await input.send(input.tabId, fixErrorsPrompt(input.prUrl, attachment.path, input.instructions));
  return `${outcome.queued ? "Queued" : "Sent"} failed check logs to the agent on ${input.name}${attachment.truncated ? " (trimmed to 256 KiB)" : ""}.`;
}

/** The model's `usage`: read on each connect and again when a turn in the session ends. */
export function useMachineSessionUsage(input: { client: WorkspaceRpcClient | null; connected: boolean; sessionId: string; generation: string | null; working: boolean }): MachineSessionUsage {
  const { client, connected, sessionId, generation, working } = input;
  const served = connected && !!client && client.hasCapability(MACHINE_SESSION_AGENTS);
  const [read, setRead] = useState<{ sessionId: string; usage: RuntimeSessionUsage | null; error: string | null }>({ sessionId, usage: null, error: null });
  const [loading, setLoading] = useState(false);
  const live = useRef({ client, sessionId, served });
  live.current = { client, sessionId, served };
  const refresh = useCallback(async () => {
    const now = live.current;
    if (!now.served || !now.client) return null;
    setLoading(true);
    try {
      const usage = await now.client.sessionUsage(now.sessionId);
      if (live.current.sessionId === now.sessionId) setRead({ sessionId: now.sessionId, usage, error: null });
      return usage;
    } catch (cause) {
      if (live.current.sessionId === now.sessionId) setRead((last) => ({ sessionId: now.sessionId, usage: last.sessionId === now.sessionId ? last.usage : null, error: cause instanceof Error ? cause.message : String(cause) }));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);
  // A turn's end is when the machine counts the tab's usage again.
  useEffect(() => {
    if (served && generation && !working) void refresh();
  }, [served, generation, sessionId, working, refresh]);
  const own = read.sessionId === sessionId ? read : null;
  return useMemo(() => ({ served, read: served ? (own?.usage ?? null) : null, error: served ? (own?.error ?? null) : null, loading, refresh }), [served, own, loading, refresh]);
}

/** The model's `checks`. */
export function useMachineSessionChecks(input: {
  client: WorkspaceRpcClient | null;
  connected: boolean;
  manage: boolean;
  name: string;
  sessionId: string;
  pr: MachinePr | null;
  send(tabId: string, text: string): Promise<SendResult>;
}): MachineSessionChecks {
  const { client, connected, manage, name, sessionId, pr, send } = input;
  const served = connected && !!client && client.hasCapability(MACHINE_SESSION_AGENTS) && manage;
  const failing = useMemo(() => failingChecksOf(pr), [pr]);
  const blocked = agentsBlocked({ name, connected: connected && !!client, served: !!client?.hasCapability(MACHINE_SESSION_AGENTS), manage, what: "Fix check errors" });
  const fix = useCallback(
    async (tabId: string, prUrl?: string) => {
      if (blocked || !client) throw new Error(blocked ?? `Fix check errors works once ${name} is back`);
      const url = prUrl ?? failing?.prUrl;
      if (!url) throw new Error("No failing GitHub Actions checks were found for this session.");
      return fixMachineChecks({ client, name, sessionId, tabId, prUrl: url, instructions: getPrefs().fixErrorsInstructions, send });
    },
    [blocked, client, name, failing?.prUrl, sessionId, send],
  );
  return useMemo(() => ({ served, failing, blocked, fix }), [served, failing, blocked, fix]);
}
