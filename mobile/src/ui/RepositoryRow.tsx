import { Pressable, StyleSheet, Text, View } from "react-native";
import { Check, Globe, Lock, TriangleAlert } from "lucide-react-native";
import { useTheme } from "./theme";

/** The round tick of a choice among several (25.05's agents, 25.11's repositories): filled when on, a ring when off. */
export function Tick({ on, dim }: { on: boolean; dim?: boolean }) {
  const { palette } = useTheme();
  return <View style={[styles.tick, on ? { backgroundColor: palette.accent } : { borderWidth: 1.5, borderColor: palette.faint }, dim && !on ? styles.dim : null]}>
    {on ? <Check size={14} color={palette.accentInk} /> : null}
  </View>;
}

/** A repository's `owner/name` on one line, the owner quieter than the name; a long one is cut at its end. */
export function RepositoryName({ fullName }: { fullName: string }) {
  const { palette } = useTheme();
  const slash = fullName.indexOf("/");
  return <Text numberOfLines={1} style={[styles.name, { color: palette.ink }]}>
    {slash < 0 ? fullName : <><Text style={{ color: palette.muted }}>{fullName.slice(0, slash + 1)}</Text>{fullName.slice(slash + 1)}</>}
  </Text>;
}

/** Private with a lock or Public with a globe, then the branch. */
export function RepositoryFacts({ isPrivate, branch }: { isPrivate: boolean; branch?: string | null }) {
  const { palette } = useTheme();
  const Mark = isPrivate ? Lock : Globe;
  return <View style={styles.facts}>
    <Mark size={12} color={palette.muted} />
    <Text numberOfLines={1} style={[styles.detail, styles.grow, { color: palette.muted }]}>{`${isPrivate ? "Private" : "Public"}${branch ? ` · ${branch}` : ""}`}</Text>
  </View>;
}

/**
 * One repository in a list (25.11): a tick, its full name, whether it is
 * private, and its default branch. One that cannot be used right now carries
 * a warning in place of the tick and says why. `off` dims a row that cannot
 * be chosen for another reason (five are chosen already), with no words of
 * its own: the list says why once.
 */
export function RepositoryRow({ fullName, isPrivate, branch, on, off, why, first, onPress, testID }: {
  fullName: string;
  isPrivate: boolean;
  branch?: string | null;
  on: boolean;
  off?: boolean;
  why?: string | null;
  first?: boolean;
  onPress?(): void;
  testID?: string;
}) {
  const { palette } = useTheme();
  const disabled = off || !!why || !onPress;
  const line = first ? null : { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border };
  const label = [fullName, isPrivate ? "Private" : "Public", branch, why].filter(Boolean).join(", ");
  return <Pressable testID={testID} accessibilityRole="checkbox" accessibilityLabel={label} accessibilityState={{ checked: on, disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.row, line, off ? styles.dim : null, pressed ? { backgroundColor: palette.raised } : null]}>
    {why ? <View style={styles.mark}><TriangleAlert size={17} color={palette.warning} /></View> : <Tick on={on} dim={off} />}
    <View style={styles.grow}>
      <RepositoryName fullName={fullName} />
      <RepositoryFacts isPrivate={isPrivate} branch={branch} />
      {why ? <Text style={[styles.detail, { color: palette.warning }]}>{why}</Text> : null}
    </View>
  </Pressable>;
}

const WIDTHS = ["62%", "48%", "70%", "55%", "40%"] as const;

/** A list while it loads (25.11): plain grey rows the height of the ones to come. Said aloud once, as loading. */
export function SkeletonRows({ count, label = "Loading repositories", testID }: { count: number; label?: string; testID?: string }) {
  const { palette } = useTheme();
  const bar = { backgroundColor: palette.selected };
  return <View testID={testID} accessible accessibilityRole="progressbar" accessibilityLabel={label} accessibilityState={{ busy: true }}>
    {Array.from({ length: count }, (_, index) => <View key={index} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.row, index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border } : null]}>
      <View style={[styles.tick, bar]} />
      <View style={styles.grow}>
        <View style={[styles.bar, bar, { width: WIDTHS[index % WIDTHS.length] }]} />
        <View style={[styles.bar, styles.short, bar]} />
      </View>
    </View>)}
  </View>;
}

const styles = StyleSheet.create({
  row: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 9 },
  tick: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  mark: { width: 22, alignItems: "center" },
  dim: { opacity: 0.5 },
  grow: { flex: 1, minWidth: 0 },
  name: { fontSize: 16, lineHeight: 21 },
  facts: { flexDirection: "row", alignItems: "center", gap: 5 },
  detail: { fontSize: 13, lineHeight: 18 },
  bar: { height: 12, borderRadius: 6 },
  short: { width: "30%", height: 10, marginTop: 8 },
});
