import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "../../../ui/primitives";
import { useTheme } from "../../../ui/theme";
import { STOP } from "./sentences";

/**
 * In the composer's place while a stop is under way, or after one did not go
 * through (25.06): a card like the stopped bar, saying what is happening, with
 * Retry stop for someone who may stop it. While it stops, the composer is gone.
 */
export function StopBar({ state, cause, onRetry }: { state: "stopping" | "failed"; /** Why it did not stop (failed only). */ cause?: string; /** Absent for someone who may not stop it. */ onRetry?: () => void }) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const stopping = state === "stopping";
  return <View testID="stop-bar" style={[styles.bar, { backgroundColor: palette.card, borderColor: palette.border, marginBottom: insets.bottom + 8 }]}>
    <View style={styles.words}>
      <Text style={[styles.title, { color: palette.ink }]}>{stopping ? STOP.stoppingTitle : STOP.failedTitle}</Text>
      <Text style={[styles.detail, { color: palette.muted }]}>{stopping ? STOP.stoppingDetail : STOP.failedDetail(cause ?? "")}</Text>
    </View>
    {stopping ? <Button label={STOP.stoppingButton} kind="secondary" size="small" disabled onPress={() => undefined} />
      : onRetry ? <Button label={STOP.retry} size="small" onPress={onRetry} /> : null}
  </View>;
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 12, marginTop: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, borderCurve: "continuous", paddingHorizontal: 14, paddingVertical: 12 },
  words: { flex: 1 },
  title: { fontSize: 15, fontWeight: "600", lineHeight: 20 },
  detail: { fontSize: 13, lineHeight: 18, marginTop: 2 },
});
