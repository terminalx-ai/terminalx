import { Pressable, StyleSheet, Text, View } from "react-native";
import { ChevronRight, Plus } from "lucide-react-native";
import { SETUP_TEXT, stepsDoneLabel, type SetupStepKey, type SetupView } from "@mobile/cloud/setup";
import { Button, Card } from "./primitives";
import { SetupSteps } from "./SetupSteps";
import { useTheme } from "./theme";

/**
 * One organization's setup as the Cloud tab draws it (25.01): the card of
 * four steps, the button for the step to do next, and a line under it when
 * the steps could not be read or the phone is offline.
 */
export function SetupCard({ view, onOpen, offline = false, button = true, testID }: {
  view: SetupView;
  onOpen(step: SetupStepKey): void;
  /** The service cannot be reached: what is shown was read before, and nothing can be started. */
  offline?: boolean;
  /** The second card on a page has no button of its own: its rows open the steps. */
  button?: boolean;
  testID?: string;
}) {
  const { palette } = useTheme();
  const steps = view.steps.map((step) => ({ key: step.key, title: step.title, detail: step.detail, state: step.state, alert: step.alert, onPress: step.opens ? () => onOpen(step.key) : undefined }));
  const action = button ? view.action : null;
  const note = offline ? SETUP_TEXT.offline : view.unread ? SETUP_TEXT.unreadHelp : null;
  return <View testID={testID}>
    <SetupSteps steps={steps} />
    {action ? <Button label={action.label} disabled={offline} style={styles.button} icon={action.step === "launch" ? (color) => <Plus size={18} color={color} /> : undefined} onPress={() => onOpen(action.step)} /> : null}
    {note ? <Text style={[styles.help, { color: palette.muted }]}>{note}</Text> : null}
  </View>;
}

/** An organization this person may not set up, with no compute yet (25.01): the console's sentence on who can. */
export function NoComputeCard({ name }: { name: string }) {
  const { palette } = useTheme();
  return <Card style={styles.pad}>
    <Text style={[styles.title, { color: palette.ink }]}>{SETUP_TEXT.noCompute(name)}</Text>
    <Text style={[styles.detail, { color: palette.muted }]}>{SETUP_TEXT.noComputeDetail}</Text>
  </Card>;
}

/** An organization still being set up, folded to one row under the ones that have workspaces (25.01). */
export function FoldedSetup({ view, onPress }: { view: SetupView; onPress(): void }) {
  const { palette } = useTheme();
  const done = stepsDoneLabel(view);
  return <Card>
    <Pressable testID="setup-folded" accessibilityRole="button" accessibilityLabel={`${SETUP_TEXT.folded}, ${done}`} onPress={onPress} style={({ pressed }) => [styles.folded, { backgroundColor: pressed ? palette.raised : undefined }]}>
      <View style={styles.body}>
        <Text style={[styles.row, { color: palette.ink }]}>{SETUP_TEXT.folded}</Text>
        <Text style={[styles.small, { color: palette.muted }]}>{done}</Text>
      </View>
      <ChevronRight size={18} color={palette.faint} />
    </Pressable>
  </Card>;
}

const styles = StyleSheet.create({
  button: { marginTop: 12 },
  help: { fontSize: 13, lineHeight: 18, marginTop: 6, marginHorizontal: 4 },
  pad: { padding: 16, gap: 10 },
  title: { fontSize: 16, fontWeight: "600" },
  detail: { fontSize: 14, lineHeight: 21 },
  folded: { minHeight: 52, paddingHorizontal: 14, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 12 },
  body: { flex: 1, minWidth: 0 },
  row: { fontSize: 16 },
  small: { fontSize: 13, lineHeight: 18, marginTop: 2 },
});
