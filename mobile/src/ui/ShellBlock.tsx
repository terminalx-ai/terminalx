import { useState } from "react";
import { Alert, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Check, Copy } from "lucide-react-native";
import { foldShellOutput } from "@terminalx/portable/harnessText";
import type { WorkItem } from "@terminalx/portable/transcript";
import { useTheme } from "./theme";

type Shell = Extract<WorkItem, { kind: "shell" }>;

/** What Copy puts on the clipboard: the command as typed at a prompt, then what it printed (as on the desktop). */
export function shellCopyText(item: Shell): string {
  return [item.command !== undefined ? `$ ${item.command}` : "", item.stdout, item.stderr].filter(Boolean).join("\n");
}

/**
 * A command the reader ran through Claude Code's `!` (#1294), drawn like a
 * shell: `$ command`, then what it printed, stderr in red. Long output folds
 * behind "Show more" where the desktop folds it; an empty part draws nothing.
 */
export function ShellBlock({ item }: { item: Shell }) {
  const { palette } = useTheme();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const stdout = foldShellOutput(item.stdout);
  const stderr = foldShellOutput(item.stderr);
  const folded = stdout.folded || stderr.folded;
  const failed = item.exitCode !== undefined && item.exitCode !== 0;
  const copy = () => {
    Clipboard.setStringAsync(shellCopyText(item)).then(() => setCopied(true), (cause: unknown) => Alert.alert("Could not copy the command", cause instanceof Error ? cause.message : "Try again."));
  };
  return <View testID="shell-block" style={[styles.block, { backgroundColor: palette.card, borderColor: palette.border }]}>
    <View style={styles.head}>
      <View style={styles.headText}>
        {item.author ? <Text style={[styles.author, { color: palette.faint }]}>{`${item.author.displayName} ran`}</Text> : null}
        {item.command !== undefined ? <Text selectable style={[styles.mono, { color: palette.ink }]}><Text style={{ color: palette.faint }}>$ </Text>{item.command}</Text> : null}
      </View>
      <Pressable testID="shell-copy" accessibilityRole="button" accessibilityLabel={copied ? "Copied" : "Copy command and output"} onPress={copy} hitSlop={10} style={styles.copy}>
        {copied ? <Check size={15} color={palette.muted} /> : <Copy size={15} color={palette.muted} />}
      </Pressable>
    </View>
    {item.stdout ? <Text testID="shell-stdout" selectable style={[styles.mono, { color: palette.muted }]}>{open ? item.stdout : stdout.shown}</Text> : null}
    {item.stderr ? <Text testID="shell-stderr" selectable style={[styles.mono, { color: palette.danger }]}>{open ? item.stderr : stderr.shown}</Text> : null}
    {failed ? <Text testID="shell-exit" style={[styles.mono, { color: palette.danger }]}>{`exit ${item.exitCode}`}</Text> : null}
    {folded ? <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} hitSlop={8} style={[styles.more, { borderTopColor: palette.border }]}>
      <Text style={[styles.moreText, { color: palette.muted }]}>{open ? "Show less" : "Show more"}</Text>
    </Pressable> : null}
  </View>;
}

const styles = StyleSheet.create({
  block: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 11, paddingTop: 9, paddingBottom: 9, gap: 4 },
  head: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  headText: { flex: 1, gap: 2 },
  author: { fontSize: 12, lineHeight: 16 },
  mono: { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 13, lineHeight: 18 },
  copy: { paddingTop: 1 },
  more: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 4, paddingTop: 7, minHeight: 32, justifyContent: "center" },
  moreText: { fontSize: 13 },
});
