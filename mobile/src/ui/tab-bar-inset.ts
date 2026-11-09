import { createContext, useContext } from "react";

/** How tall the system's floating tab bar is. */
const TAB_BAR = 62;
/** How tall the tab bar stands over a tab's content, for its last row to scroll clear of it. */
export function tabBarHeight(bottomInset: number) { return TAB_BAR + Math.max(bottomInset, 12); }
/** The space a tab's content leaves at its foot for the bar floating over it; 0 outside the tabs. */
export const TabBarInset = createContext(0);
export const useTabBarInset = () => useContext(TabBarInset);
