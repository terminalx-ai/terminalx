import { describe, expect, it } from "vitest";
import type { Bot } from "@/types/bots";
import type { BotItem } from "@/types/botItems";
import { askedBy } from "./BotItemPage";

const bot = (id: string, name: string) => ({ id, name }) as Bot;
const item = (extra: Partial<BotItem>) => ({ addedBy: "b2", askedBy: "the release lead", ...extra }) as BotItem;

describe("who asked for an item (PRO-475, lead review 1)", () => {
  const sentry = bot("b2", "Sentry");
  const atlas = bot("b1", "Atlas");
  it("names the bot that handed it on, as TerminalX recorded it, not the bot that holds it", () => {
    expect(askedBy(item({ addedBy: "b1", askedBy: "b1" }), sentry, [atlas, sentry])).toBe("Atlas (a bot), through a hand-off");
    expect(askedBy(item({ addedBy: "gone", askedBy: "gone" }), sentry, [sentry])).toBe("a bot no longer here (a bot), through a hand-off");
  });
  it("keeps you for the owner's work, and the bot's own word for what it added", () => {
    expect(askedBy(item({ addedBy: "owner" }), sentry, [sentry])).toBe("you");
    expect(askedBy(item({}), sentry, [sentry])).toBe("the release lead, as Sentry noted");
  });
});
