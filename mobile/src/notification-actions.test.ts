import { beforeEach, describe, expect, it, vi } from "vitest";

const notifications = vi.hoisted(() => ({ setNotificationCategoryAsync: vi.fn(async () => ({})) }));
vi.mock("expo-notifications", () => notifications);

import { answer, categoryFor, intentOf, MAX_QUESTION_ACTIONS, prepareCategory, type AnswerTarget } from "./notification-actions";
import { present, type HostNotification } from "./notifications/filter";
import { defaultSettings, type LockScreenShow } from "./notifications/model";

const question: HostNotification = {
  seq: 1, epoch: "e", kind: "question", title: "Mobile question card needs your answer", body: "Merge now, or wait for the macOS job?",
  sessionId: "s", tabId: "t", question: { requestId: "q1", options: [{ label: "Merge now" }, { label: "Wait for it" }] },
};
const approval: HostNotification = { seq: 2, epoch: "e", kind: "approval", title: "Rust cleanup needs approval", body: "Run: cargo clean in the build folder", sessionId: "s", tabId: "t", approval: { requestId: "p1" } };
const finished: HostNotification = { seq: 3, epoch: "e", kind: "finished", title: "Runtime handover finished", body: "Merged, and the checks passed.", sessionId: "s", tabId: "t" };

function shown(event: HostNotification, show: LockScreenShow = "everything") {
  const settings = { ...defaultSettings(), allow: true, lockScreen: { show, sound: true } };
  return present(settings, "mac", "Studio MacBook", event);
}

beforeEach(() => notifications.setNotificationCategoryAsync.mockClear());

describe("which buttons a notification gets", () => {
  it("a question's options, and Allow and Deny for an approval, when the lock screen shows everything", () => {
    expect(categoryFor(shown(question))?.actions.map((action) => action.buttonTitle)).toEqual(["Merge now", "Wait for it"]);
    expect(categoryFor(shown(approval))?.actions.map((action) => action.buttonTitle)).toEqual(["Allow", "Deny"]);
    expect(categoryFor(shown(approval))?.actions.every((action) => action.options?.isAuthenticationRequired && action.options.opensAppToForeground)).toBe(true);
  });

  it("none with 'Session name only' or 'Nothing', and none for other kinds", () => {
    for (const level of ["sessionName", "nothing"] as const) {
      expect(categoryFor(shown(question, level))).toBeNull();
      expect(categoryFor(shown(approval, level))).toBeNull();
    }
    expect(categoryFor(shown(finished))).toBeNull();
  });

  it("none for a question the Mac sent without answers, or with more options than iOS shows", () => {
    expect(categoryFor(shown({ ...question, question: undefined }))).toBeNull();
    expect(categoryFor(shown({ ...approval, approval: undefined }))).toBeNull();
    const many = Array.from({ length: MAX_QUESTION_ACTIONS + 1 }, (_, index) => ({ label: `Option ${index}` }));
    expect(categoryFor(shown({ ...question, question: { requestId: "q2", options: many } }))).toBeNull();
  });

  it("one category per set of labels, registered with iOS once", async () => {
    const first = await prepareCategory(shown(question));
    expect(await prepareCategory(shown({ ...question, question: { requestId: "q9", options: [{ label: "Merge now" }, { label: "Wait for it" }] } }))).toBe(first);
    expect(notifications.setNotificationCategoryAsync).toHaveBeenCalledTimes(1);
    const other = await prepareCategory(shown({ ...question, question: { requestId: "q3", options: [{ label: "Yes" }, { label: "No" }] } }));
    expect(other).not.toBe(first);
    expect(await prepareCategory(shown(finished))).toBeNull();
  });
});

describe("what a tap asks for", () => {
  const data = (event: HostNotification) => shown(event).data as unknown as Record<string, unknown>;

  it("Allow and Deny answer the request by its options' ids", () => {
    expect(intentOf("approval.allow", data(approval), approval.body)).toEqual({ type: "permission", hostId: "mac", sessionId: "s", tabId: "t", requestId: "p1", optionId: "allow" });
    expect(intentOf("approval.deny", data(approval), approval.body)).toMatchObject({ type: "permission", optionId: "deny" });
  });

  it("an option answers the question, keyed by its text", () => {
    expect(intentOf("question.option.1", data(question), question.body)).toEqual({ type: "question", hostId: "mac", sessionId: "s", tabId: "t", requestId: "q1", answers: { [question.body]: "Wait for it" } });
  });

  it("a plain tap, or a button that does not fit the notification, opens the session", () => {
    expect(intentOf("expo.modules.notifications.actions.DEFAULT", data(question), question.body)).toEqual({ type: "open", hostId: "mac", sessionId: "s", tabId: "t" });
    expect(intentOf("approval.allow", data(question), question.body)?.type).toBe("open");
    expect(intentOf("question.option.7", data(question), question.body)?.type).toBe("open");
    // An older notification without its Mac: opens the session on the connected one.
    expect(intentOf("x", { sessionId: "s", tabId: "t" }, null)).toEqual({ type: "open", hostId: null, sessionId: "s", tabId: "t" });
    expect(intentOf("x", { sessionId: "s" }, null)).toBeNull();
  });
});

describe("answering on the Mac", () => {
  const target = (reachable: boolean): AnswerTarget & { calls: unknown[] } => {
    const calls: unknown[] = [];
    return {
      calls,
      reach: vi.fn(async () => reachable),
      respondPermission: vi.fn(async (...args: unknown[]) => { calls.push(["permission", ...args]); return { answered: true as const }; }),
      answerQuestions: vi.fn(async (...args: unknown[]) => { calls.push(["question", ...args]); return { answered: false as const, message: "Already answered on the Mac." }; }),
    };
  };

  it("answers through the session's own paths, on the notification's Mac", async () => {
    const mac = target(true);
    expect(await answer({ type: "permission", hostId: "mac", sessionId: "s", tabId: "t", requestId: "p1", optionId: "allow" }, mac)).toBeNull();
    expect(mac.reach).toHaveBeenCalledWith("mac");
    expect(await answer({ type: "question", hostId: "mac", sessionId: "s", tabId: "t", requestId: "q1", answers: { Q: "A" } }, mac)).toBe("Already answered on the Mac.");
    expect(mac.calls).toEqual([["permission", "s", "t", "p1", "allow"], ["question", "s", "t", "q1", { Q: "A" }]]);
  });

  it("says so when the Mac cannot be reached, and sends nothing", async () => {
    const mac = target(false);
    expect(await answer({ type: "permission", hostId: "mac", sessionId: "s", tabId: "t", requestId: "p1", optionId: "deny" }, mac)).toMatch(/not connected/);
    expect(mac.calls).toEqual([]);
  });
});
