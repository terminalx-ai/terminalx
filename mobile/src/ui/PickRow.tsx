import { Pressable, StyleSheet, Text, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { Card } from "./primitives";
import { useLargeText } from "./text-size";
import { useTheme } from "./theme";

/**
 * One line of a form (25.05): what it is, what is chosen, and a chevron when
 * it opens a choice. A row with nothing to choose is a fact: no chevron, and
 * read aloud as "label: value".
 *
 * At the accessibility text sizes the value goes under its label, in full,
 * as iOS Settings stacks its rows (PRO-563): beside the label it was cut to
 * "De…".
 */
export function PickRow({ label, value, onPress, first, bad, testID }: { label: string; value: string; onPress?(): void; first?: boolean; bad?: boolean; testID?: string }) {
  const { palette } = useTheme();
  const line = first ? null : { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border };
  const large = useLargeText();
  const chevron = onPress ? <ChevronRight size={18} color={palette.faint} /> : null;
  const body = large ? <>
    <View style={styles.stack}>
      <Text style={[styles.label, { color: palette.ink }]}>{label}</Text>
      <Text style={[styles.stackValue, { color: bad ? palette.danger : palette.muted }]}>{value}</Text>
    </View>
    {chevron}
  </> : <>
    <Text style={[styles.label, { color: palette.ink }]}>{label}</Text>
    <Text numberOfLines={1} style={[styles.value, { color: bad ? palette.danger : palette.muted }]}>{value}</Text>
    {chevron}
  </>;
  if (!onPress) return <View testID={testID} accessible accessibilityLabel={`${label}: ${value}`} style={[styles.row, line]}>{body}</View>;
  return <Pressable testID={testID ?? `pick-${label.toLowerCase().replace(/\s+/g, "-")}`} accessibilityRole="button" accessibilityLabel={`${label}: ${value}`} onPress={onPress} style={({ pressed }) => [styles.row, line, pressed ? { backgroundColor: palette.raised } : null]}>{body}</Pressable>;
}

/** What the Model row says when the agent's own default is used: nothing to choose, so no chevron. */
export const AGENT_DEFAULT_MODEL = "Agent’s default";

/**
 * The four choices an agent starts with (25.09, 25.10): Agent, Model, Effort
 * and Permission mode, as one card of the form's own rows. Each row opens a
 * choice when its handler is given. A model of `null` is the agent's default,
 * stated and not chosen; an effort or a mode of `null` has nothing to choose
 * from, and its row is not drawn.
 */
export function AgentSettingsRows({ agent, model, effort, mode, onAgent, onModel, onEffort, onMode, badAgent, testID }: {
  /** The chosen agent's name. */
  agent: string;
  /** The chosen model's name; null for the agent's own default. */
  model: string | null;
  effort: string | null;
  mode: string | null;
  onAgent?(): void;
  onModel?(): void;
  onEffort?(): void;
  onMode?(): void;
  /** The chosen agent cannot start: a check before pricing said so. */
  badAgent?: boolean;
  testID?: string;
}) {
  return <Card testID={testID}>
    <PickRow label="Agent" value={agent} onPress={onAgent} bad={badAgent} first testID={onAgent ? "pick-agent" : "agent-fact"} />
    {model === null ? <PickRow label="Model" value={AGENT_DEFAULT_MODEL} testID="model-fact" /> : <PickRow label="Model" value={model} onPress={onModel} testID={onModel ? "pick-model" : "model-fact"} />}
    {effort === null ? null : <PickRow label="Effort" value={effort} onPress={onEffort} testID={onEffort ? "pick-effort" : "effort-fact"} />}
    {mode === null ? null : <PickRow label="Permission mode" value={mode} onPress={onMode} testID={onMode ? "pick-permission-mode" : "mode-fact"} />}
  </Card>;
}

const styles = StyleSheet.create({
  row: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 9 },
  label: { fontSize: 16, lineHeight: 21 },
  value: { flex: 1, fontSize: 15, lineHeight: 20, textAlign: "right" },
  stack: { flex: 1, minWidth: 0, gap: 2 },
  stackValue: { fontSize: 15, lineHeight: 20 },
});
