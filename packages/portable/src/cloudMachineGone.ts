/**
 * A cloud workspace whose machine is gone at the provider (#1581), decided
 * the same way on the desktop and the phone.
 *
 * Only a failed resume says so. A resume is the one action that tries to
 * bring a missing machine back: TerminalX Cloud rebuilds a missing box from
 * its newest checkpoint, and fails with "not found" only when there is none
 * (`box_lost_without_checkpoint`); the other providers never create a machine
 * on a resume. A stop or an archive of a missing machine also fails with
 * "not found", but a resume may still restore it, so those keep their retry.
 *
 * The server refuses a provider the organization cannot use with the same
 * code, but before any operation exists: on an operation it is the provider's
 * own "not found". Of the server's details, only a missing environment image
 * comes with it and is about something other than the machine.
 *
 * #1589 asks the server to state the fact itself.
 */

export const MACHINE_GONE_MESSAGE = "This workspace's machine no longer exists at the provider. It may have been deleted outside TerminalX.";

const NOT_THE_MACHINE = "environment_image_missing";

export interface MachineGoneOperation {
  state?: string | null;
  action?: string | null;
  errorCode?: string | null;
  detailCode?: string | null;
}

export function machineGone(operation: MachineGoneOperation | null | undefined): boolean {
  return !!operation && operation.state === "failed" && operation.action === "resume"
    && operation.errorCode === "cloud_provider_not_found" && operation.detailCode !== NOT_THE_MACHINE;
}
