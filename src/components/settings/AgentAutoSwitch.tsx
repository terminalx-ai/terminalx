import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "@/icons";
import { Button } from "@/components/ui/button";
import { Segmented, SettingRow, Switch } from "@/components/ui/controls";
import {
  agentAccounts,
  AUTO_SWITCH_MAX_THRESHOLD,
  AUTO_SWITCH_MIN_THRESHOLD,
  autoSwitchSetting,
  type AccountSwitchLogEntry,
  type AgentAccountAgent,
  type AgentAccounts,
  type AutoSwitchOrder,
  type AutoSwitchSetting,
  type AutoSwitchView,
} from "@/lib/agentAccounts";
import { errorMessage } from "@/lib/api";
import { takeAgentAccounts } from "@/lib/useSessionAgent";
import { tabName } from "./AgentAccountRow";

/**
 * Settings → Agents: switch accounts automatically (#981). Under an agent's
 * accounts, and only when it has two or more subscription accounts. Off by
 * default. What it decides lives in the runtime
 * (`src-tauri/src/agent_accounts/auto_switch.rs`); this only edits the
 * setting and shows the log of what it did.
 */

/** The note shown while the setting is on. */
export const TERMS_NOTE = "Use automatic switching only with accounts you hold legitimately, such as a work and a personal one. You are responsible for using each account within its provider's terms.";
export const API_KEY_NOTE = "Billed per request";

const ORDERS: { value: AutoSwitchOrder; label: string }[] = [
  { value: "mostRoom", label: "Most room left" },
  { value: "inOrder", label: "In my order" },
];

/** A threshold typed or slid, kept to its range. */
export function clampThreshold(value: number): number {
  if (!Number.isFinite(value)) return 90;
  return Math.min(AUTO_SWITCH_MAX_THRESHOLD, Math.max(AUTO_SWITCH_MIN_THRESHOLD, Math.round(value)));
}

