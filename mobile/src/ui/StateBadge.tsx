import { StyleSheet, Text, View } from "react-native";
import type { CloudProvider } from "@mobile/cloud/api";
import { useTheme } from "./theme";

/** What a provider or an agent login can be said to be, in one small pill. */
export type BadgeState = "connected" | "not-connected" | "attention-required" | "sign-in-required" | "revoked" | "ready" | "available" | "not-offered";

const WORDS: Record<BadgeState, string> = {
  connected: "Connected",
  "not-connected": "Not connected",
  "attention-required": "Needs attention",
  "sign-in-required": "Sign-in required",
  revoked: "Revoked",
  ready: "Ready to use",
  available: "Available",
  "not-offered": "Not offered",
};
type Tone = "success" | "warning" | "danger" | "muted";
const TONES: Record<BadgeState, Tone> = {
  connected: "success",
  ready: "success",
  available: "success",
  "attention-required": "danger",
  "sign-in-required": "warning",
  "not-connected": "muted",
  revoked: "muted",
  "not-offered": "muted",
};

export const badgeLabel = (state: BadgeState): string => WORDS[state];

/** The small state pill of 25.03 and 25.04: green when it works, amber or red when it needs someone, grey at rest. */
export function StateBadge({ state, testID }: { state: BadgeState; testID?: string }) {
  const { palette } = useTheme();
  const tone = TONES[state];
  const color = tone === "success" ? palette.success : tone === "warning" ? palette.warning : tone === "danger" ? palette.danger : palette.muted;
  return <View testID={testID} style={[styles.pill, { backgroundColor: tone === "muted" ? palette.raised : `${color}24` }]}>
    <Text style={[styles.text, { color }]}>{WORDS[state]}</Text>
  </View>;
}

/**
 * The pill for a provider as the server lists it for this person. Someone who
 * manages compute is told whether it is connected; a provider with nothing to
 * connect is ready. A member is told only whether it can be used. An
 * availability this app does not know gets no pill rather than a guess.
 */
export function providerBadge(provider: Pick<CloudProvider, "availability" | "canManage"> & { descriptor: Pick<CloudProvider["descriptor"], "credentialFields"> }): BadgeState | null {
  switch (provider.availability) {
    case "attention-required": return "attention-required";
    case "not-connected": return "not-connected";
    case "disabled-for-create": return "not-offered";
    case "available": return !provider.canManage ? "available" : provider.descriptor.credentialFields.length ? "connected" : "ready";
    default: return null;
  }
}

/** The pill for a stored agent login's state; none for a state this app does not know. */
export function credentialBadge(state: string): BadgeState | null {
  switch (state) {
    case "connected": return "connected";
    case "sign-in-required": return "sign-in-required";
    case "revoked": return "revoked";
    case "disconnected": return "not-connected";
    default: return null;
  }
}

const styles = StyleSheet.create({
  // As tall as its words: a fixed 22 cut "Not connected" in half at the accessibility sizes (PRO-563).
  pill: { minHeight: 22, maxWidth: "100%", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 7, flexDirection: "row", alignItems: "center", flexShrink: 0 },
  text: { flexShrink: 1, fontSize: 12, fontWeight: "600" },
});
