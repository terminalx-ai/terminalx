import { useCallback, useRef, useState, type ReactNode } from "react";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import type { Tokens } from "marked";
import { LinearGradient } from "expo-linear-gradient";
import * as Clipboard from "expo-clipboard";
import { Copy, Maximize2, X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, type Palette } from "./theme";

/** Which sides of a sideways scroller still hide content, so only those sides fade. */
export function scrollEdges(offset: number, viewport: number, content: number): { start: boolean; end: boolean } {
  const slack = 1;
  return { start: offset > slack, end: viewport > 0 && offset + viewport < content - slack };
}

/** A column is as wide as its widest cell, up to this; longer cells end in an ellipsis until the table is opened. */
const MAX_COLUMN_WIDTH = 220;
/** Full screen a column is as wide as its widest cell, up to this; longer cells wrap. */
const WRAPPING_COLUMN_WIDTH = 200;
const FADE_WIDTH = 56;

/**
 * Column widths after a cell reports its own: a column grows to its widest
 * cell, up to `cap`, and never shrinks, so every row lines up.
 * The same array comes back when nothing grew, so no render follows.
 */
export function growColumns(widths: readonly number[], column: number, width: number, cap = MAX_COLUMN_WIDTH): readonly number[] {
  const next = Math.min(cap, Math.ceil(width));
  if ((widths[column] ?? 0) >= next) return widths;
  const grown = [...widths];
  grown[column] = next;
  return grown;
}

type CellRenderer = (cell: Tokens.TableCell) => ReactNode;

/**
 * A markdown table in its own card: it starts at its first column, scrolls
 * sideways inside the card, fades at an edge only where more is hidden, and
 * opens full screen where cells wrap instead of being cut.
 */
export function MarkdownTable({ table, renderCell }: { table: Tokens.Table; renderCell: CellRenderer }) {
  const { palette } = useTheme();
  const [edges, setEdges] = useState({ start: false, end: false });
  const [expanded, setExpanded] = useState(false);
  const [widths, setWidths] = useState<readonly number[]>([]);
  // The latest sizes, not the ones a render closed over: layout and content
  // size can arrive in one batch, and the second must see the first.
  const size = useRef({ offset: 0, viewport: 0, content: 0 });
  const update = useCallback((next: Partial<{ offset: number; viewport: number; content: number }>) => {
    size.current = { ...size.current, ...next };
    const { offset, viewport, content } = size.current;
    setEdges((previous) => {
      const edge = scrollEdges(offset, viewport, content);
      return previous.start === edge.start && previous.end === edge.end ? previous : edge;
    });
  }, []);
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
    update({ offset: contentOffset.x, viewport: layoutMeasurement.width, content: contentSize.width });
  };
  // Each cell reports its width; a column grows to its widest cell, so every row lines up.
  const measured = useCallback((column: number, width: number) => {
    setWidths((previous) => growColumns(previous, column, width));
  }, []);
  return <View style={[styles.card, { borderColor: palette.border, backgroundColor: palette.card }]}>
    <ScrollView
      horizontal
      accessibilityLabel="Markdown table"
      scrollEventThrottle={16}
      showsHorizontalScrollIndicator={false}
      contentOffset={{ x: 0, y: 0 }}
      onScroll={onScroll}
      onLayout={(event) => update({ viewport: event.nativeEvent.layout.width })}
      onContentSizeChange={(width) => update({ content: width })}
    >
      <TableGrid table={table} renderCell={renderCell} palette={palette} widths={widths} onMeasure={measured} />
    </ScrollView>
    {edges.start ? <Fade side="start" color={palette.card} /> : null}
    {edges.end ? <Fade side="end" color={palette.card} /> : null}
    <Pressable accessibilityRole="button" accessibilityLabel="Expand table" hitSlop={4} onPress={() => setExpanded(true)}
      style={[styles.round, styles.expand, { backgroundColor: palette.raised, borderColor: palette.border }]}>
      <Maximize2 size={16} color={palette.ink} />
    </Pressable>
    <ExpandedTable visible={expanded} table={table} renderCell={renderCell} palette={palette} onClose={() => setExpanded(false)} />
  </View>;
}

/** The table as the agent wrote it, for Copy: the markdown, which pastes as a table where markdown is read. */
export function tableText(table: Tokens.Table): string {
  return table.raw.trim();
}

