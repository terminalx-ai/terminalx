import { useState, type ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EyeOff, Eye, Laptop, Monitor, MoreHorizontal, Pencil, Plug, QrCode, Server, Trash2, Unplug } from "lucide-react-native";
import { useApp } from "@mobile/state/AppProvider";
import type { AvailableMachine, Machine, MachineIcon, PairedMachine } from "@mobile/state/machines";
import { useMachines } from "@mobile/state/useMachines";
import { cleanHostName, hostDisplayName, HOST_NAME_MAX } from "@mobile/store/host-name";
import { Button } from "@mobile/ui/primitives";
import { useTheme } from "@mobile/ui/theme";
import { keyboardAvoidingBehavior } from "@mobile/ui/keyboard";

/**
 * The menu of a machine (PRO-87, #987). Every row in the machine list has
 * one, online or offline, paired here or only on the account:
 *
 * - paired: Rename, Connect (off, with the reason, while it is offline),
 *   Disconnect (the machine in use, where the screen offers it: PRO-465),
 *   Pair again, and Forget this machine after a confirmation;
 * - on the account only: Rename, Pair, and Hide on this phone.
 *
 * A name is saved on this phone, so renaming needs no connection. The menu
 * opens from the "…" button beside the name or a long press on it; the
 * button is always there, so a long press is never the only way in.
 *
 * As 22.05 draws it: the menu and the rename form are sheets on the bottom
 * edge (the rename sheet rides above the keyboard), closed by a tap outside;
 * Forget asks in a dialog in the middle of the screen.
 */
export function useDeviceMenu(options: { onRemoved?(): void; onPairAgain?(): void; onScanServer?(): void; onConnect?(machine: PairedMachine): void; onDisconnect?(machine: PairedMachine): void } = {}) {
  const machines = useMachines();
  const [id, setId] = useState<string | null>(null);
  const all: Machine[] = [...machines.paired, ...machines.available, ...machines.hidden];
  const byId = new Map(all.map((machine) => [machine.id, machine]));
  const machine = id ? byId.get(id) ?? null : null;
  return {
    machines,
    /** What to call a machine on screen: the same name as in the machine list. */
    nameOf: (item: { id: string } & Parameters<typeof hostDisplayName>[0]) => byId.get(item.id)?.name ?? hostDisplayName(item),
    open: (item: { id: string }) => setId(item.id),
    element: machine ? <DeviceMenu key={machine.id} machine={machine} options={options} onClose={() => setId(null)} /> : null,
  };
}

