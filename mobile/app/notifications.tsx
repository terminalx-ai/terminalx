import { StyleSheet, View } from "react-native";
import { Stack, useRouter } from "expo-router";
import { NotificationsPage } from "@mobile/ui/notifications/NotificationsPage";
import { ScreenHeader } from "@mobile/ui/SessionChrome";
import { useTheme } from "@mobile/ui/theme";

/** 22.07 draws the page under its own bar, as the session and workspace screens have: a round Back and the title beside it. */
export default function NotificationsScreen() {
  const router = useRouter();
  const { palette } = useTheme();
  return <View style={[styles.page, { backgroundColor: palette.page }]}>
    <Stack.Screen options={{ title: "Notifications", headerShown: false }} />
    <ScreenHeader title="Notifications" onBack={() => router.back()} />
    <NotificationsPage />
  </View>;
}

const styles = StyleSheet.create({ page: { flex: 1 } });
