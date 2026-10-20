import { useSyncExternalStore } from "react";
import { getPrefs, subscribePrefs } from "@/lib/prefs";

/** What a field where the reader writes to an agent spreads onto its textarea. */
export interface PromptTextProps {
  spellCheck?: false;
  autoCorrect?: "off";
  autoCapitalize?: "off";
}

/**
 * Off sets all three. WebKit on macOS reads only `spellcheck`, and turning it
 * off there also stops smart quotes and dashes and text replacements (smart
 * dashes turn `--dry-run` into `—dry-run`); the other two do the same where
 * `spellcheck` alone does not. On sets none of them, so the browser's defaults
 * and the system's keyboard settings apply as they would to any text box.
 */
const OFF: PromptTextProps = { spellCheck: false, autoCorrect: "off", autoCapitalize: "off" };
const SYSTEM: PromptTextProps = {};

export function promptTextProps(autocorrect: boolean): PromptTextProps {
  return autocorrect ? SYSTEM : OFF;
}

const autocorrectOn = () => getPrefs().autocorrect;

/**
 * Follows Settings → Autocorrect in every open field at once. Subscribes to that
 * one preference, so a composer does not render again for unrelated ones (the
 * sidebar's width while it is dragged).
 */
export function usePromptTextProps(): PromptTextProps {
  return promptTextProps(useSyncExternalStore(subscribePrefs, autocorrectOn, autocorrectOn));
}
