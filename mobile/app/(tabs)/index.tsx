import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";
import { useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { ChevronRight, Keyboard, QrCode, X } from "lucide-react-native";
import { ACCOUNT_PAIRING_CAPABILITY } from "@mobile/pairing/contracts";
import type { AccountHost } from "@mobile/pairing/account-client";
import type { PairingProgress } from "@mobile/pairing/pair";
import { accountHostIdentityMatches } from "@mobile/pairing/account";
import { useApp } from "@mobile/state/AppProvider";
import { Button, Card, EmptyState, Screen, SectionTitle, StatusDot } from "@mobile/ui/primitives";
import { useTheme } from "@mobile/ui/theme";
import { PairingScanner } from "@mobile/ui/PairingScanner";
import { DeviceOptionsButton, useDeviceMenu } from "@mobile/ui/DeviceMenu";

export default function MachinesScreen() {
  const app = useApp();
  const { palette } = useTheme();
  const router = useRouter();
  const [pairingOpen, setPairingOpen] = useState(false);
  const { session, refreshMachines } = app;

  const menu = useDeviceMenu();
  const openPairing = () => { app.clearError(); setPairingOpen(true); };
  const closePairing = () => { app.clearError(); setPairingOpen(false); };

  useEffect(() => { if (session) void refreshMachines(); }, [refreshMachines, session]);

  const connect = async (host: (typeof app.hosts)[number]) => {
    // Sessions is a sibling tab. dismissTo emits a stack POP_TO action, which
    // the tab navigator cannot handle when Machines is already at the root.
    if (await app.connectHost(host)) router.navigate("/(tabs)/sessions");
  };

  if (!app.ready) return <Screen title="Machines"><EmptyState title="Loading" detail="Reading this installation's device-only credentials." busy /></Screen>;
  if (!app.session) {
    return <>
      <Screen title="Machines" contentContainerStyle={app.hosts.length ? undefined : styles.signedOut}>
        <View style={[styles.mark, { backgroundColor: palette.accent }]}><Text style={[styles.markText, { color: palette.accentInk }]}>TX</Text></View>
        <Text style={[styles.heroTitle, { color: palette.ink }]}>Your work, away from your desk</Text>
        <Text style={[styles.heroDetail, { color: palette.muted }]}>Sign in with the same TerminalX account as your Mac, or use an explicit QR pairing. Sessions stay on the Mac and travel over an end-to-end encrypted connection.</Text>
        <Button label="Sign in" onPress={() => void app.signIn()} />
        {app.error ? <Card style={[styles.errorPanel, { borderColor: `${palette.danger}66` }]}><Text style={[styles.errorTitle, { color: palette.ink }]}>Couldn’t finish that</Text><Text style={[styles.detail, { color: palette.muted }]}>{app.error}</Text><View style={styles.actions}><Button label="Retry" kind="secondary" style={styles.flex} onPress={() => void app.retryPairing().catch(() => undefined)} /><Button label="Use QR code" kind="secondary" style={styles.flex} onPress={openPairing} /></View></Card> : null}
        {app.hosts.length ? <><SectionTitle>QR-paired machines</SectionTitle><Card>{app.hosts.map((host, index) => <View key={host.id} style={[styles.hostRow, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }]}><Pressable testID={`machine-row-${host.id}`} accessibilityRole="button" accessibilityActions={[{ name: "options", label: "Device options" }]} onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === "options") menu.open(host); }} onPress={() => void connect(host)} onLongPress={() => menu.open(host)} style={({ pressed }) => [styles.row, styles.hostRowMain, pressed && { backgroundColor: palette.raised }]}><StatusDot color={app.activeHost?.id === host.id && app.connectionStage === "connected" ? palette.success : palette.muted} /><View style={styles.rowCopy}><Text numberOfLines={1} style={[styles.rowTitle, { color: palette.ink }]}>{menu.nameOf(host)}</Text><Text style={[styles.detail, { color: palette.muted }]}>{app.activeHost?.id === host.id ? connectionLabel(app.connectionStage, app.connectionAttempt) : host.disconnectedOnMacAt ? connectionLabel("disconnected-on-mac", 0) : relativeTime(host.lastConnectedAt)}</Text></View><ChevronRight size={18} color={palette.faint} /></Pressable><DeviceOptionsButton name={menu.nameOf(host)} onPress={() => menu.open(host)} /></View>)}</Card></> : null}
        <Button label="Use QR code or pairing code" kind="secondary" onPress={openPairing} />
      </Screen>
      {menu.element}
      <PairingSheet key={pairingOpen ? "open" : "closed"} visible={pairingOpen} progress={app.pairingProgress ?? null} error={app.error} onClearError={app.clearError} onClose={closePairing} onPair={async (code) => { await app.pairCode(code); setPairingOpen(false); }} />
    </>;
  }

  return <>
    <Screen title="Machines" refreshControl={<RefreshControl refreshing={app.loadingMachines} onRefresh={() => void app.refreshMachines()} tintColor={palette.accent} />}>
      {app.error ? <Card style={[styles.errorPanel, { borderColor: `${palette.danger}66` }]}><Text style={[styles.errorTitle, { color: palette.ink }]}>Couldn’t finish that</Text><Text style={[styles.detail, { color: palette.muted }]}>{app.error}</Text><View style={styles.actions}><Button label="Retry" kind="secondary" style={styles.flex} onPress={() => void app.refreshMachines()} /><Button label="Use QR code" kind="secondary" style={styles.flex} onPress={openPairing} /></View></Card> : null}
      <View style={styles.heading}><View><Text style={[styles.account, { color: palette.ink }]}>{app.session.user.displayName ?? app.session.user.email}</Text><Text style={[styles.detail, { color: palette.muted }]}>One active Mac at a time</Text></View><Button label="Pair" kind="secondary" onPress={openPairing} /></View>

      <SectionTitle>Paired machines</SectionTitle>
      {app.hosts.length ? <Card>{app.hosts.map((host, index) => <View key={host.id} style={[styles.hostRow, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }]}><Pressable testID={`machine-row-${host.id}`} accessibilityRole="button" accessibilityActions={[{ name: "options", label: "Device options" }]} onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === "options") menu.open(host); }} onPress={() => void connect(host)} onLongPress={() => menu.open(host)} style={({ pressed }) => [styles.row, styles.hostRowMain, pressed && { backgroundColor: palette.raised }]}><StatusDot color={app.activeHost?.id === host.id && app.connectionStage === "connected" ? palette.success : palette.muted} /><View style={styles.rowCopy}><Text numberOfLines={1} style={[styles.rowTitle, { color: palette.ink }]}>{menu.nameOf(host)}</Text><Text style={[styles.detail, { color: palette.muted }]}>{app.activeHost?.id === host.id ? connectionLabel(app.connectionStage, app.connectionAttempt) : host.disconnectedOnMacAt ? connectionLabel("disconnected-on-mac", 0) : relativeTime(host.lastConnectedAt)}</Text></View><ChevronRight size={18} color={palette.faint} /></Pressable><DeviceOptionsButton name={menu.nameOf(host)} onPress={() => menu.open(host)} /></View>)}</Card> : <EmptyState title="No paired Macs" detail="Choose a live Mac below, or pair from the QR code in TerminalX on your Mac." />}

      <SectionTitle>Your machines</SectionTitle>
      {app.installationState === "reauthentication-required" ? <StateCard title="Sign in again to verify this installation" detail="For your security, pairing needs a recent sign-in." action="Sign in again" onPress={() => void app.signIn()} /> : null}
      {app.installationState === "approval-required" ? <StateCard title="Awaiting approval" detail="Approve this installation from your TerminalX account, then retry." action="Retry" onPress={() => void app.refreshMachines()} /> : null}
      {app.loadingMachines && !app.availableHosts.length ? <EmptyState title="Loading" detail="Looking for Macs bound to your account." busy /> : null}
      {app.availableHosts.length ? <Card>{app.availableHosts.map((host, index) => <AvailableMachine key={host.hostId} host={host} divided={index > 0} onPair={() => void app.pairAvailable(host)} />)}</Card> : !app.loadingMachines && app.installationState === "ready" ? <EmptyState title="No unpaired Macs found" detail="A Mac appears here after TerminalX is signed in and its host service is live. QR pairing remains available." /> : null}
      <Button label="Use QR code or pairing code" kind="secondary" onPress={openPairing} />
    </Screen>
    {menu.element}
    <PairingSheet key={pairingOpen ? "open" : "closed"} visible={pairingOpen} progress={app.pairingProgress ?? null} error={app.error} onClearError={app.clearError} onClose={closePairing} onPair={async (code) => { await app.pairCode(code); setPairingOpen(false); }} />
  </>;
}