/** The "…" button that opens a machine's menu. */
export function DeviceOptionsButton({ name, onPress }: { name: string; onPress(): void }) {
  const { palette } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Device options for ${name}`} hitSlop={10} onPress={onPress} style={({ pressed }) => [styles.dots, pressed && { backgroundColor: palette.raised }]}>
      <MoreHorizontal size={20} color={palette.muted} />
    </Pressable>
  );
}

/** The mark beside a machine's name. */
export function MachineGlyph({ icon, color, size = 20 }: { icon: MachineIcon; color: string; size?: number }) {
  const Icon = icon === "laptop" ? Laptop : icon === "server" ? Server : Monitor;
  return <Icon size={size} color={color} strokeWidth={1.7} />;
}

type Mode = "menu" | "rename" | "forget";

function DeviceMenu({ machine, options, onClose }: { machine: Machine; options: Parameters<typeof useDeviceMenu>[0] & object; onClose(): void }) {
  const app = useApp();
  const { palette } = useTheme();
  const [mode, setMode] = useState<Mode>("menu");
  // The name itself, without the ending that tells two of the same name apart.
  const [draft, setDraft] = useState(machine.customName ?? machine.ownName ?? machine.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (work: () => Promise<unknown>, after?: () => void) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
      onClose();
      after?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const rename = (name: string) => machine.kind === "paired" ? app.renameHost(machine.id, name) : app.renameAccountMachine(machine.id, name);

  const close = busy ? undefined : onClose;
  const backdrop = <Pressable accessibilityLabel="Close" accessibilityRole="button" style={StyleSheet.absoluteFill} onPress={close} />;

  if (mode === "forget") return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.backdrop, styles.centred]}>
        {backdrop}
        <View accessibilityViewIsModal onAccessibilityEscape={close} style={[styles.dialog, { backgroundColor: palette.card, borderColor: palette.border }]}>
          <Text accessibilityRole="header" numberOfLines={2} style={[styles.title, { color: palette.ink }]}>{`Forget ${machine.name}?`}</Text>
          <Text style={[styles.dialogText, { color: palette.muted }]}>
            {"This phone will no longer connect to it. Sessions on that machine are not changed. To use it again, pair it again."}
            {machine.kind === "paired" && machine.active && app.connectionStage === "connected" ? " It is also asked to remove this phone from its paired devices." : ""}
            {machine.kind === "paired" && machine.account ? " It stays on your account, hidden on this phone; you can show it again from the list of machines." : ""}
          </Text>
          {error ? <Text accessibilityRole="alert" style={[styles.detail, styles.errorText, { color: palette.danger }]}>{error}</Text> : null}
          <View style={styles.pair}>
            <Button label="Cancel" kind="secondary" style={styles.flex} disabled={busy} onPress={onClose} />
            <Button label="Forget" kind="danger" style={styles.flex} disabled={busy} onPress={() => void act(() => app.forgetHost(machine.id), options.onRemoved)} />
          </View>
        </View>
      </View>
    </Modal>
  );

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={keyboardAvoidingBehavior()} style={styles.backdrop}>
        {backdrop}
        <Sheet onClose={close}>
          {mode === "menu" ? <>
            <Text numberOfLines={2} accessibilityRole="header" style={[styles.title, styles.sheetTitle, { color: palette.ink }]}>{machine.name}</Text>
            <Text style={[styles.detail, styles.sheetDetail, { color: palette.muted }]}>{machine.state}</Text>
            <View style={[styles.list, { borderColor: palette.border }]}>
              <MenuItem icon={<Pencil size={18} color={palette.ink} />} label="Rename" first disabled={busy} onPress={() => { setError(null); setMode("rename"); }} />
              {machine.kind === "paired" ? <PairedItems machine={machine} busy={busy} options={options} act={act} onForget={() => { setError(null); setMode("forget"); }} onClose={onClose} /> : <AvailableItems machine={machine} busy={busy} act={act} onScan={options.onScanServer && (() => { onClose(); options.onScanServer?.(); })} />}
            </View>
            {error ? <Text accessibilityRole="alert" style={[styles.detail, styles.errorText, { color: palette.danger }]}>{error}</Text> : null}
          </> : <>
            <Text accessibilityRole="header" style={[styles.title, styles.renameTitle, { color: palette.ink }]}>Rename machine</Text>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              maxLength={HOST_NAME_MAX}
              autoFocus
              accessibilityLabel="Name for this machine"
              placeholder={machine.ownName ?? "Name"}
              placeholderTextColor={palette.faint}
              selectionColor={palette.accent}
              style={[styles.input, { color: palette.ink, borderColor: palette.accent }]}
            />
            <Text style={[styles.detail, styles.renameNote, { color: palette.muted }]}>The name is saved on this phone. It works while the machine is offline.</Text>
            {error ? <Text accessibilityRole="alert" style={[styles.detail, styles.errorText, { color: palette.danger }]}>{error}</Text> : null}
            {machine.custom ? <Button label={machine.ownName ? `Use its own name (${machine.ownName})` : "Remove my name for it"} kind="secondary" style={styles.ownName} disabled={busy} onPress={() => void act(() => rename(""))} /> : null}
            <View style={styles.pair}>
              <Button label="Cancel" kind="secondary" style={styles.flex} disabled={busy} onPress={onClose} />
              <Button label="Save" style={styles.flex} disabled={busy || !cleanHostName(draft)} onPress={() => void act(() => rename(draft))} />
            </View>
          </>}
        </Sheet>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/**
 * A sheet on the bottom edge with a grabber, clear of the home indicator.
 * VoiceOver keeps to the sheet (the backdrop's Close is outside it), so the
 * sheet closes on the escape gesture, and the grabber is its Close button:
 * drawn as the board draws it, with a full-size place to tap.
 */
function Sheet({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  return <View accessibilityViewIsModal onAccessibilityEscape={onClose} style={[styles.sheet, { backgroundColor: palette.card, borderColor: palette.border, paddingBottom: Math.max(26, insets.bottom + 8) }]}>
    <Pressable accessibilityRole="button" accessibilityLabel="Close" disabled={!onClose} onPress={onClose} style={styles.grabTarget}>
      <View style={[styles.grab, { backgroundColor: palette.selected }]} />
    </Pressable>
    {children}
  </View>;
}

function PairedItems({ machine, busy, options, act, onForget, onClose }: { machine: PairedMachine; busy: boolean; options: Parameters<typeof useDeviceMenu>[0] & object; act(work: () => Promise<unknown>, after?: () => void): Promise<void>; onForget(): void; onClose(): void }) {
  const app = useApp();
  const { palette } = useTheme();
  const connect = () => {
    if (options.onConnect && !machine.active) {
      onClose();
      options.onConnect(machine);
      return;
    }
    void act(() => app.reconnectHost(machine.id));
  };
  const blocked = machine.connectBlocked;
  return <>
    <MenuItem icon={<Plug size={18} color={palette.ink} />} label={machine.active ? "Reconnect" : "Connect"} detail={blocked ?? undefined} disabled={busy || blocked !== null} onPress={connect} />
    {/* Drops the connection and keeps the pairing (PRO-465). */}
    {options.onDisconnect && machine.active ? <MenuItem icon={<Unplug size={18} color={palette.ink} />} label="Disconnect" detail="Stays paired. Connect again from Machines." disabled={busy} onPress={() => { onClose(); options.onDisconnect!(machine); }} /> : null}
    {options.onPairAgain ? <MenuItem icon={<QrCode size={18} color={palette.ink} />} label="Pair again" disabled={busy} onPress={() => { onClose(); options.onPairAgain!(); }} /> : null}
    <MenuItem icon={<Trash2 size={18} color={palette.danger} />} label="Forget this machine" danger disabled={busy} onPress={onForget} />
  </>;
}

function AvailableItems({ machine, busy, act, onScan }: { machine: AvailableMachine; busy: boolean; act(work: () => Promise<unknown>): Promise<void>; onScan?: () => void }) {
  const app = useApp();
  const { palette } = useTheme();
  const blocked = machine.pairBlocked;
  return <>
    {machine.terminalPairing
      ? <MenuItem icon={<QrCode size={18} color={palette.ink} />} label="Scan pairing QR" disabled={busy || !onScan} onPress={() => onScan?.()} />
      : <MenuItem icon={<QrCode size={18} color={palette.ink} />} label="Pair" detail={blocked ?? undefined} disabled={busy || blocked !== null} onPress={() => void act(() => app.pairAvailable(machine.host))} />}
    {machine.hidden
      ? <MenuItem icon={<Eye size={18} color={palette.ink} />} label="Show on this phone" disabled={busy} onPress={() => void act(() => app.hideAccountMachine(machine.id, false))} />
      : <MenuItem icon={<EyeOff size={18} color={palette.ink} />} label="Hide on this phone" detail="It stays on your account." disabled={busy} onPress={() => void act(() => app.hideAccountMachine(machine.id, true))} />}
  </>;
}

function MenuItem({ icon, label, detail, disabled, danger, first, onPress }: { icon: ReactNode; label: string; detail?: string; disabled?: boolean; danger?: boolean; first?: boolean; onPress(): void }) {
  const { palette } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint={detail} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.item, !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }, disabled && !danger && styles.off, pressed && { backgroundColor: palette.raised }]}>
      {icon}
      <View style={styles.flex}>
        <Text style={[styles.itemLabel, { color: danger ? palette.danger : palette.ink }]}>{label}</Text>
        {detail ? <Text style={[styles.itemDetail, { color: palette.muted }]}>{detail}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  dots: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.5)" },
  centred: { justifyContent: "center", paddingHorizontal: 28 },
  sheet: { borderTopLeftRadius: 26, borderTopRightRadius: 26, borderCurve: "continuous", borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, paddingHorizontal: 16 },
  // Grabber with a >=44pt touch target for U-60.
  grabTarget: { alignSelf: "center", minWidth: 88, minHeight: 44, marginTop: -10, marginBottom: -8, alignItems: "center", justifyContent: "center" },
  grab: { width: 38, height: 5, borderRadius: 3 },
  errorText: { marginTop: 8, marginBottom: 4 },
  dialog: { borderRadius: 20, borderCurve: "continuous", borderWidth: StyleSheet.hairlineWidth, padding: 20 },
  dialogText: { fontSize: 14, lineHeight: 20, marginTop: 8, marginBottom: 16 },
  title: { fontSize: 17, fontWeight: "600" },
  sheetTitle: { marginBottom: 2 },
  sheetDetail: { marginBottom: 12 },
  renameTitle: { marginBottom: 12 },
  renameNote: { marginTop: 8, marginHorizontal: 2, marginBottom: 14 },
  ownName: { marginBottom: 8 },
  detail: { fontSize: 13, lineHeight: 18 },
  list: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, borderCurve: "continuous", overflow: "hidden" },
  item: { minHeight: 50, paddingHorizontal: 14, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 12 },
  off: { opacity: 0.45 },
  itemLabel: { fontSize: 16 },
  itemDetail: { fontSize: 13, marginTop: 1 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16 },
  pair: { flexDirection: "row", gap: 8 },
  flex: { flex: 1 },
});
