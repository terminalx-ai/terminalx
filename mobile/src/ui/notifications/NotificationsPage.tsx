import { useEffect, useState, type ReactNode } from "react";
import { AppState, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { BellOff, Check, ChevronRight, CircleHelp, CircleX, Gauge, GitMerge, ShieldAlert, TriangleAlert, type LucideIcon } from "lucide-react-native";
import {
  machineOn,
  notificationPermission,
  openNotificationSettings,
  refreshLocalNotifications,
  setMachineNotifications,
  setNotificationsAllowed,
  updateNotificationSettings,
  useNotificationSettings,
  type LockScreenShow,
  type NotificationKind,
  type NotificationSettings,
  type PermissionState,
  type SessionScope,
} from "@mobile/notifications";
import { useApp } from "@mobile/state/AppProvider";
import { iconFor } from "@mobile/state/machines";
import { hostDisplayName, hostDisplayNames } from "@mobile/store/host-name";
import { MachineGlyph } from "../DeviceMenu";
import { Button, Card, Screen, SectionTitle } from "../primitives";
import { useTheme, type Palette } from "../theme";
import { ChoiceSheet, type Choice } from "./ChoiceSheet";
import { QUARTER_HOURS, quietSpan, timeOfDay } from "./time";

type Tone = "warning" | "success" | "danger" | "muted";
/** The page's rows in design 22.07's order and words, each with its mark in its colour. */
const AGENT_KINDS: [NotificationKind, string, LucideIcon, Tone][] = [
  ["question", "Asks a question", CircleHelp, "warning"],
  ["approval", "Needs approval", ShieldAlert, "warning"],
  ["finished", "Finishes its task", Check, "success"],
  ["failed", "Fails or stops on an error", TriangleAlert, "danger"],
  ["usage_limit", "Reaches a usage limit", Gauge, "muted"],
];
const PULL_REQUEST_KINDS: [NotificationKind, string, LucideIcon, Tone][] = [
  ["pr_checks_failed", "Checks fail", CircleX, "danger"],
  ["pr_merged", "Merged", GitMerge, "muted"],
];
const mark = (Icon: LucideIcon, tone: Tone, palette: Palette) => <Icon size={20} color={palette[tone]} />;
const SCOPES: [SessionScope, string][] = [
  ["all", "All sessions"],
  ["mine", "Only sessions I started or follow"],
];
const SHOW: Choice<LockScreenShow>[] = [
  { value: "everything", label: "Everything" },
  { value: "sessionName", label: "Session name only" },
  { value: "nothing", label: "Nothing" },
];
const SOUND: Choice<"default" | "none">[] = [
  { value: "default", label: "Default" },
  { value: "none", label: "None" },
];

/** Until push delivery (#989), what reaches the phone does so over the Mac's open connection. */
export const DELIVERY_NOTE = "Until push notifications arrive, notifications reach this phone only while TerminalX is open or was used recently.";

type Picking = null | "show" | "sound" | "start" | "end";

/**
 * Notifications (design 22.07, frames 2 to 4): what to be told of, for which
 * sessions and machines, when, and how much the lock screen shows. With iOS
 * notifications off for TerminalX the page says so and links to iOS
 * Settings; the choices stay, dimmed.
 */
export function NotificationsPage() {
  const app = useApp();
  const { palette } = useTheme();
  const settings = useNotificationSettings();
  const [permission, setPermission] = useState<PermissionState | null>(null);
  const [picking, setPicking] = useState<Picking>(null);

  // iOS's answer, read now and each time the app comes back from iOS Settings.
  useEffect(() => {
    let current = true;
    const read = (refresh: boolean) => void (refresh ? refreshLocalNotifications() : notificationPermission()).then((state) => { if (current) setPermission(state); }).catch(() => undefined);
    read(false);
    const subscription = AppState.addEventListener("change", (state) => { if (state === "active") read(true); });
    return () => { current = false; subscription.remove(); };
  }, []);

  if (!settings) return <Screen><Text style={[styles.detail, { color: palette.muted }]}>Reading your notification choices…</Text></Screen>;

  const iosOff = permission === "denied";
  // Kept, but not in force: dimmed while iOS or the master switch has them off.
  const dimmed = iosOff || !settings.allow;
  const change = (update: (current: NotificationSettings) => NotificationSettings) => void updateNotificationSettings(update);
  const setKind = (kind: NotificationKind, on: boolean) => change((current) => ({ ...current, kinds: { ...current.kinds, [kind]: on } }));
  const allow = async (on: boolean) => setPermission(await setNotificationsAllowed(on));
  const names = hostDisplayNames(app.hosts);

  return <Screen>
    {iosOff ? <Card accessibilityRole="alert" style={styles.notice}>
      <BellOff size={20} color={palette.warning} />
      <View style={styles.flex}>
        <Text style={[styles.noticeTitle, { color: palette.ink }]}>Notifications are off for TerminalX</Text>
        <Text style={[styles.detail, styles.noticeDetail, { color: palette.muted }]}>Turn them on in iOS Settings. Your choices below are kept.</Text>
        <Button label="Open iOS Settings" kind="secondary" size="small" onPress={() => void openNotificationSettings()} style={styles.noticeButton} />
      </View>
    </Card> : <>
      <Card><Row label="Allow notifications" first><Toggle label="Allow notifications" value={settings.allow} onChange={(on) => void allow(on)} /></Row></Card>
      <Text style={[styles.note, { color: palette.faint }]}>{DELIVERY_NOTE}</Text>
    </>}

    <View style={dimmed && styles.dimmed} pointerEvents={iosOff ? "none" : "auto"}>
      <SectionTitle>Notify me when an agent</SectionTitle>
      <Card>{AGENT_KINDS.map(([kind, label, Icon, tone], index) => <Row key={kind} icon={mark(Icon, tone, palette)} label={label} first={index === 0}><Toggle label={label} value={settings.kinds[kind]} disabled={iosOff} onChange={(on) => setKind(kind, on)} /></Row>)}</Card>

      <SectionTitle>Pull requests</SectionTitle>
      <Card>{PULL_REQUEST_KINDS.map(([kind, label, Icon, tone], index) => <Row key={kind} icon={mark(Icon, tone, palette)} label={label} first={index === 0}><Toggle label={`Pull request ${label.toLowerCase()}`} value={settings.kinds[kind]} disabled={iosOff} onChange={(on) => setKind(kind, on)} /></Row>)}</Card>

      <SectionTitle>Which sessions</SectionTitle>
      <Card>{SCOPES.map(([scope, label], index) => {
        const selected = settings.sessions === scope;
        // The one chosen carries the accent check, as 22.07 draws it.
        return <Pressable key={scope} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected, disabled: iosOff }} disabled={iosOff} onPress={() => change((current) => ({ ...current, sessions: scope }))} style={({ pressed }) => [styles.row, styles.choiceRow, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }, pressed && { backgroundColor: palette.selected }]}>
          <Text style={[styles.label, styles.flex, { color: palette.ink }]}>{label}</Text>
          {selected ? <Check size={18} color={palette.accent} /> : null}
        </Pressable>;
      })}</Card>

      <SectionTitle>Machines</SectionTitle>
      <Card>{app.hosts.length ? app.hosts.map((host, index) => {
        const name = names.get(host.id) ?? hostDisplayName(host);
        const on = machineOn(settings, host.id);
        // Its mark as the Machines list draws it, muted while its notifications are off.
        const icon = iconFor(name, app.accountHosts?.find((account) => account.hostId === host.id) ?? null);
        return <Row key={host.id} icon={<MachineGlyph icon={icon} color={on ? palette.ink : palette.muted} />} label={name} first={index === 0}><Toggle label={`Notifications from ${name}`} value={on} disabled={iosOff} onChange={(on) => void setMachineNotifications(host.id, on)} /></Row>;
      }) : <Row label="No paired Macs on this phone." first muted />}</Card>

      <SectionTitle>Quiet hours</SectionTitle>
      <Card>
        <Row label="Quiet hours" detail={quietSpan(settings.quietHours.start, settings.quietHours.end)} first><Toggle label="Quiet hours" value={settings.quietHours.on} disabled={iosOff} onChange={(on) => change((current) => ({ ...current, quietHours: { ...current.quietHours, on } }))} /></Row>
        {settings.quietHours.on ? <>
          <ValueRow label="Starts" value={timeOfDay(settings.quietHours.start)} disabled={iosOff} onPress={() => setPicking("start")} />
          <ValueRow label="Ends" value={timeOfDay(settings.quietHours.end)} disabled={iosOff} onPress={() => setPicking("end")} />
        </> : null}
        <Row label="Still notify when an agent needs me"><Toggle label="Still notify when an agent needs me" value={settings.quietHours.stillNotifyNeedsMe} disabled={iosOff} onChange={(on) => change((current) => ({ ...current, quietHours: { ...current.quietHours, stillNotifyNeedsMe: on } }))} /></Row>
      </Card>

      <SectionTitle>On the lock screen</SectionTitle>
      <Card>
        <ValueRow label="Show" value={SHOW.find((choice) => choice.value === settings.lockScreen.show)!.label} disabled={iosOff} first onPress={() => setPicking("show")} />
        <ValueRow label="Sound" value={settings.lockScreen.sound ? "Default" : "None"} disabled={iosOff} onPress={() => setPicking("sound")} />
      </Card>
    </View>

    <ChoiceSheet visible={picking === "show"} title="Show on the lock screen" choices={SHOW} current={settings.lockScreen.show} onClose={() => setPicking(null)} onChoose={(show) => change((current) => ({ ...current, lockScreen: { ...current.lockScreen, show } }))} />
    <ChoiceSheet visible={picking === "sound"} title="Sound" choices={SOUND} current={settings.lockScreen.sound ? "default" : "none"} onClose={() => setPicking(null)} onChoose={(sound) => change((current) => ({ ...current, lockScreen: { ...current.lockScreen, sound: sound === "default" } }))} />
    <ChoiceSheet visible={picking === "start" || picking === "end"} title={picking === "end" ? "Quiet hours end" : "Quiet hours start"} choices={QUARTER_HOURS.map((minutes) => ({ value: String(minutes), label: timeOfDay(minutes) }))} current={String(picking === "end" ? settings.quietHours.end : settings.quietHours.start)} onClose={() => setPicking(null)} onChoose={(value) => {
      const minutes = Number(value);
      const edge = picking === "end" ? "end" : "start";
      change((current) => ({ ...current, quietHours: { ...current.quietHours, [edge]: minutes } }));
    }} />
  </Screen>;
}

