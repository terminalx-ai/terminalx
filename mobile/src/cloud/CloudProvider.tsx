import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type PropsWithChildren } from "react";
import { readSession, refreshStoredSession } from "../auth/native";
import { AUTH_CONFIG } from "../auth/protocol";
import packageJson from "../../package.json";
import { useApp } from "../state/AppProvider";
import { forgetConversationState } from "../state/conversation-state";
import { CloudApi } from "./api";
import { CloudCatalog, type CatalogSnapshot, type CatalogStorage } from "./catalog";
import type { SecretStorage } from "./keys";

/**
 * The signed-in account's cloud catalog for the screens. One catalog per
 * signed-in person; when they sign out, or their session is rejected, every
 * workspace key, saved conversation and outbox is removed from the phone.
 */

const SECURE: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const secrets: SecretStorage = {
  get: (name) => SecureStore.getItemAsync(name, SECURE),
  set: (name, value) => SecureStore.setItemAsync(name, value, SECURE),
  delete: (name) => SecureStore.deleteItemAsync(name, SECURE),
};
const storage: CatalogStorage = {
  getItem: (name) => AsyncStorage.getItem(name),
  setItem: (name, value) => AsyncStorage.setItem(name, value),
  removeItem: (name) => AsyncStorage.removeItem(name),
  getAllKeys: () => AsyncStorage.getAllKeys(),
};

const INSTALLATION = "terminalx:cloud-installation:v1";
/** Whose cloud data this phone holds (a user id; not a secret). */
const OWNER = "terminalx:cloud-owner:v1";
/** A name for this phone's attachments. Not a secret, and not tied to the account. */
async function installationId(): Promise<string> {
  const existing = await AsyncStorage.getItem(INSTALLATION).catch(() => null);
  if (existing && /^[A-Za-z0-9._:-]{1,128}$/.test(existing)) return existing;
  const created = `mobile-${Crypto.randomUUID()}`;
  await AsyncStorage.setItem(INSTALLATION, created).catch(() => undefined);
  return created;
}

const APP_VERSION: string = packageJson.version;
const EMPTY: CatalogSnapshot = { organizations: [], loading: false, error: null, refreshedAt: null };
const CloudContext = createContext<CloudCatalog | null>(null);

export function CloudProvider({ children }: PropsWithChildren) {
  const app = useApp();
  const userId = app.session?.user.userId ?? null;
  const [catalog, setCatalog] = useState<CloudCatalog | null>(null);

  useEffect(() => {
    if (!app.ready) return;
    let current = true;
    let made: CloudCatalog | null = null;
    void (async () => {
      const clientInstallationId = await installationId();
      const api = new CloudApi({
        origin: new URL(AUTH_CONFIG.sessionEndpoint).origin,
        accessToken: async () => {
          // The stored session is the current one, also after a refresh elsewhere.
          const held = await readSession();
          if (!held || held.user.userId !== userId) return null;
          const outcome = await refreshStoredSession(held);
          return outcome.status === "rejected" ? null : outcome.session.accessToken;
        },
      });
      const create = () => new CloudCatalog({ api, secrets, storage, clientInstallationId, appVersion: APP_VERSION });
      // What is kept belongs to the person who was signed in when it was kept.
      // Signed out (now, or while the app was closed), or someone else signed
      // in: nothing of the cloud stays on the phone.
      const owner = await AsyncStorage.getItem(OWNER).catch(() => null);
      if (owner !== userId) {
        await create().signOut();
        // Drafts written by the person before are not shown to the next.
        forgetConversationState("cloud:");
        if (userId) await AsyncStorage.setItem(OWNER, userId).catch(() => undefined);
        else await AsyncStorage.removeItem(OWNER).catch(() => undefined);
      }
      if (!current || !userId) return;
      made = create();
      setCatalog(made);
      void made.refresh();
    })();
    return () => {
      current = false;
      setCatalog(null);
      // Connections are let go; what is kept is removed only by the check above.
      made?.close();
    };
  }, [app.ready, userId]);

  useEffect(() => {
    if (!catalog) return;
    // In the background nothing stays attached: an attached phone counts as
    // activity and would keep a workspace from idling in someone's pocket.
    // Coming back connects again and reads the list; a read never starts compute.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") catalog.pause();
      else if (state === "active") {
        catalog.resume();
        void catalog.refresh();
      }
    });
    return () => subscription.remove();
  }, [catalog]);

  return <CloudContext.Provider value={catalog}>{children}</CloudContext.Provider>;
}

/** The catalog, or null while signed out. */
export function useCloudCatalog(): CloudCatalog | null {
  return useContext(CloudContext);
}

const noop = () => () => undefined;
export function useCatalogSnapshot(catalog: CloudCatalog | null): CatalogSnapshot {
  return useSyncExternalStore(catalog?.subscribe ?? noop, catalog?.getSnapshot ?? (() => EMPTY), catalog?.getSnapshot ?? (() => EMPTY));
}
