import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";
import { useCameraPermissions } from "expo-camera";
import { useFocusEffect, useRouter } from "expo-router";
import { Keyboard, Plus, QrCode, X } from "lucide-react-native";
import type { PairingProgress } from "@mobile/pairing/pair";
import { useApp } from "@mobile/state/AppProvider";
import type { Machine, MachineTone, PairedMachine } from "@mobile/state/machines";
import { useConnectionState, type ConnectionState } from "@mobile/state/connection-view";
import { ConnectionLine } from "@mobile/ui/ConnectionLine";
import { usePullRefresh } from "@mobile/ui/pull-refresh";
import { Button, Card, EmptyState, Screen, SectionTitle } from "@mobile/ui/primitives";
import { GlassIconButton } from "@mobile/ui/glass";
import { useTheme, type Palette } from "@mobile/ui/theme";
import { PairingScanner } from "@mobile/ui/PairingScanner";
import { DeviceOptionsButton, MachineGlyph, useDeviceMenu } from "@mobile/ui/DeviceMenu";

/**
 * Machines (#987): one list of every machine this phone knows, paired ones
 * first, then the account's machines that are not paired here. Every row has
 * the same menu, online or offline. One + in the title adds a machine.
 */
export default function MachinesScreen() {
  const app = useApp();
  const { palette } = useTheme();
  const router = useRouter();
  const [pairingOpen, setPairingOpen] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const { session, refreshMachines } = app;
  const openPairing = () => { app.clearError(); setPairingOpen(true); };
  const closePairing = () => { app.clearError(); setPairingOpen(false); };

  const connect = async (machine: PairedMachine) => {
    // Sessions is a sibling tab. dismissTo emits a stack POP_TO action, which
    // the tab navigator cannot handle when Machines is already at the root.
    if (await app.connectHost(machine.host)) router.navigate("/(tabs)/sessions");
  };
  const menu = useDeviceMenu({ onPairAgain: openPairing, onConnect: (machine) => void connect(machine) });
  const state = useConnectionState(app);
  const pull = usePullRefresh(app.refreshMachines);
  const { paired, available, hidden } = menu.machines;

  // Read the account again each time the list comes into view: whether a machine is online must not be stale.
  useFocusEffect(useCallback(() => { if (session) void refreshMachines(); }, [refreshMachines, session]));

  const add = <GlassIconButton label="Add a machine" icon={<Plus size={22} color={palette.ink} />} onPress={openPairing} testID="add-machine" />;
  const sheet = <PairingSheet key={pairingOpen ? "open" : "closed"} visible={pairingOpen} progress={app.pairingProgress ?? null} error={app.error} onClearError={app.clearError} onClose={closePairing} onPair={async (code) => { await app.pairCode(code); setPairingOpen(false); }} />;
  const retry = () => session ? app.refreshMachines() : app.retryPairing().catch(() => undefined);
  const errorCard = app.error && !pairingOpen ? <Card style={[styles.errorPanel, { borderColor: `${palette.danger}66` }]}><Text style={[styles.errorTitle, { color: palette.ink }]}>Couldn’t finish that</Text><Text style={[styles.detail, { color: palette.muted }]}>{app.error}</Text><Button label="Retry" kind="secondary" onPress={() => void retry()} /></Card> : null;

  if (!app.ready) return <Screen title="Machines"><EmptyState title="Loading" detail="Reading this phone’s saved machines." /></Screen>;
  if (!session && !paired.length) {
    return <>
      <Screen title="Machines" titleActions={add} contentContainerStyle={styles.signedOut}>
        <View style={[styles.mark, { backgroundColor: palette.accent }]}><Text style={[styles.markText, { color: palette.accentInk }]}>TX</Text></View>
        <Text style={[styles.heroTitle, { color: palette.ink }]}>Your work, away from your desk</Text>
        <Text style={[styles.heroDetail, { color: palette.muted }]}>Sign in with the same TerminalX account as your Mac, or tap + to pair with the QR code TerminalX shows there. Sessions stay on your Mac.</Text>
        <Button label="Sign in" onPress={() => void app.signIn()} />
        {errorCard}
      </Screen>
      {menu.element}
      {sheet}
    </>;
  }

  const shownAvailable = showHidden ? [...available, ...hidden] : available;
  return <>
    <Screen title="Machines" titleActions={add} refreshControl={session ? <RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} tintColor={palette.accent} /> : undefined}>
      {errorCard}
      {paired.length ? <Card>{paired.map((machine, index) => <MachineRow key={machine.id} machine={machine} connection={state} divided={index > 0} onPress={() => machine.connectBlocked ? menu.open(machine) : void connect(machine)} onMenu={() => menu.open(machine)} />)}</Card> : null}

      {session && app.installationState === "reauthentication-required" ? <StateCard title="Sign in again to see your account’s machines" detail="For your security, pairing needs a recent sign-in." action="Sign in again" onPress={() => void app.signIn()} /> : null}
      {session && app.installationState === "approval-required" ? <StateCard title="Waiting for approval" detail="Approve this phone from your TerminalX account, then retry." action="Retry" onPress={() => void app.refreshMachines()} /> : null}
      {session && app.loadingMachines && !paired.length && !shownAvailable.length ? <EmptyState title="Loading" detail="Looking for machines on your account." /> : null}
      {shownAvailable.length ? <><SectionTitle>Available to pair</SectionTitle><Card>{shownAvailable.map((machine, index) => <MachineRow key={machine.id} machine={machine} divided={index > 0} onPress={() => machine.pairBlocked ? menu.open(machine) : void app.pairAvailable(machine.host)} onMenu={() => menu.open(machine)} />)}</Card></> : null}
      {hidden.length ? <Pressable accessibilityRole="button" onPress={() => setShowHidden((value) => !value)} hitSlop={8} style={styles.link}><Text style={[styles.linkText, { color: palette.accent }]}>{showHidden ? "Hide the hidden machines" : `Show ${hidden.length} hidden ${hidden.length === 1 ? "machine" : "machines"}`}</Text></Pressable> : null}
      {!paired.length && !shownAvailable.length && !(session && app.loadingMachines) ? <EmptyState title="No machines yet" detail="Tap + to pair with the QR code in TerminalX on your Mac. A machine signed in to your account also shows here while TerminalX is open on it." /> : null}
      {!session ? <Card style={styles.stateCard}><Text style={[styles.rowTitle, { color: palette.ink }]}>See every machine on your account</Text><Text style={[styles.detail, { color: palette.muted }]}>Sign in with the account you use in TerminalX on your Mac.</Text><Button label="Sign in" kind="secondary" onPress={() => void app.signIn()} /></Card> : null}

      {paired.length ? <Text style={[styles.note, { color: palette.muted }]}>The phone talks to one machine at a time. Tap another one to switch.</Text> : null}
    </Screen>
    {menu.element}
    {sheet}
  </>;
}

