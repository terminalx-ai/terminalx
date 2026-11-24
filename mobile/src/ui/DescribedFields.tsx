import { useImperativeHandle, useRef, useState, type Ref } from "react";
import { StyleSheet, View } from "react-native";
import type { CloudProviderCredentialField } from "@mobile/cloud/api";
import { TextField, type TextFieldHandle } from "./TextField";

export interface DescribedFieldsHandle {
  /** Every field's value by name, for the one request that sends them. */
  read(): Record<string, string>;
  /** Empties one field, or all of them: a rejected key is never kept on screen. */
  clear(name?: string): void;
  focus(name: string): void;
}

/**
 * A provider's credential form as its descriptor describes it (25.03): one
 * field per credential field, in the server's order and under the server's
 * labels. A text field shows what is typed; a secret one never does, and a
 * kind this app does not know arrives here already read as secret. A field
 * with a help address offers it as a link.
 *
 * The form above is told only whether every field has something in it. Give
 * this a `key` of the provider's id: another provider is another form.
 */
export function DescribedFields({ ref, fields, onReadyChange, onOpenHelp, helper, errors, disabled, linkLabel = "Get a key", testID }: {
  ref?: Ref<DescribedFieldsHandle>;
  fields: readonly CloudProviderCredentialField[];
  /** Whether every field is filled in: when the form's button may come alive. */
  onReadyChange?(ready: boolean): void;
  /** Opens a field's help address; the link is drawn only when this is given. */
  onOpenHelp?(url: string): void;
  /** Under the last field: what happens to what is entered. */
  helper?: string;
  /** A refusal for a field, by its name, in place of the line under it. */
  errors?: Readonly<Record<string, string | undefined>>;
  disabled?: boolean;
  linkLabel?: string;
  testID?: string;
}) {
  const [text, setText] = useState<Record<string, string>>({});
  const inputs = useRef(new Map<string, TextFieldHandle | null>());
  const filled = useRef(new Map<string, boolean>());
  const ready = useRef(false);

  const report = (name: string, has: boolean) => {
    filled.current.set(name, has);
    const next = fields.every((field) => filled.current.get(field.name));
    if (next !== ready.current) { ready.current = next; onReadyChange?.(next); }
  };

  useImperativeHandle(ref, () => ({
    read: () => Object.fromEntries(fields.map((field) => [field.name, field.kind === "text" ? (text[field.name] ?? "").trim() : inputs.current.get(field.name)?.read() ?? ""])),
    clear: (name) => { for (const field of fields) if (name === undefined || field.name === name) inputs.current.get(field.name)?.clear(); },
    focus: (name) => inputs.current.get(name)?.focus(),
  }));

  if (!fields.length) return null;
  return <View testID={testID} style={styles.fields}>
    {fields.map((field, index) => {
      const shared = {
        ref: (handle: TextFieldHandle | null) => { inputs.current.set(field.name, handle); },
        label: field.label,
        placeholder: field.label,
        link: field.helpUrl && onOpenHelp ? { label: linkLabel, onPress: () => onOpenHelp(field.helpUrl!) } : undefined,
        helper: index === fields.length - 1 ? helper : undefined,
        error: errors?.[field.name],
        disabled,
        testID: `described-field-${field.name}`,
      };
      return field.kind === "text"
        ? <TextField key={`${index}:${field.name}`} {...shared} value={text[field.name] ?? ""} onChangeText={(value) => { setText((current) => ({ ...current, [field.name]: value })); report(field.name, value.trim() !== ""); }} autoCapitalize="none" autoCorrect={false} spellCheck={false} />
        : <TextField key={`${index}:${field.name}`} {...shared} secret paste onFilledChange={(has) => report(field.name, has)} />;
    })}
  </View>;
}

const styles = StyleSheet.create({
  fields: { gap: 14 },
});