function AvailableMachine({ host, divided, onPair }: { host: AccountHost; divided: boolean; onPair(): void }) {
  const { palette } = useTheme();
  const compatible = host.capabilities.includes(ACCOUNT_PAIRING_CAPABILITY) && accountHostIdentityMatches(host);
  const live = host.reachability === "live";
  const enabled = compatible && live;
  const state = !compatible ? "Incompatible" : !live ? "Offline" : `Live${host.lastSeenAt ? ` · ${relativeTime(Date.parse(host.lastSeenAt))}` : ""}${host.platform ? ` · ${host.platform}` : ""}`;
  return <Pressable accessibilityRole="button" disabled={!enabled} onPress={onPair} style={({ pressed }) => [styles.row, divided && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }, { opacity: enabled ? pressed ? 0.72 : 1 : 0.48 }]}><StatusDot color={enabled ? palette.success : palette.faint} /><View style={styles.rowCopy}><Text style={[styles.rowTitle, { color: palette.ink }]}>{host.displayName}</Text><Text style={[styles.detail, { color: palette.muted }]}>{state}</Text></View>{enabled ? <Text style={[styles.pairLabel, { color: palette.accent }]}>Pair</Text> : null}</Pressable>;
}

function StateCard({ title, detail, action, onPress }: { title: string; detail: string; action: string; onPress(): void }) {
  const { palette } = useTheme();
  return <Card style={styles.stateCard}><Text style={[styles.rowTitle, { color: palette.ink }]}>{title}</Text><Text style={[styles.detail, { color: palette.muted }]}>{detail}</Text><Button label={action} kind="secondary" onPress={onPress} /></Card>;
}

