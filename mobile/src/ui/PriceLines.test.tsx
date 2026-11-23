// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clockText } from "./countdown";
import { PriceLines, priceText } from "./PriceLines";
import { appearance, stage } from "./testing/kit";

// PRO-542: a quote's price and how long it holds (25.05).
vi.mock("react-native", () => import("@mobile/ui/testing/native"));
vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()));
vi.mock("lucide-react-native", async () => (await import("@mobile/ui/testing/kit")).namedIcons());

const page = stage();
const NOW = Date.UTC(2026, 10, 23, 10, 25, 0);
const quote = (more: Partial<{ activeHourlyMicros: number; alwaysOnThirtyDayMicros: number; currency: string; expiresAt: number }> = {}) => ({ activeHourlyMicros: 18_000, alwaysOnThirtyDayMicros: 12_960_000, currency: "USD", expiresAt: NOW + 278_000, ...more });
const NOTE = "Per second, billed by Boat. Prices are estimates, in US dollars.";
const rows = () => [...page.byId("price")!.firstElementChild!.children] as HTMLElement[];
const holds = () => page.byId("price-holds");
const pass = (milliseconds: number) => act(async () => { vi.advanceTimersByTime(milliseconds); });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

it("writes an amount from its millionths: two places, and three below one unit", () => {
  const money = (amount: number, digits: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount);
  expect(priceText(18_000, "USD")).toBe(money(0.018, 3));
  expect(priceText(20_000, "USD")).toBe(money(0.02, 3));
  expect(priceText(12_960_000, "USD")).toBe(money(12.96, 2));
  expect(priceText(14_400_000, "USD")).toBe(money(14.4, 2));
  expect(priceText(0, "USD")).toBe(money(0, 3));
  expect(priceText(18_000, "USD")).toContain("0.018");
  expect(priceText(12_960_000, "USD")).toContain("12.96");
  expect(priceText(17_500_000, "EUR")).toContain("17.50");
});

it("writes the number beside the code for a currency the phone cannot format", () => {
  expect(priceText(18_000, "not a currency")).toBe("0.018 not a currency");
  expect(priceText(12_960_000, "")).toBe("12.96 ");
});

it("writes time left as minutes and seconds", () => {
  expect(clockText(278_000)).toBe("4:38");
  expect(clockText(892_000)).toBe("14:52");
  expect(clockText(7_000)).toBe("0:07");
  expect(clockText(400)).toBe("0:01");
  expect(clockText(0)).toBe("0:00");
  expect(clockText(-5_000)).toBe("0:00");
});

it("draws the two prices from the quote, then who bills and how long the price holds", async () => {
  await page.show(<PriceLines testID="price" quote={quote()} note={NOTE} />);
  expect(rows()).toHaveLength(2);
  expect(rows()[0].textContent).toBe(`Per active hour${priceText(18_000, "USD")}`);
  expect(rows()[1].textContent).toBe(`Always on, 30 days${priceText(12_960_000, "USD")}`);
  expect(page.styleOf(page.byText("Per active hour"))).toMatchObject({ fontSize: 15, color: "#ab9aa0" });
  expect(page.styleOf(page.byText(priceText(18_000, "USD")))).toMatchObject({ fontWeight: "600", color: "#f4ecee", fontVariant: ["tabular-nums"] });
  expect(page.styleOf(rows()[0]).borderTopWidth).toBeUndefined();
  expect(page.styleOf(rows()[1])).toMatchObject({ borderTopWidth: 1, borderTopColor: "#ffffff1a" });
  expect(holds()!.textContent).toBe(`${NOTE} This price holds for 4:38.`);
  expect(page.styleOf(holds())).toMatchObject({ fontSize: 13, lineHeight: 18, color: "#ab9aa0" });
  expect(rows()[0].getAttribute("aria-label")).toBe(`Per active hour: ${priceText(18_000, "USD")}`);
});

it("counts the hold down, then dims the figures and says once that the price ran out", async () => {
  const expired = vi.fn();
  await page.show(<PriceLines testID="price" quote={quote({ expiresAt: NOW + 2_000 })} onExpired={expired} />);
  expect(holds()!.textContent).toBe("This price holds for 0:02.");
  await pass(1_000);
  expect(holds()!.textContent).toBe("This price holds for 0:01.");
  expect(page.styleOf(rows()[0]).opacity).toBeUndefined();
  expect(expired).not.toHaveBeenCalled();
  await pass(1_000);
  expect(expired).toHaveBeenCalledTimes(1);
  expect(holds()).toBeNull();
  expect(page.styleOf(rows()[0]).opacity).toBe(0.45);
  expect(page.styleOf(rows()[1]).opacity).toBe(0.45);
  // The figures stay: what the price was is still shown.
  expect(rows()[0].textContent).toContain(priceText(18_000, "USD"));
  expect(rows()[0].getAttribute("aria-label")).toBe(`Per active hour: ${priceText(18_000, "USD")}, expired`);
  await pass(10_000);
  expect(expired).toHaveBeenCalledTimes(1);
});

it("treats a quote that had already run out as expired from the first frame", async () => {
  const expired = vi.fn();
  await page.show(<PriceLines testID="price" quote={quote({ expiresAt: NOW - 1 })} onExpired={expired} />);
  expect(holds()).toBeNull();
  expect(page.styleOf(rows()[0]).opacity).toBe(0.45);
  expect(expired).toHaveBeenCalledTimes(1);
});

it("starts over with a new quote: the new figures, undimmed, counting from now", async () => {
  const expired = vi.fn();
  await page.show(<PriceLines testID="price" quote={quote({ expiresAt: NOW + 1_000 })} onExpired={expired} />);
  await pass(60_000);
  expect(expired).toHaveBeenCalledTimes(1);
  await page.show(<PriceLines testID="price" quote={quote({ activeHourlyMicros: 20_000, alwaysOnThirtyDayMicros: 14_400_000, expiresAt: Date.now() + 295_000 })} onExpired={expired} />);
  await pass(0);
  expect(rows()[0].textContent).toContain(priceText(20_000, "USD"));
  expect(rows()[1].textContent).toContain(priceText(14_400_000, "USD"));
  expect(page.styleOf(rows()[0]).opacity).toBeUndefined();
  expect(holds()!.textContent).toBe("This price holds for 4:55.");
  expect(expired).toHaveBeenCalledTimes(1);
});

it("takes the light palette", async () => {
  appearance.scheme = "light";
  await page.show(<PriceLines testID="price" quote={quote()} note={NOTE} />);
  expect(page.styleOf(page.byId("price")!.firstElementChild).backgroundColor).toBe("#ffffff");
  expect(page.styleOf(page.byText("Per active hour")).color).toBe("#706d70");
  expect(page.styleOf(page.byText(priceText(18_000, "USD"))).color).toBe("#29282b");
  expect(page.styleOf(holds()).color).toBe("#706d70");
});
