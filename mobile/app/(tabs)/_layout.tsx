import { Tabs } from "expo-router";
import { Cpu, ListTodo, Settings } from "lucide-react-native";
import { useTheme } from "@mobile/ui/theme";

export default function TabLayout() {
  const { palette } = useTheme();
  return <Tabs screenOptions={{ headerStyle: { backgroundColor: palette.page }, headerTintColor: palette.ink, headerShadowVisible: false, sceneStyle: { backgroundColor: palette.page }, tabBarActiveTintColor: palette.accent, tabBarInactiveTintColor: palette.muted, tabBarStyle: { backgroundColor: palette.card, borderTopColor: palette.border } }}>
    <Tabs.Screen name="index" options={{ title: "Machines", tabBarIcon: ({ color, size }) => <Cpu color={color} size={size} /> }} />
    <Tabs.Screen name="sessions" options={{ title: "Sessions", tabBarIcon: ({ color, size }) => <ListTodo color={color} size={size} /> }} />
    <Tabs.Screen name="settings" options={{ title: "Settings", tabBarIcon: ({ color, size }) => <Settings color={color} size={size} /> }} />
  </Tabs>;
}
