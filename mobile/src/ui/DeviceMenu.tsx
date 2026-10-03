import { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { MoreVertical } from "lucide-react-native";
import { useApp } from "@mobile/state/AppProvider";
import { cleanHostName, hasCustomName, hostDisplayName, hostDisplayNames, HOST_NAME_MAX } from "@mobile/store/host-name";
import type { StoredHost } from "@mobile/store/hosts";
import { Button, Card } from "@mobile/ui/primitives";
import { useTheme } from "@mobile/ui/theme";

/**
 * The menu of a paired computer (PRO-87): Rename, Reconnect and Remove. It
 * opens from the three-dot button next to the computer's name, or from a
 * long press on the name; the button is always there, so a long press is
 * never the only way in. The device list and the sessions screen both use
 * it, through `useDeviceMenu`.
 */
export function useDeviceMenu(options: { onRemoved?(): void } = {}) {
  const app = useApp();
  const [hostId, setHostId] = useState<string | null>(null);
  const host = app.hosts.find((item) => item.id === hostId) ?? null;
  const names = hostDisplayNames(app.hosts);
  return {
    /** What to call `host` on screen: its name, told apart from another computer of the same name. */
    nameOf: (item: StoredHost) => names.get(item.id) ?? hostDisplayName(item),
    open: (item: StoredHost) => setHostId(item.id),
    element: host ? <DeviceMenu key={host.id} host={host} name={names.get(host.id) ?? hostDisplayName(host)} onClose={() => setHostId(null)} onRemoved={options.onRemoved} /> : null,
  };
}

/** The three-dot button that opens a computer's menu. */
export function DeviceOptionsButton({ name, onPress }: { name: string; onPress(): void }) {
  const { palette } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Device options for ${name}`} hitSlop={10} onPress={onPress} style={({ pressed }) => [styles.dots, pressed && { backgroundColor: palette.raised }]}>
      <MoreVertical size={20} color={palette.muted} />
    </Pressable>
  );
}

type Mode = "menu" | "rename" | "remove";

function DeviceMenu({ host, name, onClose, onRemoved }: { host: StoredHost; name: string; onClose(): void; onRemoved?(): void }) {
  const app = useApp();
  const { palette } = useTheme();
  const [mode, setMode] = useState<Mode>("menu");
  const [draft, setDraft] = useState(hostDisplayName(host));
  const [busy, setBusy] = useState(false);
  const custom = hasCustomName(host);
  const own = cleanHostName(host.hostName);

  const act = async (work: () => Promise<void>, after?: () => void) => {
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

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Card style={styles.sheet}>
          <Text numberOfLines={2} style={[styles.title, { color: palette.ink }]}>{name}</Text>
          {mode === "menu" ? (
            <>
              <Text style={[styles.detail, { color: palette.muted }]}>
                {custom ? (own ? `Your name for it. The computer calls itself ${own}.` : "Your name for it.") : own ? "The computer's own name." : "This computer has not sent its name yet."}
              </Text>
              <Button label="Rename" kind="secondary" disabled={busy} onPress={() => setMode("rename")} />
              <Button label="Reconnect" kind="secondary" disabled={busy} onPress={() => void act(() => app.reconnectHost(host.id))} />
              <Button label="Remove" kind="danger" disabled={busy} onPress={() => setMode("remove")} />
              <Button label="Cancel" kind="secondary" disabled={busy} onPress={onClose} />
            </>
          ) : mode === "rename" ? (
            <>
              <Text style={[styles.detail, { color: palette.muted }]}>
                The name is kept on this phone only. It stays if the computer is renamed or reconnects.
              </Text>
              <TextInput
                value={draft}
                onChangeText={setDraft}
                maxLength={HOST_NAME_MAX}
                autoFocus
                accessibilityLabel="Name for this computer"
                placeholder={own ?? "Name"}
                placeholderTextColor={palette.faint}
                style={[styles.input, { color: palette.ink, borderColor: palette.border, backgroundColor: palette.card }]}
              />
              <Button label="Save" disabled={busy || !cleanHostName(draft)} onPress={() => void act(() => app.renameHost(host.id, draft))} />
              {custom ? <Button label={own ? `Use the computer's name (${own})` : "Remove my name for it"} kind="secondary" disabled={busy} onPress={() => void act(() => app.renameHost(host.id, ""))} /> : null}
              <Button label="Cancel" kind="secondary" disabled={busy} onPress={onClose} />
            </>
          ) : (
            <>
              <Text style={[styles.detail, { color: palette.muted }]}>
                Unpair this computer? This phone forgets it, and the computer is asked to remove this phone from its paired devices (it can only be asked while connected). To use it again, pair with a new QR code.
              </Text>
              <Button label={`Remove ${name}`} kind="danger" disabled={busy} onPress={() => void act(() => app.forgetHost(host.id), onRemoved)} />
              <Button label="Cancel" kind="secondary" disabled={busy} onPress={onClose} />
            </>
          )}
        </Card>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  dots: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  backdrop: { flex: 1, justifyContent: "flex-end", padding: 16, backgroundColor: "rgba(0,0,0,0.45)" },
  sheet: { padding: 16, gap: 10 },
  title: { fontSize: 18, fontWeight: "700" },
  detail: { fontSize: 13, lineHeight: 18 },
  input: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 12, fontSize: 16 },
});
