import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { CircleAlert, CircleCheck, Info } from "lucide-react-native";
import { Button } from "./primitives";
import { useTheme } from "./theme";

export type NoticeTone = "warning" | "danger" | "info" | "success";

/**
 * What went wrong or what to know, inside a page (25.07), with one way on
 * under it where there is one. A warning or an error is announced as it appears.
 */
export function Notice({ tone, title, text, items, icon, action, testID }: {
  tone: NoticeTone;
  /** A heading over the text, when the notice lists several things. */
  title?: string;
  text?: string;
  /** One line each, under the text: every check that failed. */
  items?: readonly string[];
  /** Drawn in place of the tone's own mark, in its colour: offline, say. */
  icon?: (color: string) => ReactNode;
  action?: { label: string; onPress(): void; disabled?: boolean };
  testID?: string;
}) {
  const { palette } = useTheme();
  const quiet = tone === "info";
  const color = tone === "warning" ? palette.warning : tone === "danger" ? palette.danger : tone === "success" ? palette.success : palette.muted;
  const frame = quiet
    ? { borderColor: palette.border, backgroundColor: palette.raised }
    : { borderColor: `${color}${tone === "danger" ? "57" : tone === "warning" ? "52" : "4d"}`, backgroundColor: `${color}${tone === "danger" ? "12" : "0f"}` };
  const words = { color: quiet ? palette.muted : palette.ink };
  const Mark = quiet ? Info : tone === "success" ? CircleCheck : CircleAlert;
  return <View testID={testID} accessibilityRole={tone === "danger" || tone === "warning" ? "alert" : undefined} style={[styles.notice, frame]}>
    <View style={styles.mark}>{icon ? icon(color) : <Mark size={16} color={color} />}</View>
    <View style={styles.body}>
      {title ? <Text style={[styles.text, styles.title, { color: palette.ink }]}>{title}</Text> : null}
      {text ? <Text style={[styles.text, words]}>{text}</Text> : null}
      {items?.map((item, index) => <Text key={index} style={[styles.text, words]}>{item}</Text>)}
      {action ? <View style={styles.actions}><Button label={action.label} kind="secondary" size="small" disabled={action.disabled} onPress={action.onPress} /></View> : null}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  notice: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  mark: { marginTop: 2 },
  body: { flex: 1, minWidth: 0, gap: 4 },
  text: { fontSize: 13, lineHeight: 19 },
  title: { fontWeight: "600" },
  actions: { flexDirection: "row", gap: 8, marginTop: 6 },
});
