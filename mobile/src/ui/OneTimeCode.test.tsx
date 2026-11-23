// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OneTimeCode } from "./OneTimeCode";
import { appearance, stage } from "./testing/kit";

// PRO-542: the device login's code, with Copy and the countdown (25.04).
const mocks = vi.hoisted(() => ({ copy: vi.fn(async (_text: string) => true) }));
vi.mock("expo-clipboard", () => ({ setStringAsync: mocks.copy }));
vi.mock("react-native", () => import("@mobile/ui/testing/native"));
vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()));
vi.mock("lucide-react-native", async () => (await import("@mobile/ui/testing/kit")).namedIcons());

const page = stage();
const NOW = Date.UTC(2026, 10, 23, 10, 25, 0);
const code = () => page.byId("one-time-code")!;
const expiry = () => page.byId("one-time-code-expiry");
const copyButton = () => page.byLabel("Copy code");
const pass = (milliseconds: number) => act(async () => { vi.advanceTimersByTime(milliseconds); });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); mocks.copy.mockReset().mockResolvedValue(true); });
afterEach(() => { vi.useRealTimers(); });

it("draws the code large and monospaced, selectable, with the time it has left", async () => {
  await page.show(<OneTimeCode code="K7QM-4TXP" expiresAt={NOW + 892_000} />);
  expect(code().textContent).toBe("K7QM-4TXP");
  expect(code().dataset.selectable).toBe("true");
  expect(page.styleOf(code())).toMatchObject({ fontFamily: "Menlo", fontSize: 30, fontWeight: "500", letterSpacing: 4.2, textAlign: "center", borderRadius: 12, color: "#f4ecee", backgroundColor: "#20181b", borderColor: "#ffffff1a" });
  expect(page.byText("One-time code")).not.toBeNull();
  expect(expiry()!.textContent).toBe("expires in 14:52");
  expect(page.styleOf(expiry()).fontVariant).toEqual(["tabular-nums"]);
});

it("reads the code out character by character", async () => {
  await page.show(<OneTimeCode code="K7QM-4TXP" expiresAt={NOW + 60_000} />);
  expect(code().getAttribute("aria-label")).toBe("One-time code: K 7 Q M - 4 T X P");
});

it("counts down by the second and says once when the code has run out", async () => {
  const expired = vi.fn();
  await page.show(<OneTimeCode code="K7QM-4TXP" expiresAt={NOW + 3_000} onExpired={expired} />);
  expect(expiry()!.textContent).toBe("expires in 0:03");
  await pass(1_000);
  expect(expiry()!.textContent).toBe("expires in 0:02");
  expect(expired).not.toHaveBeenCalled();
  await pass(2_000);
  expect(expired).toHaveBeenCalledTimes(1);
  expect(expiry()).toBeNull();
  expect(copyButton()).toBeNull();
  expect(page.styleOf(code())).toMatchObject({ textDecorationLine: "line-through", color: "#7a6a70" });
  await pass(5_000);
  expect(expired).toHaveBeenCalledTimes(1);
});

it("copies the code in one tap and says so", async () => {
  await page.show(<OneTimeCode code="K7QM-4TXP" expiresAt={NOW + 600_000} />);
  expect(copyButton()!.textContent).toBe("Copy code");
  expect(page.icon("Copy")).not.toBeNull();
  await page.press(copyButton());
  expect(mocks.copy).toHaveBeenCalledExactlyOnceWith("K7QM-4TXP");
  expect(copyButton()!.textContent).toBe("Copied");
  expect(page.icon("Check")).not.toBeNull();
  expect(page.icon("Copy")).toBeNull();
});

it("says how else to copy it when the clipboard refuses", async () => {
  mocks.copy.mockRejectedValue(new Error("denied"));
  await page.show(<OneTimeCode code="K7QM-4TXP" expiresAt={NOW + 600_000} />);
  await page.press(copyButton());
  expect(page.container.querySelector("[role='alert']")!.textContent).toBe("Could not copy the code. Select it and copy it, or type it.");
  expect(copyButton()!.textContent).toBe("Copy code");
});

it("says neither Copied nor a failure for a new code shown in its place", async () => {
  await page.show(<OneTimeCode code="K7QM-4TXP" expiresAt={NOW + 600_000} />);
  await page.press(copyButton());
  expect(copyButton()!.textContent).toBe("Copied");
  await page.show(<OneTimeCode code="R2VD-9HLC" expiresAt={NOW + 900_000} />);
  expect(code().textContent).toBe("R2VD-9HLC");
  expect(copyButton()!.textContent).toBe("Copy code");
  expect(page.icon("Check")).toBeNull();
  expect(expiry()!.textContent).toBe("expires in 15:00");
  mocks.copy.mockRejectedValue(new Error("denied"));
  await page.press(copyButton());
  expect(page.container.querySelector("[role='alert']")).not.toBeNull();
  await page.show(<OneTimeCode code="W8NB-3JQF" expiresAt={NOW + 900_000} />);
  expect(page.container.querySelector("[role='alert']")).toBeNull();
  expect(copyButton()!.textContent).toBe("Copy code");
  mocks.copy.mockResolvedValue(true);
  await page.press(copyButton());
  expect(mocks.copy).toHaveBeenLastCalledWith("W8NB-3JQF");
  expect(copyButton()!.textContent).toBe("Copied");
});

it("keeps a code that is no longer good in view, struck through, with nothing to copy or count", async () => {
  const expired = vi.fn();
  await page.show(<OneTimeCode code="K7QM-4TXP" expiresAt={NOW + 600_000} spent onExpired={expired} />);
  expect(code().textContent).toBe("K7QM-4TXP");
  expect(page.styleOf(code())).toMatchObject({ textDecorationLine: "line-through", color: "#7a6a70" });
  expect(code().getAttribute("aria-label")).toBe("One-time code: K 7 Q M - 4 T X P, no longer valid");
  expect(expiry()).toBeNull();
  expect(copyButton()).toBeNull();
  await pass(700_000);
  expect(expired).not.toHaveBeenCalled();
});

it("shows no countdown for a code that was given no deadline", async () => {
  await page.show(<OneTimeCode code="K7QM-4TXP" />);
  expect(expiry()).toBeNull();
  expect(copyButton()).not.toBeNull();
  expect(page.styleOf(code()).textDecorationLine).toBeUndefined();
});

it("takes the light palette", async () => {
  appearance.scheme = "light";
  await page.show(<OneTimeCode code="K7QM-4TXP" expiresAt={NOW + 60_000} />);
  expect(page.styleOf(code())).toMatchObject({ color: "#29282b", backgroundColor: "#f2f0ec", borderColor: "#706d7035" });
  expect(page.styleOf(expiry()).color).toBe("#706d70");
});
