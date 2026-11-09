import type { ComponentProps } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Tabs } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Cloud, Laptop, MessagesSquare, Plus, Settings, type LucideIcon } from "lucide-react-native";
import { EdgeFade } from "./EdgeFade";
import { TAB_BAR_PILL, tabBarHeight } from "./tab-bar-inset";
import { Glass } from "./glass";
import { useTheme } from "./theme";

export type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>["tabBar"]>>[0];

const PILL = TAB_BAR_PILL;

/** Each tab's icon and name; the name is for assistive technology, the bar shows icons alone. */
const TABS: Record<string, { icon: LucideIcon; label: string; testID?: string }> = {
  index: { icon: Laptop, label: "Machines", testID: "machines-tab" },
  sessions: { icon: MessagesSquare, label: "Sessions", testID: "sessions-tab" },
  cloud: { icon: Cloud, label: "Cloud" },
  settings: { icon: Settings, label: "Settings" },
};

/**
 * Where to go on the left, in a Liquid Glass pill of icons; what to do on the
 * right, in one solid button: a new session. `dotted` marks a tab with
 * something waiting on the reader. (On the current tab library, iOS cannot
 * set a + apart in its own bar, so this one is drawn here.)
 */
export function FloatingTabBar({ state, navigation, dotted, onNew }: Pick<TabBarProps, "state" | "navigation"> & { dotted?: string[]; onNew(): void }) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  // The bar floats over the content, which fades and blurs away under it rather than stopping short.
  return <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom - 6, 12) }]}>
    <EdgeFade edge="bottom" height={tabBarHeight(insets.bottom) + 28} />
    <Glass interactive style={styles.pill}>
      {state.routes.map((route, index) => {
        const tab = TABS[route.name];
        if (!tab) return null;
        const focused = state.index === index;
        const Icon = tab.icon;
        const press = () => {
          const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params);
        };
        return <Pressable key={route.key} accessibilityRole="tab" accessibilityLabel={tab.label} accessibilityState={{ selected: focused }} testID={tab.testID} onPress={press} hitSlop={4} style={[styles.tab, focused && { backgroundColor: palette.selected }]}>
          <Icon size={22} color={focused ? palette.ink : palette.muted} strokeWidth={focused ? 2.2 : 1.8} />
          {dotted?.includes(route.name) ? <View style={[styles.dot, { backgroundColor: palette.danger, borderColor: focused ? palette.selected : palette.raised }]} /> : null}
        </Pressable>;
      })}
    </Glass>
    <View style={styles.flex} />
    <Pressable accessibilityRole="button" accessibilityLabel="New session" testID="new-session" onPress={onNew} style={({ pressed }) => [styles.new, { backgroundColor: palette.ink, opacity: pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.95 : 1 }] }]}>
      <Plus size={26} color={palette.page} strokeWidth={2.4} />
    </Pressable>
  </View>;
}

const styles = StyleSheet.create({
  bar: { position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: 8 },
  flex: { flex: 1 },
  pill: { flexDirection: "row", alignItems: "center", height: PILL, borderRadius: PILL / 2, paddingHorizontal: 6, gap: 2 },
  tab: { width: 56, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center" },
  dot: { position: "absolute", top: 10, right: 14, width: 9, height: 9, borderRadius: 5, borderWidth: 1.5 },
  new: { width: 60, height: 60, borderRadius: 30, alignItems: "center", justifyContent: "center", shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } },
});
