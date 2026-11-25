import { useEffect, useImperativeHandle, useRef, useState, type ComponentRef, type Ref } from "react";
import { Platform, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import * as Clipboard from "expo-clipboard";
import { ArrowUpRight } from "lucide-react-native";
import { useTheme } from "./theme";

/** What a form asks of its field without holding what is in it. */
export interface TextFieldHandle {
  focus(): void;
  /** Empties the field. A secret is dropped at once. */
  clear(): void;
  /** What the field holds, for the one request that sends it. A secret comes without the space around it. */
  read(): string;
}

interface Shared extends Pick<TextInputProps, "autoCapitalize" | "autoCorrect" | "autoComplete" | "spellCheck" | "returnKeyType" | "keyboardType" | "onSubmitEditing" | "autoFocus" | "maxLength"> {
  ref?: Ref<TextFieldHandle>;
  /** The field gained or lost the keyboard: a form keeps a tall field in view while it is typed in. */
  onFocus?: () => void;
  onBlur?: () => void;
  /** Drawn above the field, and what the field is called aloud. */
  label?: string;
  /** What the field is called aloud when it has no label above it. Never the value. */
  accessibilityLabel?: string;
  /** A quiet word at the end of the label's line: "optional". */
  hint?: string;
  /** A link at the end of the label's line: "Get a key". */
  link?: { label: string; onPress(): void };
  /** The line under the field. An error takes its place, in the danger colour. */
  helper?: string;
  error?: string | null;
  placeholder?: string;
  /** Offers Paste at the end of the field while it is empty. */
  paste?: boolean;
  /** Locked while a request is under way. */
  disabled?: boolean;
  /** The monospaced face, for a value that is read character by character. */
  mono?: boolean;
  /**
   * Keeps the hairline while focused and full strength while locked, as the
   * organization delete field has always been drawn. An error still reddens it.
   */
  steady?: boolean;
  testID?: string;
}
interface Plain extends Shared {
  secret?: false;
  value: string;
  onChangeText(value: string): void;
  /**
   * Several lines (25.09's first task): 96 high, growing with the text to 180,
   * then scrolling inside, with the same label, helper and error lines.
   */
  multiline?: boolean;
}
interface Secret extends Shared {
  /** Only ever dots: the value is not drawn, not said aloud, and gone when the field is. */
  secret: true;
  /** Whether anything has been entered: all a form may know before it sends. */
  onFilledChange?(filled: boolean): void;
}
export type TextFieldProps = Plain | Secret;

/** A pasted secret is drawn as this many dots whatever its length (25.03). */
const DOTS = "•".repeat(24);
const NOTHING_TO_PASTE = "Nothing to paste. Copy it first, then tap Paste.";

/**
 * The phone's one text field (25.07): 44 high, a hairline, the raised fill;
 * with a label above, a helper or error line below, and Paste at its end.
 *
 * A secret field keeps what was entered out of React altogether: it is held
 * in a ref, never in state and never in a prop, so nothing that is drawn or
 * read aloud can contain it. Typed, it stays in the system's secure field;
 * pasted, the field shows a fixed row of dots and a tap starts over. The form
 * reads it once, through the handle, for the request that sends it.
 */
export function TextField({ ref, ...props }: TextFieldProps) {
  const { label, hint, link, helper, error, placeholder, paste, disabled, mono, steady, testID, secret } = props;
  const { palette } = useTheme();
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const held = useRef("");
  const epoch = useRef(0);
  const [filled, setFilled] = useState(false);
  const [pasted, setPasted] = useState(false);
  const [refocus, setRefocus] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);
  // Gone from the screen: the secret goes with it, and a late clipboard answer lands nowhere.
  useEffect(() => () => { epoch.current += 1; held.current = ""; }, []);

  const name = props.accessibilityLabel ?? label;
  const empty = secret ? !filled : props.value === "";
  const multiline = !props.secret && props.multiline === true;

  // Space around a secret is never part of it, however it got in: a key pasted from the system's
  // own menu often ends in a space or a line break, and only spaces is nothing entered.
  const hold = (value: string, fromClipboard: boolean) => {
    if (!props.secret) return;
    const had = held.current.trim() !== "";
    const has = value.trim() !== "";
    held.current = value;
    setPasted(fromClipboard && has);
    setFilled(has);
    if (had !== has) props.onFilledChange?.(has);
  };
  const change = (value: string) => {
    setPasteError(null);
    if (props.secret) hold(value, false); else props.onChangeText(value);
  };
  const startOver = () => {
    hold("", false);
    setRefocus(true);
  };
  const pasteIn = () => {
    const attempt = epoch.current;
    Clipboard.getStringAsync().then((text) => {
      if (epoch.current !== attempt) return;
      const value = text.trim();
      if (!value) { setPasteError(NOTHING_TO_PASTE); return; }
      setPasteError(null);
      if (props.secret) { input.current?.clear(); hold(value, true); } else props.onChangeText(value);
    }, () => { if (epoch.current === attempt) setPasteError(NOTHING_TO_PASTE); });
  };

  useImperativeHandle(ref, () => ({
    // A field showing dots has no input to focus until it is cleared: the next one drawn takes the focus.
    focus: () => { if (input.current) input.current.focus(); else setRefocus(true); },
    clear: () => {
      setPasteError(null);
      input.current?.clear();
      if (props.secret) hold("", false); else props.onChangeText("");
    },
    read: () => (props.secret ? held.current.trim() : props.value),
  }));

  const problem = error || pasteError;
  const line = problem || helper;
  const border = problem ? palette.danger : focused && !steady ? palette.accent : palette.border;
  const face = mono ? { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }) } : null;
  return <View testID={testID}>
    {label || hint || link ? <View style={styles.labelRow}>
      <Text style={[styles.label, { color: palette.muted }]}>{label}</Text>
      {link ? <Pressable accessibilityRole="link" accessibilityLabel={link.label} onPress={link.onPress} hitSlop={8} style={styles.link}>
        <Text style={[styles.label, { color: palette.accent }]}>{link.label}</Text>
        <ArrowUpRight size={12} color={palette.accent} />
      </Pressable> : hint ? <Text style={[styles.label, { color: palette.faint }]}>{hint}</Text> : null}
    </View> : null}
    <View style={[styles.field, multiline ? styles.tallField : null, { borderColor: border, backgroundColor: palette.raised }, disabled && !steady ? styles.off : null]}>
      {secret && pasted
        ? <Pressable accessibilityRole="button" accessibilityLabel={name} accessibilityHint="Entered. Double tap to enter it again." accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={startOver} style={styles.dots}>
          <Text accessibilityElementsHidden importantForAccessibility="no-hide-descendants" numberOfLines={1} style={[styles.text, face, { color: palette.ink }]}>{DOTS}</Text>
        </Pressable>
        : <TextInput
          ref={input}
          accessibilityLabel={name}
          // A secret is never handed back to the field: what was typed stays in the system's secure input.
          {...(props.secret ? { secureTextEntry: true } : { value: props.value })}
          onChangeText={change}
          onFocus={() => { setFocused(true); props.onFocus?.(); }}
          onBlur={() => { setFocused(false); setRefocus(false); props.onBlur?.(); }}
          editable={!disabled}
          autoFocus={props.autoFocus || refocus}
          autoCapitalize={props.autoCapitalize ?? (secret ? "none" : undefined)}
          autoCorrect={props.autoCorrect ?? (secret ? false : undefined)}
          autoComplete={props.autoComplete ?? (secret ? "off" : undefined)}
          spellCheck={props.spellCheck ?? (secret ? false : undefined)}
          returnKeyType={props.returnKeyType}
          keyboardType={props.keyboardType}
          maxLength={props.maxLength}
          onSubmitEditing={props.onSubmitEditing}
          placeholder={placeholder}
          placeholderTextColor={palette.faint}
          {...(multiline ? { multiline: true, textAlignVertical: "top" as const, scrollEnabled: true } : {})}
          style={[styles.input, styles.text, multiline ? styles.tallInput : null, face, { color: palette.ink }]}
        />}
      {paste && empty && !disabled ? <Pressable accessibilityRole="button" accessibilityLabel={name ? `Paste ${name}` : "Paste"} onPress={pasteIn} hitSlop={10}>
        <Text style={[styles.paste, { color: palette.accent }]}>Paste</Text>
      </Pressable> : null}
    </View>
    {line ? <Text accessibilityRole={problem ? "alert" : undefined} style={[styles.line, { color: problem ? palette.danger : palette.muted }]}>{line}</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  // The hint or the link goes under a label it does not fit beside: at the accessibility text sizes "optional" ran off the edge (PRO-563).
  labelRow: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", columnGap: 8, rowGap: 2, marginHorizontal: 4, marginBottom: 6 },
  label: { fontSize: 13, lineHeight: 18 },
  link: { flexDirection: "row", alignItems: "center", gap: 3 },
  field: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 8 },
  // 96 high with its padding, growing to 180: the text area is 74 to 158.
  tallField: { minHeight: 96, alignItems: "flex-start", paddingVertical: 11 },
  tallInput: { minHeight: 74, maxHeight: 158, lineHeight: 22 },
  off: { opacity: 0.55 },
  input: { flex: 1, alignSelf: "stretch", paddingVertical: 0 },
  dots: { flex: 1, alignSelf: "stretch", justifyContent: "center" },
  text: { fontSize: 16 },
  paste: { fontSize: 14, fontWeight: "600" },
  line: { fontSize: 13, lineHeight: 18, marginTop: 6, marginHorizontal: 4 },
});
