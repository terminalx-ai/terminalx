import { describe, expect, it } from "vitest";
import { answerCloudBot, cloudBotQuestions, type BotsClient } from "./bots";
import { PHONE_CAPABILITIES } from "./link";

const bot = { id: "b1", slug: "atlas", name: "Atlas", roleTitle: "CTO", roleTemplateId: "cto", harness: "claude", model: "", access: "full", runsOn: "thisMac", reportsTo: "owner", worksIn: ["personal"], created: "", modified: "" };
const item = (number: number, question: string | null) => ({ number, title: `Item ${number}`, state: "needsYou", summary: "", question: question ? { id: `q${number}`, text: question, answers: ["Yes", "No"], recommended: 0, asked: "2026-11-23T10:00:00Z" } : null });

function client(capable = true) {
  const calls: [string, Record<string, unknown> | undefined][] = [];
  const value: BotsClient = {
    hasCapability: (capability) => capable && capability === "bots/1",
    async call<T>(method: string, params?: Record<string, unknown>) {
      calls.push([method, params]);
      if (method === "bots.list") return {
        bots: { revision: 1, bots: [bot], unreadable: 0 },
        needsYou: { entries: [
          { kind: "item", botId: "b1", at: "2026-11-23T10:00:00Z", item: item(1, "Ship today?") },
          { kind: "item", botId: "b1", at: "2026-11-23T11:00:00Z", item: item(2, "Which branch?") },
          { kind: "item", botId: "b1", at: "2026-11-23T12:00:00Z", item: item(3, null) },
          { kind: "item", botId: "gone", at: "2026-11-23T12:00:00Z", item: item(4, "Whose?") },
        ], counts: [] },
        team: [],
      } as T;
      return { item: item(1, null), delivery: { sent: true } } as T;
    },
  };
  return { calls, value };
}

describe("a cloud workspace's bots on the phone (PRO-482)", () => {
  it("the phone asks for bots/1", () => {
    expect(PHONE_CAPABILITIES).toContain("bots/1");
  });

  it("lists the open questions of the person's bots there, newest first", async () => {
    const questions = await cloudBotQuestions(client().value);
    expect(questions.map((question) => question.item.question?.text)).toEqual(["Which branch?", "Ship today?"]);
    expect(questions[0]!.bot.name).toBe("Atlas");
  });

  it("asks nothing of a runtime without bots/1", async () => {
    const c = client(false);
    expect(await cloudBotQuestions(c.value)).toEqual([]);
    expect(c.calls).toEqual([]);
  });

  it("answers through bots.answer, naming the question as shown", async () => {
    const c = client();
    const [, first] = await cloudBotQuestions(c.value);
    const result = await answerCloudBot(c.value, first!, { answer: 0 });
    expect(result.delivery?.sent).toBe(true);
    expect(c.calls.at(-1)).toEqual(["bots.answer", { id: "b1", number: 1, answer: 0, question: expect.any(String) }]);
  });
});
