import { afterEach, expect, it } from "vitest";
import { dismissError, dismissErrorKey, errorToastText, getErrorToasts, reportError, runErrorAction, showError, subscribeErrorToasts } from "./errorToasts";

afterEach(() => { for (const toast of getErrorToasts()) dismissError(toast.id); });

it("keeps the action and the cause the failing call reported", () => {
  showError("Couldn't move “Notarize release builds” to Release:", new Error("database is locked (SQLITE_BUSY)"));
  const [toast] = getErrorToasts();
  expect(toast).toMatchObject({ action: "Couldn't move “Notarize release builds” to Release", cause: "database is locked (SQLITE_BUSY)", count: 1 });
  expect(errorToastText(toast)).toBe("Couldn't move “Notarize release builds” to Release: database is locked (SQLITE_BUSY)");
});

it("reads a string, an object with a message, and no cause at all", () => {
  showError("Couldn't pin “web”", "remote said no");
  showError("Couldn't archive “web”", { message: "not found", code: 404 });
  showError("Couldn't reveal “web” in Finder");
  expect(getErrorToasts().map((toast) => toast.cause)).toEqual(["remote said no", "not found", ""]);
  expect(errorToastText(getErrorToasts()[2])).toBe("Couldn't reveal “web” in Finder.");
});

it("stacks different errors and counts a repeat of the same one instead of copying it", () => {
  const first = showError("Couldn't pin “web”", "locked");
  showError("Couldn't pin “api”", "locked");
  showError("Couldn't pin “web”", "gone");
  expect(showError("Couldn't pin “web”", "locked")).toBe(first);
  const toasts = getErrorToasts();
  expect(toasts).toHaveLength(3);
  // The repeat is counted and moves to the newest place.
  expect(toasts[2]).toMatchObject({ id: first, count: 2 });
});

it("removes only the toast closed and tells subscribers", () => {
  let heard = 0;
  const stop = subscribeErrorToasts(() => heard++);
  const a = showError("Couldn't pin “web”", "locked");
  showError("Couldn't pin “api”", "locked");
  dismissError(a);
  dismissError(a);
  stop();
  expect(getErrorToasts().map((toast) => toast.action)).toEqual(["Couldn't pin “api”"]);
  expect(heard).toBe(3);
});

it("turns a rejected promise into a toast", async () => {
  await Promise.reject(new Error("permission denied")).catch(reportError("Couldn't copy the path"));
  expect(getErrorToasts()[0]).toMatchObject({ action: "Couldn't copy the path", cause: "permission denied" });
});

it("takes a heading of its own, said apart from its body, and copies all of it (PRO-291)", () => {
  showError("", "~/.claude/settings.json line 14: Unexpected token }", { title: "Couldn't open a new Claude Code tab: claude exited while starting" });
  const [toast] = getErrorToasts();
  expect(toast).toMatchObject({ title: "Couldn't open a new Claude Code tab: claude exited while starting", action: "" });
  expect(errorToastText(toast)).toBe("Couldn't open a new Claude Code tab: claude exited while starting\n~/.claude/settings.json line 14: Unexpected token }");
  showError("Codex didn't stop within 10 seconds, so “web” is still open", undefined, { title: "Couldn't close the chat. Try again." });
  expect(errorToastText(getErrorToasts()[1])).toBe("Couldn't close the chat. Try again.\nCodex didn't stop within 10 seconds, so “web” is still open.");
});

it("updates a toast raised again under its key in place, whatever it says now", () => {
  const first = showError("“web” is still open", "busy", { key: "close:agent:web", title: "Couldn't close the chat. Try again." });
  showError("Couldn't pin “api”", "locked");
  expect(showError("Codex didn't stop within 10 seconds, so “web” is still open", undefined, { key: "close:agent:web", title: "Couldn't close the chat. Try again." })).toBe(first);
  const toasts = getErrorToasts();
  expect(toasts).toHaveLength(2);
  expect(toasts[1]).toMatchObject({ id: first, count: 2, cause: "", action: "Codex didn't stop within 10 seconds, so “web” is still open" });
  dismissErrorKey("close:agent:web");
  dismissErrorKey("close:agent:nothing");
  expect(getErrorToasts().map((toast) => toast.action)).toEqual(["Couldn't pin “api”"]);
});

it("closes a toast once its Try again worked, and keeps it while it fails", async () => {
  let works = false;
  const retry = { label: "Try again", icon: "retry" as const, run: async () => works };
  const id = showError("“web” is still open", "busy", { key: "k", actions: [retry] });
  await runErrorAction(id, retry);
  expect(getErrorToasts()).toHaveLength(1);
  works = true;
  await runErrorAction(id, retry);
  expect(getErrorToasts()).toHaveLength(0);
});

it("keeps the toast open beside an action that does not retry, and says when that action fails", async () => {
  const open = { label: "Open settings.json", keepOpen: true, run: async () => { throw new Error("no such file"); } };
  const id = showError("", "bad json", { title: "Couldn't open a new Codex tab", actions: [open] });
  await runErrorAction(id, open);
  expect(getErrorToasts().map((toast) => [toast.id === id, toast.action, toast.cause])).toEqual([[true, "", "bad json"], [false, "Couldn't open settings.json", "no such file"]]);
});

it("counts a retry that threw on the toast it came from", async () => {
  const retry = { label: "Try again", run: async () => { throw new Error("still locked"); } };
  const id = showError("Couldn't pin “web”", "locked", { key: "pin:web", actions: [retry] });
  await runErrorAction(id, retry);
  expect(getErrorToasts()).toEqual([expect.objectContaining({ id, cause: "still locked", count: 2 })]);
});
