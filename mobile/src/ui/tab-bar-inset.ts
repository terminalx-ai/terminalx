import { createContext, useContext } from "react";
import { Platform } from "react-native";

/** How tall the system's floating tab bar is. */
const TAB_BAR = 62;
/**
 * How tall the tab bar stands over a tab's content, for its last row to scroll clear of it. iOS floats
 * its bar over the content; Android lays each tab out above its bar, so nothing there is covered.
 */
export function tabBarHeight(bottomInset: number, os: string = Platform.OS) {
  return os === "android" ? 0 : TAB_BAR + Math.max(bottomInset, 12);
}
/** The space a tab's content leaves at its foot for the bar floating over it; 0 outside the tabs, and on Android. */
export const TabBarInset = createContext(0);
export const useTabBarInset = () => useContext(TabBarInset);
/** Whether a page is one of the tabs, which draw their own large title and top bar rather than a stack header. */
export const InTabs = createContext(false);
export const useInTabs = () => useContext(InTabs);
/**
 * Whether New session is in the tab bar. Android's bottom bar holds five items at most, and with Bots there
 * would be six: there a new session is started from the + on the Sessions page instead.
 */
export function newSessionInBar(os: string = Platform.OS) { return os !== "android"; }
