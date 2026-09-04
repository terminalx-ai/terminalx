import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { Check, ChevronDown, ChevronUp, Trash2 } from "lucide-react-native";
import { disableLocalNotifications, enableLocalNotifications, localNotificationsEnabled } from "@mobile/notifications/local";
import { useApp } from "@mobile/state/AppProvider";
import { Button, Card, Screen, SectionTitle } from "@mobile/ui/primitives";
import { useTheme, type ThemeName } from "@mobile/ui/theme";

const themes: ThemeName[] = ["Den", "Slate", "Moss", "Ember"];

export default function SettingsScreen() {
  const app = useApp();
  const { name, palette, setName } = useTheme();
  const [notifications, setNotifications] = useState(false);
  const [logOpen, setLogOpen] = useState(false);

  useEffect(() => {
    let current = true;
    const enabled = app.activeHost ? localNotificationsEnabled(app.activeHost.id) : Promise.resolve(false);
    void enabled.then((value) => { if (current) setNotifications(value); });
    return () => { current = false; };
  }, [app.activeHost]);

  const toggleNotifications = async (enabled: boolean) => {
    if (!enabled) {
      if (app.activeHost) await disableLocalNotifications(app.activeHost.id);
      setNotifications(false);
      return;
    }
    if (!app.activeHost || app.connectionStage !== "connected") {
      Alert.alert("Connect a Mac", "Notifications are delivered over the active encrypted connection.");
      return;
    }
    setNotifications(await enableLocalNotifications(app.connection, app.activeHost.id));
  };

  return <Screen>
    <SectionTitle>Account</SectionTitle>
    <Card style={styles.block}>{app.session ? <><Text style={[styles.title, { color: palette.ink }]}>{app.session.user.displayName ?? "TerminalX account"}</Text><Text style={[styles.detail, { color: palette.muted }]}>{app.session.user.email}</Text><Button label="Sign out" kind="secondary" onPress={() => void app.signOut()} /></> : <><Text style={[styles.title, { color: palette.ink }]}>Not signed in</Text><Text style={[styles.detail, { color: palette.muted }]}>Sign in to discover Macs bound to your account.</Text><Button label="Sign in" onPress={() => void app.signIn()} /></>}</Card>

    <SectionTitle>Paired machines</SectionTitle>
    <Card>{app.hosts.length ? app.hosts.map((host, index) => <View key={host.id} style={[styles.hostRow, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }]}><View style={styles.flex}><Text style={[styles.rowTitle, { color: palette.ink }]}>{host.label}</Text><Text style={[styles.detail, { color: palette.muted }]}>{host.provenance.kind === "explicit" ? "QR pairing · kept after sign-out" : "Account pairing · removed at sign-out"}</Text></View><Pressable accessibilityRole="button" accessibilityLabel={`Forget ${host.label}`} hitSlop={10} onPress={() => Alert.alert("Forget this Mac?", "Its device credential will be deleted from this phone. Agents on the Mac keep running.", [{ text: "Cancel", style: "cancel" }, { text: "Forget", style: "destructive", onPress: () => void app.forgetHost(host.id) }])}><Trash2 size={19} color={palette.danger} /></Pressable></View>) : <View style={styles.block}><Text style={[styles.detail, { color: palette.muted }]}>No paired Macs on this phone.</Text></View>}</Card>

    <SectionTitle>Appearance</SectionTitle>
    <Card style={styles.themeGrid}>{themes.map((theme) => <Pressable key={theme} accessibilityRole="button" accessibilityState={{ selected: theme === name }} onPress={() => setName(theme)} style={[styles.theme, { backgroundColor: theme === name ? palette.selected : palette.raised }]}><Text style={[styles.rowTitle, { color: palette.ink }]}>{theme}</Text>{theme === name ? <Check size={17} color={palette.accent} /> : null}</Pressable>)}</Card>

    <SectionTitle>Notifications</SectionTitle>
    <Card><View style={styles.settingRow}><View style={styles.flex}><Text style={[styles.rowTitle, { color: palette.ink }]}>Local completion alerts</Text><Text style={[styles.detail, { color: palette.muted }]}>No push service. Alerts arrive while iOS lets TerminalX keep its encrypted socket open.</Text></View><Switch value={notifications} onValueChange={(value) => void toggleNotifications(value)} trackColor={{ true: palette.accent }} /></View></Card>

    <SectionTitle>Connection</SectionTitle>
    <Card><Pressable accessibilityRole="button" onPress={() => setLogOpen((value) => !value)} style={styles.settingRow}><View style={styles.flex}><Text style={[styles.rowTitle, { color: palette.ink }]}>Connection log</Text><Text style={[styles.detail, { color: palette.muted }]}>{app.logs.length} redacted events on this phone</Text></View>{logOpen ? <ChevronUp color={palette.muted} /> : <ChevronDown color={palette.muted} />}</Pressable>{logOpen ? <View style={[styles.log, { borderTopColor: palette.border }]}>{app.logs.length ? [...app.logs].reverse().map((entry) => <View key={entry.id} style={styles.logRow}><Text style={[styles.logTime, { color: palette.faint }]}>{new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</Text><View style={styles.flex}><Text style={[styles.detail, { color: entry.level === "error" ? palette.danger : entry.level === "warning" ? palette.warning : palette.ink }]}>{entry.message}</Text>{entry.detail ? <Text style={[styles.logDetail, { color: palette.muted }]}>{entry.detail}</Text> : null}</View></View>) : <Text style={[styles.detail, { color: palette.muted }]}>No connection attempts yet.</Text>}</View> : null}</Card>

    <Card style={styles.privacy}><Text style={[styles.title, { color: palette.ink }]}>Mac is the source of truth</Text><Text style={[styles.detail, { color: palette.muted }]}>Transcripts are never uploaded. This phone caches only the bounded pages it displayed for offline reading. Pairing and RPC travel through relay.terminalx.ai as end-to-end encrypted ciphertext.</Text></Card>
  </Screen>;
}

const styles = StyleSheet.create({
  block: { padding: 16, gap: 10 },
  title: { fontSize: 17, fontWeight: "700" },
  rowTitle: { fontSize: 15, fontWeight: "600" },
  detail: { fontSize: 13, lineHeight: 19 },
  flex: { flex: 1 },
  hostRow: { minHeight: 67, paddingHorizontal: 15, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 12 },
  themeGrid: { padding: 8, flexDirection: "row", flexWrap: "wrap", gap: 8 },
  theme: { minHeight: 44, flexBasis: "47%", flexGrow: 1, paddingHorizontal: 12, borderRadius: 10, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  settingRow: { minHeight: 72, padding: 15, flexDirection: "row", alignItems: "center", gap: 12 },
  log: { borderTopWidth: StyleSheet.hairlineWidth, padding: 14, gap: 11 },
  logRow: { flexDirection: "row", gap: 10 },
  logTime: { width: 70, fontSize: 11, fontVariant: ["tabular-nums"] },
  logDetail: { fontSize: 11, marginTop: 2 },
  privacy: { padding: 16, gap: 7, marginTop: 8 },
});
