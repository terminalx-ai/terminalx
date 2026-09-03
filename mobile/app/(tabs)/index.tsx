import { useEffect, useState } from "react";
import { Modal, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { ChevronRight, Keyboard, QrCode, X } from "lucide-react-native";
import { ACCOUNT_PAIRING_CAPABILITY } from "@mobile/pairing/contracts";
import type { AccountHost } from "@mobile/pairing/account-client";
import { accountHostIdentityMatches } from "@mobile/pairing/account";
import { useApp } from "@mobile/state/AppProvider";
import { Button, Card, EmptyState, Screen, SectionTitle, StatusDot } from "@mobile/ui/primitives";
import { useTheme } from "@mobile/ui/theme";

export default function MachinesScreen() {
  const app = useApp();
  const { palette } = useTheme();
  const router = useRouter();
  const [pairingOpen, setPairingOpen] = useState(false);
  const { session, refreshMachines } = app;

  useEffect(() => { if (session) void refreshMachines(); }, [refreshMachines, session]);

  const connect = async (host: (typeof app.hosts)[number]) => {
    await app.connectHost(host);
    router.navigate("/(tabs)/sessions");
  };

  if (!app.ready) return <Screen><EmptyState title="Loading" detail="Reading this installation's device-only credentials." busy /></Screen>;
  if (!app.session) {
    return <>
      <Screen contentContainerStyle={app.hosts.length ? undefined : styles.signedOut}>
        <View style={[styles.mark, { backgroundColor: palette.accent }]}><Text style={[styles.markText, { color: palette.accentInk }]}>TX</Text></View>
        <Text style={[styles.heroTitle, { color: palette.ink }]}>Your work, away from your desk</Text>
        <Text style={[styles.heroDetail, { color: palette.muted }]}>Sign in with the same TerminalX account as your Mac, or use an explicit QR pairing. Sessions stay on the Mac and travel over an end-to-end encrypted connection.</Text>
        <Button label="Sign in" onPress={() => void app.signIn()} />
        {app.hosts.length ? <><SectionTitle>QR-paired machines</SectionTitle><Card>{app.hosts.map((host, index) => <Pressable key={host.id} accessibilityRole="button" onPress={() => void connect(host)} style={({ pressed }) => [styles.row, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }, pressed && { backgroundColor: palette.raised }]}><StatusDot color={app.activeHost?.id === host.id && app.connectionStage === "connected" ? palette.success : palette.muted} /><View style={styles.rowCopy}><Text style={[styles.rowTitle, { color: palette.ink }]}>{host.label}</Text><Text style={[styles.detail, { color: palette.muted }]}>{app.activeHost?.id === host.id ? connectionLabel(app.connectionStage, app.connectionAttempt) : relativeTime(host.lastConnectedAt)}</Text></View><ChevronRight size={18} color={palette.faint} /></Pressable>)}</Card></> : null}
        <Button label="Use QR code or pairing code" kind="secondary" onPress={() => setPairingOpen(true)} />
      </Screen>
      <PairingSheet visible={pairingOpen} onClose={() => setPairingOpen(false)} onPair={async (code) => { await app.pairCode(code); setPairingOpen(false); }} />
    </>;
  }

  return <>
    <Screen refreshControl={<RefreshControl refreshing={app.loadingMachines} onRefresh={() => void app.refreshMachines()} tintColor={palette.accent} />}>
      {app.error ? <Card style={[styles.errorPanel, { borderColor: `${palette.danger}66` }]}><Text style={[styles.errorTitle, { color: palette.ink }]}>Couldn’t finish that</Text><Text style={[styles.detail, { color: palette.muted }]}>{app.error}</Text><View style={styles.actions}><Button label="Retry" kind="secondary" style={styles.flex} onPress={() => void app.refreshMachines()} /><Button label="Use QR code" kind="secondary" style={styles.flex} onPress={() => setPairingOpen(true)} /></View></Card> : null}
      <View style={styles.heading}><View><Text style={[styles.account, { color: palette.ink }]}>{app.session.user.displayName ?? app.session.user.email}</Text><Text style={[styles.detail, { color: palette.muted }]}>One active Mac at a time</Text></View><Button label="Pair" kind="secondary" onPress={() => setPairingOpen(true)} /></View>

      <SectionTitle>Paired machines</SectionTitle>
      {app.hosts.length ? <Card>{app.hosts.map((host, index) => <Pressable key={host.id} accessibilityRole="button" onPress={() => void connect(host)} style={({ pressed }) => [styles.row, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }, pressed && { backgroundColor: palette.raised }]}><StatusDot color={app.activeHost?.id === host.id && app.connectionStage === "connected" ? palette.success : palette.muted} /><View style={styles.rowCopy}><Text style={[styles.rowTitle, { color: palette.ink }]}>{host.label}</Text><Text style={[styles.detail, { color: palette.muted }]}>{app.activeHost?.id === host.id ? connectionLabel(app.connectionStage, app.connectionAttempt) : relativeTime(host.lastConnectedAt)}</Text></View><ChevronRight size={18} color={palette.faint} /></Pressable>)}</Card> : <EmptyState title="No paired Macs" detail="Choose a live Mac below, or pair from the QR code in TerminalX on your Mac." />}

      <SectionTitle>Your machines</SectionTitle>
      {app.installationState === "reauthentication-required" ? <StateCard title="Sign in again to verify this installation" detail="For your security, pairing needs a recent sign-in." action="Sign in again" onPress={() => void app.signIn()} /> : null}
      {app.installationState === "approval-required" ? <StateCard title="Awaiting approval" detail="Approve this installation from your TerminalX account, then retry." action="Retry" onPress={() => void app.refreshMachines()} /> : null}
      {app.loadingMachines && !app.availableHosts.length ? <EmptyState title="Loading" detail="Looking for Macs bound to your account." busy /> : null}
      {app.availableHosts.length ? <Card>{app.availableHosts.map((host, index) => <AvailableMachine key={host.hostId} host={host} divided={index > 0} onPair={() => void app.pairAvailable(host)} />)}</Card> : !app.loadingMachines && app.installationState === "ready" ? <EmptyState title="No unpaired Macs found" detail="A Mac appears here after TerminalX is signed in and its host service is live. QR pairing remains available." /> : null}
      <Button label="Use QR code or pairing code" kind="secondary" onPress={() => setPairingOpen(true)} />
    </Screen>
    <PairingSheet visible={pairingOpen} onClose={() => setPairingOpen(false)} onPair={async (code) => { await app.pairCode(code); setPairingOpen(false); }} />
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

