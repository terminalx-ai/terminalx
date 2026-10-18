import { usePrefs } from "@/lib/prefs";

export interface PromptTextProps {
  spellCheck?: boolean;
  autoCorrect?: string;
  autoCapitalize?: string;
}

// In WebKit on macOS `spellcheck` is the attribute that counts: false stops
// the underline and every substitution (spelling, smart quotes and dashes,
// text replacements), while `autocorrect="off"` alone stops none of them.
// The other two are for engines that read them.
const AS_TYPED: PromptTextProps = { spellCheck: false, autoCorrect: "off", autoCapitalize: "off" };

/**
 * Text-correction attributes for a field where the reader writes to an agent.
 * Prompts are full of identifiers, paths and flags a spell checker "fixes"
 * wrongly, so with the Autocorrect setting off (the default) the field keeps
 * what was typed exactly as typed. On leaves the browser's defaults.
 */
export function promptTextProps(autocorrect: boolean): PromptTextProps {
  return autocorrect ? {} : AS_TYPED;
}

/** {@link promptTextProps} for the current setting; a change applies to open fields at once. */
export function usePromptTextProps(): PromptTextProps {
  return promptTextProps(usePrefs().autocorrect);
}
