import { afterEach, expect, it } from "vitest";
import { dismissError, errorToastText, getErrorToasts, reportError, showError, subscribeErrorToasts } from "./errorToasts";

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
