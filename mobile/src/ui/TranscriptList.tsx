import { useMemo, useRef, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View, type FlatListProps } from "react-native";
import { useTheme } from "./theme";

const LATEST_THRESHOLD = 80;
const MAINTAIN_POSITION = { minIndexForVisible: 0 };

type Props<Item> = Pick<FlatListProps<Item>, "data" | "renderItem" | "keyExtractor" | "ListEmptyComponent" | "onScroll"> & {
  earlier?: FlatListProps<Item>["ListFooterComponent"];
  latest?: FlatListProps<Item>["ListHeaderComponent"];
};

// Give this component a conversation key (or remount its parent) when switching
// agents. Data stays chronological at the call site; native offset zero is the
// latest edge, even before cache/host data or variable-height rows finish layout.
export function TranscriptList<Item>({ data, earlier, latest, onScroll, ...props }: Props<Item>) {
  const { palette } = useTheme();
  const list = useRef<FlatList<Item>>(null);
  const following = useRef(true);
  const dragging = useRef(false);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const newestFirst = useMemo(() => Array.from(data ?? []).reverse(), [data]);
  const keepLatest = () => {
    if (following.current && !dragging.current) list.current?.scrollToOffset({ offset: 0, animated: false });
  };

  return <View style={styles.container}>
    <FlatList
      {...props}
      ref={list}
      testID="conversation-transcript"
      data={newestFirst}
      inverted
      // Anchor history readers during host merges and pagination. While following,
      // leave offset zero fixed: native anchoring of estimated cells can otherwise
      // move the latest edge during the first variable-height layout passes.
      maintainVisibleContentPosition={awayFromLatest ? MAINTAIN_POSITION : undefined}
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
      contentContainerStyle={styles.content}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      scrollEventThrottle={16}
      onScroll={(event) => {
        const away = event.nativeEvent.contentOffset.y > LATEST_THRESHOLD;
        following.current = !away;
        setAwayFromLatest(away);
        onScroll?.(event);
      }}
      onScrollBeginDrag={() => { dragging.current = true; }}
      onScrollEndDrag={() => { dragging.current = false; }}
      onMomentumScrollBegin={() => { dragging.current = true; }}
      onMomentumScrollEnd={() => { dragging.current = false; }}
      onContentSizeChange={keepLatest}
      onLayout={keepLatest}
      ListHeaderComponent={latest}
      ListFooterComponent={earlier}
    />
    {awayFromLatest ? <Pressable
      accessibilityRole="button"
      accessibilityLabel="Jump to latest"
      onPress={() => {
        following.current = true;
        setAwayFromLatest(false);
        list.current?.scrollToOffset({ offset: 0, animated: false });
      }}
      style={[styles.jump, { backgroundColor: palette.accent }]}
    ><Text style={[styles.jumpText, { color: palette.accentInk }]}>↓ Jump to latest</Text></Pressable> : null}
  </View>;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // Inversion swaps the physical top/bottom padding as well as header/footer.
  content: { padding: 16, paddingTop: 24, gap: 16 },
  jump: { position: "absolute", bottom: 12, alignSelf: "center", borderRadius: 22, minHeight: 44, paddingHorizontal: 18, justifyContent: "center", elevation: 3 },
  jumpText: { fontSize: 14, fontWeight: "600" },
});
