import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";

/**
 * "Send recent sessions ahead of time" (#1283). Off unless the person turns
 * it on: it spends this phone's data and battery. While it is on and the app
 * is in the foreground, the phone asks its Mac, once connected, to send the
 * newest part of its most recently active conversations, from where the
 * phone's copy of each ends; opening one of them then reads only what came
 * after. The Mac bounds what it sends; going to the background stops it.
 */
const SETTING_KEY = "terminalx:prefetch:v1";
const listeners = new Set<(on: boolean) => void>();
let current: boolean | undefined;

export async function readPrefetchSetting(): Promise<boolean> {
  if (current !== undefined) return current;
  try { current = (await AsyncStorage.getItem(SETTING_KEY)) === "on"; } catch { current = false; }
  return current;
}

export async function writePrefetchSetting(on: boolean): Promise<void> {
  current = on;
  for (const listener of [...listeners]) listener(on);
  await AsyncStorage.setItem(SETTING_KEY, on ? "on" : "off");
}

export function usePrefetchSetting(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(current ?? false);
  useEffect(() => {
    let active = true;
    void readPrefetchSetting().then((value) => { if (active) setOn(value); });
    const listener = (value: boolean) => setOn(value);
    listeners.add(listener);
    return () => { active = false; listeners.delete(listener); };
  }, []);
  const change = useCallback((value: boolean) => { void writePrefetchSetting(value).catch(() => undefined); }, []);
  return [on, change];
}
