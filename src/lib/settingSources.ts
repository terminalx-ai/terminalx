// PRO-140: where a setting's value comes from, in the words the Settings UI shows.
// Pure functions over the native contract (src/types/settingsSources.ts and
// src/types/configuration.ts); the components only lay these out.
import type { ConfigurationLayer, ConfigurationLayerValue, ConfigurationValue } from "@/types/configuration";
import type { SettingsFileEffect, SettingsFileLayer, SettingsFileProblem } from "@/types/settingsSources";

/** The badges this build can produce. There is no organization layer and no staged rollout, so neither has a badge. */
export type SourceBadgeKind = "managed" | "project" | "overridesProject" | "yours";

export const SOURCE_BADGES: Record<SourceBadgeKind, { label: string; tone: "managed" | "project" | "overrides" | "neutral" }> = {
  managed: { label: "Managed · locked", tone: "managed" },
  project: { label: "Project value", tone: "project" },
  overridesProject: { label: "Your value · overrides project", tone: "overrides" },
  yours: { label: "Your value", tone: "neutral" },
};

/** Resolver order, highest first. */
export const LAYER_ORDER: readonly ConfigurationLayer[] = ["managed", "repositoryLocal", "repositoryShared", "user", "defaults"];

/** A layer's name in the popover and in Settings files. */
export const LAYER_TITLES: Record<ConfigurationLayer, string> = {
  managed: "Managed",
  repositoryLocal: "Project · local",
  repositoryShared: "Project · shared",
  user: "Your settings",
  defaults: "Defaults",
};

const USER_FILE = "$TERMINALX_HOME/settings.json#";

/**
 * The dotted keys a registry row keeps in the user file, read from its storage
 * location: "$TERMINALX_HOME/settings.json#preferences.linkBrowser, preferences.linkBrowserChosen"
 * → ["preferences.linkBrowser", "preferences.linkBrowserChosen"]. Other stores (another
 * file, the Keychain, a service) give none. Later entries that name another file are not keys.
 */
export function userFileKeys(location: string): string[] {
  if (!location.startsWith(USER_FILE)) return [];
  const keys: string[] = [];
  for (const part of location.slice(USER_FILE.length).split(",")) {
    const key = part.trim();
    if (!/^[A-Za-z][\w-]*(\.[\w-]+)*$/.test(key)) break;
    keys.push(key);
  }
  return keys;
}

/** The row's keys the user file sets itself, per SettingsFileStatus.setKeys. */
export function setUserKeys(keys: readonly string[], setKeys: readonly string[]): string[] {
  const set = new Set(setKeys);
  return keys.filter((key) => set.has(key));
}

/** Each layer that supplies the key, highest first; an older runtime without `layers` still names its winner. */
export function valueLayers(value: ConfigurationValue): ConfigurationLayerValue[] {
  return value.layers?.length ? value.layers : [{ layer: value.source, value: value.value, redacted: value.redacted }];
}

/** The badge for a layered value, from the resolver's own source and layers. Defaults have none. */
export function badgeForValue(value: ConfigurationValue): SourceBadgeKind | null {
  switch (value.source) {
    case "managed": return "managed";
    case "repositoryLocal": return valueLayers(value).some((entry) => entry.layer === "repositoryShared") ? "overridesProject" : "yours";
    case "repositoryShared": return "project";
    case "user": return "yours";
    case "defaults": return null;
  }
}

export interface LayerRow {
  layer: ConfigurationLayer;
  title: string;
  /** The layer's own value, as text; null when the layer does not set the key. */
  value: string | null;
  winning: boolean;
  overridden: boolean;
}

export function formatLayerValue(entry: Pick<ConfigurationLayerValue, "value" | "redacted">): string {
  if (entry.redacted) return "hidden";
  if (entry.value === "") return "empty";
  if (typeof entry.value === "string") return entry.value;
  return JSON.stringify(entry.value) ?? "";
}

/**
 * The popover's list: every layer that can apply, highest first, each with its own value.
 * Without a repository the two project layers cannot apply and are left out.
 */
export function layerRows(value: ConfigurationValue, repository: boolean): LayerRow[] {
  const supplied = new Map(valueLayers(value).map((entry) => [entry.layer, entry]));
  return LAYER_ORDER.filter((layer) => repository || (layer !== "repositoryLocal" && layer !== "repositoryShared")).map((layer) => {
    const entry = supplied.get(layer);
    const winning = layer === value.source;
    return { layer, title: layer === "defaults" ? "Default" : LAYER_TITLES[layer], value: entry ? formatLayerValue(entry) : null, winning, overridden: !!entry && !winning };
  });
}

/**
 * What removing the winning value falls back to, and the button that does it.
 * Managed values are read-only and a project's committed value is the project's,
 * so neither offers a reset.
 */
export function resetFor(value: ConfigurationValue): { layer: ConfigurationLayer; label: string } | null {
  if (value.locked || (value.source !== "repositoryLocal" && value.source !== "user")) return null;
  const below = LAYER_ORDER.slice(LAYER_ORDER.indexOf(value.source) + 1);
  const next = below.find((layer) => valueLayers(value).some((entry) => entry.layer === layer)) ?? "defaults";
  const label = next === "repositoryShared" ? "Reset to project value" : next === "user" ? "Reset to your value" : "Reset to default";
  return { layer: value.source, label };
}

/** The chips beside a file in Settings files. */
export function fileChips(file: SettingsFileLayer): string[] {
  if (file.layer === "defaults") return [];
  if (!file.exists) return ["none on this Mac"];
  const chips = [`${file.keys} ${file.keys === 1 ? "key" : "keys"}`];
  if (file.git === "committed") chips.push("committed");
  if (file.git === "ignored") chips.push("ignored by Git");
  return chips;
}

const EFFECTS: Record<SettingsFileEffect, string> = {
  lastGood: "The last good values stay in effect.",
  ignoredKey: "That key is ignored; the rest of the file applies.",
  fileIgnored: "None of this file’s values apply until it is fixed.",
  blocked: "Sessions that use this file can’t start until it is fixed.",
};

export function effectSentence(effect: SettingsFileEffect): string {
  return EFFECTS[effect];
}

/** "~/.raccoon/settings.json line 7: preferences.theme unknown option. …" — one error, naming file, line and key. */
export function problemText(file: string, problem: SettingsFileProblem): string {
  const where = [file, problem.line == null ? null : `line ${problem.line}`].filter(Boolean).join(" ");
  return `${where}: ${problem.key ? `${problem.key} ` : ""}${problem.message.replace(/\.$/, "")}. ${effectSentence(problem.effect)}`;
}

/** The title of the toast a save refused by an invalid user file raises. */
export function cantSaveTitle(displayPath: string, problem: SettingsFileProblem | null): string {
  return problem?.line == null ? `Can’t save: ${displayPath} has an error` : `Can’t save: ${displayPath} has an error on line ${problem.line}`;
}

/** What stays in effect after a refused save. */
export function cantSaveEffect(problem: SettingsFileProblem): string {
  return problem.effect === "lastGood"
    ? "This change wasn’t saved; your other settings keep their last good values until the file is fixed."
    : `This change wasn’t saved. ${effectSentence(problem.effect)}`;
}

/** The text Copy error puts on the clipboard: the toast whole. */
export function cantSaveCopy(displayPath: string, problem: SettingsFileProblem): string {
  return `${cantSaveTitle(displayPath, problem)}\n${problem.key ? `${problem.key}: ` : ""}${problem.message}\n${cantSaveEffect(problem)}`;
}
