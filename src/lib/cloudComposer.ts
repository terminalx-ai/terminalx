import { WorkspaceRpcError, type WorkspaceRpcClient, type WorkspaceYou } from "@terminalx/portable/workspace";
import type { FileHit, ImageInput, SlashCommand } from "@/lib/api";
import type { CloudImageRef } from "@/lib/cloudAgentApi";
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

/** A runtime from before `composer/3` cannot take an image. */
export const CLOUD_IMAGES_OLD_RUNTIME = "Images need a newer workspace runtime. They can be sent here once this workspace's runtime is updated.";
/**
 * Images are uploaded straight to the workspace, so it has to be running.
 * Sending them to a stopped one starts it (the same single wake a message
 * asks for) and keeps the message in the composer.
 */
export const CLOUD_IMAGES_NEED_RUNNING = "Starting the workspace: images are uploaded straight to it. Send again once it is running.";
/** Not connected for another reason (reconnecting, offline): nothing is started, and the message stays in the composer. */
export const CLOUD_IMAGES_NEED_CONNECTION = "Not connected to the workspace: images are uploaded straight to it. Send again once it is connected.";
/** As many as the runtime takes with one message. */
export const CLOUD_MAX_IMAGES = 8;
export const CLOUD_TOO_MANY_IMAGES = `A message to a cloud agent carries at most ${CLOUD_MAX_IMAGES} images.`;

/** Why a message's images did not go: a sentence for the person, shown as written. */
export class CloudImageError extends Error {}

/** One part of an upload, in base64 characters: 384 KiB of image, well inside a frame. */
const PART_CHARS = 512 * 1024;

/**
 * Upload `images` to the workspace's runtime for the message about to be
 * sent to `tabId` (`session.attach`, in parts, over the end-to-end encrypted
 * connection), and return what that message names them by. They wait in
 * the runtime's private state, never in the workspace's files, and only
 * this person's message can use them. A part whose answer was lost is sent
 * again under the same request, so nothing is written twice.
 */
export async function uploadCloudImages(client: WorkspaceRpcClient, where: { sessionId: string; tabId: string }, images: ImageInput[]): Promise<CloudImageRef[]> {
  if (images.length > CLOUD_MAX_IMAGES) throw new CloudImageError(CLOUD_TOO_MANY_IMAGES);
  const refs: CloudImageRef[] = [];
  for (const image of images) {
    // One id per attachment the composer holds: a send tried again uploads under the same id,
    // which the runtime takes as the same upload, instead of leaving one behind per attempt.
    const id = attachmentId(image);
    if (refs.some((ref) => ref.id === id)) continue;
    const parts = Math.max(1, Math.ceil(image.data.length / PART_CHARS));
    for (let part = 0; part < parts; part++) {
      const request = {
        sessionId: where.sessionId,
        tabId: where.tabId,
        attachmentId: id,
        mediaType: image.mediaType,
        ...(image.name ? { name: image.name } : {}),
        // Whole base64 quads per part, so each part decodes by itself.
        offset: (part * PART_CHARS * 3) / 4,
        data: image.data.slice(part * PART_CHARS, (part + 1) * PART_CHARS),
        last: part === parts - 1,
      };
      await client.mutate("session.attach", request).catch((error: unknown) => {
        // The runtime's own sentence (too large, not an image, no driver access), with the image's name.
        if (error instanceof WorkspaceRpcError) throw new CloudImageError(`${image.name ?? "The image"} was not sent: ${error.message}.`);
        throw error;
      });
    }
    refs.push({ id, mediaType: image.mediaType, ...(image.name ? { name: image.name } : {}) });
  }
  return refs;
}

/** The upload id of each image a composer has handed over, for as long as the composer keeps that image. */
const attachmentIds = new WeakMap<ImageInput, string>();

function attachmentId(image: ImageInput): string {
  const known = attachmentIds.get(image);
  if (known) return known;
  const id = `att-${crypto.randomUUID().replace(/-/g, "")}`;
  attachmentIds.set(image, id);
  return id;
}

/**
 * Why images cannot go to this runtime now, or null when they can. `asleep`:
 * the workspace is stopped, so sending starts it; any other disconnected
 * state (reconnecting, offline) only waits for the connection.
 */
export function cloudImagesBlocked(client: WorkspaceRpcClient | null, asleep: boolean): string | null {
  if (!client || client.connection.state !== "connected") return asleep ? CLOUD_IMAGES_NEED_RUNNING : CLOUD_IMAGES_NEED_CONNECTION;
  return client.hasCapability("composer/3") ? null : CLOUD_IMAGES_OLD_RUNTIME;
}

/** Tests only. */
export function resetCloudComposer() {
  lists.clear();
}
