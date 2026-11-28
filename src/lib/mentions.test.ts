import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@terminalx/portable/events";
import { matchMentionPeople, mentionedPeople, mentionMessage, mentionPeople, mentionQuote, mentionSegments, mentionSpans, noAccessMessage, withoutMention, type MentionPerson } from "./mentions";

const person = (userId: string, name: string, email = `${userId}@example.test`): MentionPerson => ({ userId, name, email, role: "member" });
const aisha = person("u-aisha", "Aisha Khan");
const sam = person("u-sam", "Sam Rivera");
const samShort = person("u-sam2", "Sam");
const people = [aisha, sam, samShort];

describe("the people source", () => {
  it("lists the roster by display name, without oneself", () => {
    const listed = mentionPeople([
      { userId: "me", email: "me@example.test", displayName: "Paresh Dudhat", role: "owner" },
      { userId: "u-aisha", email: "aisha@example.test", displayName: " Aisha Khan ", photoUrl: "https://example.test/a.png", role: "member" },
      { userId: "u-nameless", email: "sam@example.test", role: "member" },
    ], "me");
    expect(listed).toEqual([
      { userId: "u-aisha", name: "Aisha Khan", email: "aisha@example.test", photoUrl: "https://example.test/a.png", role: "member" },
      { userId: "u-nameless", name: "sam@example.test", email: "sam@example.test", role: "member" },
    ]);
  });

  it("matches what follows @: name start, then a later word, then email, then anywhere", () => {
    const pool = [person("1", "Paresh Dudhat", "paresh@x.test"), person("2", "Sam Rivera", "sam@x.test"), person("3", "Ada Parker", "ada@x.test"), person("4", "Oscar Spartan", "o@x.test")];
    expect(matchMentionPeople(pool, "pa").map((p) => p.name)).toEqual(["Paresh Dudhat", "Ada Parker", "Oscar Spartan"]);
    expect(matchMentionPeople(pool, "sam@").map((p) => p.name)).toEqual(["Sam Rivera"]);
    expect(matchMentionPeople(pool, "").length).toBe(4);
    expect(matchMentionPeople(pool, "zz")).toEqual([]);
  });
});

describe("mentions in text", () => {
  it("finds whole names, the longest first, and nothing inside a word", () => {
    const text = "@Sam Rivera and @Sam, ask @aisha khan's agent; not foo@Sam or @Samantha";
    expect(mentionSpans(text, people).map((span) => [text.slice(span.start, span.end), span.person.userId])).toEqual([
      ["@Sam Rivera", "u-sam"],
      ["@Sam", "u-sam2"],
      ["@aisha khan", "u-aisha"],
    ]);
  });

  it("never guesses between two people of the same name", () => {
    const twins = [person("a", "Alex Lee"), person("b", "Alex Lee"), sam];
    expect(mentionedPeople("@Alex Lee and @Sam Rivera", twins).map((p) => p.userId)).toEqual(["u-sam"]);
  });

  it("lists each person once, in order", () => {
    expect(mentionedPeople("@Sam Rivera @Aisha Khan @Sam Rivera", people).map((p) => p.userId)).toEqual(["u-sam", "u-aisha"]);
    expect(mentionedPeople("no mentions here", people)).toEqual([]);
  });

  it("splits text and chips for drawing, keeping every character", () => {
    const parts = mentionSegments("hi @Aisha Khan, look", people);
    expect(parts.map((part) => (typeof part === "string" ? part : `<${part.person.userId}>`))).toEqual(["hi ", "<u-aisha>", ", look"]);
    expect(mentionSegments("plain", people)).toEqual(["plain"]);
  });

  it("removes one person's mentions and the space after them", () => {
    expect(withoutMention("@Aisha Khan please check, @Sam Rivera too", aisha, people)).toBe("please check, @Sam Rivera too");
    expect(withoutMention("ask @Aisha Khan now", aisha, people)).toBe("ask now");
  });

  it("says screen 14.07's message without guessing pronouns", () => {
    expect(noAccessMessage(["Sam Rivera"], "Push org events")).toBe("Sam Rivera can't follow Push org events yet. Share it with them, then mention them again.");
    expect(noAccessMessage(["Sam Rivera", "Alex Lee", "Ada"], "#18")).toBe("Sam Rivera, Alex Lee and Ada can't follow #18 yet. Share it with them, then mention them again.");
  });
});

describe("the quote", () => {
  const event = (id: string, seq: number, payload: AgentEvent["payload"]) => ({ id, sessionId: "s", tabId: "t", harness: "claude", seq, ts: "2026-11-25T10:00:00Z", payload }) as AgentEvent;

  const aisha = { userId: "u-aisha", displayName: "Aisha Khan" };
  const sam = { userId: "u-sam", displayName: "Sam Rivera" };

  it("is the mentioned message's own text, from the local transcript, one line and short", () => {
    const events = [
      event("m1", 1, { type: "user_message", author: aisha, text: "first", queued: false }),
      event("m2", 2, { type: "user_message", author: aisha, text: "@Paresh Dudhat  the read-marker event\nneeds the session id too", queued: false }),
    ];
    expect(mentionQuote(events, "m2", aisha.userId)).toBe("@Paresh Dudhat the read-marker event needs the session id too");
    const long = "x".repeat(300);
    expect(mentionQuote([event("m3", 3, { type: "user_message", author: aisha, text: long, queued: false })], "m3", aisha.userId)).toHaveLength(140);
  });

  it("is null when the message is not here yet", () => {
    expect(mentionQuote([], "m9", aisha.userId)).toBeNull();
    expect(mentionMessage([], "m9", aisha.userId)).toBe("missing");
  });

  it("never quotes someone else's message as the mentioning person's", () => {
    // The server takes the message id from the sender: Aisha's mention could name Sam's message.
    const events = [
      event("m1", 1, { type: "user_message", author: sam, text: "my private thought", queued: false }),
      event("m2", 2, { type: "user_message", text: "nobody is recorded as writing this", queued: false }),
    ];
    for (const id of ["m1", "m2"]) {
      expect(mentionQuote(events, id, aisha.userId)).toBeNull();
      expect(mentionMessage(events, id, aisha.userId)).toBe("other");
    }
    expect(mentionQuote(events, "m1", sam.userId)).toBe("my private thought");
  });
});
