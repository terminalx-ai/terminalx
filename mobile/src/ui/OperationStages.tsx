import { StyleSheet, Text, View } from "react-native";
import { Check, X } from "lucide-react-native";
import { Card } from "./primitives";
import { Spinner } from "./Spinner";
import { useTheme } from "./theme";

type StageState = "done" | "current" | "failed" | "todo";
const SAID: Record<StageState, string> = { done: "done", current: "in progress", failed: "failed", todo: "not started" };

/**
 * An operation's stages in order (25.05): a tick on each one passed, the
 * spinner on the one under way, a cross where it stopped, and nothing yet on
 * the rest. The latest event sits under the stage it belongs to.
 */
export function OperationStages({ stages, current, status, detail, testID }: {
  /** Each stage's name, in the order the operation goes through them. */
  stages: readonly string[];
  /** The stage the operation is at, by its place in `stages`. */
  current: number;
  /** `finished`: it ran through, and every stage is ticked. `failed`: it stopped at `current`. */
  status: "running" | "failed" | "finished";
  /** The latest event, or why it stopped: under the current stage. */
  detail?: string;
  testID?: string;
}) {
  const { palette } = useTheme();
  return <Card testID={testID} style={styles.card}>
    {stages.map((name, index) => {
      const state: StageState = status === "finished" || index < current ? "done" : index > current ? "todo" : status === "failed" ? "failed" : "current";
      const under = index === current && status !== "finished" ? detail : undefined;
      return <View key={index} testID={`operation-stage-${index}`} accessible accessibilityLabel={`${name}, ${SAID[state]}${under ? `: ${under}` : ""}`} style={[styles.row, under ? styles.tall : null]}>
        <View style={[styles.mark, state === "done" ? { backgroundColor: `${palette.success}29` } : state === "failed" ? { backgroundColor: `${palette.danger}29` } : state === "todo" ? { borderWidth: StyleSheet.hairlineWidth, borderColor: palette.border } : null]}>
          {state === "done" ? <Check size={13} color={palette.success} /> : state === "failed" ? <X size={13} color={palette.danger} /> : state === "current" ? <Spinner size={18} color={palette.info} /> : null}
        </View>
        <View style={styles.body}>
          <Text style={[styles.name, { color: state === "todo" ? palette.muted : palette.ink }, state === "current" || state === "failed" ? styles.strong : null]}>{name}</Text>
          {under ? <Text style={[styles.detail, { color: palette.muted }]}>{under}</Text> : null}
        </View>
      </View>;
    })}
  </Card>;
}

const styles = StyleSheet.create({
  card: { paddingVertical: 6 },
  row: { minHeight: 46, flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 14, paddingVertical: 8 },
  tall: { minHeight: 56 },
  mark: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", marginTop: 1 },
  body: { flex: 1, minWidth: 0 },
  name: { fontSize: 15, lineHeight: 20 },
  strong: { fontWeight: "600" },
  detail: { fontSize: 13, lineHeight: 18, marginTop: 2 },
});
