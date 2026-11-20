/**
 * A bot's role and memory as the Role and memory screen reads them (PRO-470). Every change to them is in the bot's
 * change log, kept outside its home folder, and can be undone. Kinds and sources a newer app wrote arrive as their
 * own strings and are shown as themselves.
 */

/** Where a change came from. */
export interface BotChangeSource {
  /** `chat`, `duty`, `app`, `cli`, `outside`, `budget`, `undo`, `template`, or a newer app's word. */
  kind: string;
  session?: string;
  tab?: string;
  /** The chat's title when the change was made. */
  title?: string;
  duty?: string;
}

/** One edit, by the file's path in the bot's home. An op a newer app wrote arrives as its own string. */
export type BotEdit =
  | { op: "addLine"; file: string; line: string; index?: number }
  | { op: "removeLine"; file: string; line: string; index?: number }
  | { op: "replaceText"; file: string; before: string | null; after: string | null }
  | { op: string & {}; file?: string };

export interface BotChange {
  id: string;
  at: string;
  /** `learned`, `forgot`, `archived`, `role`, `restored`, `outside`, `undo`, or a newer app's word. */
  kind: string;
  /** What changed, in a line: the note itself for a note. */
  text: string;
  edits: BotEdit[];
  source: BotChangeSource;
  /** `owner`, a bot's id, or `outside`. */
  by: string;
  /** The change this one undid. */
  undoes?: string;
  /** The undo that undid this one. */
  undoneBy: string | null;
  /** Why it cannot be undone; `null` when Undo is offered. */
  notUndoable: string | null;
}

/** How a file is read for a conversation: a regular file, at most `readLimit` bytes, decoded lossily. */
export interface BotFileRead {
  bytes: number;
  overLimit: boolean;
  /** Why nothing was read from a file that is there. */
  problem?: string;
}

export interface BotDiffLine {
  kind: "same" | "added" | "removed";
  text: string;
}

export interface BotRoleVersion {
  /** The change that left it; `null` for the role template's text the bot was built from. */
  change: string | null;
  at: string;
  by: string;
  kind: string;
  source: BotChangeSource;
  text: string | null;
}

export interface BotRoleView extends BotFileRead {
  path: string;
  /** The whole file, for the editor; only its first `readLimit` bytes reach a conversation. */
  text: string;
  /** Whether the editor may save it: `false` past the size a role may be, so a save never cuts it short. */
  editable: boolean;
  templateTitle: string | null;
  /** From the template's text to the role now; `null` with no template, or too long to compare. */
  templateDiff: BotDiffLine[] | null;
  /** Newest first; the template's last. */
  versions: BotRoleVersion[];
}

export interface BotMemoryPlace extends BotFileRead {
  /** `bot`, `personal`, or the organisation's name. */
  key: string;
  path: string;
  lines: string[];
  /** Given to a conversation where the bot works now. */
  read: boolean;
  readLines: number;
  notRead: number;
  archiveLines: number;
}

export interface BotMemoryTopic {
  place: string;
  name: string;
  path: string;
  lines: number;
  modified: string | null;
}

export interface BotMemoryView {
  off: boolean;
  budget: number;
  readLimit: number;
  /** The place a conversation works in. */
  workingPlace: string;
  /** Lines a conversation starts with. */
  read: number;
  places: BotMemoryPlace[];
  topics: BotMemoryTopic[];
}

export interface BotRoleMemory {
  role: BotRoleView;
  memory: BotMemoryView;
  /** Newest first. */
  changes: BotChange[];
  totalChanges: number;
  /** Lines of the log this app cannot read. They are kept. */
  unreadableChanges: number;
}
