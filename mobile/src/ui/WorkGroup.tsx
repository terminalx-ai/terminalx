import { useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SquareTerminal } from "lucide-react-native";
import type { ToolCall } from "@terminalx/portable/transcript";
import { useTheme } from "./theme";
import { callCommand, callDescription, callsLabel, commandFirstLine, folds } from "./transcript-rows";

/**
 * A run of the agent's tool calls in one line ("Ran 2 commands", design
 * 22.03). Tapped, it opens to each call: the agent's plain description first,
 * then the command in small monospace on one line, which a tap shows whole.
 *
 * A call held by a safety check (or one that returned images) stands alone and
 * is drawn open, with what held it, since the person may need to act (#775).
 */
export function WorkGroup({ calls }: { calls: ToolCall[] }) {
  const { palette } = useTheme();
  const single = calls.length === 1;
  const held = single && !folds(calls[0]);
  // A single call that names nothing has no more to show than its line.
  const opens = !held && (!single || callCommand(calls[0]) !== undefined);
  const [open, setOpen] = useState(false);
  const label = callsLabel(calls);
  const shown = held || (opens && open);
  const header = <>
    <SquareTerminal size={16} color={shown ? palette.ink : palette.muted} />
    <Text numberOfLines={2} style={[styles.label, { color: shown ? palette.ink : palette.muted }]}>{label}</Text>
    {opens ? <Chevron open={open} color={open ? palette.ink : palette.muted} /> : null}
  </>;
  return <View style={styles.group}>
    {!opens ? <View testID="work-group-header" style={styles.header}>{header}</View>
      : <Pressable testID="work-group-header" accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded: open }} accessibilityHint={open ? "Hides the commands." : "Shows each command."} hitSlop={{ top: 8, bottom: 8 }} onPress={() => setOpen(!open)} style={styles.header}>{header}</Pressable>}
    {shown ? <View testID="work-group-calls" style={[styles.calls, { borderColor: palette.border, backgroundColor: palette.card }]}>
      {/* One call: the line above already says what it does. */}
      {calls.map((call, index) => <CallDetail key={call.callId} call={call} describe={!single} first={index === 0} />)}
    </View> : null}
  </View>;
}

function CallDetail({ call, describe, first }: { call: ToolCall; describe: boolean; first: boolean }) {
  const { palette } = useTheme();
  const command = callCommand(call);
  const safetyCheck = call.result?.safetyCheck;
  if (!describe && !command && !safetyCheck) return null;
  return <View testID="work-group-call" style={[styles.call, first ? null : [styles.callAfter, { borderTopColor: palette.border }]]}>
    {describe ? <Text testID="work-group-description" style={[styles.description, { color: palette.ink }]}>{callDescription(call)}</Text> : null}
    {command ? <CommandLine command={command} /> : null}
    {call.abandoned && describe ? <Text style={[styles.status, { color: palette.muted }]}>Stopped</Text> : null}
    {safetyCheck ? <Text testID="tool-safety-check" style={[styles.status, { color: palette.warning }]}>{safetyCheck}</Text> : null}
  </View>;
}

/** Points right while the run is folded, down once open: two strokes of a square's corner, turned. */
function Chevron({ open, color }: { open: boolean; color: string }) {
  return <View style={styles.chevronBox}><View style={[styles.chevron, { borderColor: color, transform: [{ rotate: open ? "45deg" : "-45deg" }] }]} /></View>;
}

/** A command, one line of it until tapped; tapped, all of it, to read or select. */
function CommandLine({ command }: { command: string }) {
  const { palette } = useTheme();
  const [whole, setWhole] = useState(false);
  const { line, cut } = commandFirstLine(command);
  return <Pressable testID="work-group-command" accessibilityRole="button" accessibilityLabel={whole ? command : `Command: ${line}`} accessibilityHint={whole ? "Shows one line of the command." : "Shows the whole command."} accessibilityState={{ expanded: whole }} onPress={() => setWhole(!whole)}>
    {whole ? <Text selectable style={[styles.command, { color: palette.muted }]}>{command}</Text>
      // A long line is cut in its middle, so the end of a path stays in sight.
      : <Text numberOfLines={1} ellipsizeMode={cut ? "tail" : "middle"} style={[styles.command, { color: palette.muted }]}>{line}</Text>}
  </Pressable>;
}

const styles = StyleSheet.create({
  group: { gap: 8 },
  header: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28, alignSelf: "flex-start", maxWidth: "100%" },
  label: { flexShrink: 1, fontSize: 14, lineHeight: 20 },
  calls: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, borderCurve: "continuous", paddingHorizontal: 14, paddingVertical: 12, gap: 10 },
  call: { gap: 3 },
  callAfter: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10 },
  description: { fontSize: 14, lineHeight: 20, fontWeight: "600" },
  command: { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 13, lineHeight: 18 },
  chevronBox: { width: 16, height: 16, alignItems: "center", justifyContent: "center" },
  chevron: { width: 7, height: 7, borderRightWidth: 1.75, borderBottomWidth: 1.75, marginTop: -2 },
  status: { fontSize: 13, lineHeight: 18 },
});
