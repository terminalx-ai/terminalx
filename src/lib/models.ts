import { useSyncExternalStore } from "react";
import { agent, type ModelInfo } from "@/lib/api";

let models: ModelInfo[] = [];
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

export function loadModels() {
  if (!loading) {
    loading = agent
      .listModels()
      .then((m) => {
        models = m;
        for (const l of listeners) l();
      })
      .catch(() => {});
  }
  return loading;
}

/** Re-read the list from the agents themselves; the picker does this as it opens. */
export async function refreshModels() {
  try {
    models = await agent.listModels(true);
    for (const l of listeners) l();
  } catch {
    /* keep whatever was known */
  }
}

export function useModels(harness?: string): ModelInfo[] {
  const all = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      void loadModels();
      return () => listeners.delete(cb);
    },
    () => models,
    () => models,
  );
  return harness ? all.filter((m) => m.harness === harness) : all;
}

/**
 * A readable name for an id the list no longer carries — a session stored
 * before a model was retired, say. `gpt-5.6-sol` reads as `GPT-5.6 Sol`.
 */
export function prettyModelId(id: string): string {
  if (!id) return "Default";
  const last = id.split("/").pop() ?? id;
  // `claude-opus-5-5` reads as `Opus 5.5`; a date stamp is not part of the version.
  const claude = /^claude-([a-z]+)((?:-\d{1,2})+)(?:-\d{6,})?$/.exec(last);
  if (claude) return `${claude[1]![0]!.toUpperCase()}${claude[1]!.slice(1)} ${claude[2]!.slice(1).replace(/-/g, ".")}`;
  return last
    .replace(/^gpt/i, "GPT")
    .replace(/(\d)-([a-z])/gi, "$1 $2")
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * How a model being retired reads in the picker: the replacement's own label,
 * shown faintly after the name. `null` when the model is current.
 */
export function upgradeHint(m: ModelInfo, all: ModelInfo[]): string | null {
  if (!m.upgrade) return null;
  return all.find((x) => x.id === m.upgrade)?.label ?? prettyModelId(m.upgrade);
}

/**
 * What a family alias is known to run: what the session itself last reported
 * if that is the same family, else what the CLI said when it listed its
 * models. `null` when nobody has said, and for a pinned version. `here: false`
 * is for a tab on another machine (a cloud workspace): only its own report
 * counts there, since its CLI may resolve the alias differently.
 */
export function aliasRuns(m: ModelInfo, reported?: string | null, here = true): string | null {
  if (!m.alias) return null;
  if (reported && reported.includes(`-${m.id}-`)) return reported;
  return here ? (m.resolved ?? null) : null;
}

/**
 * The name on the composer's model button: the version actually in use where
 * that is known (`Opus 5.5`), the family alone where it is not (`Opus`).
 */
export function runningModelName(m: ModelInfo, reported?: string | null, here = true): string {
  const runs = aliasRuns(m, reported, here);
  return runs ? prettyModelId(runs) : m.label;
}

/**
 * The faint note after a model in a menu. An alias says that it follows the
 * latest release and, when known, which version that is now; a model being
 * retired names its replacement. `here: false` is for a list drawn for
 * another machine (a cloud workspace), whose CLI may resolve the alias
 * differently, so no version is claimed.
 */
export function modelNote(m: ModelInfo, all: ModelInfo[], here = true): string | null {
  const upgrade = upgradeHint(m, all);
  if (upgrade) return `→ ${upgrade}`;
  if (!m.alias) return null;
  return here && m.resolved ? `latest · ${prettyModelId(m.resolved)}` : "latest";
}

/** The same in one string, for a plain `<select>`: `Opus (latest · Opus 5.5)`. */
export function modelOptionText(m: ModelInfo, all: ModelInfo[], here = true): string {
  const note = m.alias ? modelNote(m, all, here) : null;
  return note ? `${m.label} (${note})` : m.label;
}

/**
 * The models to offer for a tab on this machine (`here`) or on another one (a
 * cloud workspace). Elsewhere only the family aliases are offered where a
 * harness has them: every CLI version takes `opus`, but a pinned version from
 * this machine's list may be one the other machine's CLI cannot run, and it
 * would fail at the first turn.
 */
export function offeredOn(models: ModelInfo[], here: boolean): ModelInfo[] {
  if (here) return models;
  return models.filter((m) => m.alias || (m.harness !== "claude" && !models.some((x) => x.harness === m.harness && x.alias)));
}

/**
 * The entry for the model a tab is on. An id the list does not carry — a
 * version pinned earlier or on another machine, or one the agent itself
 * reported after it was changed in the terminal — is still what the tab
 * runs, so it gets an entry of its own, named after the id, rather than
 * being shown as the default. It takes the efforts of its family where it
 * has one (a Claude id), else the default model's. Only a tab with no model
 * at all reads as the default.
 */
export function modelForTab(models: ModelInfo[], id: string): ModelInfo | undefined {
  const listed = models.find((m) => m.id === id);
  if (listed) return listed;
  const fallback = models.find((m) => m.isDefault);
  if (!id) return fallback;
  const family = (id.startsWith("claude-") ? models.find((m) => m.alias && id.includes(`-${m.id}-`)) : undefined) ?? fallback;
  return {
    id,
    label: prettyModelId(id),
    harness: family?.harness ?? (id.startsWith("claude-") ? "claude" : (models[0]?.harness ?? "")),
    efforts: family?.efforts ?? [],
    defaultEffort: family?.defaultEffort ?? null,
    acceptsImages: family?.acceptsImages ?? true,
    isDefault: false,
    upgrade: null,
    description: null,
    alias: false,
    resolved: null,
  };
}

/** A menu's models as the reader chooses between them: the aliases, then the versions that can be pinned. */
export function modelGroups(models: ModelInfo[]): { title: string | null; models: ModelInfo[] }[] {
  const latest = models.filter((m) => m.alias);
  if (latest.length === 0) return [{ title: null, models }];
  return [
    { title: null, models: latest },
    { title: "Pinned version", models: models.filter((m) => !m.alias) },
  ].filter((g) => g.models.length > 0);
}

export function modelLabel(harness: string, id: string): string {
  const m = models.find((x) => x.harness === harness && x.id === id);
  return m?.label ?? prettyModelId(id);
}

export const BYPASS_MODE = "bypassPermissions";

/**
 * The launch mode of every new session or agent tab, local or cloud, until
 * the reader picks another. Mirrors `DEFAULT_PERMISSION_MODE` in
 * src-tauri/src/store/index.rs, which also covers any request that names no
 * mode. An explicit choice (including one saved in prefs) always wins.
 */
export const DEFAULT_PERMISSION_MODE = BYPASS_MODE;

/**
 * Every new automation starts in "Bypass permissions". Automations run
 * unattended, so any mode that stops to ask would leave a run parked until
 * someone notices. The default is deliberately independent of the mode the
 * reader last used for an interactive session (`prefs.lastMode`): the two
 * choices answer different questions and must not leak into each other.
 */
export const DEFAULT_AUTOMATION_MODE = BYPASS_MODE;

export const PERMISSION_MODES: { id: string; label: string; hint: string }[] = [
  { id: "plan", label: "Plan", hint: "Read and plan only; no edits or commands." },
  { id: "manual", label: "Ask every time", hint: "Every edit and command waits for you." },
  { id: "auto", label: "Auto", hint: "Routine actions are approved; risky ones ask." },
  { id: "acceptEdits", label: "Accept edits", hint: "File edits go through; commands still ask." },
  { id: BYPASS_MODE, label: "Bypass permissions", hint: "Nothing asks. Only in a tree you can throw away." },
];

/** Spellings of a picker mode that older tabs and other clients still carry. */
const MODE_ALIASES: Record<string, string> = { "": BYPASS_MODE, bypass: BYPASS_MODE, default: "manual", ask: "manual", accept_edits: "acceptEdits" };

/** The picker's entry for a mode, if it has one. */
export function pickerMode(id: string): { id: string; label: string; hint: string } | undefined {
  const known = MODE_ALIASES[id] ?? id;
  return PERMISSION_MODES.find((m) => m.id === known);
}

/**
 * A mode's name. One the picker does not offer is the mode the agent reported
 * itself in (#417) — Claude Code's `dontAsk`, a Codex approval policy and
 * sandbox no mode of ours launches — and is named exactly as reported.
 */
export function modeLabel(id: string): string {
  return pickerMode(id)?.label ?? id;
}

/** Whether nothing stands between the agent and the machine in this mode: Bypass, or any Codex stance with no sandbox. */
export function modeIsUnguarded(id: string): boolean {
  return pickerMode(id)?.id === BYPASS_MODE || id.endsWith("danger-full-access");
}

/**
 * What "Bypass permissions" comes down to for one agent: the flag its CLI is
 * launched with, and what that flag stops doing. The hint in the picker is
 * one line; this is what the reader is asked to agree to, so it says which
 * protections are gone rather than that some are.
 */
export function bypassEffect(harness: string): { flag: string; effect: string } {
  if (harness === "codex") {
    return {
      flag: "--dangerously-bypass-approvals-and-sandbox",
      effect:
        "Codex runs with its sandbox off and its approvals off. Every command it writes executes immediately, with your own access to the disk and the network, and nothing stops to ask — not for edits outside this workspace, not for deletions, not for anything that reaches the internet.",
    };
  }
  if (harness === "claude") {
    return {
      flag: "--dangerously-skip-permissions",
      effect:
        "Claude Code stops asking about anything. File edits, shell commands and network calls all go through the moment it decides on them, inside this workspace and out.",
    };
  }
  return {
    flag: BYPASS_MODE,
    effect: "The agent stops asking about anything. Every edit and every command it decides on runs the moment it decides on it.",
  };
}

export const EFFORT_LABEL: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

/**
 * What to say while a model, effort or permission mode that was asked for is
 * not yet what the agent is on (#404, #417); `null` when nothing is waiting.
 * The pickers go on showing what is in force, so this is the only place the
 * choice appears until the agent confirms it. A change made mid-turn waits
 * for the turn: a CLI holds what is typed at it until then, and is restarted
 * after it for a setting it only reads at startup, which a mode always is.
 */
export function pendingSettingsNote(
  tab: { requestedModel?: string | null; requestedEffort?: string | null; requestedPermissionMode?: string | null },
  models: ModelInfo[],
  busy: boolean,
): string | null {
  const model = tab.requestedModel ? (models.find((m) => m.id === tab.requestedModel)?.label ?? prettyModelId(tab.requestedModel)) : null;
  const effort = tab.requestedEffort ? (EFFORT_LABEL[tab.requestedEffort] ?? tab.requestedEffort) : null;
  const mode = tab.requestedPermissionMode ? modeLabel(tab.requestedPermissionMode) : null;
  const running = model && effort ? `${model} · ${effort}` : (model ?? (effort ? `${effort} effort` : null));
  const what = [running, mode && running ? `${mode} mode` : mode].filter(Boolean).join(" and ");
  if (!what) return null;
  return busy ? `Switching to ${what} after this turn` : `Switching to ${what}…`;
}

// Module state lives here; a hot update would lose it, so edits reload the page.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
