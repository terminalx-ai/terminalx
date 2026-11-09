import { createElement, isValidElement, useMemo, useRef, useState, type ComponentType, type ReactElement } from "react";
import { FlatList, StyleSheet, View, type FlatListProps } from "react-native";
import { ArrowDown } from "lucide-react-native";
import { GlassIconButton } from "./glass";
import { useTheme } from "./theme";

const LATEST_THRESHOLD = 80;
const MAINTAIN_POSITION = { minIndexForVisible: 0 };

type Props<Item> = Pick<FlatListProps<Item>, "data" | "renderItem" | "keyExtractor" | "ListEmptyComponent" | "onScroll" | "contentContainerStyle"> & {
  earlier?: ReactElement | null;
  latest?: ReactElement | null;
  /** Room kept at the latest edge for a composer floating over the list, which the latest rows scroll clear of. */
  inset?: number;
};

// Give this component a conversation key (or remount its parent) when switching
// agents. Data stays chronological at the call site; native offset zero is the
// latest edge, even before cache/host data or variable-height rows finish layout.
export function TranscriptList<Item>({ data, earlier, latest, onScroll, contentContainerStyle, ListEmptyComponent, inset = 0, ...props }: Props<Item>) {
  const { palette } = useTheme();
  const list = useRef<FlatList<Item>>(null);
  const following = useRef(true);
  const dragging = useRef(false);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const newestFirst = useMemo(() => Array.from(data ?? []).reverse(), [data]);
  // An inverted list counter-flips its empty state through a `style` prop on the
  // element. Host it on a View so components that ignore `style` stay upright.
  const empty = ListEmptyComponent ? <View>{isValidElement(ListEmptyComponent) ? ListEmptyComponent : createElement(ListEmptyComponent as ComponentType)}</View> : undefined;
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
      // Native row measurements determine the window. The initial batch stays
      // mounted even while reading history, so keep it small as well.
      initialNumToRender={8}
      maxToRenderPerBatch={8}
      windowSize={5}
      // Anchor history readers during host merges and pagination. While following,
      // leave offset zero fixed: native anchoring of estimated cells can otherwise
      // move the latest edge during the first variable-height layout passes.
      maintainVisibleContentPosition={awayFromLatest ? MAINTAIN_POSITION : undefined}
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
      contentContainerStyle={[styles.content, contentContainerStyle, inset ? { paddingTop: 28 + inset } : null]}
      scrollIndicatorInsets={inset ? { top: inset } : undefined}
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
      ListEmptyComponent={empty}
      ListHeaderComponent={latest ?? undefined}
      ListFooterComponent={earlier ?? undefined}
    />
    {awayFromLatest ? <View style={[styles.jump, { bottom: 12 + inset }]}><GlassIconButton
      label="Jump to latest"
      icon={<ArrowDown size={18} color={palette.ink} />}
      onPress={() => {
        following.current = true;
        setAwayFromLatest(false);
        list.current?.scrollToOffset({ offset: 0, animated: false });
      }}
    /></View> : null}
  </View>;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // Inversion swaps the physical top/bottom padding as well as header/footer.
  content: { paddingHorizontal: 20, paddingVertical: 16, paddingTop: 28, gap: 16 },
  jump: { position: "absolute", bottom: 12, alignSelf: "center" },
});
