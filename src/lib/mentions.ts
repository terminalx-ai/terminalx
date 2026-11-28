/**
 * Chat @mentions of teammates (PRO-141).
 *
 * A mention is plain text: `@Display Name`, which is what the agent reads.
 * Who it names is worked out from the organization roster, both in the
 * composer and in the transcript, so nothing beyond the text is stored with
 * the message. The server is told ids only.
 */
import type { AgentEvent } from "@terminalx/portable/events";
import type { OrganizationMember } from "@/lib/organizationMembers";

export interface MentionPerson {
  userId: string;
  name: string;
  email: string;
  photoUrl?: string;
  role: string;
}

/** People one can mention: everyone on the roster with a usable name, never oneself. */
export function mentionPeople(members: readonly OrganizationMember[] | undefined, selfUserId: string | null | undefined): MentionPerson[] {
  const people: MentionPerson[] = [];
  for (const member of members ?? []) {
    if (member.userId === selfUserId) continue;
    // As MemberProfile names them; an id-only fallback is no name to type.
    const name = (member.displayName?.trim() || member.email || "").trim();
    if (!name || name.includes("\n")) continue;
    people.push({ userId: member.userId, name, email: member.email, ...(member.photoUrl ? { photoUrl: member.photoUrl } : {}), role: member.role });
  }
  return people;
}

const lower = (value: string) => value.toLocaleLowerCase();

/** People whose name or email matches what follows `@`, best first: name start, then word start, then anywhere. */
export function matchMentionPeople(people: readonly MentionPerson[], query: string, limit = 6): MentionPerson[] {
  const q = lower(query.trim());
  if (!q) return people.slice(0, limit);
  const rank = (person: MentionPerson) => {
    const name = lower(person.name);
    if (name.startsWith(q)) return 0;
    if (name.split(/\s+/).some((word) => word.startsWith(q))) return 1;
    if (lower(person.email).startsWith(q)) return 2;
    if (name.includes(q)) return 3;
    return -1;
  };
  return people
    .map((person) => ({ person, rank: rank(person) }))
    .filter((hit) => hit.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.person.name.localeCompare(b.person.name))
    .slice(0, limit)
    .map((hit) => hit.person);
}

/** What a picked person puts in the draft. */
export const mentionText = (person: Pick<MentionPerson, "name">) => `@${person.name}`;

const BOUNDARY_BEFORE = /[\s([{"'“‘]/;
// After a name: anything that cannot continue a word, so `@Aisha Khan's` and `@Aisha Khan,` count and `@Aisha Khanh` does not.
const continuesWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_-]/u.test(ch);

export interface MentionSpan {
  start: number;
  end: number;
  person: MentionPerson;
}

/**
 * Every `@Name` in the text that names exactly one person. Two people with
 * the same name are never guessed between: neither is mentioned.
 */
export function mentionSpans(text: string, people: readonly MentionPerson[]): MentionSpan[] {
  if (!text.includes("@") || !people.length) return [];
  const byName = new Map<string, MentionPerson | null>();
  for (const person of people) {
    const name = lower(person.name);
    byName.set(name, byName.has(name) ? null : person);
  }
  // Longest first, so "Sam Rivera" wins over a teammate called "Sam".
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  const folded = lower(text);
  const spans: MentionSpan[] = [];
  for (let at = folded.indexOf("@"); at !== -1; at = folded.indexOf("@", at + 1)) {
    if (at > 0 && !BOUNDARY_BEFORE.test(text[at - 1])) continue;
    for (const name of names) {
      const end = at + 1 + name.length;
      if (folded.startsWith(name, at + 1) && !continuesWord(text[end])) {
        const person = byName.get(name);
        if (person) spans.push({ start: at, end, person });
        at = end - 1;
        break;
      }
    }
  }
  return spans;
}

/** The distinct people a message mentions, in the order first named. */
export function mentionedPeople(text: string, people: readonly MentionPerson[]): MentionPerson[] {
  const seen = new Map<string, MentionPerson>();
  for (const span of mentionSpans(text, people)) if (!seen.has(span.person.userId)) seen.set(span.person.userId, span.person);
  return [...seen.values()];
}

/** Text and mentions in order, for drawing the chips. */
export function mentionSegments(text: string, people: readonly MentionPerson[]): (string | MentionSpan)[] {
  const spans = mentionSpans(text, people);
  if (!spans.length) return [text];
  const parts: (string | MentionSpan)[] = [];
  let at = 0;
  for (const span of spans) {
    if (span.start > at) parts.push(text.slice(at, span.start));
    parts.push(span);
    at = span.end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/** The draft without this person's mentions (the chip's remove button), and one space where each was. */
export function withoutMention(text: string, person: MentionPerson, people: readonly MentionPerson[]): string {
  let next = "";
  let at = 0;
  for (const span of mentionSpans(text, people)) {
    if (span.person.userId !== person.userId) continue;
    next += text.slice(at, span.start);
    at = span.end;
    if (text[at] === " " && (next === "" || next.endsWith(" "))) at++;
  }
  return next + text.slice(at);
}

const listNames = (names: readonly string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** Screen 14.07's message, with "them" for a person whose pronouns the app does not know. */
export function noAccessMessage(names: readonly string[], workspace: string): string {
  return `${listNames(names)} can't follow ${workspace} yet. Share it with them, then mention them again.`;
}

const QUOTE_MAX = 140;

/**
 * The mentioned message, as this device's transcript has it: `missing` while
 * it has not arrived, `other` when it is not that person's message.
 */
export function mentionMessage(events: readonly AgentEvent[], messageId: string, actorId: string): "missing" | "other" | AgentEvent {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.id !== messageId || event.payload.type !== "user_message") continue;
    // The server takes the message id from the sender as given: only a message
    // the transcript says that person wrote may be quoted as theirs.
    return event.payload.author?.userId === actorId ? event : "other";
  }
  return "missing";
}

/**
 * The quoted text of a mentioned message, read from a transcript this device
 * has decrypted itself. Null when the message is not here yet, or was written
 * by someone other than the person who mentioned (`actorId`).
 */
export function mentionQuote(events: readonly AgentEvent[], messageId: string, actorId: string): string | null {
  const event = mentionMessage(events, messageId, actorId);
  if (typeof event === "string" || event.payload.type !== "user_message") return null;
  const text = event.payload.text.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX - 1).trimEnd()}…` : text;
}
