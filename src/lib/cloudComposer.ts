import type { WorkspaceRpcClient, WorkspaceYou } from "@terminalx/portable/workspace";
import type { FileHit, SlashCommand } from "@/lib/api";
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
/** What each runtime last listed, by session, agent and the right the runtime said the list was made for. */
const lists = new Map<string, ComposerCommandList>();
/** Listings on their way, so several composers and a reader typing `/` ask once. */
const asking = new Map<string, Promise<ComposerCommandList>>();

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
 * will accept from them. A list with commands in it is kept per session,
 * agent and the right the runtime made it for, and not asked for again. An
 * empty list or a failed listing is not kept: the CLI may not have answered
 * yet on a machine that just woke, so `load` asks again. Never wakes a
 * stopped workspace, which keeps what was last listed. Null on a runtime
 * from before `composer/1`.
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
  const base = `${target.workspaceKey}|${target.sessionId}|${target.harness}`;
  const slot = (restricted: boolean) => `${base}|${restricted ? "restricted" : "all"}`;
  // Looked up by what this person is believed to be allowed, kept under what the runtime said
  // the list was made for: a list made for an approver is never shown to someone who is not one,
  // even if the two disagree for a moment.
  const expected = slot(!mayConfigure(target.you));
  return {
    key: `${expected}|${live ? "live" : "offline"}`,
    known: () => lists.get(expected) ?? null,
    load: () => {
      const known = lists.get(expected);
      if (known || !live) return Promise.resolve(known ?? NONE);
      const pending = asking.get(expected);
      if (pending) return pending;
      const asked = client
        .call<{ commands?: unknown; restricted?: unknown }>("session.commands", { sessionId: target.sessionId, tabId: target.tabId })
        .then((result) => {
          const list = parse(result);
          if (list.commands.length) lists.set(slot(result.restricted === true), list);
          return list;
        })
        .finally(() => asking.delete(expected));
      asking.set(expected, asked);
      return asked;
    },
  };
}

/**
 * Where a composer's `@` list comes from: the files of the directory the
 * tab runs in, by name. A local tab searches this computer; a cloud tab asks
 * the workspace's runtime (`composer/2`).
 */
export interface ComposerFiles {
  /** Names the directory searched. */
  key: string;
  /** The best matches for `query`, paths relative to that directory; an empty query lists the shallowest files. */
  search(query: string, limit: number): Promise<FileHit[]>;
}

/**
 * The files a cloud agent tab's composer can mention: the session's own
 * directory on the workspace, searched by the runtime as a local tab's is
 * searched here. Only while the runtime is connected and serves
 * `composer/2`: a stopped workspace is never woken to list files (the path
 * can still be typed), and null then hides the list and its button.
 */
export function cloudComposerFiles(target: { workspaceKey: string; sessionId: string; client: WorkspaceRpcClient | null }): ComposerFiles | null {
  const { client } = target;
  if (!client || client.connection.state !== "connected" || !client.hasCapability("composer/2")) return null;
  return {
    key: `${target.workspaceKey}|${target.sessionId}`,
    search: async (query, limit) => {
      const result = await client.call<{ files?: unknown }>("session.files", { sessionId: target.sessionId, query, limit });
      const hits: FileHit[] = [];
      for (const entry of Array.isArray(result.files) ? result.files : []) {
        const hit = entry as Partial<FileHit> | null;
        if (!hit || typeof hit.path !== "string" || !hit.path) continue;
        hits.push({ path: hit.path, name: typeof hit.name === "string" && hit.name ? hit.name : (hit.path.split("/").pop() ?? hit.path), score: typeof hit.score === "number" ? hit.score : 0 });
      }
      return hits;
    },
  };
}

/** Tests only. */
export function resetCloudComposer() {
  lists.clear();
  asking.clear();
}
