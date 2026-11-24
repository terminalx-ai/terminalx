import { useEffect, useState, type ReactNode } from "react";
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronDown, ChevronRight, Plus } from "lucide-react-native";
import { SetupSteps } from "../../../ui/SetupSteps";
import { Button, Card } from "../../../ui/primitives";
import { useTheme } from "../../../ui/theme";
import type { SetupModel } from "./steps";
import * as W from "./words";

/**
 * One organization's setup as 25.01 draws it: the card of four steps, the
 * button for the step to do next, and the line under it when a list could
 * not be read or the phone is offline (the button is then off).
 */
export function SetupCard({ model, offline, onOpen, testID }: { model: SetupModel; offline: boolean; onOpen(href: string): void; testID?: string }) {
  const { palette } = useTheme();
  const steps = model.steps.map((step) => ({ key: step.key, title: step.title, detail: step.detail, state: step.state, alert: step.alert, ...(step.href ? { onPress: () => onOpen(step.href!) } : {}) }));
  const action = model.action;
  return <View style={styles.setup} testID={testID}>
    <SetupSteps steps={steps} testID="setup-steps" />
    {action ? <Button label={action.label} disabled={offline} onPress={() => onOpen(action.href)} icon={action.launch ? (color) => <Plus size={16} color={color} strokeWidth={2.2} /> : undefined} /> : null}
    {offline && action ? <Text style={[styles.note, { color: palette.ink }]}>{W.OFFLINE_NOTE}</Text> : null}
    {model.unread ? <Text style={[styles.note, { color: palette.muted }]}>{W.PULL_TO_READ}</Text> : null}
  </View>;
}

/** A member's organization with no compute: the console's sentence, in a card of its own (25.01). */
export function NoComputeCard({ organization }: { organization: string }) {
  const { palette } = useTheme();
  return <Card style={styles.noCompute}>
    <Text style={[styles.noComputeTitle, { color: palette.ink }]}>{W.noComputeTitle(organization)}</Text>
    <Text style={[styles.noComputeDetail, { color: palette.muted }]}>{W.NO_COMPUTE_DETAIL}</Text>
  </Card>;
}

/**
 * An organization still being set up, under the ones that have workspaces:
 * one row saying how far it is, which opens to its card (25.01).
 */
export function SetupFold({ model, open, onToggle, offline, onOpen }: { model: SetupModel; open: boolean; onToggle(): void; offline: boolean; onOpen(href: string): void }) {
  const { palette } = useTheme();
  const done = W.stepsDone(model.done, model.steps.length);
  return <View style={styles.fold}>
    <Card>
      <Pressable accessibilityRole="button" accessibilityLabel={`${W.FOLD_TITLE}, ${done}`} accessibilityState={{ expanded: open }} onPress={onToggle} style={({ pressed }) => [styles.foldRow, pressed && { backgroundColor: palette.raised }]}>
        <View style={styles.foldBody}>
          <Text numberOfLines={1} style={[styles.foldTitle, { color: palette.ink }]}>{W.FOLD_TITLE}</Text>
          <Text numberOfLines={1} style={[styles.foldDetail, { color: palette.muted }]}>{done}</Text>
        </View>
        {open ? <ChevronDown size={18} color={palette.faint} /> : <ChevronRight size={18} color={palette.faint} />}
      </Pressable>
    </Card>
    {open ? <SetupCard model={model} offline={offline} onOpen={onOpen} /> : null}
  </View>;
}

/**
 * A form page (25.02's New organization): its content scrolls, and its button
 * stays at the foot above a hairline, lifted over the keyboard while it is up
 * so the button is never under it.
 */
export function FormPage({ children, footer, testID }: { children: ReactNode; footer: ReactNode; testID?: string }) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const [keyboard, setKeyboard] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardWillShow", (event) => setKeyboard(event.endCoordinates.height));
    const hide = Keyboard.addListener("keyboardWillHide", () => setKeyboard(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  return <View testID={testID} style={[styles.page, { backgroundColor: palette.page }]}>
    <ScrollView keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic" style={styles.page} contentContainerStyle={styles.content}>{children}</ScrollView>
    <View style={[styles.footer, { paddingBottom: keyboard ? keyboard + 10 : Math.max(insets.bottom, 12), borderTopColor: palette.border, backgroundColor: palette.page }]}>{footer}</View>
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24, gap: 12 },
  footer: { paddingHorizontal: 16, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  setup: { gap: 12 },
  note: { fontSize: 13, lineHeight: 18, paddingHorizontal: 4 },
  noCompute: { paddingHorizontal: 14, paddingVertical: 14, gap: 6 },
  noComputeTitle: { fontSize: 16, lineHeight: 21, fontWeight: "600" },
  noComputeDetail: { fontSize: 13, lineHeight: 18 },
  fold: { gap: 12 },
  foldRow: { minHeight: 56, paddingHorizontal: 14, paddingVertical: 11, flexDirection: "row", alignItems: "center", gap: 10 },
  foldBody: { flex: 1, minWidth: 0 },
  foldTitle: { fontSize: 16, lineHeight: 21 },
  foldDetail: { fontSize: 13, lineHeight: 18, marginTop: 2 },
});