function Row({ icon, label, detail, first, muted, children }: { icon?: ReactNode; label: string; detail?: string; first?: boolean; muted?: boolean; children?: ReactNode }) {
  const { palette } = useTheme();
  return <View style={[styles.row, !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }]}>
    {icon}
    <View style={styles.flex}>
      <Text style={[styles.label, { color: muted ? palette.muted : palette.ink }]}>{label}</Text>
      {detail ? <Text style={[styles.detail, { color: palette.muted }]}>{detail}</Text> : null}
    </View>
    {children}
  </View>;
}

function ValueRow({ label, value, disabled, first, onPress }: { label: string; value: string; disabled?: boolean; first?: boolean; onPress(): void }) {
  const { palette } = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={`${label}, ${value}`} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.row, styles.choiceRow, !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }, pressed && { backgroundColor: palette.selected }]}>
    <Text style={[styles.label, styles.flex, { color: palette.ink }]}>{label}</Text>
    <Text style={[styles.value, { color: palette.muted }]}>{value}</Text>
    <ChevronRight size={18} color={palette.faint} />
  </Pressable>;
}

function Toggle({ label, value, disabled, onChange }: { label: string; value: boolean; disabled?: boolean; onChange(on: boolean): void }) {
  const { palette } = useTheme();
  return <Switch accessibilityLabel={label} value={value} disabled={disabled} onValueChange={onChange} trackColor={{ true: palette.accent }} />;
}

// 22.07's sizes: 56 pt rows of 16 pt words with a 20 pt mark, 48 pt rows for a choice or a value.
const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { minHeight: 56, paddingHorizontal: 14, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 12 },
  choiceRow: { minHeight: 48 },
  label: { fontSize: 16 },
  value: { fontSize: 15 },
  detail: { fontSize: 13, lineHeight: 18 },
  note: { fontSize: 12, lineHeight: 17, paddingHorizontal: 4, marginTop: 8 },
  notice: { padding: 14, borderRadius: 14, flexDirection: "row", alignItems: "flex-start", gap: 10 },
  noticeTitle: { fontSize: 16, fontWeight: "600" },
  noticeDetail: { marginTop: 2, marginBottom: 10 },
  noticeButton: { alignSelf: "flex-start" },
  dimmed: { opacity: 0.45 },
});
