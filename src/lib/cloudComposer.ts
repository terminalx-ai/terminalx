import type { WorkspaceRpcClient, WorkspaceYou } from "@terminalx/portable/workspace";
import type { SlashCommand } from "@/lib/api";
import { mayConfigure } from "@/lib/cloudCollab";

/** The slash commands a composer offers, and why some are not among them (null when all are). */
export interface ComposerCommandList {
  commands: SlashCommand[];
  note: string | null;
}

/**
 * Where a composer's slash commands come from. A local tab asks its CLI on
 * this computer; a cloud tab asks the workspace's runtime (`composer/1`).
 */
export interface ComposerCommands {
  /** Names the list: it is read again whenever this changes. */
  key: string;
  /** What is already known for `key`, without asking anyone. */
  known(): ComposerCommandList | null;
  load(): Promise<ComposerCommandList>;
}

/**
 * Said in the command list of someone who drives a shared workspace without
 * the right to approve permissions: the runtime refuses every other command
 * from them (PRO-88), so the composer does not offer those.
 */
export const COMMANDS_RESTRICTED_NOTE = "Other commands need someone who can approve permissions.";

const NONE: ComposerCommandList = { commands: [], note: null };
const lists = new Map<string, ComposerCommandList>();

function parse(result: { commands?: unknown; restricted?: unknown }): ComposerCommandList {
  const commands: SlashCommand[] = [];
  for (const entry of Array.isArray(result.commands) ? result.commands : []) {
    const command = entry as Partial<SlashCommand> | null;
    if (!command || typeof command.name !== "string" || !command.name) continue;
    commands.push({
      name: command.name,
      description: typeof command.description === "string" ? command.description : "",
      argumentHint: typeof command.argumentHint === "string" ? command.argumentHint : undefined,
      source: command.source === "plugin" || command.source === "user" ? command.source : "builtin",
    });
  }
  return { commands, note: result.restricted === true ? COMMANDS_RESTRICTED_NOTE : null };
}

/**
 * The slash commands of a cloud agent tab, as the runtime lists them for
 * this person: everything the tab's CLI offers in the session's directory,
 * or, for a driver who may not approve permissions, only what the runtime
 * will accept from them. Asked once per session, agent and right while the
 * runtime is connected; never wakes a stopped workspace, which keeps what
 * was last listed. Null on a runtime from before `composer/1`.
 */
export function cloudComposerCommands(target: {
  /** `cloud:<orgId>:<workspaceId>`. */
  workspaceKey: string;
  /** The runtime's id for the session. */
  sessionId: string;
  tabId: string;
  harness: string;
  /** The live connection, or null while there is none. */
  client: WorkspaceRpcClient | null;
  you: WorkspaceYou | null;
}): ComposerCommands | null {
  const { client } = target;
  const live = !!client && client.connection.state === "connected";
  if (live && !client.hasCapability("composer/1")) return null;
  // The right is part of the name: a list read as an approver is not shown to the same person once they are not.
  const stored = `${target.workspaceKey}|${target.sessionId}|${target.harness}|${mayConfigure(target.you) ? "all" : "restricted"}`;
  return {
    key: `${stored}|${live ? "live" : "offline"}`,
    known: () => lists.get(stored) ?? null,
    load: async () => {
      const known = lists.get(stored);
      if (known || !live) return known ?? NONE;
      const list = parse(await client.call<{ commands?: unknown; restricted?: unknown }>("session.commands", { sessionId: target.sessionId, tabId: target.tabId }));
      lists.set(stored, list);
      return list;
    },
  };
}

/** Tests only. */
export function resetCloudComposer() {
  lists.clear();
}
