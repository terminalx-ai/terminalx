import { StyleSheet, View } from "react-native";
import { useTheme } from "./theme";

/**
 * A voice as it is heard, the way chat apps draw it while they listen: a row
 * of rounded bars, the newest on the right, standing as tall as the voice was
 * loud and settling to dots in a pause. The oldest fade out at the left.
 */
export function Waveform({ levels, height = 28 }: { levels: number[]; height?: number }) {
  const { palette } = useTheme();
  return <View accessibilityLabel="Listening" style={[styles.wave, { height }]}>
    {levels.map((level, index) => <View key={index} style={[styles.bar, {
      height: Math.max(4, Math.round(4 + level * (height - 4))),
      backgroundColor: palette.ink,
      opacity: 0.25 + 0.7 * Math.min(1, index / (levels.length * 0.35)),
    }]} />)}
  </View>;
}

const styles = StyleSheet.create({
  wave: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 3, overflow: "hidden" },
  bar: { width: 3.5, borderRadius: 2 },
});