/** One machine: tap to use it (or pair it); "…" or a long press for its menu. */
function MachineRow({ machine, connection, divided, onPress, onMenu }: { machine: Machine; connection?: ConnectionState; divided: boolean; onPress(): void; onMenu(): void }) {
  const { palette } = useTheme();
  const offline = machine.tone === "offline";
  const active = machine.kind === "paired" && machine.active;
  const pairable = machine.kind === "available" && machine.pairBlocked === null;
  // The row and its buttons are siblings, so each is its own accessibility element (a button inside a pressable row is hidden from VoiceOver).
  return <View style={[styles.hostRow, divided && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }]}>
    <Pressable testID={`machine-row-${machine.id}`} accessibilityRole="button" accessibilityLabel={`${machine.name}${active ? ", active" : ""}, ${machine.state}`} accessibilityActions={[{ name: "options", label: "Device options" }]} onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === "options") onMenu(); }} onPress={onPress} onLongPress={onMenu} style={({ pressed }) => [styles.row, styles.hostRowMain, pressed && { backgroundColor: palette.raised }]}>
      <MachineGlyph icon={machine.icon} color={offline ? palette.faint : palette.ink} />
      <View style={styles.rowCopy}>
        <View style={styles.nameLine}>
          <Text numberOfLines={1} style={[styles.rowTitle, styles.shrink, { color: offline ? palette.muted : palette.ink }]}>{machine.name}</Text>
          {active ? <View style={[styles.badge, { backgroundColor: `${palette.success}26` }]}><Text style={[styles.badgeText, { color: palette.success }]}>Active</Text></View> : null}
        </View>
        {/* The machine this phone is using says its connection in the words every screen uses (#983); disconnected on the Mac keeps its own line and action. */}
        {active && connection && connection !== "none" && connection !== "held" ? <ConnectionLine state={connection} />
          : <Text numberOfLines={1} style={[styles.detail, { color: toneColor(machine.tone, palette) }]}>{machine.state}</Text>}
      </View>
    </Pressable>
    {pairable ? <Pressable accessibilityRole="button" accessibilityLabel={`Pair ${machine.name}`} onPress={onPress} style={({ pressed }) => [styles.pairButton, { backgroundColor: `${palette.accent}24`, opacity: pressed ? 0.7 : 1 }]}><Text style={[styles.pairLabel, { color: palette.accent }]}>Pair</Text></Pressable> : null}
    <DeviceOptionsButton name={machine.name} onPress={onMenu} />
  </View>;
}

