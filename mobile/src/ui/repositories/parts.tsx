import { useState, type ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronRight } from "lucide-react-native";
import { branchHelp } from "@mobile/cloud/github";
import type { LaunchRepository } from "@mobile/cloud/launch";
import { Button } from "../primitives";
import { TextField } from "../TextField";
import { useTheme } from "../theme";
import { keyboardAvoidingBehavior } from "@mobile/ui/keyboard";

/** The launch flow's own page frame: a header, a scrolling body (or virtualized list container when `scroll: false`) and a foot above the keyboard. */
export type RepositoriesPage = (title: string, onBack: () => void, body: ReactNode, foot: ReactNode, subtitle?: string, options?: { scroll?: boolean }) => ReactNode;

/** The quiet paragraph a page opens with. */
export function Lede({ children, small }: { children: string; small?: boolean }) {
  const { palette } = useTheme();
  return <Text style={[small ? styles.smallLede : styles.lede, { color: palette.muted }]}>{children}</Text>;
}

/** The line under a field or a list. */
export function Help({ children, testID }: { children: string; testID?: string }) {
  const { palette } = useTheme();
  return <Text testID={testID} style={[styles.help, { color: palette.muted }]}>{children}</Text>;
}

/** Over a list: what it is, and at its end how many are chosen. */
export function CountLine({ label, count, testID }: { label: string; count: string; testID?: string }) {
  const { palette } = useTheme();
  return <View testID={testID} style={styles.count}>
    <Text style={[styles.help, { color: palette.muted }]}>{label}</Text>
    {count ? <Text style={[styles.help, styles.number, { color: palette.muted }]}>{count}</Text> : null}
  </View>;
}

/** A row that opens another page (25.11: Type a repository URL), drawn as the form's own rows are. */
export function LinkRow({ label, icon, first, off, onPress, testID }: { label: string; icon?: (color: string) => ReactNode; first?: boolean; off?: boolean; onPress(): void; testID?: string }) {
  const { palette } = useTheme();
  const line = first ? null : { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border };
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!off }} disabled={off} onPress={onPress}
    style={({ pressed }) => [styles.link, line, off ? styles.off : null, pressed ? { backgroundColor: palette.raised } : null]}>
    {icon ? icon(palette.muted) : null}
    <Text style={[styles.linkLabel, { color: palette.ink }]}>{label}</Text>
    <ChevronRight size={18} color={palette.faint} />
  </Pressable>;
}

/**
 * A chosen repository's branch or tag, in a sheet over the list (25.11).
 * Empty means the repository's default branch, which the line under the
 * field names where it is known. Done keeps what was typed; a tap outside
 * changes nothing.
 */
export function BranchSheet({ repository, onDone, onRemove, onClose }: { repository: LaunchRepository; onDone(ref: string): void; onRemove(): void; onClose(): void }) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const [ref, setRef] = useState(repository.ref);
  return <Modal visible transparent animationType="slide" onRequestClose={onClose}>
    <KeyboardAvoidingView style={styles.fill} behavior={keyboardAvoidingBehavior()}>
      <Pressable testID="branch-sheet-backdrop" accessibilityRole="button" accessibilityLabel="Close Branch or tag" onPress={onClose} style={[styles.fill, styles.backdrop]} />
      <View testID="branch-sheet" accessibilityViewIsModal style={[styles.sheet, { backgroundColor: palette.page, borderColor: palette.border, paddingBottom: insets.bottom + 16 }]}>
        <View style={[styles.handle, { backgroundColor: palette.faint }]} />
        <Text accessibilityRole="header" style={[styles.title, { color: palette.ink }]}>Branch or tag</Text>
        <Text numberOfLines={1} style={[styles.subtitle, { color: palette.muted }]}>{repository.fullName}</Text>
        <View style={styles.body}>
          <TextField testID="branch-ref" accessibilityLabel={`Branch or tag for ${repository.fullName}`} value={ref} onChangeText={setRef} placeholder={repository.defaultBranch || "main"} autoFocus autoCapitalize="none" autoCorrect={false} returnKeyType="done" onSubmitEditing={() => onDone(ref.trim())} helper={branchHelp(repository.typed ? null : repository.defaultBranch)} />
          <Button testID="branch-done" label="Done" onPress={() => onDone(ref.trim())} />
          <Button testID="branch-remove" label="Remove this repository" kind="secondary" onPress={onRemove} />
        </View>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

const styles = StyleSheet.create({
  lede: { fontSize: 15, lineHeight: 21, marginHorizontal: 4 },
  smallLede: { fontSize: 14, lineHeight: 20, marginHorizontal: 4 },
  help: { fontSize: 13, lineHeight: 18, marginHorizontal: 4 },
  count: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  number: { fontVariant: ["tabular-nums"] },
  link: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 9 },
  linkLabel: { flex: 1, minWidth: 0, fontSize: 16, lineHeight: 21 },
  off: { opacity: 0.5 },
  fill: { flex: 1 },
  backdrop: { backgroundColor: "#00000080" },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingTop: 10 },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, marginBottom: 12, opacity: 0.6 },
  title: { fontSize: 17, fontWeight: "600", lineHeight: 22, paddingHorizontal: 4 },
  subtitle: { fontSize: 13, lineHeight: 18, paddingHorizontal: 4, paddingTop: 2 },
  body: { gap: 12, marginTop: 10 },
});
