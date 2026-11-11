/** Message chronology is independent of opening, naming or configuring a session. */
export interface MessageActivity {
  created: string;
  lastMessageAt?: string | null;
  hasMessages?: boolean;
  pinned: boolean;
}
const timestamp = (value: string | null | undefined): number | null => {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
};
export function conversationTime(session: Pick<MessageActivity, "created" | "lastMessageAt">): string {
  return timestamp(session.lastMessageAt) === null ? session.created : session.lastMessageAt!;
}
export function newestMessageTime(...values: (string | null | undefined)[]): string | undefined {
  return values.filter((value): value is string => timestamp(value) !== null)
    .sort((a, b) => timestamp(b)! - timestamp(a)!)[0];
}
export function compareMessageActivity(a: MessageActivity, b: MessageActivity, aId: string, bId: string): number {
  return Number(b.pinned) - Number(a.pinned)
    || (timestamp(conversationTime(b)) ?? 0) - (timestamp(conversationTime(a)) ?? 0)
    || (aId < bId ? -1 : aId > bId ? 1 : 0);
}

/** A delayed metadata snapshot cannot erase a message already observed. */
export function keepMessageTime<T extends { lastMessageAt?: string | null; hasMessages?: boolean }>(incoming: T, previous?: { lastMessageAt?: string | null; hasMessages?: boolean }): T {
  const lastMessageAt = newestMessageTime(incoming.lastMessageAt, previous?.lastMessageAt);
  if (previous?.hasMessages && !incoming.hasMessages) incoming = { ...incoming, hasMessages: true };
  return lastMessageAt === incoming.lastMessageAt || (!lastMessageAt && incoming.lastMessageAt == null)
    ? incoming : { ...incoming, lastMessageAt };
}
