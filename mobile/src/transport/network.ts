import type { NetInfoState } from "@react-native-community/netinfo";

/** What the phone reaches its Mac through. */
export interface PhoneNetwork {
  /** Changes whenever a path chosen before may be dead: another interface, or another address on it, as on another Wi-Fi. */
  key: string;
  online: boolean;
  label: string;
}

/** Null while the OS has not said yet: a first "unknown" must not count as a change. */
export function phoneNetwork(state: Pick<NetInfoState, "type" | "isConnected" | "details">): PhoneNetwork | null {
  if (state.type === "unknown") return null;
  const online = state.isConnected !== false && state.type !== "none";
  if (!online) return { key: "offline", online, label: "offline" };
  const details = state.details as { ipAddress?: string | null } | null;
  return { key: `${state.type}:${details?.ipAddress ?? ""}`, online, label: state.type };
}
