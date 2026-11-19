import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Switch, Text, useColorScheme, View } from "react-native";
import { useRouter } from "expo-router";
import { Bell, Check, ChevronRight } from "lucide-react-native";
import { settingsSummary } from "@mobile/notifications/model";
import { useNotificationSettings } from "@mobile/notifications/store";
import type { MacSettings } from "@mobile/data/host-api";
import { appVersion } from "@mobile/state/app-version";
import { useApp } from "@mobile/state/AppProvider";
import { useHostFeatures } from "@mobile/state/host-features";
import { useMachines } from "@mobile/state/useMachines";
import { hostDisplayName } from "@mobile/store/host-name";
import { Button, Card, Screen, SectionTitle } from "@mobile/ui/primitives";
import { THEMES, themePalette, useTheme } from "@mobile/ui/theme";

/**
 * Settings (#987), in plain words. Machines are managed on the Machines tab
 * only; what is here is the account, alerts, the look, the options of the
 * machine in use, and where to read how data is kept.
 */
export default function SettingsScreen() {
  const app = useApp();
  const router = useRouter();
  const scheme = useColorScheme();
  const { name, palette, setName } = useTheme();
  const machine = useMachines().paired.find((item) => item.active);
  const notificationSettings = useNotificationSettings();
  // The machine's own settings: undefined while asking, null from a machine that does not offer them.
  const [mac, setMac] = useState<MacSettings | null | undefined>(undefined);
  const [macError, setMacError] = useState<string | null>(null);
  const connected = app.connectionStage === "connected";
  const [settingsRevision, setSettingsRevision] = useState(0);
  useEffect(() => app.api.onSettingsChanged(() => setSettingsRevision((value) => value + 1)), [app.api]);

  // Asked again when the machine starts or stops offering them (#730).
  const macOffered = useHostFeatures(app.api, app.activeHost?.id)?.macSettings === 1;
  const request = useMemo(() => ({ api: app.api, connected, host: app.activeHost?.id, macOffered, settingsRevision }), [app.api, connected, app.activeHost?.id, macOffered, settingsRevision]);
  const [previousRequest, setPreviousRequest] = useState(request);
  if (previousRequest !== request) {
    setPreviousRequest(request);
    setMac(undefined);
    setMacError(null);
  }
  useEffect(() => {
    if (!request.connected) return;
    let current = true;
    request.api.macSettings().then((value) => { if (current) setMac(value); }).catch((cause: unknown) => { if (current) { setMac(null); setMacError(cause instanceof Error ? cause.message : String(cause)); } });
    return () => { current = false; };
  }, [request]);

  const toggleNativeCodex = async (on: boolean) => {
    const before = mac;
    setMac(mac ? { ...mac, nativeCodex: on } : mac);
    setMacError(null);
    try {
      setMac(await app.api.setNativeCodex(on));
    } catch (cause) {
      setMac(before);
      setMacError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const user = app.session?.user;
  const who = user ? user.displayName ?? user.email : null;
  const machineName = machine?.name ?? (app.activeHost ? hostDisplayName(app.activeHost) : null);

  return <Screen title="Settings">
    {user ? <Card>
      <Pressable accessibilityRole="button" accessibilityLabel={`Account, ${who}`} onPress={() => router.push("/account")} style={({ pressed }) => [styles.accountRow, pressed && { backgroundColor: palette.raised }]}>
        <View style={[styles.avatar, { backgroundColor: palette.selected }]}><Text style={[styles.avatarText, { color: palette.ink }]}>{[...(who ?? "?")][0]!.toUpperCase()}</Text></View>
        <View style={styles.flex}><Text numberOfLines={1} style={[styles.rowTitle, { color: palette.ink }]}>{user.displayName ?? "TerminalX account"}</Text><Text numberOfLines={1} style={[styles.detail, { color: palette.muted }]}>{user.email}</Text></View>
        <ChevronRight size={18} color={palette.faint} />
      </Pressable>
    </Card> : <Card style={styles.block}><Text style={[styles.title, { color: palette.ink }]}>Not signed in</Text><Text style={[styles.detail, { color: palette.muted }]}>Sign in to see the machines on your TerminalX account.</Text><Button label="Sign in" onPress={() => void app.signIn()} />{app.error ? <Text accessibilityRole="alert" style={[styles.detail, { color: palette.danger }]}>{app.error}</Text> : null}</Card>}

    <SectionTitle>Notifications</SectionTitle>
    {/* Its own page (#990, design 22.07): the row says what is switched on. */}
    <Card><Pressable accessibilityRole="button" accessibilityLabel={`Notifications, ${notificationSettings ? settingsSummary(notificationSettings) : ""}`} onPress={() => router.push("/notifications")} style={({ pressed }) => [styles.settingRow, pressed && { backgroundColor: palette.raised }]}><Bell size={20} color={palette.ink} /><View style={styles.flex}><Text style={[styles.rowName, { color: palette.ink }]}>Notifications</Text>{notificationSettings ? <Text style={[styles.detail, { color: palette.muted }]}>{settingsSummary(notificationSettings)}</Text> : null}</View><ChevronRight size={18} color={palette.faint} /></Pressable></Card>

    <SectionTitle>Appearance</SectionTitle>
    <View style={styles.themeGrid}>{THEMES.map((theme) => {
      const colours = themePalette(theme, scheme);
      const selected = theme === name;
      return <Pressable key={theme} accessibilityRole="button" accessibilityLabel={`${theme} theme`} accessibilityState={{ selected }} onPress={() => setName(theme)} style={[styles.theme, { backgroundColor: palette.raised, borderColor: selected ? palette.accent : palette.border }]}>
        <View testID={`theme-preview-${theme}`} style={[styles.swatch, { backgroundColor: colours.page, borderColor: palette.border }]}><View style={[styles.swatchAccent, { backgroundColor: colours.accent }]} /></View>
        <View style={styles.themeName}><Text style={[styles.themeLabel, { color: palette.ink }]}>{theme}</Text>{selected ? <Check size={15} color={palette.accent} /> : null}</View>
      </Pressable>;
    })}</View>

    {app.activeHost && machineName ? <><SectionTitle>{machineName}</SectionTitle>
    <Card>{mac ? <View style={styles.settingRow}><View style={styles.flex}><Text style={[styles.rowTitle, { color: palette.ink }]}>Native Codex</Text><Text style={[styles.detail, { color: palette.muted }]}>Experimental. A more reliable chat for new Codex sessions.</Text></View><Switch accessibilityLabel="Native Codex" value={mac.nativeCodex} onValueChange={(value) => void toggleNativeCodex(value)} trackColor={{ true: palette.accent }} /></View>
      : <View style={styles.block}><Text style={[styles.detail, { color: palette.muted }]}>{!connected ? "Connect to this machine to change its settings." : mac === undefined ? "Reading this machine’s settings…" : macError ?? "Update TerminalX on this machine to change its settings from your phone."}</Text></View>}
      {mac && macError ? <Text accessibilityRole="alert" style={[styles.detail, styles.macError, { color: palette.danger }]}>{macError}</Text> : null}</Card></> : null}

    <SectionTitle>Privacy and help</SectionTitle>
    <Card>
      <LinkRow label="How your data stays on your Mac" onPress={() => router.push("/privacy")} />
      <LinkRow label="Connection log" divided onPress={() => router.push("/connection-log")} />
      <LinkRow label="Send a support report" divided onPress={() => router.push("/support-report")} />
      <View style={[styles.linkRow, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }]}><Text style={[styles.linkLabel, styles.flex, { color: palette.ink }]}>Version</Text><Text selectable style={[styles.value, { color: palette.muted }]}>{appVersion()}</Text></View>
    </Card>
  </Screen>;
}

function LinkRow({ label, divided, onPress }: { label: string; divided?: boolean; onPress(): void }) {
  const { palette } = useTheme();
  return <Pressable accessibilityRole="link" onPress={onPress} style={({ pressed }) => [styles.linkRow, divided && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }, pressed && { backgroundColor: palette.raised }]}>
    <Text style={[styles.linkLabel, styles.flex, { color: palette.ink }]}>{label}</Text><ChevronRight size={18} color={palette.faint} />
  </Pressable>;
}

