import { Pressable, StyleSheet, Text, View } from "react-native";
import { Box, ChevronRight, Cloud, Container, Server, Ship, type LucideIcon } from "lucide-react-native";
import { badgeLabel, StateBadge, type BadgeState } from "./StateBadge";
import { useTheme } from "./theme";

// The server names a shape, not a provider (the desktop reads the same words).
const GLYPHS: Record<string, LucideIcon> = { cloud: Cloud, ship: Ship, server: Server, container: Container, box: Box };

/**
 * A provider's or an agent's mark (25.03, 25.04): the shape the server named
 * in a rounded square, a box for a shape this app does not have, or an
 * initial where there is no shape at all.
 */
export function ProviderMark({ icon, letter, testID }: { icon?: string; letter?: string; testID?: string }) {
  const { palette } = useTheme();
  const Glyph = (icon && Object.hasOwn(GLYPHS, icon) ? GLYPHS[icon] : null) ?? Box;
  return <View testID={testID} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.mark, { backgroundColor: palette.raised, borderColor: palette.border }]}>
    {letter ? <Text style={[styles.letter, { color: palette.muted }]}>{letter.slice(0, 1).toUpperCase()}</Text> : <Glyph size={17} color={palette.muted} />}
  </View>;
}

/**
 * A provider as the server describes it (25.03): mark, name and state, its
 * description, then how it bills. An agent login is the same row with an
 * initial and no billing line (25.04). It opens something only when it is
 * given somewhere to go.
 */
export function ProviderRow({ name, description, billing, icon, letter, badge, badgeAtEnd, divided, onPress, testID }: {
  name: string;
  description?: string;
  billing?: string;
  icon?: string;
  letter?: string;
  badge?: BadgeState | null;
  /** The provider's own page heads its card with this row: the state sits at the end, level with the name. */
  badgeAtEnd?: boolean;
  /** A hairline above, for every row of a card but the first. */
  divided?: boolean;
  onPress?(): void;
  testID?: string;
}) {
  const { palette } = useTheme();
  const body = <>
    <ProviderMark icon={icon} letter={letter} />
    <View style={styles.body}>
      <View style={styles.heading}>
        <Text numberOfLines={1} style={[styles.name, { color: palette.ink }]}>{name}</Text>
        {badge && !badgeAtEnd ? <StateBadge state={badge} /> : null}
      </View>
      {description ? <Text style={[styles.detail, { color: palette.muted }]}>{description}</Text> : null}
      {billing ? <Text style={[styles.detail, { color: palette.faint }]}>{billing}</Text> : null}
    </View>
    {badge && badgeAtEnd ? <StateBadge state={badge} /> : null}
    {onPress ? <View style={styles.trailing}><ChevronRight size={18} color={palette.faint} /></View> : null}
  </>;
  const line = divided ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border } : null;
  const said = [name, badge ? badgeLabel(badge) : null, description, billing].filter(Boolean).join(", ");
  if (!onPress) return <View testID={testID} accessible accessibilityLabel={said} style={[styles.row, badgeAtEnd ? styles.level : null, line]}>{body}</View>;
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={said} onPress={onPress} style={({ pressed }) => [styles.row, badgeAtEnd ? styles.level : null, line, { backgroundColor: pressed ? palette.raised : undefined }]}>{body}</Pressable>;
}

const styles = StyleSheet.create({
  mark: { width: 32, height: 32, borderRadius: 9, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
  letter: { fontSize: 14, fontWeight: "600" },
  row: { minHeight: 56, flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  level: { alignItems: "center" },
  body: { flex: 1, minWidth: 0 },
  heading: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { flexShrink: 1, fontSize: 16, lineHeight: 21, fontWeight: "600" },
  detail: { fontSize: 13, lineHeight: 18, marginTop: 2 },
  trailing: { height: 21, justifyContent: "center" },
});