function PairingSheet({ visible, onClose, onPair }: { visible: boolean; onClose(): void; onPair(code: string): Promise<void> }) {
  const { palette } = useTheme();
  const [mode, setMode] = useState<"scan" | "type">("scan");
  const [permission, requestPermission] = useCameraPermissions();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanned, setScanned] = useState(false);
  const submit = async (value: string) => { if (busy || !value.trim()) return; setBusy(true); try { await onPair(value); setCode(""); setScanned(false); } finally { setBusy(false); } };
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}><View style={[styles.modal, { backgroundColor: palette.page }]}><View style={styles.modalHeader}><Text style={[styles.modalTitle, { color: palette.ink }]}>Pair a Mac</Text><Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={12}><X color={palette.ink} /></Pressable></View><View style={[styles.segment, { backgroundColor: palette.raised }]}><Pressable onPress={() => setMode("scan")} style={[styles.segmentItem, mode === "scan" && { backgroundColor: palette.card }]}><QrCode size={16} color={mode === "scan" ? palette.ink : palette.muted} /><Text style={{ color: mode === "scan" ? palette.ink : palette.muted }}>Scan</Text></Pressable><Pressable onPress={() => setMode("type")} style={[styles.segmentItem, mode === "type" && { backgroundColor: palette.card }]}><Keyboard size={16} color={mode === "type" ? palette.ink : palette.muted} /><Text style={{ color: mode === "type" ? palette.ink : palette.muted }}>Type code</Text></Pressable></View>{mode === "scan" ? permission?.granted ? <CameraView style={styles.camera} barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={scanned ? undefined : ({ data }) => { setScanned(true); void submit(data); }}><View style={styles.scanFrame} /></CameraView> : <View style={styles.cameraPermission}><Text style={[styles.heroDetail, { color: palette.muted }]}>Camera access is requested only to scan a pairing QR shown on your Mac.</Text><Button label="Allow camera" onPress={() => void requestPermission()} /></View> : <View style={styles.codeForm}><Text style={[styles.detail, { color: palette.muted }]}>Paste the full pairing link or its code. Pairing grants expire and can be used only once.</Text><TextInput value={code} onChangeText={setCode} autoCapitalize="none" autoCorrect={false} multiline placeholder="terminalx://pair?code=…" placeholderTextColor={palette.faint} style={[styles.codeInput, { color: palette.ink, backgroundColor: palette.card, borderColor: palette.border }]} /><Button label={busy ? "Connecting · Requesting secure credential" : "Pair securely"} disabled={busy || !code.trim()} onPress={() => void submit(code)} /></View>}</View></Modal>;
}

function connectionLabel(stage: string, attempt: number) {
  if (stage === "connected") return "Connected";
  if (stage === "connecting") return "Connecting · Requesting secure credential";
  if (stage === "cant-connect") return `Can’t connect · attempt ${attempt}`;
  if (stage === "unreachable") return "Host unreachable · re-pair?";
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
  camera: { flex: 1, borderRadius: 18, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  scanFrame: { width: 230, height: 230, borderRadius: 24, borderWidth: 3, borderColor: "white" },
  cameraPermission: { flex: 1, justifyContent: "center", gap: 16, paddingHorizontal: 28 },
  codeForm: { gap: 14 },
  codeInput: { minHeight: 120, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 14, textAlignVertical: "top", fontSize: 15 },
});
