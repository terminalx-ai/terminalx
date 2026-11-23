import { useEffect, useRef, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Check, Copy } from "lucide-react-native";
import { clockText, useRemaining } from "./countdown";
import { Button } from "./primitives";
import { useTheme } from "./theme";

/**
 * The device login's code (25.04): large and monospaced, with Copy under it
 * and the time it has left beside its label. A code that can no longer be
 * used (expired, refused, cancelled) stays in view struck through, with
 * nothing left to copy or count.
 */
export function OneTimeCode({ code, expiresAt, spent, onExpired, testID }: {
  code: string;
  /**
   * When the code stops working, on the phone's own clock: the server gives a
   * number of seconds, which the screen adds to the time it got the answer.
   */
  expiresAt?: number | null;
  /** The code is no longer good, whatever the clock says. */
  spent?: boolean;
  /** Told once when the clock runs out on a code that was still good. */
  onExpired?(): void;
  testID?: string;
}) {
  const { palette } = useTheme();
  const remaining = useRemaining(spent ? null : expiresAt);
  const ranOut = !spent && expiresAt != null && remaining === 0;
  const over = spent || ranOut;
  // Which code was copied, or could not be: a new code starts with neither said.
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [failedCode, setFailedCode] = useState<string | null>(null);
  const copied = copiedCode === code;
  const failed = failedCode === code;
  const epoch = useRef(0);
  useEffect(() => () => { epoch.current += 1; }, []);
  const expired = useRef(onExpired);
  useEffect(() => { expired.current = onExpired; });
  useEffect(() => { if (ranOut) expired.current?.(); }, [ranOut]);

  const copy = () => {
    const attempt = epoch.current;
    Clipboard.setStringAsync(code).then(
      () => { if (epoch.current === attempt) { setCopiedCode(code); setFailedCode(null); } },
      () => { if (epoch.current === attempt) setFailedCode(code); },
    );
  };

  return <View testID={testID} style={styles.block}>
    <View style={styles.labelRow}>
      <Text style={[styles.label, { color: palette.muted }]}>One-time code</Text>
      {!over && expiresAt != null ? <Text testID="one-time-code-expiry" style={[styles.label, styles.clock, { color: palette.muted }]}>{`expires in ${clockText(remaining)}`}</Text> : null}
    </View>
    {/* Read out character by character, not as a word; long-press selects it. */}
    <Text selectable testID="one-time-code" accessibilityLabel={`One-time code: ${[...code].join(" ")}${over ? ", no longer valid" : ""}`}
      style={[styles.code, { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), color: over ? palette.faint : palette.ink, backgroundColor: palette.raised, borderColor: palette.border }, over ? styles.struck : null]}>{code}</Text>
    {over ? null : <Button label={copied ? "Copied" : "Copy code"} accessibilityLabel="Copy code" kind="secondary" icon={(color) => (copied ? <Check size={16} color={color} /> : <Copy size={16} color={color} />)} onPress={copy} />}
    {failed && !over ? <Text accessibilityRole="alert" style={[styles.problem, { color: palette.danger }]}>Could not copy the code. Select it and copy it, or type it.</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  block: { gap: 10 },
  labelRow: { flexDirection: "row", justifyContent: "space-between", gap: 8, marginHorizontal: 4, marginBottom: -4 },
  label: { fontSize: 13, lineHeight: 18 },
  clock: { fontVariant: ["tabular-nums"] },
  code: { fontSize: 30, fontWeight: "500", letterSpacing: 4.2, textAlign: "center", paddingHorizontal: 8, paddingVertical: 18, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  struck: { textDecorationLine: "line-through" },
  problem: { fontSize: 13, lineHeight: 18, marginHorizontal: 4 },
});
