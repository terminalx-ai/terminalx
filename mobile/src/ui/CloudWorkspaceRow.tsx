import { Platform, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { ChevronRight, Cloud } from "lucide-react-native";
import type { CloudWorkspaceItem } from "@mobile/cloud/api";
import { listStatus, roleLabel } from "@mobile/cloud/words";
import { agoTime } from "@mobile/data/session-list";
import { StatusDot } from "./primitives";
import { Spinner } from "./Spinner";
import { rowActionProps, type RowAction } from "./row-actions";
import { useTheme } from "./theme";

const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";

/**
 * A workspace as the Sessions list lists a session: its mark, its title, what
 * it is doing and when, then where it works. An organization's rows share one
 * card, as in the design: the first and last round it off.
 *
 * `cloud`: drawn among the Mac's own sessions (the Pinned section, #1403),
 * where a cloud mark says what it is, as the Cloud tab's icon does.
 * `actions`: what a long press offers (Pin project or Unpin project).
 */
export function CloudWorkspaceRow({ item, title, first, last, onPress, cloud = false, actions = [], style }: {
  item: CloudWorkspaceItem;
  title: string;
  first: boolean;
  last: boolean;
  onPress(): void;
  cloud?: boolean;
  actions?: RowAction[];
  style?: StyleProp<ViewStyle>;
}) {
  const { palette } = useTheme();
  const { workspace } = item;
  const status = listStatus(workspace);
  const role = roleLabel(workspace.you?.role);
  const providerLabel = workspace.providerDescriptor?.label;
  const provider = typeof providerLabel === "string" && providerLabel.trim() ? providerLabel : workspace.provider;
  const repository = workspace.repositories?.find((entry) => entry.primary)?.fullName ?? workspace.repositories?.[0]?.fullName ?? null;
  const branch = workspace.launch?.workBranch ?? null;
  const where = [provider, repository, branch].filter(Boolean).join(" · ");
  const when = workspace.lastActivityAt ? agoTime(workspace.lastActivityAt) : "";
  // What is said aloud also names the role (a manager's is assumed) and who else it is shared with.
  const facts = [cloud ? "cloud workspace" : null, status.words, role === "Manager" ? null : role, workspace.sharedWith ? `Shared with ${workspace.sharedWith}` : null, provider].filter(Boolean);
  // As the Sessions list colours its words (22.06): blue work, amber waits, red trouble, green running, grey rest.
  const tone = status.mark === "working" || status.mark === "changing" ? palette.info : status.mark === "needs" ? palette.warning : status.mark === "attention" ? palette.danger : status.mark === "running" ? palette.success : palette.muted;
  return <Pressable accessibilityRole="button" accessibilityLabel={`${title}, ${facts.join(", ")}`} {...rowActionProps(title, actions)} onPress={onPress} style={({ pressed }) => [styles.row, styles.cardRow, { backgroundColor: pressed ? palette.raised : palette.card, borderColor: palette.border }, first ? styles.cardTop : { borderTopColor: palette.border, borderTopWidth: StyleSheet.hairlineWidth }, last && styles.cardBottom, style]}>
    <View style={styles.mark}>{status.mark === "working" ? <Spinner size={18} color={palette.info} /> : <StatusDot color={tone} />}</View>
    <View style={styles.body}>
      <Text numberOfLines={1} style={[styles.title, { color: palette.ink }]}>{title}</Text>
      <Text numberOfLines={1} style={[styles.status, { color: palette.muted }]}><Text style={[styles.words, { color: status.mark === "running" ? palette.muted : tone }]}>{status.words}</Text>{when ? ` · ${when}` : null}</Text>
      {where ? <Text numberOfLines={1} style={[styles.where, { color: palette.faint }]}>{where}</Text> : null}
    </View>
    <View style={styles.trailing}>
      {cloud ? <Cloud testID="cloud-row-mark" size={15} color={palette.faint} strokeWidth={1.9} /> : null}
      <ChevronRight size={18} color={palette.faint} />
    </View>
  </Pressable>;
}

const styles = StyleSheet.create({
  row: { minHeight: 56, paddingHorizontal: 14, paddingVertical: 12, flexDirection: "row", gap: 12, alignItems: "flex-start" },
  cardRow: { borderLeftWidth: StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth },
  cardTop: { borderTopWidth: StyleSheet.hairlineWidth, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  cardBottom: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomLeftRadius: 16, borderBottomRightRadius: 16 },
  trailing: { height: 21, flexDirection: "row", alignItems: "center", gap: 6 },
  mark: { width: 18, height: 21, alignItems: "center", justifyContent: "center" },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 16, lineHeight: 21, letterSpacing: -0.3, fontWeight: "600" },
  status: { marginTop: 2, fontSize: 13, lineHeight: 18 },
  words: { fontWeight: "600" },
  where: { marginTop: 3, fontFamily: MONO, fontSize: 12, lineHeight: 16 },
});
