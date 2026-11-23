import { describe, expect, it } from "vitest";
import { inQuietHours, present, shouldShow, subscribeFilter, type HostNotification } from "./filter";
import { defaultSettings, followedSessions, parseSettings, settingsSummary, withOverride, withStartedSession, type NotificationSettings } from "./model";

const on = (change: Partial<NotificationSettings> = {}): NotificationSettings => ({ ...defaultSettings(), allow: true, ...change });
const event = (fields: Partial<HostNotification> = {}): HostNotification => ({ seq: 1, epoch: "e", title: "Review and merge needs your answer", body: "Merge now, or wait for the macOS job?", sessionId: "s-1", tabId: "t-1", ...fields });
const at = (hours: number, minutes = 0) => new Date(2026, 10, 15, hours, minutes);
const noon = at(12);

describe("notification settings model", () => {
  it("starts off, with questions, approvals, finished, failed and failing checks on", () => {
    const settings = defaultSettings();
    expect(settings.allow).toBe(false);
    expect(settings.kinds).toEqual({ question: true, approval: true, finished: true, failed: true, pr_checks_failed: true, usage_limit: false, pr_merged: false });
    expect(settings.sessions).toBe("all");
    expect(settings.quietHours).toEqual({ on: false, start: 1320, end: 420, stillNotifyNeedsMe: false });
    expect(settings.lockScreen).toEqual({ show: "everything", sound: true });
    expect(settingsSummary(settings)).toBe("Off");
    expect(settingsSummary(on())).toBe("Questions, approvals, finished, failed");
    expect(settingsSummary(on({ kinds: { ...defaultSettings().kinds, usage_limit: true, question: false } }))).toBe("Approvals, finished, failed, usage limits");
    const none = { question: false, approval: false, finished: false, failed: false, usage_limit: false, pr_checks_failed: false, pr_merged: false };
    expect(settingsSummary(on({ kinds: { ...none, pr_merged: true } }))).toBe("Pull requests only");
    expect(settingsSummary(on({ kinds: none }))).toBe("No events chosen");
  });

  it("reads back what it wrote as plain JSON, and defaults what is missing or wrong", () => {
    const settings = withOverride(withStartedSession(on({ sessions: "mine", machines: { mini: false } }), "mac", "s-9"), "mac", "s-2", "mute");
    expect(parseSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
    const read = parseSettings({ allow: "yes", kinds: { question: false, bogus: true }, quietHours: { start: 5000 }, lockScreen: { show: "loud" }, perSession: { mac: { a: "default", b: "needsMe" } } });
    expect(read.allow).toBe(false);
    expect(read.kinds.question).toBe(false);
    expect(read.quietHours.start).toBe(1320);
    expect(read.lockScreen.show).toBe("everything");
    expect(read.perSession).toEqual({ mac: { b: "needsMe" } });
  });

  it("follows sessions started here and those with needsMe or everything", () => {
    let settings = withStartedSession(on(), "mac", "s-1");
    settings = withOverride(settings, "mac", "s-2", "everything");
    settings = withOverride(settings, "mac", "s-3", "needsMe");
    settings = withOverride(settings, "mac", "s-4", "mute");
    settings = withOverride(settings, "other", "s-5", "everything");
    expect(followedSessions(settings, "mac").sort()).toEqual(["s-1", "s-2", "s-3"]);
    expect(withOverride(settings, "mac", "s-2", "default").perSession.mac).toEqual({ "s-3": "needsMe", "s-4": "mute" });
  });
});

describe("subscribe filter", () => {
  it("asks for the kinds switched on, all sessions, and the overrides of that Mac", () => {
    const settings = withOverride(withOverride(on(), "mac", "s-2", "mute"), "other", "s-3", "everything");
    expect(subscribeFilter(settings, "mac")).toEqual({ kinds: ["question", "approval", "finished", "failed", "pr_checks_failed"], sessions: { scope: "all" }, overrides: { "s-2": "mute" } });
  });

  it("names only the followed sessions when the scope is mine", () => {
    const settings = withOverride(withStartedSession(on({ sessions: "mine", kinds: { ...defaultSettings().kinds, finished: false, pr_merged: true } }), "mac", "s-1"), "mac", "s-2", "needsMe");
    expect(subscribeFilter(settings, "mac")).toEqual({ kinds: ["question", "approval", "failed", "pr_checks_failed", "pr_merged"], sessions: { scope: "only", ids: ["s-1", "s-2"] }, overrides: { "s-2": "needsMe" } });
    expect(subscribeFilter(settings, "other")).toEqual({ kinds: ["question", "approval", "failed", "pr_checks_failed", "pr_merged"], sessions: { scope: "only", ids: [] }, overrides: {} });
  });
});

describe("quiet hours", () => {
  const quiet = { on: true, start: 22 * 60, end: 7 * 60, stillNotifyNeedsMe: false };
  it("run across midnight", () => {
    expect(inQuietHours(quiet, at(21, 59))).toBe(false);
    expect(inQuietHours(quiet, at(22))).toBe(true);
    expect(inQuietHours(quiet, at(0, 30))).toBe(true);
    expect(inQuietHours(quiet, at(6, 59))).toBe(true);
    expect(inQuietHours(quiet, at(7))).toBe(false);
    expect(inQuietHours({ ...quiet, on: false }, at(23))).toBe(false);
  });
  it("run within a day", () => {
    const day = { ...quiet, start: 9 * 60, end: 17 * 60 };
    expect(inQuietHours(day, at(8, 59))).toBe(false);
    expect(inQuietHours(day, at(12))).toBe(true);
    expect(inQuietHours(day, at(17))).toBe(false);
  });
  it("let only questions and approvals through when still notifying for what needs me", () => {
    const settings = on({ quietHours: { ...quiet, stillNotifyNeedsMe: true } });
    expect(shouldShow(settings, "mac", event({ kind: "question" }), at(23))).toBe(true);
    expect(shouldShow(settings, "mac", event({ kind: "approval" }), at(2))).toBe(true);
    expect(shouldShow(settings, "mac", event({ kind: "finished" }), at(2))).toBe(false);
    expect(shouldShow(settings, "mac", event({ kind: "finished" }), noon)).toBe(true);
    expect(shouldShow(on({ quietHours: quiet }), "mac", event({ kind: "question" }), at(23))).toBe(false);
  });
});

describe("phone-side filter (an older Mac sends everything)", () => {
  it("drops everything with the master switch or the machine off", () => {
    expect(shouldShow(defaultSettings(), "mac", event({ kind: "question" }), noon)).toBe(false);
    expect(shouldShow(on({ machines: { mac: false } }), "mac", event({ kind: "question" }), noon)).toBe(false);
    expect(shouldShow(on({ machines: { mac: false } }), "mini", event({ kind: "question" }), noon)).toBe(true);
  });

  it("shows a notification without a kind, and an unknown kind, while the master and machine are on", () => {
    const allOff = on({ kinds: { question: false, approval: false, finished: false, failed: false, usage_limit: false, pr_checks_failed: false, pr_merged: false } });
    expect(shouldShow(allOff, "mac", event(), noon)).toBe(true);
    expect(shouldShow(allOff, "mac", event({ kind: "deployed" }), noon)).toBe(true);
    expect(shouldShow(allOff, "mac", event({ kind: "finished" }), noon)).toBe(false);
  });

  it("applies kinds, mute, overrides and the session scope", () => {
    expect(shouldShow(on(), "mac", event({ kind: "usage_limit" }), noon)).toBe(false);
    expect(shouldShow(withOverride(on(), "mac", "s-1", "mute"), "mac", event({ kind: "question" }), noon)).toBe(false);
    expect(shouldShow(withOverride(on(), "mac", "s-1", "mute"), "mac", event(), noon)).toBe(false);
    expect(shouldShow(withOverride(on(), "mac", "s-1", "everything"), "mac", event({ kind: "pr_merged" }), noon)).toBe(true);
    expect(shouldShow(withOverride(on(), "mac", "s-1", "needsMe"), "mac", event({ kind: "finished" }), noon)).toBe(false);
    expect(shouldShow(withOverride(on(), "mac", "s-1", "needsMe"), "mac", event({ kind: "approval" }), noon)).toBe(true);
    const mine = on({ sessions: "mine" });
    expect(shouldShow(mine, "mac", event({ kind: "finished" }), noon)).toBe(false);
    expect(shouldShow(withStartedSession(mine, "mac", "s-1"), "mac", event({ kind: "finished" }), noon)).toBe(true);
    expect(shouldShow(withStartedSession(mine, "other", "s-1"), "mac", event({ kind: "finished" }), noon)).toBe(false);
    expect(shouldShow(mine, "mac", event({ kind: "usage_limit", sessionId: undefined }), noon)).toBe(false);
    expect(shouldShow(on({ sessions: "mine", kinds: { ...defaultSettings().kinds, usage_limit: true } }), "mac", event({ kind: "usage_limit", sessionId: undefined }), noon)).toBe(true);
  });
});

describe("lock-screen levels", () => {
  const question = event({ kind: "question", question: { requestId: "r-1", options: [{ label: "Merge now" }, { label: "Wait for it" }] } });

  it("everything: title, body and the machine, with the answer for the actions", () => {
    // iOS heads it with the app's name; the machine's is the line under the title, not "TerminalX" twice (22.07).
    expect(present(on(), "mac", "Studio MacBook", question)).toEqual({
      title: "Review and merge needs your answer", body: "Merge now, or wait for the macOS job?", subtitle: "Studio MacBook", thread: "mac:s-1", sound: true,
      data: { hostId: "mac", sessionId: "s-1", tabId: "t-1", kind: "question", detailsHidden: false, requestId: "r-1", options: [{ label: "Merge now" }, { label: "Wait for it" }] },
    });
  });

  it("session name only: the title, not the text or the machine", () => {
    const shown = present(on({ lockScreen: { show: "sessionName", sound: true } }), "mac", "Studio MacBook", question);
    expect(shown.title).toBe("Review and merge needs your answer");
    expect(shown.body).toBe("Open TerminalX to see the question.");
    expect(shown.subtitle).toBeUndefined();
  });

  it("nothing: generic text per kind, no machine or session, no answer; a tap still opens the session", () => {
    const settings = on({ lockScreen: { show: "nothing", sound: false } });
    const shown = present(settings, "mac", "Studio MacBook", question);
    expect(shown).toEqual({ title: "An agent needs your answer", body: "Open TerminalX to see the question.", thread: "mac:s-1", sound: false, data: { hostId: "mac", sessionId: "s-1", tabId: "t-1", kind: "question", detailsHidden: true } });
    expect(present(settings, "mac", "x", event({ kind: "approval", approval: { requestId: "r-2" } }))).toMatchObject({ title: "An agent needs approval", body: "Open TerminalX to see the request.", data: { detailsHidden: true } });
    expect(present(settings, "mac", "x", event({ kind: "finished" }))).toMatchObject({ title: "An agent finished", body: "Open TerminalX to see the result." });
    expect(present(settings, "mac", "x", event())).toMatchObject({ title: "TerminalX", body: "Open TerminalX to see what happened." });
  });

  it("groups each session's notifications on their own, at every level, and a Mac's sessionless ones together (22.07)", () => {
    for (const show of ["everything", "sessionName", "nothing"] as const) {
      const settings = on({ lockScreen: { show, sound: true } });
      expect(present(settings, "mac", "Studio MacBook", event({ sessionId: "s-1" })).thread, show).toBe("mac:s-1");
      expect(present(settings, "mac", "Studio MacBook", event({ sessionId: "s-2" })).thread, show).toBe("mac:s-2");
      expect(present(settings, "other", "Mac mini", event({ sessionId: "s-1" })).thread, show).toBe("other:s-1");
      expect(present(settings, "mac", "Studio MacBook", event({ kind: "usage_limit", sessionId: undefined })).thread, show).toBe("mac");
    }
  });
});

// PRO-479: a bot's question, under the "questions" choice and never held to a session's scope.
describe("a bot's question", () => {
  const asked = event({ kind: "bot_question", title: "Sentry asks", body: "Fix now or file it?", sessionId: "home", tabId: "t", botQuestion: { botId: "b1", number: 4, question: "q1", answers: ["Fix it now", "File an issue"], recommended: 0 } });

  it("is asked for with questions, only from a Mac that offers its bots", () => {
    expect(subscribeFilter(on(), "mac", true).kinds).toEqual(["question", "approval", "finished", "failed", "pr_checks_failed", "bot_question"]);
    expect(subscribeFilter(on(), "mac").kinds).not.toContain("bot_question");
    expect(subscribeFilter(on({ kinds: { ...defaultSettings().kinds, question: false } }), "mac", true).kinds).not.toContain("bot_question");
  });

  it("shows under the questions switch, whatever the session scope, and through quiet hours when needs-me still notifies", () => {
    expect(shouldShow(on(), "mac", asked, noon)).toBe(true);
    expect(shouldShow(on({ kinds: { ...defaultSettings().kinds, question: false } }), "mac", asked, noon)).toBe(false);
    expect(shouldShow(on({ sessions: "mine" }), "mac", asked, noon)).toBe(true);
    expect(shouldShow(withOverride(on(), "mac", "home", "mute"), "mac", asked, noon)).toBe(false);
    const quiet = { on: true, start: 11 * 60, end: 13 * 60, stillNotifyNeedsMe: true };
    expect(shouldShow(on({ quietHours: quiet }), "mac", asked, noon)).toBe(true);
    expect(shouldShow(on({ quietHours: { ...quiet, stillNotifyNeedsMe: false } }), "mac", asked, noon)).toBe(false);
  });

  it("carries which bot and item, and its answers only when the lock screen shows the question", () => {
    const everything = present(on(), "mac", "Studio", asked);
    expect(everything.data).toEqual({ hostId: "mac", sessionId: "home", tabId: "t", kind: "bot_question", detailsHidden: false, botId: "b1", number: 4, question: "q1", answers: ["Fix it now", "File an issue"], recommended: 0 });
    expect(everything.thread).toBe("mac:bot:b1");
    const nothing = present(on({ lockScreen: { show: "nothing", sound: true } }), "mac", "Studio", asked);
    expect(nothing.title).toBe("A bot needs your answer");
    expect(nothing.data).toEqual({ hostId: "mac", sessionId: "home", tabId: "t", kind: "bot_question", detailsHidden: true, botId: "b1", number: 4 });
  });
});
