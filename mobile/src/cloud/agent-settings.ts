import { BYPASS_MODE, EFFORT_LABEL, FIRST_RUN_PERMISSION_MODE, PERMISSION_MODES } from "@terminalx/portable/agentSettings";

/**
 * The agent settings a phone may choose when it starts an agent in a cloud
 * workspace: at launch (25.09) and in a running workspace (25.10). The names
 * and hints are the desktop's (`@terminalx/portable/agentSettings`).
 *
 * A phone never starts an agent in Bypass permissions, and never leaves the
 * mode out: the runtime starts a launch that names no mode in bypass
 * (`cloud_agents/launch.rs`, `new_tab`), so every request from the phone names
 * one of the four modes here, and the server refuses anything else
 * (PRO-544, PRO-546).
 */
export const PHONE_MODE_IDS = ["plan", "manual", "auto", "acceptEdits"] as const;
export type PhoneMode = (typeof PHONE_MODE_IDS)[number];

/** The mode a phone's choice starts on, and the one sent where the agent lists no modes to choose from: Ask every time. */
export const PHONE_DEFAULT_MODE: PhoneMode = FIRST_RUN_PERMISSION_MODE as PhoneMode;

/** The owner's line under the modes (approved 2026-11-24), wherever a phone picks one. */
export const BYPASS_NOT_FROM_PHONE = "Bypass permissions can't be chosen from a phone.";

export const isPhoneMode = (mode: unknown): mode is PhoneMode => (PHONE_MODE_IDS as readonly unknown[]).includes(mode);

/** What a phone sends for a mode: the mode itself when it is one of the four, else Ask every time. Never bypass, never nothing. */
export const phoneMode = (mode: string | null | undefined): PhoneMode => (isPhoneMode(mode) ? mode : PHONE_DEFAULT_MODE);

export interface PhoneModeChoice { id: PhoneMode; label: string; hint: string }

/**
 * The modes a phone offers for an agent, in the desktop's order with its
 * names and hints. `listed` is what the agent's own list carries, when there
 * is one: only those are offered, and Bypass permissions is left out whoever
 * lists it. An agent that lists none has nothing to choose (no row is drawn),
 * and the request names `PHONE_DEFAULT_MODE`.
 */
export function phoneModes(listed?: readonly string[] | null): PhoneModeChoice[] {
  return PERMISSION_MODES.filter((mode): mode is PhoneModeChoice => mode.id !== BYPASS_MODE && isPhoneMode(mode.id) && (listed == null || listed.includes(mode.id)));
}

/** A mode's name as the desktop's picker has it. */
export const phoneModeLabel = (mode: PhoneMode): string => PERMISSION_MODES.find((entry) => entry.id === mode)?.label ?? mode;

/** An effort's name as the app's pickers have it; one they do not know keeps its own word. */
export const effortLabel = (effort: string): string => EFFORT_LABEL[effort] ?? effort;