/** `ids` with the one at `index` moved by `by` places, when there is room to. */
export function moved<T>(items: readonly T[], index: number, by: -1 | 1): T[] {
  const to = index + by;
  if (to < 0 || to >= items.length) return [...items];
  const next = [...items];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

const OUTCOMES: Record<AccountSwitchLogEntry["outcome"], string> = {
  switched: "Switched",
  started: "Started on another account",
  noneAvailable: "No account had room",
  failed: "Switch failed",
};

/** "Switched · Work → Personal", or as much as one line says. */
export function logLine(entry: AccountSwitchLogEntry): string {
  const to = entry.toLabel ? ` → ${entry.toLabel}` : "";
  return `${OUTCOMES[entry.outcome]} · ${entry.fromLabel}${to}`;
}

export function AgentAutoSwitch({ harness, agentName, view, onView }: {
  harness: AgentAccountAgent;
  agentName: string;
  view: AgentAccounts;
  /** The list came back from a change: show it. */
  onView: (view: AgentAccounts) => void;
}) {
  const auto = view.autoSwitch;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(auto?.setting.threshold ?? 90);
  useEffect(() => { if (auto) setThreshold(auto.setting.threshold); }, [auto?.setting.threshold]);
  if (!auto?.offered) return null;
  const { setting } = auto;

  const save = async (patch: Partial<AutoSwitchSetting>, list: AutoSwitchView["accounts"] = auto.accounts) => {
    setBusy(true);
    setError(null);
    try {
      const next = await agentAccounts.setAutoSwitch(harness, autoSwitchSetting({ ...auto, accounts: list }, patch));
      onView(next);
      takeAgentAccounts(next);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const commitThreshold = () => {
    const value = clampThreshold(threshold);
    setThreshold(value);
    if (value !== setting.threshold) void save({ threshold: value });
  };

  return <section aria-labelledby={`${harness}-auto-switch`} className="mt-4 rounded-lg border border-hairline px-3 py-1">
    <SettingRow id={`${harness}-auto-switch`} label="Switch accounts automatically"
      description={`When the account a ${agentName} tab runs on reaches the threshold, continue on another account that has room. Tabs switch between turns; a tab that hits its limit mid-turn continues on its own.`}
      control={<Switch aria-label="Switch accounts automatically" checked={setting.enabled} disabled={busy} onCheckedChange={(enabled) => void save({ enabled })} />} />
    {setting.enabled && <>
      <p role="note" className="pb-2 text-xs leading-relaxed text-muted-foreground" data-testid="auto-switch-terms">{TERMS_NOTE}</p>
      <SettingRow label="Threshold" description={setting.threshold >= 100 ? "Switches only once an account actually reaches its limit." : "The used share of any window (5-hour, weekly or a model's) at which an account counts as full."}
        control={<div className="flex items-center gap-2">
          <input type="range" aria-label="Threshold" min={AUTO_SWITCH_MIN_THRESHOLD} max={AUTO_SWITCH_MAX_THRESHOLD} step={1} value={threshold} disabled={busy}
            onChange={(e) => setThreshold(Number(e.target.value))} onPointerUp={commitThreshold} onKeyUp={commitThreshold} onBlur={commitThreshold}
            className="w-28 accent-(--color-accent)" />
          <span className="w-10 text-right text-xs tabular-nums">{threshold}%</span>
        </div>} />
      <div className="py-2">
        <div className="text-[13px] font-medium" id={`${harness}-auto-switch-accounts`}>Accounts to use</div>
        <p className="text-xs text-muted-foreground">Checked accounts may be switched onto, first to last in this order. Others never are.</p>
        <ul aria-labelledby={`${harness}-auto-switch-accounts`} className="mt-2 rounded-md border border-hairline">
          {auto.accounts.map((account, index) => (
            <li key={account.id} className="flex items-center gap-2 border-b border-hairline px-2 py-1.5 text-[13px] last:border-b-0">
              <input type="checkbox" aria-label={`Use ${account.label}`} checked={account.use} disabled={busy}
                onChange={(e) => void save({}, auto.accounts.map((other) => other.id === account.id ? { ...other, use: e.target.checked } : other))} />
              <span className="min-w-0 flex-1 truncate" title={account.label}>{account.label}</span>
              {account.kind === "apiKey" && <span className="shrink-0 text-[12px] text-faint">{API_KEY_NOTE}</span>}
              {!account.signedIn && <span className="shrink-0 text-[12px] text-faint">sign in again</span>}
              <Button size="icon-xs" variant="ghost" aria-label={`Move ${account.label} up`} disabled={busy || index === 0}
                onClick={() => void save({}, moved(auto.accounts, index, -1))}><ChevronUp /></Button>
              <Button size="icon-xs" variant="ghost" aria-label={`Move ${account.label} down`} disabled={busy || index === auto.accounts.length - 1}
                onClick={() => void save({}, moved(auto.accounts, index, 1))}><ChevronDown /></Button>
            </li>
          ))}
        </ul>
      </div>
      <SettingRow label="When choosing the next account" control={<Segmented aria-label="When choosing the next account" value={setting.order} options={ORDERS} disabled={busy}
        onChange={(order) => void save({ order })} />} />
      <SettingRow label="Notify on each switch" description="For a tab that is not in view."
        control={<Switch aria-label="Notify on each switch" checked={setting.notifySwitch} disabled={busy} onCheckedChange={(notifySwitch) => void save({ notifySwitch })} />} />
      <SettingRow label="Notify when no account has room"
        control={<Switch aria-label="Notify when no account has room" checked={setting.notifyNoneLeft} disabled={busy} onCheckedChange={(notifyNoneLeft) => void save({ notifyNoneLeft })} />} />
      <SwitchLog harness={harness} />
    </>}
    {error && <p role="alert" className="pb-2 text-xs text-destructive">{error}</p>}
  </section>;
}

const SHOWN = 5;

/** The switches of the last 30 days for `harness`, newest first. */
export function SwitchLog({ harness }: { harness: AgentAccountAgent }) {
  const [entries, setEntries] = useState<AccountSwitchLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => agentAccounts.switchLog()).then(
      (log) => { if (live) setEntries(log.filter((entry) => entry.agent === harness)); },
      (e) => { if (live) setError(errorMessage(e)); },
    );
    return () => { live = false; };
  }, [harness]);
  const shown = entries ? (all ? entries : entries.slice(0, SHOWN)) : [];
  return <div className="py-2">
    <div className="text-[13px] font-medium" id={`${harness}-switch-log`}>Switch log</div>
    <p className="text-xs text-muted-foreground">The last 30 days, on this Mac.</p>
    {error && <p role="alert" className="mt-1 text-xs text-destructive">{error}</p>}
    {entries && !entries.length && <p className="mt-1 text-xs text-faint">No switches yet.</p>}
    {shown.length > 0 && <ol aria-labelledby={`${harness}-switch-log`} className="mt-2 flex flex-col gap-1.5 text-xs">
      {shown.map((entry) => (
        <li key={`${entry.at}:${entry.tabId}:${entry.outcome}`} className="min-w-0">
          <div className="flex gap-2">
            <span className="min-w-0 flex-1 truncate">{logLine(entry)}</span>
            <time className="shrink-0 tabular-nums text-faint" dateTime={new Date(entry.at).toISOString()}>
              {new Date(entry.at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
            </time>
          </div>
          <p className="truncate text-muted-foreground" title={entry.reason}>{entry.title?.trim() || tabName(entry)} · {entry.reason}</p>
        </li>
      ))}
    </ol>}
    {entries && entries.length > SHOWN && <Button size="xs" variant="ghost" className="mt-1" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${entries.length}`}</Button>}
  </div>;
}
