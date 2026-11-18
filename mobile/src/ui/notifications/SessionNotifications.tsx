import { BellOff } from "lucide-react-native";
// The store and model only: the delivery side brings expo-notifications with it, which a row needs not.
import { sessionOverride, type SessionOverride } from "@mobile/notifications/model";
import { setSessionOverride, useNotificationSettings } from "@mobile/notifications/store";
import { useTheme } from "../theme";
import { ChoiceSheet, type Choice } from "./ChoiceSheet";

/** Design 22.07 frame 5, in its order and words. */
export const SESSION_CHOICES: Choice<SessionOverride>[] = [
  { value: "default", label: "Use my settings" },
  { value: "needsMe", label: "Only when it needs me" },
  { value: "everything", label: "Everything from this session" },
  { value: "mute", label: "Mute this session", icon: (color) => <BellOff size={18} color={color} /> },
];

/** This session's own choice on this phone; "default" while the settings are first read. */
export function useSessionOverride(hostId: string, sessionId: string): SessionOverride {
  const settings = useNotificationSettings();
  return settings ? sessionOverride(settings, hostId, sessionId) : "default";
}

/**
 * "Notifications for this session" (design 22.07 frame 5): follow it more
 * closely or mute it, over the Notifications page for this session only.
 */
export function SessionNotificationsSheet({ visible, hostId, sessionId, name, onClose }: { visible: boolean; hostId: string; sessionId: string; name: string; onClose(): void }) {
  const current = useSessionOverride(hostId, sessionId);
  return <ChoiceSheet visible={visible} title={name} detail="Notifications for this session" choices={SESSION_CHOICES} current={current} onClose={onClose} onChoose={(mode) => void setSessionOverride(hostId, sessionId, mode)} />;
}

/** The small mark a muted session carries in the sessions list. */
export function MutedMark({ hostId, sessionId, size = 14 }: { hostId: string; sessionId: string; size?: number }) {
  const { palette } = useTheme();
  if (useSessionOverride(hostId, sessionId) !== "mute") return null;
  return <BellOff accessibilityLabel="Muted" size={size} color={palette.faint} strokeWidth={1.9} />;
}
