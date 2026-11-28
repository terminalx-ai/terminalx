import { Platform } from "react-native";
import { AUTH_CONFIG, type CloudSession } from "../auth/protocol";
import { loadOrCreateInstallation, readInstallation } from "../pairing/installation";
import type { PermissionState } from "./permissions";
import { loadNotificationSettings } from "./store";

export type CloudPushPlatform = "ios" | "android";
export type CloudApnsEnvironment = "production" | "sandbox";

const PUSH_REGISTER_PATH = "/v1/mobile/push/register";
const PUSH_REQUEST_TIMEOUT_MS = 10_000;

let lastRegisteredKey: string | null = null;
let syncEpoch = 0;
let pendingUnregister: Promise<unknown> | null = null;
const activeSyncPromises = new Set<Promise<unknown>>();
const activeSyncControllers = new Set<AbortController>();

export function resolveCloudPushOrigin(sessionEndpoint: string = AUTH_CONFIG.sessionEndpoint): string | null {
  try {
    return new URL(sessionEndpoint).origin;
  } catch {
    return null;
  }
}

export function resolveCloudPushPlatform(os?: string): CloudPushPlatform | null {
  let resolved = os;
  if (resolved === undefined) {
    try {
      resolved = Platform?.OS;
    } catch {
      return null;
    }
  }
  if (resolved === "ios" || resolved === "android") return resolved;
  return null;
}

export function resolveApnsEnvironment(): CloudApnsEnvironment {
  return typeof __DEV__ !== "undefined" && __DEV__ ? "sandbox" : "production";
}

function registerUrl(origin: string): string {
  return new URL(PUSH_REGISTER_PATH, `${origin.replace(/\/+$/, "")}/`).toString();
}

export async function registerCloudPushToken(params: {
  origin: string;
  accessToken: string;
  relayDeviceId: string;
  platform: CloudPushPlatform;
  pushToken: string;
  apnsEnvironment?: CloudApnsEnvironment;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<boolean> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (params.signal) {
    if (params.signal.aborted) return false;
    params.signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), PUSH_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(registerUrl(params.origin), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        relayDeviceId: params.relayDeviceId,
        platform: params.platform,
        pushToken: params.pushToken,
        ...(params.platform === "ios" && params.apnsEnvironment ? { apnsEnvironment: params.apnsEnvironment } : {}),
      }),
      redirect: "error",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    params.signal?.removeEventListener("abort", onExternalAbort);
  }
}

