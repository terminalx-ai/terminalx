import { useCallback, useEffect, useRef, useState } from "react";
import type { BotHome, BotsOverview } from "../data/bots";
import type { HostApi } from "../data/host-api";
import { screenMessage } from "../transport/connection-errors";
import { useHostFeatures } from "./host-features";

/** How soon after a change on the Mac what is shown is read again: changes come in bursts (an agent's every event). */
const SETTLE_MS = 600;

/** The last answer per Mac and per read, so a screen opened again shows it at once while it reads afresh. */
const kept = new Map<string, unknown>();

interface Read<T> {
  value: T | null;
  error: string | null;
  refresh(): Promise<void>;
}

/**
 * One read of the bots that follows the Mac: again on `bots.changed`, on a
 * new connection (`epoch`), and when `also` changes (the session list, whose
 * changes carry agents' questions). Nothing while `on` is false. What is shown
 * is kept with the key it was read for, so another Mac or bot shows what was
 * kept for it, never the last one's, until it is read.
 */
function useFollowedRead<T>(api: HostApi, key: string | null, on: boolean, epoch: number, also: unknown, read: () => Promise<T | null>): Read<T> {
  const [shown, setShown] = useState<{ key: string; value: T | null; error: string | null } | null>(null);
  const latest = useRef(0);
  const readRef = useRef(read);
  useEffect(() => { readRef.current = read; });
  const refresh = useCallback(async () => {
    if (!key || !on) return;
    const ticket = ++latest.current;
    try {
      const next = await readRef.current();
      if (ticket !== latest.current) return;
      if (next) kept.set(key, next);
      setShown({ key, value: next, error: null });
    } catch (cause) {
      if (ticket !== latest.current) return;
      const error = screenMessage(cause, "Couldn’t reach the Mac. Try again once it is connected.");
      setShown((current) => ({ key, value: current?.key === key ? current.value : (kept.get(key) as T | undefined) ?? null, error }));
    }
  }, [key, on]);
  useEffect(() => { void refresh(); }, [refresh, epoch]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const soon = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; void refresh(); }, SETTLE_MS);
  }, [refresh]);
  useEffect(() => api.onBotsChanged(soon), [api, soon]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    soon();
  }, [also, soon]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const mine = shown && shown.key === key ? shown : null;
  return { value: mine ? mine.value : key ? (kept.get(key) as T | undefined) ?? null : null, error: mine?.error ?? null, refresh };
}

/** The time now, again each half minute: the lists' "8m" and "now" keep up by themselves. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Whether the connected Mac offers its bots to this phone: null until it has said. */
export function useBotsOffered(api: HostApi, hostId: string | null | undefined): boolean | null {
  const features = useHostFeatures(api, hostId);
  return features ? features.bots === 1 : null;
}

/** The Bots tab's read (`bots.list`), followed. */
export function useBotsOverview(api: HostApi, hostId: string | null | undefined, epoch: number, sessions: unknown): Read<BotsOverview> & { offered: boolean | null } {
  const offered = useBotsOffered(api, hostId);
  const read = useFollowedRead(api, hostId ? `${hostId}:overview` : null, offered === true, epoch, sessions, () => api.botsOverview());
  return { ...read, offered };
}

/** One bot's home (`bots.home`), followed. */
export function useBotHome(api: HostApi, hostId: string | null | undefined, botId: string, epoch: number, sessions: unknown): Read<BotHome> & { offered: boolean | null } {
  const offered = useBotsOffered(api, hostId);
  const read = useFollowedRead(api, hostId && botId ? `${hostId}:home:${botId}` : null, offered === true, epoch, sessions, () => api.botHome(botId));
  return { ...read, offered };
}
