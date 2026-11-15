import { useCallback, useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import type { Tokens } from "marked";
import { LinearGradient } from "expo-linear-gradient";
import { Maximize2, X } from "lucide-react-native";
import { useTheme, type Palette } from "./theme";

/** Which sides of a sideways scroller still hide content, so only those sides fade. */
export function scrollEdges(offset: number, viewport: number, content: number): { start: boolean; end: boolean } {
  const slack = 1;
  return { start: offset > slack, end: viewport > 0 && offset + viewport < content - slack };
}

const COLUMN_WIDTH = 180;
const WRAPPING_COLUMN_WIDTH = 150;
const FADE_WIDTH = 36;

type CellRenderer = (cell: Tokens.TableCell) => ReactNode;

/**
 * A markdown table in its own card: it starts at its first column, scrolls
 * sideways inside the card, fades at an edge only where more is hidden, and
 * opens full screen where cells wrap instead of being cut.
 */
export function MarkdownTable({ table, renderCell }: { table: Tokens.Table; renderCell: CellRenderer }) {
  const { palette } = useTheme();
  const [edges, setEdges] = useState({ start: false, end: false });
  const [size, setSize] = useState({ viewport: 0, content: 0 });
  const [expanded, setExpanded] = useState(false);
  const update = useCallback((offset: number, viewport: number, content: number) => {
    setSize((previous) => previous.viewport === viewport && previous.content === content ? previous : { viewport, content });
    setEdges((previous) => {
      const next = scrollEdges(offset, viewport, content);
      return previous.start === next.start && previous.end === next.end ? previous : next;
    });
  }, []);
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
    update(contentOffset.x, layoutMeasurement.width, contentSize.width);
  };
  return <View style={[styles.card, { borderColor: palette.border, backgroundColor: palette.card }]}>
    <ScrollView
      horizontal
      accessibilityLabel="Markdown table"
      scrollEventThrottle={16}
      showsHorizontalScrollIndicator={false}
      contentOffset={{ x: 0, y: 0 }}
      onScroll={onScroll}
      onLayout={(event) => update(0, event.nativeEvent.layout.width, size.content)}
      onContentSizeChange={(width) => update(0, size.viewport, width)}
    >
      <TableGrid table={table} renderCell={renderCell} palette={palette} cellStyle={{ width: COLUMN_WIDTH }} />
    </ScrollView>
    {edges.start ? <Fade side="start" color={palette.card} /> : null}
    {edges.end ? <Fade side="end" color={palette.card} /> : null}
    <Pressable accessibilityRole="button" accessibilityLabel="Expand table" hitSlop={8} onPress={() => setExpanded(true)}
      style={[styles.expand, { backgroundColor: palette.raised, borderColor: palette.border }]}>
      <Maximize2 size={14} color={palette.muted} />
    </Pressable>
    <ExpandedTable visible={expanded} table={table} renderCell={renderCell} palette={palette} onClose={() => setExpanded(false)} />
  </View>;
}

/** The table seen full screen: every cell is drawn, and long cell text wraps. */
export function ExpandedTable({ visible, table, renderCell, palette, onClose }: {
  visible: boolean; table: Tokens.Table; renderCell: CellRenderer; palette: Palette; onClose: () => void;
}) {
  return <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
    <View style={[styles.full, { backgroundColor: palette.page }]}>
      <View style={styles.fullBar}>
        <Text accessibilityRole="header" style={[styles.fullTitle, { color: palette.ink }]}>Table</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Close table" hitSlop={10} onPress={onClose}
          style={[styles.close, { backgroundColor: palette.raised }]}>
          <X size={18} color={palette.ink} />
        </Pressable>
      </View>
      <ScrollView accessibilityLabel="Expanded table" contentContainerStyle={styles.fullContent}>
        <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.fullGrid}>
          <View style={[styles.fullCard, { borderColor: palette.border }]}>
            <TableGrid table={table} renderCell={renderCell} palette={palette} cellStyle={styles.wrapCell} />
          </View>
        </ScrollView>
      </ScrollView>
    </View>
  </Modal>;
}

function TableGrid({ table, renderCell, palette, cellStyle }: {
  table: Tokens.Table; renderCell: CellRenderer; palette: Palette; cellStyle: object;
}) {
  const rows = [table.header, ...table.rows];
  return <View>
    {rows.map((row, rowIndex) => <View key={rowIndex} style={[styles.row, rowIndex === 0 && { backgroundColor: palette.raised }]}>
      {row.map((cell, cellIndex) => <View key={cellIndex} style={[styles.cell, cellStyle, { borderColor: palette.border }]}>
        <Text selectable style={[styles.text, rowIndex === 0 && styles.header, { color: palette.ink, textAlign: table.align[cellIndex] ?? "left" }]}>{renderCell(cell)}</Text>
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
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, borderCurve: "continuous", overflow: "hidden", maxWidth: "100%" },
  row: { flexDirection: "row" },
  cell: { padding: 10, borderRightWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
  wrapCell: { width: WRAPPING_COLUMN_WIDTH },
  text: { fontSize: 15, lineHeight: 22 },
  header: { fontWeight: "700" },
  fade: { position: "absolute", top: 0, bottom: 0, width: FADE_WIDTH },
  fadeStart: { left: 0 },
  fadeEnd: { right: 0 },
  expand: { position: "absolute", top: 6, right: 6, width: 28, height: 28, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
  full: { flex: 1, paddingTop: 56 },
  fullBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingBottom: 12 },
  fullTitle: { fontSize: 18, fontWeight: "700" },
  close: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  fullContent: { paddingHorizontal: 16, paddingBottom: 32 },
  fullGrid: { flexGrow: 1 },
  fullCard: { borderWidth: StyleSheet.hairlineWidth },
});
