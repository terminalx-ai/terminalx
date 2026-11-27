import { beforeEach, describe, expect, it, vi } from "vitest";
import { readNativeNotificationData } from "./native-data";
import { intentOf } from "../notification-actions";
import {
  resetCloudPushRegistrationForTests,
  syncCloudPushRegistration,
  unregisterCloudPushRegistration,
} from "./cloud-push";
import type { CloudSession } from "../auth/protocol";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

vi.mock("expo-notifications", () => ({
  setNotificationCategoryAsync: vi.fn(),
  getDevicePushTokenAsync: vi.fn(),
  addPushTokenListener: vi.fn(),
}));

vi.mock("../pairing/installation", () => ({
  loadOrCreateInstallation: vi.fn(),
  readInstallation: vi.fn(),
}));

vi.mock("./store", () => ({
  loadNotificationSettings: vi.fn(async () => ({ allow: true })),
}));

const SESSION: CloudSession = {
  accessToken: "mobile-access-token",
  refreshToken: "mobile-refresh-token",
  expiresAt: Date.now() + 3_600_000,
  user: { userId: "user-1", email: "dev@terminalx.ai" },
};

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);

describe("readNativeNotificationData & intentOf remote push routing", () => {
  it("reads Expo iOS APNs custom fields from trigger.payload and maps paneKey to tabId", () => {
    const data = readNativeNotificationData({
      content: { data: null },
      trigger: {
        type: "push",
        payload: {
          aps: { alert: { title: "Approval needed" } },
          hostId: "relayHash1234567",
          relayHostId: "relayHash1234567",
          sessionId: "sess-42",
          paneKey: "tab-7",
          eventKind: "approval",
        },
      },
    });
    expect(intentOf("expo.modules.notifications.actions.DEFAULT", data, null)).toEqual({
      type: "open",
      hostId: "relayHash1234567",
      sessionId: "sess-42",
      tabId: "tab-7",
    });
  });

  it("does not shadow content.data with an empty trigger.payload and supports host-only openHost", () => {
    const data = readNativeNotificationData({
      content: { data: { hostId: "relayHash1234567", eventKind: "alert" } },
      trigger: { type: "push", payload: {} },
    });
    expect(intentOf("expo.modules.notifications.actions.DEFAULT", data, null)).toEqual({
      type: "openHost",
      hostId: "relayHash1234567",
    });
  });
});

describe("cloud push registration", () => {
  beforeEach(() => {
    resetCloudPushRegistrationForTests();
  });

  it("registers iOS token with apnsEnvironment, caches identical registrations, and re-registers on rotation", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ id: "tok-1" }), { status: 200 })
    ) as unknown as typeof fetch;

    const ok1 = await syncCloudPushRegistration({
      session: SESSION,
      sessionEndpoint: "https://login.terminalx.ai/v1/auth/session",
      platform: "ios",
      apnsEnvironment: "sandbox",
      fetchImpl,
      isAllowed: async () => true,
      getPermission: async () => "granted",
      getDevicePushToken: async () => TOKEN_A,
      getInstallationId: async () => "inst-uuid-1",
    });
    expect(ok1).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://login.terminalx.ai/v1/mobile/push/register",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer mobile-access-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          relayDeviceId: "inst-uuid-1",
          platform: "ios",
          pushToken: TOKEN_A,
          apnsEnvironment: "sandbox",
        }),
      })
    );

    // Cached repeat does not re-POST
    const ok2 = await syncCloudPushRegistration({
      session: SESSION,
      sessionEndpoint: "https://login.terminalx.ai/v1/auth/session",
      platform: "ios",
      apnsEnvironment: "sandbox",
      fetchImpl,
      isAllowed: async () => true,
      getPermission: async () => "granted",
      getDevicePushToken: async () => TOKEN_A,
      getInstallationId: async () => "inst-uuid-1",
    });
    expect(ok2).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Rotated token triggers a new POST
    const ok3 = await syncCloudPushRegistration({
      session: SESSION,
      tokenOverride: TOKEN_B,
      sessionEndpoint: "https://login.terminalx.ai/v1/auth/session",
      platform: "ios",
      apnsEnvironment: "sandbox",
      fetchImpl,
      isAllowed: async () => true,
      getPermission: async () => "granted",
      getInstallationId: async () => "inst-uuid-1",
    });
    expect(ok3).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("skips registration when OS permission is denied or master toggle is off", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    expect(
      await syncCloudPushRegistration({
        session: SESSION,
        sessionEndpoint: "https://login.terminalx.ai/v1/auth/session",
        platform: "android",
        fetchImpl,
        isAllowed: async () => true,
        getPermission: async () => "denied",
        getDevicePushToken: async () => TOKEN_A,
        getInstallationId: async () => "inst-uuid-1",
      })
    ).toBe(false);

    expect(
      await syncCloudPushRegistration({
        session: SESSION,
        sessionEndpoint: "https://login.terminalx.ai/v1/auth/session",
        platform: "android",
        fetchImpl,
        isAllowed: async () => false,
        getPermission: async () => "granted",
        getDevicePushToken: async () => TOKEN_A,
        getInstallationId: async () => "inst-uuid-1",
      })
    ).toBe(false);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fences an in-flight sync when sign-out unregisters before POST can land", async () => {
    let releaseTokenLookup: ((token: string) => void) | null = null;
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      methods.push(String(init?.method ?? "GET"));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const syncPromise = syncCloudPushRegistration({
      session: SESSION,
      sessionEndpoint: "https://login.terminalx.ai/v1/auth/session",
      platform: "ios",
      fetchImpl,
      isAllowed: async () => true,
      getPermission: async () => "granted",
      getDevicePushToken: () =>
        new Promise<string>((resolve) => {
          releaseTokenLookup = resolve;
        }),
      getInstallationId: async () => "inst-uuid-1",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    const unregisterPromise = unregisterCloudPushRegistration({
      session: SESSION,
      sessionEndpoint: "https://login.terminalx.ai/v1/auth/session",
      platform: "ios",
      fetchImpl,
      readInstallationId: async () => "inst-uuid-1",
    });

    releaseTokenLookup!(TOKEN_A);
    const [syncResult, unregisterResult] = await Promise.all([syncPromise, unregisterPromise]);

    expect(syncResult).toBe(false);
    expect(unregisterResult).toBe(true);
    expect(methods).toEqual(["DELETE"]);
  });
});
