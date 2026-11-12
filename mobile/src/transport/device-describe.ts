import type { RpcCallResult } from "@terminalx/portable/rpc";

/** What the Mac shows for this phone in its paired devices (docs/PAIRING-APPROVAL.md § "Phone name"). */
export type DeviceDescription = { label: string; platform: "ios" | "android" };

const MAX_LABEL = 64;

/**
 * This phone's name and platform. `deviceName` is the platform's device name
 * (expo-constants `Constants.deviceName`): on Android the name the person gave
 * the phone ("Sam's Pixel"); on iOS 16 and later only the model family
 * ("iPhone") without a special entitlement. Without it, the name comes from
 * React Native's `Platform` (`OS` and `constants`): the model family on iOS,
 * the maker and model on Android ("Google Pixel 8"). Null on any other platform.
 */
export function deviceDescriptionFrom(os: string, constants: unknown, deviceName?: unknown): DeviceDescription | null {
  const values = (constants && typeof constants === "object" ? constants : {}) as Record<string, unknown>;
  if (os !== "ios" && os !== "android") return null;
  const named = cleanDeviceLabel(text(deviceName));
  if (named) return { label: named, platform: os };
  if (os === "ios") return { label: values.interfaceIdiom === "pad" ? "iPad" : "iPhone", platform: "ios" };
  const maker = text(values.Manufacturer) || text(values.Brand);
  const model = text(values.Model);
  const name = model && maker && !model.toLowerCase().startsWith(maker.toLowerCase()) ? `${capitalize(maker)} ${model}` : model || capitalize(maker);
  return { label: cleanDeviceLabel(name) ?? "Android phone", platform: "android" };
}

/** Control characters stripped, whitespace collapsed, at most 64 characters; null when nothing is left. */
export function cleanDeviceLabel(value: string): string | null {
  const cleaned = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, MAX_LABEL).join("").trim();
}

/**
 * Tell the Mac this phone's name and platform. A Mac without
 * `device.describe` refuses it; a refusal or a failure changes nothing, and
 * the connection carries on as before. True when the Mac took it.
 */
export async function describeDevice(
  client: { request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<RpcCallResult<T>> },
  description: DeviceDescription | null | undefined,
): Promise<boolean> {
  if (!description) return false;
  const result = await client.request<unknown>("device.describe", description, 10_000).catch(() => null);
  return !!result?.ok;
}

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const capitalize = (value: string) => value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
