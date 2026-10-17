import { getPrefs, setPrefs, usePrefs } from "@/lib/prefs";

/** A fold the sidebar remembers between launches. */
export function useFold(key: string, byDefault: boolean): [boolean, () => void] {
  const { sidebarSections } = usePrefs();
  const stored = sidebarSections[key];
  const open = stored ? stored === "expanded" : byDefault;
  return [open, () => setPrefs({ sidebarSections: { ...getPrefs().sidebarSections, [key]: open ? "collapsed" : "expanded" } })];
}