function PairingSheet({ visible, progress, error, onClearError, onClose, onPair }: { visible: boolean; progress: PairingProgress | null; error: string | null; onClearError(): void; onClose(): void; onPair(code: string): Promise<void> }) {
  const { palette } = useTheme();
  const [mode, setMode] = useState<"scan" | "type">("scan");
  const [permission, requestPermission] = useCameraPermissions();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [cameraGeneration, setCameraGeneration] = useState(0);
  // Native callbacks can arrive more than once before React renders busy=true.
  const submitting = useRef(false);
  const scanConsumed = useRef(false);
  const visibleRef = useRef(visible);
  useEffect(() => {
    visibleRef.current = visible;
    return () => { visibleRef.current = false; };
  }, [visible]);
  const selectMode = (next: "scan" | "type") => {
    if (submitting.current) return;
    onClearError();
    scanConsumed.current = false;
    setScanned(false);
    setCameraGeneration((value) => value + 1);
    setMode(next);
  };
  const close = () => { if (!submitting.current) onClose(); };
  const submit = async (value: string) => {
    if (submitting.current || !visibleRef.current || !value.trim()) return;
    submitting.current = true;
    setBusy(true);
    setCode(value);
    onClearError();
    try {
      await onPair(value);
      setCode("");
    } catch {
      // Keep the failed QR paused so it cannot repeatedly consume an offer.
      // Retry reuses the recovery journal; Scan again explicitly rearms detection.
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const scan = ({ data }: { data: string }) => {
    if (scanConsumed.current || submitting.current || !visibleRef.current || !data.trim()) return;
    scanConsumed.current = true;
    setScanned(true);
    void submit(data);
  };
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
    <View style={[styles.modal, { backgroundColor: palette.page }]}>
      <View style={styles.modalHeader}>
        <Text style={[styles.modalTitle, { color: palette.ink }]}>Pair a Mac</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" disabled={busy} onPress={close} hitSlop={12}><X color={palette.ink} /></Pressable>
      </View>
      <View style={[styles.segment, { backgroundColor: palette.raised }]}>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => selectMode("scan")} style={[styles.segmentItem, mode === "scan" && { backgroundColor: palette.card }]}><QrCode size={16} color={mode === "scan" ? palette.ink : palette.muted} /><Text style={{ color: mode === "scan" ? palette.ink : palette.muted }}>Scan</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => selectMode("type")} style={[styles.segmentItem, mode === "type" && { backgroundColor: palette.card }]}><Keyboard size={16} color={mode === "type" ? palette.ink : palette.muted} /><Text style={{ color: mode === "type" ? palette.ink : palette.muted }}>Type code</Text></Pressable>
      </View>
      {busy && progress ? <PairingApproval progress={progress} /> : visible && mode === "scan" ? permission?.granted ? <>
        <PairingScanner key={cameraGeneration} enabled={!scanned && !busy} onScan={scan} />
        {busy ? <Text style={[styles.detail, { color: palette.muted }]}>QR decoded. Pairing securely…</Text> : null}
        <Button label={scanned ? "Scan again" : "Restart camera"} kind="secondary" disabled={busy} onPress={() => selectMode("scan")} />
      </> : <View style={styles.cameraPermission}><Text style={[styles.heroDetail, { color: palette.muted }]}>Camera access is requested only to scan a pairing QR shown on your Mac.</Text><Button label="Allow camera" onPress={() => void requestPermission()} /></View> : mode === "type" ? <View style={styles.codeForm}>
        <Text style={[styles.detail, { color: palette.muted }]}>Paste the full pairing link or its code. Pairing grants expire and can be used only once.</Text>
        <TextInput value={code} editable={!busy} onChangeText={(value) => { onClearError(); setCode(value); }} autoCapitalize="none" autoCorrect={false} multiline placeholder="terminalx://pair?code=…" placeholderTextColor={palette.faint} style={[styles.codeInput, { color: palette.ink, backgroundColor: palette.card, borderColor: palette.border }]} />
        <Button label={busy ? "Pairing securely…" : "Pair securely"} disabled={busy || !code.trim()} onPress={() => void submit(code)} />
      </View> : null}
      {error ? <Card style={[styles.errorPanel, { borderColor: `${palette.danger}66` }]}>
        <Text style={[styles.errorTitle, { color: palette.ink }]}>Pairing didn’t finish</Text><Text style={[styles.detail, { color: palette.muted }]}>{error}</Text>
        <View style={styles.actions}><Button label="Retry" kind="secondary" style={styles.flex} disabled={busy || !code.trim()} onPress={() => void submit(code)} /><Button label="Use QR code" kind="secondary" style={styles.flex} disabled={busy} onPress={() => selectMode("scan")} /></View>
      </Card> : null}
    </View>
  </Modal>;
}