const styles = StyleSheet.create({
  block: { padding: 16, gap: 10 },
  accountRow: { minHeight: 64, paddingHorizontal: 14, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 12 },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  avatarText: { fontSize: 17, fontWeight: "600" },
  title: { fontSize: 17, fontWeight: "700" },
  rowTitle: { fontSize: 16, fontWeight: "600" },
  // A row that opens a page (22.07's Notifications): its mark, then its name in plain 16 pt.
  rowName: { fontSize: 16 },
  linkLabel: { fontSize: 16 },
  themeLabel: { fontSize: 14 },
  value: { fontSize: 14 },
  detail: { fontSize: 13, lineHeight: 18 },
  flex: { flex: 1 },
  themeGrid: { flexDirection: "row", gap: 8 },
  theme: { flex: 1, borderWidth: 1, borderRadius: 12, padding: 8, gap: 6 },
  swatch: { height: 34, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, justifyContent: "flex-end", padding: 6 },
  swatchAccent: { width: 22, height: 6, borderRadius: 3 },
  themeName: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 2 },
  settingRow: { minHeight: 56, paddingHorizontal: 14, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 12 },
  linkRow: { minHeight: 48, paddingHorizontal: 14, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  macError: { paddingHorizontal: 15, paddingBottom: 12 },
});
