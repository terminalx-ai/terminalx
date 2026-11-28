import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

import { CloudApi } from "../cloud/api";
import { registerCloudPushToken, unregisterCloudPushToken } from "../notifications/cloud-push";
import { canonicalHttpsOrigin, canonicalRelayCellUrl, DirectEndpointsSchema, isLanOrPrivateHost } from "../pairing/contracts";
import { LAN_NETWORK_SECURITY_CONFIG_XML, stripDevUrlSchemes } from "../../plugins/security-hardening.js";

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("S-46: redirect:'error', strict relay/direct URL schemas, and Android cleartext restriction", () => {
  it("sets redirect:'error' on CloudApi.request bearer-token fetches", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ organizations: [] }), { status: 200 }));
    const api = new CloudApi({
      origin: "https://api.terminalx.ai",
      accessToken: async () => "secret-bearer-token",
      fetch: fetcher as unknown as typeof fetch,
    });
    await api.organizations();
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("https://api.terminalx.ai/"),
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("sets redirect:'error' on cloud push register and unregister fetches", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 200 }));
    await registerCloudPushToken({
      origin: "https://api.terminalx.ai",
      accessToken: "secret-bearer",
      relayDeviceId: "dev-1",
      platform: "ios",
      pushToken: "apns-tok",
      fetchImpl: fetcher as unknown as typeof fetch,
    });
    await unregisterCloudPushToken({
      origin: "https://api.terminalx.ai",
      accessToken: "secret-bearer",
      relayDeviceId: "dev-1",
      platform: "ios",
      fetchImpl: fetcher as unknown as typeof fetch,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ redirect: "error" });
    }
  });

  it("requires https:/wss: origins for relay URLs and rejects insecure/non-HTTP schemes", () => {
    expect(canonicalHttpsOrigin("https://relay.terminalx.ai")).toBe(true);
    expect(canonicalHttpsOrigin("http://relay.terminalx.ai")).toBe(false);
    expect(canonicalHttpsOrigin("javascript:alert(1)")).toBe(false);
    expect(canonicalHttpsOrigin("https://user:pass@relay.terminalx.ai")).toBe(false);

    expect(canonicalRelayCellUrl("https://cell-1.relay.terminalx.ai")).toBe(true);
    expect(canonicalRelayCellUrl("wss://cell-1.relay.terminalx.ai")).toBe(true);
    expect(canonicalRelayCellUrl("http://cell-1.relay.terminalx.ai")).toBe(false);
    expect(canonicalRelayCellUrl("ws://cell-1.relay.terminalx.ai")).toBe(false);
    expect(canonicalRelayCellUrl("file:///etc/passwd")).toBe(false);
  });

  it("allows ws: direct endpoints ONLY for RFC1918/RFC6598/loopback/link-local/ULA/.local hosts and requires wss: otherwise", () => {
    expect(isLanOrPrivateHost("192.168.1.5")).toBe(true);
    expect(isLanOrPrivateHost("10.0.0.4")).toBe(true);
    expect(isLanOrPrivateHost("172.16.0.1")).toBe(true);
    expect(isLanOrPrivateHost("172.31.255.254")).toBe(true);
    expect(isLanOrPrivateHost("100.64.0.9")).toBe(true);
    expect(isLanOrPrivateHost("127.0.0.1")).toBe(true);
    expect(isLanOrPrivateHost("localhost")).toBe(true);
    expect(isLanOrPrivateHost("mac.local")).toBe(true);
    expect(isLanOrPrivateHost("[::1]")).toBe(true);
    expect(isLanOrPrivateHost("[fe80::1]")).toBe(true);
    expect(isLanOrPrivateHost("[fd12:3456::1]")).toBe(true);

    expect(isLanOrPrivateHost("172.32.0.1")).toBe(false);
    expect(isLanOrPrivateHost("8.8.8.8")).toBe(false);
    expect(isLanOrPrivateHost("example.com")).toBe(false);
    expect(isLanOrPrivateHost("evil.test")).toBe(false);

    expect(DirectEndpointsSchema.safeParse(["ws://192.168.1.2:6768", "ws://mac.local:6768", "wss://remote.example.com:443"]).success).toBe(true);
    expect(DirectEndpointsSchema.safeParse(["ws://example.com:6768"]).success).toBe(false);
    expect(DirectEndpointsSchema.safeParse(["ws://8.8.8.8:6768"]).success).toBe(false);
    expect(DirectEndpointsSchema.safeParse(["http://192.168.1.2:6768"]).success).toBe(false);
  });

  it("disables global Android usesCleartextTraffic in app.json and restricts cleartext to local LAN/loopback in network_security_config.xml", () => {
    const appJson = JSON.parse(fs.readFileSync(path.join(mobileRoot, "app.json"), "utf8")) as {
      expo: { plugins: unknown[] };
    };
    const buildProps = appJson.expo.plugins.find((entry) => Array.isArray(entry) && entry[0] === "expo-build-properties") as [string, { android?: { usesCleartextTraffic?: boolean } }] | undefined;
    expect(buildProps?.[1]?.android?.usesCleartextTraffic).toBe(false);
    expect(LAN_NETWORK_SECURITY_CONFIG_XML).toContain('<base-config cleartextTrafficPermitted="false" />');
    expect(LAN_NETWORK_SECURITY_CONFIG_XML).toContain(">localhost</domain>");
    expect(LAN_NETWORK_SECURITY_CONFIG_XML).toContain(">127.0.0.1</domain>");
    expect(LAN_NETWORK_SECURITY_CONFIG_XML).toContain(">local</domain>");
  });
});

describe("S-57: simulator route hooks guarded behind __DEV__ and dev URL scheme stripped in production iOS builds", () => {
  it("strips exp+terminalx-mobile from CFBundleURLTypes while preserving terminalx", () => {
    const plist = {
      CFBundleURLTypes: [
        { CFBundleURLSchemes: ["terminalx", "exp+terminalx-mobile"] },
        { CFBundleURLSchemes: ["exp+other-dev"] },
      ],
    };
    const stripped = stripDevUrlSchemes(plist);
    expect(stripped.CFBundleURLTypes).toEqual([{ CFBundleURLSchemes: ["terminalx"] }]);
  });

  it("guards Settings.get('openRoute') and Settings.get('openWorkspace') behind __DEV__ in app/_layout.tsx and app/(tabs)/cloud.tsx", () => {
    const layoutSrc = fs.readFileSync(path.join(mobileRoot, "app/_layout.tsx"), "utf8");
    const cloudSrc = fs.readFileSync(path.join(mobileRoot, "app/(tabs)/cloud.tsx"), "utf8");
    expect(layoutSrc).toMatch(/typeof __DEV__ === "undefined" \|\| !__DEV__/);
    expect(cloudSrc).toMatch(/typeof __DEV__ !== "undefined" && __DEV__/);
    expect(cloudSrc).toMatch(/typeof __DEV__ === "undefined" \|\| !__DEV__/);
  });
});
