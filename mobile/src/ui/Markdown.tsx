import { memo, useMemo, type ReactNode } from "react";
import { Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { Marked, type Token, type Tokens } from "marked";
import { decodeHTML } from "entities";
import { useTheme, type Palette } from "./theme";
import { ChatLink, LinkedText, linkedText } from "./LinkedText";

// Parse markdown once per changed text, then draw native views. No WebView or
// HTML is involved, including for streamed text and nested table/list content.
const parser = new Marked({ gfm: true, breaks: true });

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const { palette } = useTheme();
  const tokens = useMemo(() => parser.lexer(text), [text]);
  return <View style={styles.blocks}>{blocks(tokens, palette)}</View>;
});

function blocks(tokens: Token[] | undefined, palette: Palette): ReactNode[] {
  return (tokens ?? []).map((token, index) => {
    switch (token.type) {
      case "space": case "def": return null;
      case "heading":
        return <Text key={index} selectable accessibilityRole="header" style={[styles.body, styles.heading, { color: palette.ink, fontSize: token.depth === 1 ? 24 : token.depth === 2 ? 21 : 18 }]}>{inline(token.tokens, palette)}</Text>;
      case "paragraph": case "text":
        return <Text key={index} selectable style={[styles.body, { color: palette.ink }]}>{token.tokens ? inline(token.tokens, palette) : linkedText(token.text)}</Text>;
      case "code":
        return <View key={index} style={[styles.codeBlock, { backgroundColor: palette.raised, borderColor: palette.border }]}>
          {token.lang ? <Text style={[styles.language, { color: palette.muted }]}>{token.lang.split(/\s/)[0]}</Text> : null}
          <ScrollView horizontal accessibilityLabel="Code block" contentContainerStyle={styles.codeContent}>
            <LinkedText style={[styles.code, { color: palette.ink }]}>{token.text}</LinkedText>
          </ScrollView>
        </View>;
      case "list":
        return <View key={index} style={styles.list}>{token.items.map((item: Tokens.ListItem, itemIndex: number) => <View key={itemIndex} style={styles.listItem}>
          <Text style={[styles.body, styles.marker, { color: palette.muted }]}>{item.task ? item.checked ? "☑" : "☐" : token.ordered ? `${Number(token.start) + itemIndex}.` : "•"}</Text>
          <View style={[styles.blocks, styles.listBody]}>{blocks(item.tokens, palette)}</View>
        </View>)}</View>;
      case "blockquote":
        return <View key={index} style={[styles.blocks, styles.quote, { borderColor: palette.accent }]}>{blocks(token.tokens, palette)}</View>;
      case "table":
        return <MarkdownTable key={index} table={token as Tokens.Table} palette={palette} />;
      case "hr":
        return <View key={index} style={[styles.rule, { backgroundColor: palette.border }]} />;
      default:
        return <LinkedText key={index} style={[styles.body, { color: palette.ink }]}>{"text" in token ? token.text : token.raw}</LinkedText>;
    }
  });
}

function inline(tokens: Token[] | undefined, palette: Palette, linkify = true): ReactNode[] {
  return (tokens ?? []).map((token, index) => {
    switch (token.type) {
      case "strong": return <Text key={index} style={styles.strong}>{inline(token.tokens, palette, linkify)}</Text>;
      case "em": return <Text key={index} style={styles.emphasis}>{inline(token.tokens, palette, linkify)}</Text>;
      case "del": return <Text key={index} style={styles.deleted}>{inline(token.tokens, palette, linkify)}</Text>;
      case "codespan": return <Text key={index} style={[styles.inlineCode, { backgroundColor: palette.raised }]}>{linkify ? linkedText(token.text) : token.text}</Text>;
      case "br": return "\n";
      case "link": {
        if (/^(javascript|data|vbscript|blob):/i.test(token.href)) return <Text key={index}>{token.text}</Text>;
        return <ChatLink key={index} href={token.href}>{inline(token.tokens, palette, false)}</ChatLink>;
      }
      case "image": return <Text key={index} style={{ color: palette.muted }}>{token.text || "Image"}</Text>;
      case "text": return token.tokens ? <Text key={index}>{inline(token.tokens, palette, linkify)}</Text> : <Text key={index}>{linkify ? linkedText(decodeHTML(token.text)) : decodeHTML(token.text)}</Text>;
      case "escape": return <Text key={index}>{linkify ? linkedText(decodeHTML(token.text)) : decodeHTML(token.text)}</Text>;
      default: {
        const text = "text" in token ? token.text : token.raw;
        return <Text key={index}>{linkify ? linkedText(text) : text}</Text>;
      }
    }
  });
}

function MarkdownTable({ table, palette }: { table: Tokens.Table; palette: Palette }) {
  const rows = [table.header, ...table.rows];
  return <ScrollView horizontal accessibilityLabel="Markdown table" style={styles.tableScroll}>
    <View style={[styles.table, { borderColor: palette.border }]}>{rows.map((row, rowIndex) => <View key={rowIndex} style={[styles.tableRow, rowIndex === 0 && { backgroundColor: palette.raised }]}>{row.map((cell, cellIndex) => <View key={cellIndex} style={[styles.cell, { borderColor: palette.border }]}>
      <Text selectable style={[styles.body, rowIndex === 0 && styles.strong, { color: palette.ink, textAlign: table.align[cellIndex] ?? "left" }]}>{inline(cell.tokens, palette)}</Text>
    </View>)}</View>)}</View>
  </ScrollView>;
}

const styles = StyleSheet.create({
  blocks: { gap: 10, minWidth: 0 },
  body: { fontSize: 15, lineHeight: 22 },
  heading: { fontWeight: "700", lineHeight: 29 },
  strong: { fontWeight: "700" },
  emphasis: { fontStyle: "italic" },
  deleted: { textDecorationLine: "line-through" },
  inlineCode: { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 13 },
  code: { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 13, lineHeight: 20 },
  codeBlock: { borderRadius: 10, borderCurve: "continuous", borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  codeContent: { padding: 12 },
  language: { fontSize: 11, paddingHorizontal: 12, paddingTop: 8 },
  list: { gap: 6 },
  listItem: { flexDirection: "row", gap: 8 },
  marker: { minWidth: 24, textAlign: "right" },
  listBody: { flex: 1 },
  quote: { borderLeftWidth: 3, paddingLeft: 12 },
  rule: { height: StyleSheet.hairlineWidth },
  tableScroll: { maxWidth: "100%" },
  table: { borderWidth: StyleSheet.hairlineWidth },
  tableRow: { flexDirection: "row" },
  cell: { width: 180, padding: 10, borderRightWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
});
