import { createContext, useContext, type ComponentType, type ReactNode } from "react";
import { useWindowDimensions, View } from "react-native";

/**
 * From this scale up, iOS calls the text size an accessibility size: the
 * largest ordinary size is 1.35 and the first accessibility size 1.64.
 */
export const LARGE_TEXT_SCALE = 1.5;

/** Whether the person reads at an accessibility text size. False where nothing above says. */
export const LargeText = createContext(false);

/** Reads the phone's text size for everything under it, and again when the person changes it in Settings. */
export function TextSizeProvider({ children }: { children: ReactNode }) {
  const large = useWindowDimensions().fontScale >= LARGE_TEXT_SCALE;
  return <LargeText.Provider value={large}>{children}</LargeText.Provider>;
}

/**
 * A page, laid out again when the text size changes in Settings while the app
 * is open (PRO-601). The root Stack draws its pages in it through
 * `textSizeScreenLayout`; each tab page is wrapped by `withTextSizePage`.
 *
 * React Native 0.88 takes the new size in at once (RCTFabricSurface puts the
 * new multiplier in the root's layout context), and Yoga's `configureYogaTree`
 * marks every text measured at the old multiplier dirty, but only during a
 * layout pass, and none runs: `RootShadowNode::clone` dirties the root only
 * when the layout constraints change, and `layoutIfNeeded` returns at once on
 * a clean root. Until something on the page moved, its text kept the size the
 * app was opened at (seen on main on the iPhone SE simulator). Each tab and
 * each pushed page is laid out on its own, so the nudge is inside every page:
 * a view of no size, put back under a new key at each text size, marks its
 * page and the root dirty, and the layout pass that follows measures every
 * text again at the new size.
 */
export function TextSizePage({ children }: { children: ReactNode }) {
  const { fontScale } = useWindowDimensions();
  return <>
    {children}
    <View key={fontScale} testID="text-size-relayout" pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={RELAYOUT} />
  </>;
}

/** `TextSizePage` as a navigator's `screenLayout`, which is called as a function rather than drawn, so it may hold no hook itself. */
export function textSizeScreenLayout({ children }: { children: ReactNode }) {
  return <TextSizePage>{children}</TextSizePage>;
}

/**
 * A tab's page drawn in `TextSizePage`. Each tab is wrapped here rather than
 * through NativeTabs' `screenLayout`, which its props type leaves out.
 */
export function withTextSizePage<P extends object>(Page: ComponentType<P>): ComponentType<P> {
  const Wrapped = (props: P) => <TextSizePage><Page {...props} /></TextSizePage>;
  Wrapped.displayName = `WithTextSizePage(${Page.displayName ?? Page.name})`;
  return Wrapped;
}

// A plain object, not a StyleSheet: this module is read by layouts whose tests stand in for only part of React Native.
const RELAYOUT = { position: "absolute", width: 0, height: 0 } as const;

/**
 * Whether the person reads at an accessibility text size (PRO-563). A row
 * that sets two things side by side then stacks them, as iOS Settings does:
 * beside each other, neither has room for a word.
 */
export function useLargeText(): boolean {
  return useContext(LargeText);
}

/**
 * How far a title in a bar of fixed height grows with the text size. The
 * system's own navigation bar titles stop growing too: the bar keeps its
 * height, and a title any larger is cut by it or drawn over the status area.
 */
export const BAR_TITLE_MAX_SCALE = 1.2;

/** How far a tab's large title grows: at 34 points it is already large, and one word has to fit the line. */
export const LARGE_TITLE_MAX_SCALE = 1.3;

/**
 * The largest size, in points, the heading of a page with little else on it
 * grows to, and the sentence under it (PRO-601): the signed-out tabs. At the
 * largest text sizes a heading that kept growing filled half an iPhone SE,
 * and its sentence and Sign in went under the tab bar. These are the most the
 * Machines tab holds on an SE with Sign in still in sight; the button keeps
 * the system size.
 */
export const HEADING_MAX_POINTS = 42;
export const HEADING_SENTENCE_MAX_POINTS = 21;

/**
 * The `maxFontSizeMultiplier` that stops text drawn at `fontSize` points
 * growing past `points`: a cap in points, so a small heading and a large one
 * stop at the same size. Never below 1, so no text is drawn smaller than set.
 */
export function maxScaleFor(fontSize: number, points: number): number {
  return Math.max(1, points / fontSize);
}
