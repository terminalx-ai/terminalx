import { ActivityIndicator, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { connectionBusy, connectionWords, type ConnectionState } from "../state/connection-view";
import { StatusDot } from "./primitives";
import { useTheme } from "./theme";

/**
 * The connection in one quiet line (#983), as a chat app says it under a
 * contact's name: a small spinner while something is under way, a green dot
 * once connected (where a screen says so at all), and the wait for the Mac in
 * the warning colour. The words are the shared ones (`connectionWords`).
 */
export function ConnectionLine({ state, showDot = true, style }: { state: ConnectionState; showDot?: boolean; style?: StyleProp<ViewStyle> }) {
  const { palette } = useTheme();
  const words = connectionWords(state);
  if (!words) return null;
  const colour = state === "waiting" ? palette.warning : palette.muted;
  return <View accessibilityLiveRegion="polite" accessibilityLabel={words} style={[styles.line, style]}>
    {connectionBusy(state) ? <ActivityIndicator testID="connection-spinner" size="small" color={palette.muted} style={styles.spinner} /> : null}
    {state === "connected" && showDot ? <StatusDot color={palette.success} /> : null}
    <Text numberOfLines={1} style={[styles.words, { color: colour }]}>{words}</Text>
  </View>;
}

const styles = StyleSheet.create({
  line: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 17 },
  // The system's small spinner, brought down to the line's size.
  spinner: { width: 14, height: 14, transform: [{ scale: 0.7 }] },
  words: { fontSize: 13, letterSpacing: -0.1, flexShrink: 1 },
});
