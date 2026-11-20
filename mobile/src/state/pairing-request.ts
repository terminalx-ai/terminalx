/**
 * A request to open pairing on the Machines tab from another screen (PRO-465):
 * Sessions' "Add a machine" and "Pair again" go to Machines, where the pairing
 * sheet lives, and it opens when that tab comes into view.
 */
let pending = false;

export function requestPairing(): void {
  pending = true;
}

/** True once per request. */
export function takePairingRequest(): boolean {
  const asked = pending;
  pending = false;
  return asked;
}
