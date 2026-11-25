import { Pressable, StyleSheet, Text, View } from "react-native";
import { Check, ChevronRight, TriangleAlert } from "lucide-react-native";
import { Card } from "./primitives";
import { useTheme } from "./theme";

/** Done; the one to do next; one that waits for an earlier step; one that could not be read or needs fixing. */
export type SetupStepState = "done" | "next" | "waiting" | "failed";

export interface SetupStep {
  key: string;
  title: string;
  /** What the step is for, or, once done, what it holds. */
  detail: string;
  state: SetupStepState;
  /** The detail says what is wrong: drawn in the danger colour. */
  alert?: boolean;
  /** Where the step opens. A step without it has no chevron and is not a button. */
  onPress?(): void;
}

const SAID: Record<SetupStepState, string> = { done: "done", next: "next", waiting: "not started", failed: "needs attention" };

/**
 * Setting up cloud workspaces as one card of numbered steps (25.01): the step
 * to do next carries the accent, a finished one a tick, one in trouble a
 * warning. The numbers are the steps' places in the list.
 */
export function SetupSteps({ steps, testID }: { steps: readonly SetupStep[]; testID?: string }) {
  const { palette } = useTheme();
  return <Card testID={testID}>
    {steps.map((step, index) => {
      const line = index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border } : null;
      const said = `Step ${index + 1} of ${steps.length}, ${SAID[step.state]}: ${step.title}. ${step.detail}`;
      const body = <>
        <Mark state={step.state} number={index + 1} />
        <View style={styles.body}>
          <Text style={[styles.title, step.state === "waiting" ? { color: palette.muted } : [styles.strong, { color: palette.ink }]]}>{step.title}</Text>
          <Text style={[styles.detail, { color: step.alert ? palette.danger : palette.muted }]}>{step.detail}</Text>
        </View>
        {step.onPress ? <View style={styles.trailing}><ChevronRight size={18} color={palette.faint} /></View> : null}
      </>;
      return step.onPress
        ? <Pressable key={step.key} testID={`setup-step-${step.key}`} accessibilityRole="button" accessibilityLabel={said} onPress={step.onPress} style={({ pressed }) => [styles.row, line, { backgroundColor: pressed ? palette.raised : undefined }]}>{body}</Pressable>
        : <View key={step.key} testID={`setup-step-${step.key}`} accessible accessibilityLabel={said} style={[styles.row, line]}>{body}</View>;
    })}
  </Card>;
}

function Mark({ state, number }: { state: SetupStepState; number: number }) {
  const { palette } = useTheme();
  if (state === "done") return <View testID="setup-step-mark" style={[styles.mark, { backgroundColor: `${palette.success}29`, borderColor: "transparent" }]}><Check size={14} color={palette.success} /></View>;
  if (state === "failed") return <View testID="setup-step-mark" style={[styles.mark, { backgroundColor: `${palette.danger}29`, borderColor: "transparent" }]}><TriangleAlert size={13} color={palette.danger} /></View>;
  const next = state === "next";
  return <View testID="setup-step-mark" style={[styles.mark, next ? { backgroundColor: palette.accent, borderColor: "transparent" } : { backgroundColor: palette.raised, borderColor: palette.border }]}>
    {/* A number in a circle of fixed size, as the tick and the warning beside it are: it keeps its size (PRO-563). */}
    <Text allowFontScaling={false} style={[styles.number, { color: next ? palette.accentInk : palette.muted }]}>{number}</Text>
  </View>;
}

const styles = StyleSheet.create({
  row: { minHeight: 64, flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  mark: { width: 26, height: 26, borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center", marginTop: 1 },
  number: { fontSize: 13, fontWeight: "600" },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 16, lineHeight: 21 },
  strong: { fontWeight: "600" },
  detail: { fontSize: 13, lineHeight: 18, marginTop: 2 },
  trailing: { height: 21, justifyContent: "center" },
});
