import { invoke } from "@tauri-apps/api/core";

/**
 * What the app keeps in native code for the cloud commands of the CLI
 * (PRO-40), so that neither the window nor an agent that can click and type
 * decides it: the person's switch, and the question shown before anything
 * that spends, wakes or stops.
 *
 * - The switch is a file in the app's home. The control socket reads it
 *   itself and refuses `cloud.*` before the window hears of the command;
 *   turning it on shows a native dialog.
 * - A question is a native dialog whose default button refuses. While it is
 *   open the app refuses computer-use actions, and after a refusal it does
 *   not ask again for a while.
 */
export type CloudControlAnswer = "accepted" | "declined" | "expired" | "busy" | `backoff:${number}`;
/** What the switch is after a request to change it, and why it did not turn on (an answer other than accepted). */
export interface CloudControlSettingChange {
  enabled: boolean;
  refused: CloudControlAnswer | null;
}

export const cloudControlNative = {
  /** Whether the person lets the command line use cloud workspaces. */
  setting: () => invoke<boolean>("cloud_control_setting"),
  /** Ask to turn it on (the person confirms in a native dialog) or turn it off. Resolves to what it is afterwards, and why if it did not turn on. */
  setSetting: (enabled: boolean) => invoke<CloudControlSettingChange>("cloud_control_set_setting", { enabled }),
  /** Ask the person about one request: "…asks to <what>". */
  confirm: (what: string, okLabel: string) => invoke<CloudControlAnswer>("cloud_control_confirm", { what, okLabel }),
};
