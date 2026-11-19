import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import {
  organizationDeletionError,
  organizationDeletionOffered,
  organizationDeletionText as text,
  organizationNameConfirmed,
} from "@terminalx/portable/organizationDeletion";
import type { CloudOrganization } from "@mobile/cloud/api";
import { Button, Card } from "@mobile/ui/primitives";
import { useTheme } from "@mobile/ui/theme";

/**
 * Deleting an organization from the phone (#1292), worded and checked as the
 * desktop app and the web console do: owners only, never a personal
 * organization, and the name typed (or pasted) to confirm. The organization's
 * own name is sent, never the typed text; the server checks it again, with
 * ownership and anything that still holds the organization.
 */
export function OrganizationDelete(props: Props) {
  const { organization } = props;
  if (!organizationDeletionOffered(organization)) return null;
  // Another organization, name or role starts over: an open confirmation never carries across.
  return <Confirmation key={JSON.stringify([organization.orgId, organization.name, organization.role, organization.isPersonal ?? null])} {...props} />;
}

interface Props {
  organization: CloudOrganization;
  /** Sends the deletion; resolves only when the server confirmed it. */
  remove: (confirmationName: string) => Promise<void>;
  onDeleted: () => void;
}

function Confirmation({ organization, remove, onDeleted }: Props) {
  const { palette } = useTheme();
  // The name as it was when the person opened the confirmation; a new name needs a new confirmation.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flight = useRef(false);
  const epoch = useRef(0);
  // Gone from the screen: a late answer neither shows nor navigates.
  useEffect(() => () => { epoch.current += 1; }, []);

  const confirmed = confirming !== null && organizationNameConfirmed(typed, confirming);

  const submit = async () => {
    if (flight.current || confirming === null || !confirmed || confirming !== organization.name) return;
    const attempt = epoch.current;
    flight.current = true;
    setBusy(true);
    setError(null);
    try {
      await remove(confirming);
      // Done: the confirmation is spent, so a tap while the screen goes away sends nothing more.
      if (epoch.current === attempt) { setConfirming(null); setTyped(""); onDeleted(); }
    } catch (failure) {
      if (epoch.current === attempt) setError(organizationDeletionError(failure));
    } finally {
      if (epoch.current === attempt) {
        // A refusal keeps what was typed, and is never tried again on its own.
        setBusy(false);
        flight.current = false;
      }
    }
  };

  const copy = (name: string) => {
    const attempt = epoch.current;
    Clipboard.setStringAsync(name).then(
      () => { if (epoch.current === attempt) setCopied(true); },
      () => { if (epoch.current === attempt) setError("Could not copy the name. Select it and copy it, or type it."); },
    );
  };

  return <Card style={[styles.card, { borderColor: `${palette.danger}55` }]}>
    <Text accessibilityRole="header" style={[styles.title, { color: palette.ink }]}>{text.title}</Text>
    <Text style={[styles.detail, { color: palette.muted }]}>{text.warning(organization.name)}</Text>
    {confirming === null
      ? <Button label={text.start} kind="danger" onPress={() => { setError(null); setTyped(""); setCopied(false); setConfirming(organization.name); }} />
      : <>
        <Text style={[styles.detail, { color: palette.ink }]}>{text.prompt}</Text>
        <View style={styles.nameRow}>
          {/* Long-press selects it; the button copies it in one tap. */}
          <Text selectable testID="organization-delete-name" style={[styles.name, { color: palette.ink, backgroundColor: palette.raised }]}>{confirming}</Text>
          <Button label={copied ? text.copied : text.copy} accessibilityLabel={text.copy} kind="secondary" size="small" disabled={busy} onPress={() => copy(confirming)} />
        </View>
        <TextInput
          accessibilityLabel={text.inputLabel}
          value={typed}
          onChangeText={setTyped}
          editable={!busy}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          returnKeyType="done"
          onSubmitEditing={() => void submit()}
          placeholder={confirming}
          placeholderTextColor={palette.faint}
          style={[styles.input, { color: palette.ink, borderColor: palette.border, backgroundColor: palette.raised }]}
        />
        <Button label={text.confirm(confirming)} kind="danger" disabled={busy || !confirmed} onPress={() => void submit()} />
        <Button label={text.cancel} kind="secondary" disabled={busy} onPress={() => { setConfirming(null); setTyped(""); setCopied(false); setError(null); }} />
      </>}
    {error ? <Text accessibilityRole="alert" style={[styles.detail, { color: palette.danger }]}>{error}</Text> : null}
  </Card>;
}

const styles = StyleSheet.create({
  card: { padding: 16, gap: 10, borderWidth: StyleSheet.hairlineWidth },
  title: { fontSize: 17, fontWeight: "600" },
  detail: { fontSize: 15, lineHeight: 21 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  name: { flexShrink: 1, fontSize: 16, fontWeight: "600", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, overflow: "hidden" },
  input: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, fontSize: 16 },
});