/**
 * After a code is scanned (PRO-314): the Mac holds the pairing until the
 * person checks that it shows this same fingerprint and approves it there.
 */
function PairingApproval({ progress }: { progress: PairingProgress }) {
  const { palette } = useTheme();
  const [first, second] = progress.fingerprint.split("\u00B7");
  return <Card style={styles.approval}>
    <Text accessibilityRole="header" style={[styles.errorTitle, { color: palette.ink }]}>Approve on your Mac</Text>
    <Text testID="pairing-fingerprint" accessibilityLabel={`Fingerprint ${[...progress.fingerprint.replace("\u00B7", "")].join(" ")}`} style={[styles.fingerprint, { color: palette.ink }]}>{progress.fingerprint}</Text>
    <Text accessibilityLiveRegion="polite" style={[styles.detail, { color: palette.muted }]}>{progress.waitingForApproval
      ? `Check that your Mac shows ${first} ${second}, then choose Approve there. This phone waits up to 2 minutes.`
      : "Connecting securely to your Mac. It will show this same fingerprint."}</Text>
  </Card>;
}

function connectionLabel(stage: string, attempt: number) {
  if (stage === "connected") return "Connected";
  if (stage === "connecting") return "Connecting · Requesting secure credential";
  if (stage === "cant-connect") return `Can’t connect · attempt ${attempt}`;
  if (stage === "disconnected-on-mac") return "Disconnected on your Mac · tap to reconnect";
  if (stage === "unreachable") return "Host unreachable · retrying";
  return "Reconnecting…";
}

function relativeTime(value: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - value) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

const styles = StyleSheet.create({
  signedOut: { flexGrow: 1, justifyContent: "center", paddingHorizontal: 30, gap: 16 },
  mark: { width: 58, height: 58, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  markText: { fontSize: 19, fontWeight: "800", letterSpacing: -1 },
  heroTitle: { fontSize: 32, lineHeight: 37, fontWeight: "700", letterSpacing: -0.8 },
  heroDetail: { fontSize: 16, lineHeight: 23 },
  heading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  account: { fontSize: 20, fontWeight: "700" },
  detail: { fontSize: 14, lineHeight: 19 },
  row: { minHeight: 68, paddingHorizontal: 15, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 12 },
  rowCopy: { flex: 1, gap: 3 },
  // The row that connects and the options button are siblings, so each is its own accessibility element (a button inside a pressable row is hidden from VoiceOver).
  hostRow: { flexDirection: "row", alignItems: "center", paddingRight: 8 },
  hostRowMain: { flex: 1, paddingRight: 6 },
  rowTitle: { fontSize: 16, fontWeight: "600" },
  pairLabel: { fontSize: 15, fontWeight: "700" },
  errorPanel: { padding: 16, gap: 8 },
  errorTitle: { fontSize: 17, fontWeight: "700" },
  actions: { flexDirection: "row", gap: 8, marginTop: 4 },
  flex: { flex: 1 },
  stateCard: { padding: 16, gap: 10 },
  modal: { flex: 1, paddingTop: 18, paddingHorizontal: 16, gap: 16 },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  modalTitle: { fontSize: 24, fontWeight: "700" },
  segment: { flexDirection: "row", padding: 3, borderRadius: 10 },
  segmentItem: { flex: 1, minHeight: 38, borderRadius: 8, flexDirection: "row", gap: 7, alignItems: "center", justifyContent: "center" },
  cameraPermission: { flex: 1, justifyContent: "center", gap: 16, paddingHorizontal: 28 },
  codeForm: { gap: 14 },
  approval: { padding: 20, gap: 12, alignItems: "center" },
  // The same characters, the same size as on the Mac, so they are compared at a glance.
  fingerprint: { fontSize: 34, fontWeight: "700", letterSpacing: 2, fontVariant: ["tabular-nums"] },
  codeInput: { minHeight: 120, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 14, textAlignVertical: "top", fontSize: 15 },
});
