import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp } from "@mobile/state/AppProvider";
import { Button, Card } from "@mobile/ui/primitives";
import { useTheme } from "@mobile/ui/theme";

/**
 * The TerminalX account this phone is signed in to, opened from its row at
 * the top of Settings (22.05). Signing out is here, one step away from a
 * stray tap.
 */
export default function AccountScreen() {
  const app = useApp();
  const router = useRouter();
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const user = app.session?.user;
  const signOut = async () => {
    await app.signOut();
    router.back();
  };
  return <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: palette.page }} contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + 24 }]}>
    {user ? <>
      <Card style={styles.block}>
        <Text style={[styles.label, { color: palette.muted }]}>Signed in as</Text>
        {user.displayName ? <Text selectable style={[styles.name, { color: palette.ink }]}>{user.displayName}</Text> : null}
        <Text selectable style={[styles.detail, { color: palette.muted }]}>{user.email}</Text>
      </Card>
      <Text style={[styles.note, { color: palette.muted }]}>Signing out removes the machines this phone paired through your account, and the conversations it saved. Machines you paired with a QR code stay.</Text>
      <Button label="Sign out" kind="danger" onPress={() => void signOut()} />
    </> : <View style={styles.block}>
      <Text style={[styles.detail, { color: palette.muted }]}>Not signed in.</Text>
      <Button label="Sign in" onPress={() => void app.signIn()} />
    </View>}
  </ScrollView>;
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 14 },
  block: { padding: 16, gap: 4 },
  label: { fontSize: 13 },
  name: { fontSize: 17, fontWeight: "600" },
  detail: { fontSize: 15, lineHeight: 21 },
  note: { fontSize: 13, lineHeight: 18, marginHorizontal: 4 },
});