export async function unregisterCloudPushToken(params: {
  origin: string;
  accessToken: string;
  relayDeviceId: string;
  platform?: CloudPushPlatform;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(registerUrl(params.origin), {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        relayDeviceId: params.relayDeviceId,
        ...(params.platform ? { platform: params.platform } : {}),
      }),
      redirect: "error",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function syncCloudPushRegistration(options: {
  session: CloudSession;
  tokenOverride?: string;
  sessionEndpoint?: string;
  platform?: CloudPushPlatform | null;
  apnsEnvironment?: CloudApnsEnvironment;
  fetchImpl?: typeof fetch;
  isAllowed?: () => Promise<boolean>;
  getPermission?: () => Promise<PermissionState>;
  getDevicePushToken?: () => Promise<string | null>;
  getInstallationId?: (userId: string) => Promise<string | null>;
}): Promise<boolean> {
  const epoch = syncEpoch;
  const controller = new AbortController();
  activeSyncControllers.add(controller);

  const run = (async (): Promise<boolean> => {
    if (pendingUnregister) {
      await pendingUnregister.catch(() => undefined);
      if (epoch !== syncEpoch) return false;
    }

    const platform = options.platform !== undefined ? options.platform : resolveCloudPushPlatform();
    if (!platform) return false;

    const origin = resolveCloudPushOrigin(options.sessionEndpoint);
    if (!origin) return false;

    const allowed = await (
      options.isAllowed ??
      (async () => (await loadNotificationSettings()).allow)
    )().catch(() => false);
    if (epoch !== syncEpoch || !allowed) return false;

    const permission = await (
      options.getPermission ??
      (async () => {
        const mod = await import("./permissions");
        return mod.notificationPermission();
      })
    )().catch(() => "denied" as const);
    if (epoch !== syncEpoch || permission !== "granted") return false;

    let pushToken = options.tokenOverride?.trim() || null;
    if (!pushToken) {
      if (options.getDevicePushToken) {
        pushToken = await options.getDevicePushToken().catch(() => null);
      } else {
        const Notifications = await import("expo-notifications").catch(() => null);
        const nativeToken = Notifications
          ? await Notifications.getDevicePushTokenAsync().catch(() => null)
          : null;
        pushToken =
          nativeToken && typeof nativeToken.data === "string" && nativeToken.data.trim().length > 0
            ? nativeToken.data.trim()
            : null;
      }
    }
    if (epoch !== syncEpoch || !pushToken) return false;

    const relayDeviceId = await (
      options.getInstallationId ??
      (async (userId: string) => (await loadOrCreateInstallation(userId)).clientInstallationId)
    )(options.session.user.userId).catch(() => null);
    if (epoch !== syncEpoch || !relayDeviceId) return false;

    const apnsEnvironment =
      platform === "ios" ? (options.apnsEnvironment ?? resolveApnsEnvironment()) : undefined;
    const cacheKey = `${options.session.user.userId}:${relayDeviceId}:${platform}:${apnsEnvironment ?? ""}:${pushToken}`;
    if (lastRegisteredKey === cacheKey) return true;

    const ok = await registerCloudPushToken({
      origin,
      accessToken: options.session.accessToken,
      relayDeviceId,
      platform,
      pushToken,
      apnsEnvironment,
      fetchImpl: options.fetchImpl,
      signal: controller.signal,
    });
    if (ok && epoch === syncEpoch) lastRegisteredKey = cacheKey;
    return ok && epoch === syncEpoch;
  })();

  activeSyncPromises.add(run);
  try {
    return await run;
  } finally {
    activeSyncPromises.delete(run);
    activeSyncControllers.delete(controller);
  }
}

export async function unregisterCloudPushRegistration(options: {
  session: CloudSession;
  remote?: boolean;
  sessionEndpoint?: string;
  platform?: CloudPushPlatform | null;
  fetchImpl?: typeof fetch;
  readInstallationId?: (userId: string) => Promise<string | null>;
}): Promise<boolean> {
  const run = (async (): Promise<boolean> => {
    syncEpoch += 1;
    lastRegisteredKey = null;
    for (const controller of activeSyncControllers) controller.abort();
    if (activeSyncPromises.size > 0) await Promise.allSettled(Array.from(activeSyncPromises));

    if (options.remote === false) return true;

    const platform = options.platform !== undefined ? options.platform : resolveCloudPushPlatform();
    const origin = resolveCloudPushOrigin(options.sessionEndpoint);
    if (!origin) return false;

    const relayDeviceId = await (
      options.readInstallationId ??
      (async (userId: string) => {
        const existing = await readInstallation();
        return existing?.userId === userId ? existing.clientInstallationId : null;
      })
    )(options.session.user.userId).catch(() => null);
    if (!relayDeviceId) return false;

    return unregisterCloudPushToken({
      origin,
      accessToken: options.session.accessToken,
      relayDeviceId,
      ...(platform ? { platform } : {}),
      fetchImpl: options.fetchImpl,
    });
  })();

  pendingUnregister = run;
  try {
    return await run;
  } finally {
    if (pendingUnregister === run) pendingUnregister = null;
  }
}

export function subscribeCloudPushTokenRotation(onToken: (token: string) => void): () => void {
  let disposed = false;
  let sub: { remove: () => void } | null = null;

  void import("expo-notifications")
    .then((Notifications) => {
      if (disposed || typeof Notifications.addPushTokenListener !== "function") return;
      sub = Notifications.addPushTokenListener((event) => {
        if (typeof event?.data === "string" && event.data.trim().length > 0) {
          onToken(event.data.trim());
        }
      });
    })
    .catch(() => undefined);

  return () => {
    disposed = true;
    sub?.remove();
  };
}

export function resetCloudPushRegistrationForTests(): void {
  syncEpoch += 1;
  lastRegisteredKey = null;
  pendingUnregister = null;
  for (const controller of activeSyncControllers) controller.abort();
  activeSyncControllers.clear();
  activeSyncPromises.clear();
}
