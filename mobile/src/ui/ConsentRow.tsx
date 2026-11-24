import { StyleSheet, Switch, Text, View } from "react-native";
import { Card } from "./primitives";
import { useTheme } from "./theme";

/**
 * An acknowledgement the server requires before it acts (25.07): the sentence
 * beside a switch. The sentence is the switch's name, so it is read whole.
 */
export function ConsentRow({ text, value, onValueChange, disabled, testID }: { text: string; value: boolean; onValueChange(value: boolean): void; disabled?: boolean; testID?: string }) {
  const { palette } = useTheme();
  return <Card testID={testID}>
    <View style={styles.row}>
      <Text accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.text, { color: palette.ink }]}>{text}</Text>
      <Switch accessibilityLabel={text} value={value} disabled={disabled} onValueChange={onValueChange} trackColor={{ false: palette.selected, true: palette.accent }} />
    </View>
  </Card>;
}

const styles = StyleSheet.create({
  row: { minHeight: 56, flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  text: { flex: 1, fontSize: 14, lineHeight: 21 },
});
