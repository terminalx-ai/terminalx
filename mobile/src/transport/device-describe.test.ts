import { describe, expect, it, vi } from "vitest";
import { cleanDeviceLabel, describeDevice, deviceDescriptionFrom } from "./device-describe";

describe("the phone's name for the Mac", () => {
  it.each([
    ["ios", { interfaceIdiom: "phone" }, { label: "iPhone", platform: "ios" }],
    ["ios", { interfaceIdiom: "pad" }, { label: "iPad", platform: "ios" }],
    ["android", { Manufacturer: "Google", Model: "Pixel 8" }, { label: "Google Pixel 8", platform: "android" }],
    ["android", { Manufacturer: "samsung", Model: "SM-S921B" }, { label: "Samsung SM-S921B", platform: "android" }],
    ["android", { Manufacturer: "OnePlus", Model: "OnePlus 12" }, { label: "OnePlus 12", platform: "android" }],
    ["android", {}, { label: "Android phone", platform: "android" }],
    ["web", {}, null],
  ])("%s %j → %j", (os, constants, expected) => {
    expect(deviceDescriptionFrom(os, constants)).toEqual(expected);
  });

  it.each([
    ["android", { Manufacturer: "Google", Model: "Pixel 8" }, "Sam’s Pixel", { label: "Sam’s Pixel", platform: "android" }],
    ["ios", { interfaceIdiom: "phone" }, "iPhone", { label: "iPhone", platform: "ios" }],
    ["android", { Manufacturer: "Google", Model: "Pixel 8" }, " \u0000 ", { label: "Google Pixel 8", platform: "android" }],
    ["ios", { interfaceIdiom: "pad" }, null, { label: "iPad", platform: "ios" }],
    ["web", {}, "Browser", null],
  ])("prefers the platform's device name: %s %j %j → %j", (os, constants, deviceName, expected) => {
    expect(deviceDescriptionFrom(os, constants, deviceName)).toEqual(expected);
  });

  it("keeps a long device name to 64 characters", () => {
    expect(deviceDescriptionFrom("android", {}, "P".repeat(100))?.label).toHaveLength(64);
  });

  it("strips control characters and keeps at most 64 characters", () => {
    expect(cleanDeviceLabel("  Pixel\u0000\n8  ")).toBe("Pixel 8");
    expect(cleanDeviceLabel("x".repeat(80))).toHaveLength(64);
    expect(cleanDeviceLabel("\u0007")).toBeNull();
  });

  it("calls device.describe and ignores a refusal or a failure", async () => {
    const description = { label: "iPhone", platform: "ios" as const };
    const refused = { request: vi.fn(async () => ({ ok: false as const, refusal: { code: "forbidden", message: "not available" } })) };
    await expect(describeDevice(refused as never, description)).resolves.toBe(false);
    expect(refused.request).toHaveBeenCalledWith("device.describe", description, 10_000);
    await expect(describeDevice({ request: async () => { throw new Error("Relay connection unavailable"); } }, description)).resolves.toBe(false);
    await expect(describeDevice({ request: async () => ({ ok: true as const, value: { ok: true } }) } as never, description)).resolves.toBe(true);
    const unused = { request: vi.fn() };
    await expect(describeDevice(unused as never, null)).resolves.toBe(false);
    expect(unused.request).not.toHaveBeenCalled();
  });
});
