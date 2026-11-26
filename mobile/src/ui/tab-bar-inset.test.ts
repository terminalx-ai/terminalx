import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
const { newSessionInBar, tabBarHeight } = await import("./tab-bar-inset");

describe("the tab bar's room at a tab's foot", () => {
  it("leaves room on iOS, where the bar floats over the content", () => {
    expect(tabBarHeight(34, "ios")).toBe(96);
    expect(tabBarHeight(0, "ios")).toBe(74);
  });

  it("leaves none on Android, where each tab is laid out above its bar", () => {
    expect(tabBarHeight(48, "android")).toBe(0);
  });
});

describe("New session in the bar", () => {
  it("is in the bar on iOS, and on Android is on the Sessions page, the bar holding five at most", () => {
    expect(newSessionInBar("ios")).toBe(true);
    expect(newSessionInBar("android")).toBe(false);
  });
});
