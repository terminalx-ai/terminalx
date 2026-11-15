import { useState, type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { EyeOff, Eye, Laptop, Monitor, MoreHorizontal, Pencil, Plug, QrCode, Server, Trash2 } from "lucide-react-native";
import { useApp } from "@mobile/state/AppProvider";
import type { AvailableMachine, Machine, MachineIcon, PairedMachine } from "@mobile/state/machines";
import { useMachines } from "@mobile/state/useMachines";
import { cleanHostName, hostDisplayName, HOST_NAME_MAX } from "@mobile/store/host-name";
import { Button, Card } from "@mobile/ui/primitives";
import { useTheme } from "@mobile/ui/theme";

/**
 * The menu of a machine (PRO-87, #987). Every row in the machine list has
 * one, online or offline, paired here or only on the account:
 *
 * - paired: Rename, Connect (off, with the reason, while it is offline),
 *   Pair again, and Forget this machine after a confirmation;
 * - on the account only: Rename, Pair, and Hide on this phone.
 *
 * A name is saved on this phone, so renaming needs no connection. The menu
 * opens from the "…" button beside the name or a long press on it; the
 * button is always there, so a long press is never the only way in.
 */
export function useDeviceMenu(options: { onRemoved?(): void; onPairAgain?(): void; onConnect?(machine: PairedMachine): void } = {}) {
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

  const act = async (work: () => Promise<unknown>, after?: () => void) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
      onClose();
      after?.();
    } finally {
      setBusy(false);
    }
  };
  const rename = (name: string) => machine.kind === "paired" ? app.renameHost(machine.id, name) : app.renameAccountMachine(machine.id, name);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable accessibilityLabel="Close" accessibilityRole="button" style={StyleSheet.absoluteFill} onPress={busy ? undefined : onClose} />
        {mode === "menu" ? (
          <Card style={styles.sheet}>
            <View style={styles.header}>
              <Text numberOfLines={2} accessibilityRole="header" style={[styles.title, { color: palette.ink }]}>{machine.name}</Text>
              <Text style={[styles.detail, { color: palette.muted }]}>{machine.state}</Text>
            </View>
            <View style={[styles.list, { borderColor: palette.border }]}>
              <MenuItem icon={<Pencil size={18} color={palette.ink} />} label="Rename" disabled={busy} onPress={() => setMode("rename")} />
              {machine.kind === "paired" ? <PairedItems machine={machine} busy={busy} options={options} act={act} onForget={() => setMode("forget")} onClose={onClose} /> : <AvailableItems machine={machine} busy={busy} act={act} />}
            </View>
            <Button label="Cancel" kind="secondary" disabled={busy} onPress={onClose} />
          </Card>
        ) : mode === "rename" ? (
          <Card style={styles.sheet}>
            <Text accessibilityRole="header" style={[styles.title, { color: palette.ink }]}>Rename machine</Text>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              maxLength={HOST_NAME_MAX}
              autoFocus
              accessibilityLabel="Name for this machine"
              placeholder={machine.ownName ?? "Name"}
              placeholderTextColor={palette.faint}
              style={[styles.input, { color: palette.ink, borderColor: palette.accent, backgroundColor: palette.card }]}
            />
            <Text style={[styles.detail, { color: palette.muted }]}>The name is saved on this phone. It works while the machine is offline.</Text>
            {machine.custom ? <Button label={machine.ownName ? `Use its own name (${machine.ownName})` : "Remove my name for it"} kind="secondary" disabled={busy} onPress={() => void act(() => rename(""))} /> : null}
            <View style={styles.pair}>
              <Button label="Cancel" kind="secondary" style={styles.flex} disabled={busy} onPress={onClose} />
              <Button label="Save" style={styles.flex} disabled={busy || !cleanHostName(draft)} onPress={() => void act(() => rename(draft))} />
            </View>
          </Card>
        ) : (
          <Card style={styles.sheet}>
            <Text accessibilityRole="header" numberOfLines={2} style={[styles.title, { color: palette.ink }]}>{`Forget ${machine.name}?`}</Text>
            <Text style={[styles.detail, { color: palette.muted }]}>
              {"This phone will no longer connect to it. Sessions on that machine are not changed. To use it again, pair it again."}
              {machine.kind === "paired" && machine.active && app.connectionStage === "connected" ? " It is also asked to remove this phone from its paired devices." : ""}
              {machine.kind === "paired" && machine.account ? " It stays on your account, hidden on this phone; you can show it again from the list of machines." : ""}
            </Text>
            <View style={styles.pair}>
              <Button label="Cancel" kind="secondary" style={styles.flex} disabled={busy} onPress={onClose} />
              <Button label="Forget" kind="danger" style={styles.flex} disabled={busy} onPress={() => void act(() => app.forgetHost(machine.id), options.onRemoved)} />
            </View>
          </Card>
        )}
      </View>
    </Modal>
  );
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
    <MenuItem icon={<Plug size={18} color={blocked ? palette.faint : palette.ink} />} label={machine.active ? "Reconnect" : "Connect"} detail={blocked ?? undefined} disabled={busy || blocked !== null} onPress={connect} />
    {options.onPairAgain ? <MenuItem icon={<QrCode size={18} color={palette.ink} />} label="Pair again" disabled={busy} onPress={() => { onClose(); options.onPairAgain!(); }} /> : null}
    <MenuItem icon={<Trash2 size={18} color={palette.danger} />} label="Forget this machine" danger disabled={busy} onPress={onForget} />
  </>;
}

