import reservedNames from "./reservedAttachmentNames.json";

/**
 * The rules for files attached to one message (PRO-290). The Rust store reads
 * the same reserved-name list (`reservedAttachmentNames.json`) and enforces
 * the same limits again, so a client that skips these checks is still refused.
 */

/** At most this many files (images included) go with one message. */
export const MAX_FILES_PER_MESSAGE = 10;
/** A file larger than this is refused. Images up to 5 MB still go to the agent as images. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const reserved = new Set((reservedNames as string[]).map((name) => name.toLowerCase()));

/** A name TerminalX uses for its own session and project files, in any letter case. */
export function isReservedName(name: string): boolean {
  return reserved.has(baseName(name).toLowerCase());
}

/** A free name to rename a reserved one to: `terminalx.json` → `terminalx.copy.json`. */
export function renameSuggestion(name: string): string {
  const base = baseName(name);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? `${base.slice(0, dot)}.copy${base.slice(dot)}` : `${base}.copy`;
}

export type Refusal = "reserved" | "too-large";

export interface Offered { name: string; size?: number }

export interface Admission<T> {
  /** In the order offered; never more than the room left. */
  attached: T[];
  /** Never attached, whatever room is left. They take no place in the count. */
  refused: { item: T; reason: Refusal }[];
  /** Would have been attached, but the message was full. */
  notAdded: T[];
}

/**
 * Split files offered to a message that already carries `queued` of them:
 * a reserved name or an oversized file is refused; the rest are attached in
 * order until the message holds `limit`, and those after are not added.
 */
export function admit<T extends Offered>(queued: number, offered: T[], limit = MAX_FILES_PER_MESSAGE): Admission<T> {
  const out: Admission<T> = { attached: [], refused: [], notAdded: [] };
  let room = Math.max(0, limit - queued);
  for (const item of offered) {
    if (isReservedName(item.name)) out.refused.push({ item, reason: "reserved" });
    else if ((item.size ?? 0) > MAX_ATTACHMENT_BYTES) out.refused.push({ item, reason: "too-large" });
    else if (room > 0) { out.attached.push(item); room--; }
    else out.notAdded.push(item);
  }
  return out;
}

/** The parts of the line above the draft: "10 attached · 1 refused · 4 not added". Zero counts are left out, except "attached". */
export function summaryParts(counts: { attached: number; refused: number; notAdded: number }): { kind: "attached" | "refused" | "notAdded"; text: string }[] {
  const parts: { kind: "attached" | "refused" | "notAdded"; text: string }[] = [{ kind: "attached", text: `${counts.attached} attached` }];
  if (counts.refused) parts.push({ kind: "refused", text: `${counts.refused} refused` });
  if (counts.notAdded) parts.push({ kind: "notAdded", text: `${counts.notAdded} not added` });
  return parts;
}

/** The notice shown when more files were offered than the message has room for. `verb` says how they came: dropped, pasted, picked. */
export function limitNotice(offered: number, notAdded: number, verb: "dropped" | "pasted" | "picked" = "dropped"): { title: string; body: string } {
  const files = (n: number) => (n === 1 ? "1 file" : `${n} files`);
  return {
    title: `Only the first ${MAX_FILES_PER_MESSAGE} files were attached`,
    body: `You ${verb} ${files(offered)}. ${notAdded} ${notAdded === 1 ? "wasn’t" : "weren’t"} added; send ${notAdded === 1 ? "it" : "them"} in another message.`,
  };
}

/** The notice for a file refused for its name. */
export function reservedNotice(name: string): { title: string; body: string } {
  const base = baseName(name);
  return {
    title: `${base} is a name TerminalX uses for session files`,
    body: `Rename it, for example to ${renameSuggestion(base)}, and attach it again.`,
  };
}

/** The notice for a file refused for its size. */
export function tooLargeNotice(name: string): { title: string; body: string } {
  return {
    title: `${baseName(name)} is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`,
    body: "Files that large can’t be attached. Point the agent at it by its path instead.",
  };
}

function baseName(name: string): string {
  return name.split(/[\\/]/).pop() || name;
}
