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

/** A change as the screen lists it. Its edits and the texts it replaced stay in the log and are not sent. */
export interface BotChange {
  id: string;
  at: string;
  /** `learned`, `forgot`, `archived`, `role`, `restored`, `outside`, `undo`, or a newer app's word. */
  kind: string;
  /** What changed, in a line: the note itself for a note. */
  text: string;
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
  /** The hash of its text, fetched with `botMemoryApi.text` when shown; `null` for no file. */
  hash: string | null;
}

export interface BotRoleView extends BotFileRead {
  path: string;
  /** The role as stored, up to `shownLimit` bytes. */
  text: string;
  /** The most a role may be, in bytes: what a conversation reads of it. */
  limit: number;
  /** The most of it shown here: the older limit, so a role saved under it is shown whole (PRO-489). */
  shownLimit: number;
  /** How many of its bytes a conversation does not read: those past `limit`. */
  cut: number;
  /** The hash of the file as read: a save names it, so a role changed since is not written over. */
  hash: string;
  /** Whether the editor may save it: `false` for a file past `shownLimit`, so a save never cuts it short. One past `limit` is saved once shortened to it. */
  editable: boolean;
  templateTitle: string | null;
  /** Newest first; the template's last. */
  versions: BotRoleVersion[];
}

export interface BotMemoryPlace extends BotFileRead {
  /** `bot`, `personal`, or the organisation's id. */
  key: string;
  path: string;
  lines: string[];
  /** Given to a conversation where the bot works now. */
  read: boolean;
  /** How many of its lines a conversation reads: the last ones. */
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
  /** Files that look like they hold a secret (a key, a token, a password), by path. */
  secrets: string[];
}
