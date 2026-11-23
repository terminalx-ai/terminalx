import { useEffect, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { CloudQuote } from "@mobile/cloud/api";
import { clockText, useRemaining } from "./countdown";
import { Card } from "./primitives";
import { useTheme } from "./theme";

/**
 * An amount the server gives in millionths of a currency unit, as the boards
 * write prices: $12.96, and three places below one unit ($0.018), where two
 * would round an hourly rate away. A currency the phone cannot format is
 * written as the number beside its code.
 */
export function priceText(micros: number, currency: string): string {
  const amount = micros / 1_000_000;
  const small = Math.abs(amount) < 1;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, ...(small ? { minimumFractionDigits: 3, maximumFractionDigits: 3 } : {}) }).format(amount);
  } catch {
    return `${amount.toFixed(small ? 3 : 2)} ${currency}`;
  }
}

/**
 * A quote's price (25.05): per active hour, and what 30 days always on comes
 * to, then how long the price holds. Once it has run out the figures stay,
 * dimmed: an expired price is shown as what it was, never as one to launch on.
 * The hold is counted on the server's clock, which the screen hands in.
 */
export function PriceLines({ quote, now, note, onExpired, testID }: {
  quote: Pick<CloudQuote, "activeHourlyMicros" | "alwaysOnThirtyDayMicros" | "currency" | "expiresAt">;
  /**
   * The server's clock: the cloud client's `serverNow`. The quote's expiry is
   * a server time, so it is never compared with the phone's own clock.
   */
  now: () => number;
  /** Before the countdown: who bills, and that prices are estimates. */
  note?: string;
  /** Told once when the quote runs out, and at once for one that already has. */
  onExpired?(): void;
  testID?: string;
}) {
  const { palette } = useTheme();
  const remaining = useRemaining(quote.expiresAt, now);
  const over = remaining === 0;
  const expired = useRef(onExpired);
  useEffect(() => { expired.current = onExpired; });
  useEffect(() => { if (over) expired.current?.(); }, [over, quote.expiresAt]);

  const line = (label: string, micros: number, divided: boolean) => {
    const value = priceText(micros, quote.currency);
    return <View accessible accessibilityLabel={`${label}: ${value}${over ? ", expired" : ""}`} style={[styles.row, divided ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border } : null, over ? styles.dim : null]}>
      <Text style={[styles.label, { color: palette.muted }]}>{label}</Text>
      <Text style={[styles.value, { color: palette.ink }]}>{value}</Text>
    </View>;
  };
  return <View testID={testID} style={styles.block}>
    <Card>
      {line("Per active hour", quote.activeHourlyMicros, false)}
      {line("Always on, 30 days", quote.alwaysOnThirtyDayMicros, true)}
    </Card>
    {over ? null : <Text testID="price-holds" style={[styles.note, { color: palette.muted }]}>{note ? `${note} ` : ""}<Text style={styles.clock}>{`This price holds for ${clockText(remaining)}.`}</Text></Text>}
  </View>;
}

const styles = StyleSheet.create({
  block: { gap: 6 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 12, paddingHorizontal: 14, paddingVertical: 9 },
  dim: { opacity: 0.45 },
  label: { fontSize: 15, lineHeight: 20 },
  value: { fontSize: 15, lineHeight: 20, fontWeight: "600", textAlign: "right", fontVariant: ["tabular-nums"] },
  note: { fontSize: 13, lineHeight: 18, marginHorizontal: 4 },
  clock: { fontVariant: ["tabular-nums"] },
});