function AvailableItems({ machine, busy, act }: { machine: AvailableMachine; busy: boolean; act(work: () => Promise<unknown>): Promise<void> }) {
  const app = useApp();
  const { palette } = useTheme();
  const blocked = machine.pairBlocked;
  return <>
    <MenuItem icon={<QrCode size={18} color={blocked ? palette.faint : palette.ink} />} label="Pair" detail={blocked ?? undefined} disabled={busy || blocked !== null} onPress={() => void act(() => app.pairAvailable(machine.host))} />
    {machine.hidden
      ? <MenuItem icon={<Eye size={18} color={palette.ink} />} label="Show on this phone" disabled={busy} onPress={() => void act(() => app.hideAccountMachine(machine.id, false))} />
      : <MenuItem icon={<EyeOff size={18} color={palette.ink} />} label="Hide on this phone" detail="It stays on your account." disabled={busy} onPress={() => void act(() => app.hideAccountMachine(machine.id, true))} />}
  </>;
}

function MenuItem({ icon, label, detail, disabled, danger, onPress }: { icon: ReactNode; label: string; detail?: string; disabled?: boolean; danger?: boolean; onPress(): void }) {
  const { palette } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint={detail} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.item, { borderTopColor: palette.border }, pressed && { backgroundColor: palette.raised }]}>
      {icon}
      <View style={styles.flex}>
        <Text style={[styles.itemLabel, { color: danger ? palette.danger : disabled ? palette.faint : palette.ink }]}>{label}</Text>
        {detail ? <Text style={[styles.itemDetail, { color: palette.faint }]}>{detail}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  dots: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  backdrop: { flex: 1, justifyContent: "flex-end", padding: 16, backgroundColor: "rgba(0,0,0,0.45)" },
  sheet: { padding: 16, gap: 12 },
  header: { gap: 3 },
  title: { fontSize: 18, fontWeight: "700" },
  detail: { fontSize: 13, lineHeight: 18 },
  list: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, overflow: "hidden" },
  item: { minHeight: 50, paddingHorizontal: 14, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 12, borderTopWidth: StyleSheet.hairlineWidth },
  itemLabel: { fontSize: 16, fontWeight: "500" },
  itemDetail: { fontSize: 12, marginTop: 2 },
  input: { minHeight: 46, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 16 },
  pair: { flexDirection: "row", gap: 8 },
  flex: { flex: 1 },
});
