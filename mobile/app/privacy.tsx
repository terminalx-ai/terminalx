import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "@mobile/ui/theme";

/**
 * How data stays on the Mac (#987), in plain words. Each line says what
 * the app does today: sessions run on the machine, the phone keeps only
 * what it showed, the relay passes messages it cannot read, and the
 * account knows machines by name and whether they are online.
 */
const PRIVACY_SECTIONS: readonly { title: string; body: string }[] = [
  { title: "Your sessions stay on your computer", body: "Agents run on your computer, and their conversations and files are kept there. They are not uploaded to TerminalX." },
  { title: "This phone keeps only what it showed you", body: "So you can read a conversation with no connection, this phone keeps the parts of it you have opened. Forgetting a machine deletes them from the phone." },
  { title: "Only your devices can read your messages", body: "The phone reaches your computer directly on the same network, or through the TerminalX relay. Everything is encrypted on one device and opened only on the other, so the relay cannot read it." },
  { title: "What your account knows", body: "When you sign in, your account lists your machines by name, with whether each one is online. It does not hold your projects, folders or conversations." },
  { title: "The connection log", body: "The log in Settings records when this phone connected and what went wrong. It stays on this phone, keeps only server names, not full addresses, and never holds your messages." },
  { title: "Support reports", body: "You can review and send selected connection events to TerminalX Support. The report can include times, app versions and connection problems. Support keeps reports for 30 days." },
];

export default function PrivacyScreen() {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  return <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: palette.page }} contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + 24 }]}>
    {PRIVACY_SECTIONS.map((section) => <View key={section.title} style={styles.section}>
      <Text accessibilityRole="header" style={[styles.title, { color: palette.ink }]}>{section.title}</Text>
      <Text style={[styles.body, { color: palette.muted }]}>{section.body}</Text>
    </View>)}
  </ScrollView>;
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 22 },
  section: { gap: 6 },
  title: { fontSize: 17, fontWeight: "700" },
  body: { fontSize: 15, lineHeight: 22 },
});
