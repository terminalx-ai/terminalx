import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import type { CloudProviderDescriptor } from "../../api";
import { useRead } from "../read";
import { operationOpen } from "./launch";

/** How often an operation under way is asked about (25.05: every 3 seconds). */
export const OPERATION_POLL_MS = 3_000;

/** Whether this page is the one in front, and the app is in the foreground. */
export function useShown(): boolean {
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(() => AppState.currentState === "active" || AppState.currentState == null);
  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => setFocused(false);
  }, []));
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => setActive(state === "active"));
    return () => subscription.remove();
  }, []);
  return focused && active;
}

/**
 * One operation, read when the page opens, then every 3 seconds while it is
 * open (queued, running, being canceled) and the page is shown with the app
 * active; read at once on coming back. Before the first answer, `listedOpen`
 * (what the list says) decides. Once it has ended the list is read again, so
 * the rest of the app sees how it ended. With no operation there is nothing
 * to read.
 */
export function useOperation(catalog: { refresh(): Promise<void> } | null, orgId: string | null, operationId: string | null, listedOpen: boolean) {
  const read = useRead((api) => (orgId && operationId ? api.operation(orgId, operationId) : Promise.resolve(null)), [orgId, operationId]);
  const lifecycle = read.value && read.value.operation.id === operationId ? read.value : null;
  const open = lifecycle ? operationOpen(lifecycle.operation) : listedOpen;
  const shown = useShown();
  const { refresh } = read;
  useEffect(() => {
    if (!open || !shown || !orgId || !operationId) return;
    const timer = setInterval(() => void refresh(), OPERATION_POLL_MS);
    return () => clearInterval(timer);
  }, [open, shown, orgId, operationId, refresh]);
  // Coming back into view, or to the foreground, while it runs: read at once.
  const wasShown = useRef(shown);
  useEffect(() => {
    if (shown && !wasShown.current && open) void refresh();
    wasShown.current = shown;
  }, [shown, open, refresh]);
  // It ended while this page followed it: the list is read again.
  const followed = useRef(false);
  useEffect(() => {
    if (lifecycle && operationOpen(lifecycle.operation)) followed.current = true;
    else if (lifecycle && followed.current) { followed.current = false; void catalog?.refresh(); }
  }, [lifecycle, catalog]);
  return { lifecycle, open, reading: read.state === "reading", error: read.error, offline: !!read.error?.unreachable && open, refresh };
}

/** A provider as its descriptor describes it: its name and its own billing line. */
export type ProviderWords = Pick<CloudProviderDescriptor, "label" | "billing">;

/**
 * The workspace's provider as the server describes it. Until the providers
 * are read (or if they cannot be), the name the list gave the workspace, with
 * no billing line; null when neither says.
 */
export function useProvider(orgId: string | null, providerId: string | null, listedLabel: string | null | undefined): ProviderWords | null {
  const read = useRead((api) => (orgId ? api.providers(orgId) : Promise.resolve([])), [orgId]);
  const described = read.value?.find((provider) => provider.id === providerId)?.descriptor;
  if (described) return { label: described.label, billing: described.billing };
  return listedLabel ? { label: listedLabel, billing: "" } : null;
}