/** The table seen full screen: every cell is drawn, and long cell text wraps. Close and Copy sit in its bar (22.03). */
export function ExpandedTable({ visible, table, renderCell, palette, onClose }: {
  visible: boolean; table: Tokens.Table; renderCell: CellRenderer; palette: Palette; onClose: () => void;
}) {
  // Said only when the columns are wider than the screen (22.03).
  const [fit, setFit] = useState({ viewport: 0, content: 0 });
  const wider = fit.viewport > 0 && fit.content > fit.viewport + 1;
  // Columns sized to their cells, as in the card; a cell past the cap wraps.
  const [widths, setWidths] = useState<readonly number[]>([]);
  const measured = useCallback((column: number, width: number) => {
    setWidths((previous) => growColumns(previous, column, width, WRAPPING_COLUMN_WIDTH));
  }, []);
  const insets = useSafeAreaInsets();
  const copy = () => { void Clipboard.setStringAsync(tableText(table)).catch((cause: unknown) => Alert.alert("Could not copy the table", cause instanceof Error ? cause.message : "Try again.")); };
  return <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
    <View style={[styles.full, { backgroundColor: palette.page, paddingTop: insets.top + 4 }]}>
      <View style={styles.fullBar}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close table" hitSlop={4} onPress={onClose}
          style={[styles.round, { backgroundColor: palette.raised, borderColor: palette.border }]}>
          <X size={20} color={palette.ink} />
        </Pressable>
        <Text accessibilityRole="header" numberOfLines={1} style={[styles.fullTitle, { color: palette.ink }]}>Table</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Copy table" hitSlop={4} onPress={copy}
          style={[styles.round, { backgroundColor: palette.raised, borderColor: palette.border }]}>
          <Copy size={18} color={palette.ink} />
        </Pressable>
      </View>
      <ScrollView accessibilityLabel="Expanded table" contentContainerStyle={styles.fullContent}>
        <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.fullGrid}
          onLayout={(event) => { const viewport = event.nativeEvent.layout.width; setFit((previous) => previous.viewport === viewport ? previous : { ...previous, viewport }); }}
          onContentSizeChange={(content) => setFit((previous) => previous.content === content ? previous : { ...previous, content })}>
          <TableGrid table={table} renderCell={renderCell} palette={palette} widths={widths} onMeasure={measured} wrap />
        </ScrollView>
        {/* The app is held upright, so turning the phone shows no more: the board's second sentence is left out. */}
        {wider ? <Text style={[styles.hint, { color: palette.faint }]}>Swipe sideways for more columns.</Text> : null}
      </ScrollView>
    </View>
  </Modal>;
}

/**
 * Rows of cells, each column as wide as its widest cell up to a cap. In the
 * card a cell stays on one line; full screen (`wrap`) a longer cell wraps.
 */
function TableGrid({ table, renderCell, palette, widths = [], onMeasure, wrap = false }: {
  table: Tokens.Table; renderCell: CellRenderer; palette: Palette; widths?: readonly number[]; onMeasure?: (column: number, width: number) => void; wrap?: boolean;
}) {
  const rows = [table.header, ...table.rows];
  return <View>
    {rows.map((row, rowIndex) => <View key={rowIndex} style={[styles.row, rowIndex < rows.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border }]}>
      {row.map((cell, cellIndex) => <View key={cellIndex}
        onLayout={onMeasure ? (event) => onMeasure(cellIndex, event.nativeEvent.layout.width) : undefined}
        style={[styles.cell, { minWidth: widths[cellIndex], maxWidth: wrap ? WRAPPING_COLUMN_WIDTH : MAX_COLUMN_WIDTH }]}>
        <Text selectable numberOfLines={wrap ? undefined : 1} style={[styles.text, (rowIndex === 0 || cellIndex === 0) && styles.header, { color: rowIndex === 0 ? palette.muted : palette.ink, textAlign: table.align[cellIndex] ?? "left" }]}>{renderCell(cell)}</Text>
      </View>)}
    </View>)}
  </View>;
}

function Fade({ side, color }: { side: "start" | "end"; color: string }) {
  const towards = side === "end" ? { start: { x: 0, y: 0 }, end: { x: 1, y: 0 } } : { start: { x: 1, y: 0 }, end: { x: 0, y: 0 } };
  return <View pointerEvents="none" testID={`table-fade-${side}`} style={[styles.fade, side === "end" ? styles.fadeEnd : styles.fadeStart]}>
    <LinearGradient {...towards} colors={[`${color}00`, color]} style={StyleSheet.absoluteFill} />
  </View>;
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, borderCurve: "continuous", overflow: "hidden", maxWidth: "100%", paddingVertical: 4, paddingLeft: 14 },
  row: { flexDirection: "row" },
  // As the board's cells: room on the right of each, none on the left, so the first column lines up with the card's text.
  cell: { paddingLeft: 0, paddingRight: 14, paddingVertical: 8 },
  text: { fontSize: 14, lineHeight: 20 },
  // The header row and the first column, which names each row.
  header: { fontWeight: "600" },
  fade: { position: "absolute", top: 0, bottom: 0, width: FADE_WIDTH },
  fadeStart: { left: 0 },
  fadeEnd: { right: 0 },
  round: { width: 40, height: 40, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
  expand: { position: "absolute", bottom: 8, right: 8 },
  full: { flex: 1 },
  fullBar: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 10 },
  fullTitle: { flex: 1, fontSize: 17, fontWeight: "600" },
  fullContent: { paddingHorizontal: 16, paddingBottom: 32 },
  fullGrid: { flexGrow: 1 },
  hint: { fontSize: 13, lineHeight: 18, marginTop: 14 },
});
