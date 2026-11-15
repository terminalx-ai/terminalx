import type { AccountHost } from "./account-client";
import { hostIdForPublicKey } from "./contracts";

/** Whether an account's record of a machine names the id its key gives: a record that does not is never paired. */
export function accountHostIdentityMatches(host: AccountHost): boolean {
  return hostIdForPublicKey(host.hostPublicKeyB64) === host.hostId;
}
