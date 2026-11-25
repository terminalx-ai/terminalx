import { Pressable, StyleSheet, Text, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { Card } from "./primitives";
import { useTheme } from "./theme";

/**
 * One line of a form (25.05): what it is, what is chosen, and a chevron when
 * it opens a choice. A row with nothing to choose is a fact: no chevron, and
 * read aloud as "label: value". A value of two lines (a size named by its
 * machine, then its rate) is drawn as two, and read as one.
 */
export function PickRow({ label, value, onPress, first, bad, testID }: { label: string; value: string; onPress?(): void; first?: boolean; bad?: boolean; testID?: string }) {
  const { palette } = useTheme();
  const line = first ? null : { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border };
  const lines = value.split("\n");
  const said = `${label}: ${lines.join(", ")}`;
  const body = <>
    <Text style={[styles.label, { color: palette.ink }]}>{label}</Text>
    <Text numberOfLines={lines.length} style={[styles.value, { color: bad ? palette.danger : palette.muted }]}>{value}</Text>
    {onPress ? <ChevronRight size={18} color={palette.faint} /> : null}
  </>;
  if (!onPress) return <View testID={testID} accessible accessibilityLabel={said} style={[styles.row, line]}>{body}</View>;
  return <Pressable testID={testID ?? `pick-${label.toLowerCase().replace(/\s+/g, "-")}`} accessibilityRole="button" accessibilityLabel={said} onPress={onPress} style={({ pressed }) => [styles.row, line, pressed ? { backgroundColor: palette.raised } : null]}>{body}</Pressable>;
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
});
