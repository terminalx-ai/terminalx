import { WorkspaceRpcError, type WorkspaceRpcClient, type WorkspaceYou } from "@terminalx/portable/workspace";
import { attachments, type FileHit, type FileInput, type ImageInput, type SlashCommand } from "@/lib/api";
import type { CloudImageRef } from "@/lib/cloudAgentApi";
import { mayConfigure } from "@/lib/cloudCollab";
import { MAX_ATTACHMENT_BYTES, MAX_FILES_PER_MESSAGE } from "@/lib/attachmentRules";

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
/** A cloud agent takes images only (PRO-290): any other file stays on this computer. A machine takes them (PRO-407). */
export const CLOUD_FILES_REFUSED = "Only images can be sent to a cloud agent. Other files can be attached to a session on this computer.";
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

/** A machine from before `composer/4` takes images only. */
export const MACHINE_FILES_OLD_RUNTIME = "This machine runs an older TerminalX that takes images only. Update it to send files from here.";
export const MACHINE_TOO_MANY_FILES = `A message carries at most ${MAX_FILES_PER_MESSAGE} files, images included.`;

/** What a message to a machine names an uploaded file by (`files: [{ id }]`). */
export interface MachineFileRef {
  id: string;
  name: string;
  mediaType?: string;
}

/**
 * Upload `files` other than images to a machine's runtime for the message
 * about to be sent to `tabId` (PRO-407): `session.attach` with `kind: "file"`,
 * in parts, as images go. The machine keeps them until the message is typed,
 * then stores them in the session's attachments folder there and hands the
 * agent those paths. Only a file's bytes and its last name segment leave this
 * computer, never a path of it: a picked or dropped file is read here part by
 * part (`attachments.readPart`).
 */
export async function uploadMachineFiles(client: WorkspaceRpcClient, where: { sessionId: string; tabId: string }, files: FileInput[], images = 0): Promise<MachineFileRef[]> {
  if (!client.hasCapability("composer/4")) throw new CloudImageError(MACHINE_FILES_OLD_RUNTIME);
  if (files.length + images > MAX_FILES_PER_MESSAGE) throw new CloudImageError(MACHINE_TOO_MANY_FILES);
  const refs: MachineFileRef[] = [];
  for (const file of files) {
    const id = attachmentId(file);
    if (refs.some((ref) => ref.id === id)) continue;
    const name = baseName(file.name);
    const mediaType = file.mediaType ?? "";
    const refuse = (error: unknown): never => {
      // The machine's own sentence (too large, a reserved name), with the file's name.
      if (error instanceof WorkspaceRpcError) throw new CloudImageError(`${name} was not sent: ${error.message}.`);
      throw error;
    };
    const send = (offset: number, data: string, last: boolean) =>
      client.mutate("session.attach", { sessionId: where.sessionId, tabId: where.tabId, attachmentId: id, kind: "file", name, mediaType, offset, data, last }).catch(refuse);
    if (file.path) {
      // Read here, one part at a time; the machine is never told where it was.
      let offset = 0;
      for (;;) {
        const part = await attachments.readPart(file.path, offset).catch((error: unknown) => {
          throw new CloudImageError(`${name} was not sent: ${error instanceof Error ? error.message : String(error)}`);
        });
        if (part.size > MAX_ATTACHMENT_BYTES) throw new CloudImageError(`${name} was not sent: it is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
        const next = offset + part.bytes;
        const last = next >= part.size;
        // An empty file goes as one empty last part; an empty part before the end means the file shrank while it was read.
        if (part.bytes === 0 && !last) throw new CloudImageError(`${name} was not sent: it changed while it was read. Attach it again.`);
        await send(offset, part.data, last);
        if (last) break;
        offset = next;
      }
    } else if (file.data !== undefined) {
      const parts = Math.max(1, Math.ceil(file.data.length / PART_CHARS));
      for (let part = 0; part < parts; part++) {
        await send((part * PART_CHARS * 3) / 4, file.data.slice(part * PART_CHARS, (part + 1) * PART_CHARS), part === parts - 1);
      }
    } else {
      throw new CloudImageError(`${name} was not sent: it could not be read.`);
    }
    refs.push({ id, name, ...(file.mediaType ? { mediaType: file.mediaType } : {}) });
  }
  return refs;
}

function baseName(name: string): string {
  return name.split(/[\\/]/).pop() || name;
}

/** The upload id of each image or file a composer has handed over, for as long as the composer keeps it. */
const attachmentIds = new WeakMap<ImageInput | FileInput, string>();

function attachmentId(item: ImageInput | FileInput): string {
  const known = attachmentIds.get(item);
  if (known) return known;
  const id = `att-${crypto.randomUUID().replace(/-/g, "")}`;
  attachmentIds.set(item, id);
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
  asking.clear();
}
