import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Check, Plus } from "lucide-react-native";
import type { MachineTone, PairedMachine } from "@mobile/state/machines";
import { MachineGlyph } from "@mobile/ui/DeviceMenu";
import { useTheme, type Palette } from "@mobile/ui/theme";

/**
 * "Switch machine" (PRO-465, 22.08): the dropdown under the machine's name at
 * the top of Sessions. It lists the paired machines with their state, the one
 * in use checked; an offline one is dimmed and cannot be chosen. "Add a
 * machine" at the end opens pairing. It opens with one machine too, so the
 * way to add a second is always there.
 */
export function MachineSwitcher({ machines, top, onChoose, onAdd, onClose }: { machines: PairedMachine[]; top: number; onChoose(machine: PairedMachine): void; onAdd(): void; onClose(): void }) {
  const { palette } = useTheme();
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable accessibilityLabel="Close" accessibilityRole="button" style={StyleSheet.absoluteFill} onPress={onClose} />
        <View testID="machine-switcher" accessibilityViewIsModal onAccessibilityEscape={onClose} style={[styles.panel, { top, backgroundColor: palette.card, borderColor: palette.border }]}>
          <Text accessibilityRole="header" style={[styles.caption, { color: palette.muted }]}>Switch machine</Text>
          {machines.map((machine) => {
            const blocked = machine.connectBlocked !== null && !machine.active;
            const state = shortState(machine);
            return (
              <Pressable
                key={machine.id}
                testID={`switch-to-${machine.id}`}
                accessibilityRole="button"
                accessibilityLabel={`${machine.name}, ${state}`}
                accessibilityHint={blocked ? machine.connectBlocked ?? undefined : undefined}
                accessibilityState={{ selected: machine.active, disabled: blocked }}
                disabled={blocked}
                onPress={() => onChoose(machine)}
                style={({ pressed }) => [styles.row, { borderTopColor: palette.border }, blocked && styles.off, pressed && { backgroundColor: palette.raised }]}
              >
                <MachineGlyph icon={machine.icon} color={palette.ink} />
                <View style={styles.copy}>
                  <Text numberOfLines={1} style={[styles.name, { color: palette.ink }]}>{machine.name}</Text>
                  <Text numberOfLines={1} style={[styles.state, { color: toneColor(machine.tone, palette) }]}>{state}</Text>
                </View>
                {machine.active ? <Check size={18} color={palette.accent} strokeWidth={2} /> : null}
              </Pressable>
            );
          })}
          <Pressable accessibilityRole="button" accessibilityLabel="Add a machine" onPress={onAdd} style={({ pressed }) => [styles.row, styles.add, { borderTopColor: palette.border }, pressed && { backgroundColor: palette.raised }]}>
            <Plus size={18} color={palette.accent} />
            <Text style={[styles.addText, { color: palette.accent }]}>Add a machine</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

/** The list's state line, without the Machines tab's "tap to switch" (a tap here always switches). */
export function shortState(machine: PairedMachine): string {
  return machine.state.replace(/ · tap to switch$/, "");
}

function toneColor(tone: MachineTone, palette: Palette) {
  return tone === "connected" ? palette.success : tone === "attention" ? palette.warning : palette.muted;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)" },
  panel: { position: "absolute", left: 12, right: 44, maxWidth: 360, borderRadius: 16, borderCurve: "continuous", borderWidth: StyleSheet.hairlineWidth, overflow: "hidden", shadowColor: "#000", shadowOpacity: 0.35, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 12 },
  caption: { fontSize: 12, fontWeight: "600", letterSpacing: 0.8, textTransform: "uppercase", paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8 },
  row: { minHeight: 56, paddingHorizontal: 14, paddingVertical: 9, flexDirection: "row", alignItems: "center", gap: 12, borderTopWidth: StyleSheet.hairlineWidth },
  off: { opacity: 0.45 },
  copy: { flex: 1, gap: 1 },
  name: { fontSize: 16, fontWeight: "600" },
  state: { fontSize: 13 },
  add: { minHeight: 48, gap: 10 },
  addText: { fontSize: 16 },
});
