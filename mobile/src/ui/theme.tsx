import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";
import { useColorScheme } from "react-native";

export type ThemeName = "Den" | "Slate" | "Moss" | "Ember";
export interface Palette {
  page: string;
  card: string;
  raised: string;
  selected: string;
  ink: string;
  muted: string;
  faint: string;
  accent: string;
  accentInk: string;
  success: string;
  warning: string;
  danger: string;
  border: string;
  terminal: string;
}

const dark: Record<ThemeName, Palette> = {
  Den: palette("#29292c", "#343437", "#2e2e31", "#414145", "#eceae6", "#9f9da1", "#747277", "#e3b45e", "#34230b"),
  Slate: palette("#25282c", "#2e3238", "#292d32", "#3a4048", "#eef1f5", "#9da6b2", "#717a86", "#6fa7ed", "#10223c"),
  Moss: palette("#222a26", "#2b3530", "#26302b", "#37433d", "#edf1e9", "#9ba89e", "#6f7d72", "#67c48a", "#102b1a"),
  Ember: palette("#2c232a", "#362a33", "#31262e", "#453540", "#f2e9ec", "#aa989f", "#796a70", "#e7806d", "#35120d"),
};

const light: Record<ThemeName, Palette> = {
  Den: palette("#f8f7f4", "#ffffff", "#f2f0ec", "#e5e1da", "#29282b", "#706d70", "#999599", "#a96f27", "#ffffff"),
  Slate: palette("#f7f8fa", "#ffffff", "#eff2f5", "#dfe4eb", "#252a31", "#68717d", "#929aa5", "#3f75c7", "#ffffff"),
  Moss: palette("#f5f8f5", "#ffffff", "#edf3ee", "#dce8df", "#263028", "#647267", "#8d9990", "#2f8750", "#ffffff"),
  Ember: dark.Ember,
};

const ThemeContext = createContext<{ name: ThemeName; palette: Palette; setName(name: ThemeName): void } | null>(null);
const THEME_KEY = "terminalx:theme";

export function ThemeProvider({ children }: PropsWithChildren) {
  const scheme = useColorScheme();
  const [name, setNameState] = useState<ThemeName>("Den");
  useEffect(() => { void AsyncStorage.getItem(THEME_KEY).then((value) => { if (value && value in dark) setNameState(value as ThemeName); }); }, []);
  const setName = (next: ThemeName) => { setNameState(next); void AsyncStorage.setItem(THEME_KEY, next); };
  const value = useMemo(() => ({ name, palette: (scheme === "light" ? light : dark)[name], setName }), [name, scheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}

function palette(page: string, card: string, raised: string, selected: string, ink: string, muted: string, faint: string, accent: string, accentInk: string): Palette {
  return { page, card, raised, selected, ink, muted, faint, accent, accentInk, success: "#55b979", warning: "#d6a744", danger: "#db695f", border: `${muted}35`, terminal: "#171719" };
}
