/**
 * A cloud workspace whose machine is gone at the provider (#1581), decided
 * the same way on the desktop and the phone.
 *
 * Since #1589 the server states it, in two places:
 * - on the workspace, `machineMissingAt`, while it is `attention-required`
 *   for that reason. The server's background check sets it without any
 *   operation failing, so a workspace whose machine was deleted at the
 *   provider says so before anyone presses Resume;
 * - on a failed stop, resume or archive, `detailCode: "machine_missing"`,
 *   when nothing at the provider can bring the machine back. TerminalX Cloud
 *   rebuilds a missing box from its newest checkpoint on a resume, so only
 *   that resume says so for it, and only when there is no checkpoint.
 *
 * A server from before #1589 sends neither, and the fact is inferred as
 * #1581 did: a failed resume the provider answered with "not found". The
 * server refuses a provider the organization cannot use with the same code,
 * but before any operation exists, so on an operation it is the provider's
 * own "not found". Of that server's details, only a missing environment image
 * comes with it and is about something other than the machine. A stop or an
 * archive with the code is not read as gone there, because a resume may
 * still restore the machine.
 */

export const MACHINE_GONE_MESSAGE = "This workspace's machine no longer exists at the provider. It may have been deleted outside TerminalX.";

/** The detail the server puts on a failed operation whose machine is gone (#1589). */
export const MACHINE_MISSING_DETAIL = "machine_missing";

const NOT_THE_MACHINE = "environment_image_missing";

export interface MachineGoneOperation {
  state?: string | null;
  action?: string | null;
  errorCode?: string | null;
  detailCode?: string | null;
}

export interface MachineGoneWorkspace {
  state?: string | null;
  machineMissingAt?: number | null;
}

export function machineGone(operation: MachineGoneOperation | null | undefined, workspace?: MachineGoneWorkspace | null): boolean {
  if (workspace?.state === "attention-required" && typeof workspace.machineMissingAt === "number") return true;
  if (!operation || operation.state !== "failed") return false;
  if (operation.detailCode === MACHINE_MISSING_DETAIL) return true;
  return operation.action === "resume" && operation.errorCode === "cloud_provider_not_found" && operation.detailCode !== NOT_THE_MACHINE;
}
