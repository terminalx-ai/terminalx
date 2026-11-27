import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useRouter } from "expo-router";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { InTabs, newSessionInBar, TabBarInset, tabBarHeight } from "@mobile/ui/tab-bar-inset";
import { textSizeScreenLayout } from "@mobile/ui/text-size";
import { useTheme } from "@mobile/ui/theme";
import { useApp } from "@mobile/state/AppProvider";
import { useBotsOffered } from "@mobile/state/bots";

// Each tab laid out again when the text size changes (PRO-601). Expo Router hands `screenLayout` on to the
// navigator as it does for Stack, but NativeTabs' props type leaves it out, so it is spread in.
const TAB_PAGE = { screenLayout: textSizeScreenLayout };

// The system tab bar, Liquid Glass on iOS 26 and later: the tabs on the left and, set apart on the
// right where iOS sets its one special tab, a new session. Outline marks throughout, the filled ones
// standing too heavy in the bar; no badge, which drew a dot even with nothing waiting. Android draws
// a Material bar: Material Symbols for the marks, every label shown, in the theme's colours.
export default function TabLayout() {
  const { palette } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const app = useApp();
  // Bots only while the connected computer offers them, which it does with Bots on (PRO-479): otherwise the bar is as it was.
  const bots = useBotsOffered(app.api, app.activeHost?.id) === true;
  // On iOS the bar floats over the content: a tab's last row scrolls clear of it.
  return <InTabs.Provider value={true}><TabBarInset.Provider value={tabBarHeight(insets.bottom)}><NativeTabs
    {...TAB_PAGE}
    tintColor={palette.ink}
    minimizeBehavior="onScrollDown"
    labelVisibilityMode="labeled"
    backgroundColor={Platform.OS === "android" ? palette.card : undefined}
    iconColor={Platform.OS === "android" ? { default: palette.muted, selected: palette.ink } : undefined}
    labelStyle={Platform.OS === "android" ? { default: { color: palette.muted }, selected: { color: palette.ink } } : undefined}
    indicatorColor={Platform.OS === "android" ? palette.selected : undefined}
  >
    <NativeTabs.Trigger name="index" testID="machines-tab">
      <NativeTabs.Trigger.Icon sf="laptopcomputer" md="computer" />
      <NativeTabs.Trigger.Label>Machines</NativeTabs.Trigger.Label>
    </NativeTabs.Trigger>
    <NativeTabs.Trigger name="sessions" testID="sessions-tab">
      <NativeTabs.Trigger.Icon sf="rectangle.stack" md="stacks" />
      <NativeTabs.Trigger.Label>Sessions</NativeTabs.Trigger.Label>
    </NativeTabs.Trigger>
    <NativeTabs.Trigger name="bots" hidden={!bots} testID="bots-tab">
      <NativeTabs.Trigger.Icon sf="person.2.badge.gearshape" md="smart_toy" />
      <NativeTabs.Trigger.Label>Bots</NativeTabs.Trigger.Label>
    </NativeTabs.Trigger>
    <NativeTabs.Trigger name="cloud">
      <NativeTabs.Trigger.Icon sf="cloud" md="cloud" />
      <NativeTabs.Trigger.Label>Cloud</NativeTabs.Trigger.Label>
    </NativeTabs.Trigger>
    <NativeTabs.Trigger name="settings">
      <NativeTabs.Trigger.Icon sf="gearshape" md="settings" />
      <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
    </NativeTabs.Trigger>
    {/* An action, not a tab: the bar never selects it, and pressing it opens a new session over the tabs. */}
    <NativeTabs.Trigger name="new" hidden={!newSessionInBar()} role="search" testID="new-session" unstable_nativeProps={{ preventNativeSelection: true }} listeners={{ tabPress: () => router.push("/session/new") }}>
      <NativeTabs.Trigger.Icon sf="plus" md="add" />
      <NativeTabs.Trigger.Label>New session</NativeTabs.Trigger.Label>
    </NativeTabs.Trigger>
  </NativeTabs></TabBarInset.Provider></InTabs.Provider>;
}
