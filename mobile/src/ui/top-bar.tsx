import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Platform, StyleSheet, Text, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BAR_TITLE_MAX_SCALE } from "./text-size";
import { useTheme } from "./theme";

/** How tall the bar's title row stands under the status area, as 22.02 draws it. */
export const TOP_BAR_ROW = 42;

/**
 * Where a tab page's scroll content starts: below the status area, at every
 * scroll position. iOS pads with a content inset, which keeps the pull-to-refresh
 * spinner under the bar too; elsewhere the content is padded.
 */
export function topBarScrollInsets(top: number, os: string = Platform.OS) {
  if (os === "ios") return { contentInset: { top, bottom: 0, left: 0, right: 0 }, contentOffset: { x: 0, y: -top }, scrollIndicatorInsets: { top }, paddingTop: 0 };
  return { contentInset: undefined, contentOffset: undefined, scrollIndicatorInsets: { top }, paddingTop: top };
}

/**
 * Whether the bar shows the page title in small type: once the large title has
 * passed wholly under the bar's title row. `titleBottom` is the large title's
 * foot in the scroll content and `offset` the scroll position; on screen that
 * foot sits at `titleBottom - offset` (the iOS inset starts the offset at -top,
 * padded content counts the padding in the title's place).
 */
export function smallTitleShown(offset: number, titleBottom: number | undefined, top: number) {
  if (titleBottom === undefined) return false;
  return titleBottom - offset <= top + TOP_BAR_ROW;
}

/**
 * A tab page's top: a solid bar in the page's colour behind the status area,
 * so scrolled content is never drawn over the clock, the Dynamic Island or the
 * system icons. Once the large title has scrolled away, the bar grows a row
 * with the title in small type and a hairline under it.
 */
export function TopBar({ title, shown }: { title?: string; shown: boolean }) {
  const { palette } = useTheme();
  const { top } = useSafeAreaInsets();
  const [fade] = useState(() => new Animated.Value(shown ? 1 : 0));
  useEffect(() => {
    const animation = Animated.timing(fade, { toValue: shown ? 1 : 0, duration: 160, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [fade, shown]);
  return <View pointerEvents="box-none" testID="top-bar" style={styles.bar}>
    <View testID="top-bar-status" style={[styles.status, { height: top, backgroundColor: palette.page }]} />
    {title ? <Animated.View pointerEvents="none" testID="top-bar-title" accessibilityElementsHidden={!shown} importantForAccessibility={shown ? "auto" : "no-hide-descendants"} style={[styles.row, { opacity: fade, backgroundColor: palette.page, borderBottomColor: palette.border }]}>
      <Text accessibilityRole="header" numberOfLines={1} maxFontSizeMultiplier={BAR_TITLE_MAX_SCALE} style={[styles.title, { color: palette.ink }]}>{title}</Text>
    </Animated.View> : null}
  </View>;
}

/**
 * Everything a tab page's scroll view needs for {@link TopBar}: its insets,
 * a scroll handler, and where the large title ends.
 */
export function useTopBar() {
  const { top } = useSafeAreaInsets();
  const insets = topBarScrollInsets(top);
  const [titleBottom, setTitleBottom] = useState<number>();
  const [shown, setShown] = useState(false);
  const offset = useRef(insets.contentOffset?.y ?? 0);
  const update = useCallback((y: number, bottom: number | undefined) => setShown(smallTitleShown(y, bottom, top)), [top]);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    offset.current = event.nativeEvent.contentOffset.y;
    update(offset.current, titleBottom);
  }, [titleBottom, update]);
  /** `base` is where the title's parent starts in the scroll content, when that is not the content itself. */
  const onTitleLayout = useCallback((event: LayoutChangeEvent, base = 0) => {
    const bottom = base + event.nativeEvent.layout.y + event.nativeEvent.layout.height;
    setTitleBottom(bottom);
    update(offset.current, bottom);
  }, [update]);
  return { top, insets, shown, onScroll, onTitleLayout };
}

const styles = StyleSheet.create({
  bar: { position: "absolute", top: 0, left: 0, right: 0, zIndex: 10 },
  status: {},
  row: { height: TOP_BAR_ROW, alignItems: "center", justifyContent: "center", paddingHorizontal: 56, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { fontSize: 17, fontWeight: "600" },
});
