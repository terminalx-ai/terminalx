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
  /** The Mac's blue, for an agent at work. */
  info: string;
  danger: string;
  border: string;
  terminal: string;
}

// Near-black pages with clear steps of elevation above them, text in the
// system's greys, and hairlines of light rather than lines of colour.
const dark: Record<ThemeName, Palette> = {
  Den: palette("#111113", "#1a1a1d", "#212124", "#2c2c30", "#f2f2f3", "#a0a0a6", "#6b6b72", "#e3b45e", "#1a1204", "#ffffff1a", "#050506"),
  Slate: palette("#080a0d", "#11151a", "#181d23", "#252c35", "#eef2f7", "#9aa5b3", "#66707d", "#6fa7ed", "#0b1830", "#ffffff1a", "#040608"),
  Moss: palette("#080b09", "#111613", "#18201b", "#243029", "#edf2ec", "#98a89c", "#67776b", "#67c48a", "#0c2415", "#ffffff1a", "#040605"),
  Ember: palette("#0c0809", "#171113", "#20181b", "#2f2327", "#f4ecee", "#ab9aa0", "#7a6a70", "#e7806d", "#2a0d08", "#ffffff1a", "#070405"),
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

function palette(page: string, card: string, raised: string, selected: string, ink: string, muted: string, faint: string, accent: string, accentInk: string, border = `${muted}35`, terminal = "#171719"): Palette {
  return { page, card, raised, selected, ink, muted, faint, accent, accentInk, success: "#55b979", warning: "#d6a744", info: "#5b8def", danger: "#db695f", border, terminal };
}
