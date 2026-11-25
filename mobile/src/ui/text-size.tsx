import { createContext, useContext, type ReactNode } from "react";
import { useWindowDimensions } from "react-native";

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
