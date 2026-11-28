import { Platform, StyleSheet, Text, View } from "react-native";
import { Card } from "./primitives";
import { useLargeText } from "./text-size";
import { useTheme } from "./theme";

export interface Fact {
  label: string;
  value: string;
  /** A fingerprint or an id: the monospaced face. */
  mono?: boolean;
  /** How it went, for a cleanup report: removed, not confirmed, pending. */
  tone?: "success" | "warning" | "danger";
  /** A value of several lines (a first task, 25.09): under its label, in full, rather than beside it. */
  block?: boolean;
}

/**
 * Label and value pairs (25.07): a saved key's facts, the review, the cleanup
 * report. `sentences` is the delete page's shape, where each value is a
 * sentence beside a short label. `embedded` draws the rows alone, under
 * whatever the card they sit in already holds.
 */
export function FactRows({ facts, layout = "pairs", embedded, testID }: { facts: readonly Fact[]; layout?: "pairs" | "sentences"; embedded?: boolean; testID?: string }) {
  const { palette } = useTheme();
  const large = useLargeText();
  const rows = facts.map((fact, index) => {
    const color = fact.tone === "success" ? palette.success : fact.tone === "warning" ? palette.warning : fact.tone === "danger" ? palette.danger : palette.ink;
    const line = index > 0 || embedded ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border } : null;
    const face = fact.mono ? [styles.mono, { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }) }] : null;
    if (fact.block || large) return <View key={index} accessible accessibilityLabel={`${fact.label}: ${fact.value}`} style={[styles.block, line]}>
      <Text style={[styles.pairLabel, { color: palette.muted }]}>{fact.label}</Text>
      <Text selectable={fact.block || fact.mono} style={[styles.blockValue, face, { color }]}>{fact.value}</Text>
    </View>;
    return <View key={index} accessible accessibilityLabel={`${fact.label}: ${fact.value}`} style={[layout === "sentences" ? styles.sentence : styles.pair, line]}>
      <Text style={[layout === "sentences" ? styles.sentenceLabel : styles.pairLabel, { color: palette.muted }]}>{fact.label}</Text>
      <Text selectable={fact.mono} style={[layout === "sentences" ? styles.sentenceValue : styles.pairValue, face, { color }]}>{fact.value}</Text>
    </View>;
  });
  return embedded ? <View testID={testID}>{rows}</View> : <Card testID={testID}>{rows}</Card>;
}

const styles = StyleSheet.create({
  pair: { flexDirection: "row", justifyContent: "space-between", gap: 12, paddingHorizontal: 14, paddingVertical: 9 },
  pairLabel: { fontSize: 15, lineHeight: 20 },
  pairValue: { flexShrink: 1, fontSize: 15, lineHeight: 20, textAlign: "right" },
  sentence: { minHeight: 48, flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  sentenceLabel: { width: 74, fontSize: 14, lineHeight: 21 },
  sentenceValue: { flex: 1, fontSize: 14, lineHeight: 21 },
  mono: { fontSize: 13 },
  block: { paddingHorizontal: 14, paddingVertical: 9 },
  blockValue: { fontSize: 15, lineHeight: 21, marginTop: 4 },
});