function toneColor(tone: MachineTone, palette: Palette) {
  return tone === "connected" ? palette.success : tone === "attention" ? palette.warning : palette.muted;
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
        <Text style={[styles.modalTitle, { color: palette.ink }]}>Add a machine</Text>
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
  const groups = progress.fingerprint.split("\u00B7");
  // Two lines of two groups, as the Mac shows it: 64 bits do not fit one line at this size.
  const half = Math.ceil(groups.length / 2);
  const lines = [groups.slice(0, half).join("\u00B7"), groups.slice(half).join("\u00B7")].filter(Boolean);
  return <Card style={styles.approval}>
    <Text accessibilityRole="header" style={[styles.errorTitle, { color: palette.ink }]}>Approve on your Mac</Text>
    <Text testID="pairing-fingerprint" accessibilityLabel={`Fingerprint ${[...groups.join("")].join(" ")}`} style={[styles.fingerprint, { color: palette.ink }]}>{lines.join("\n")}</Text>
    <Text accessibilityLiveRegion="polite" style={[styles.detail, { color: palette.muted }]}>{progress.waitingForApproval
      ? `Check that your Mac shows ${groups.join(" ")}, then choose Approve there. This phone waits up to 2 minutes.`
      : "Connecting securely to your Mac. It will show this same fingerprint."}</Text>
  </Card>;
}

const styles = StyleSheet.create({
  signedOut: { flexGrow: 1, justifyContent: "center", paddingHorizontal: 30, gap: 16 },
  mark: { width: 58, height: 58, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  markText: { fontSize: 19, fontWeight: "800", letterSpacing: -1 },
  heroTitle: { fontSize: 32, lineHeight: 37, fontWeight: "700", letterSpacing: -0.8 },
  heroDetail: { fontSize: 16, lineHeight: 23 },
  detail: { fontSize: 14, lineHeight: 19 },
  row: { minHeight: 68, paddingHorizontal: 15, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 12 },
  rowCopy: { flex: 1, gap: 3 },
  // The row that connects and the options button are siblings, so each is its own accessibility element (a button inside a pressable row is hidden from VoiceOver).
  hostRow: { flexDirection: "row", alignItems: "center", paddingRight: 8 },
  hostRowMain: { flex: 1, paddingRight: 6 },
  rowTitle: { fontSize: 16, fontWeight: "600" },
  shrink: { flexShrink: 1 },
  nameLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  badge: { borderRadius: 7, paddingHorizontal: 7, paddingVertical: 2 },
  badgeText: { fontSize: 12, fontWeight: "700" },
  pairButton: { borderRadius: 9, paddingHorizontal: 12, paddingVertical: 7, marginRight: 2 },
  pairLabel: { fontSize: 15, fontWeight: "700" },
  note: { fontSize: 13, lineHeight: 19, paddingHorizontal: 4 },
  link: { alignSelf: "flex-start", paddingHorizontal: 4, paddingVertical: 4 },
  linkText: { fontSize: 14, fontWeight: "600" },
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
  fingerprint: { fontSize: 30, lineHeight: 38, fontWeight: "700", letterSpacing: 2, fontVariant: ["tabular-nums"] },
  codeInput: { minHeight: 120, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 14, textAlignVertical: "top", fontSize: 15 },
});
