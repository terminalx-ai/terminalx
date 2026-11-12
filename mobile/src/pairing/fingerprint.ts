import { sha256 } from "@noble/hashes/sha256";
import nacl from "tweetnacl";
import { concatBytes, utf8 } from "./bytes";

/**
 * The pairing fingerprint (docs/PAIRING-APPROVAL.md § "Fingerprint"). The Mac
 * shows the same one before it approves a QR pairing: both sides know both
 * keys before `e2ee_authenticated`, so nothing crosses the wire for it.
 */
const DOMAIN = concatBytes(utf8("terminalx-pairing-fingerprint.v1"), Uint8Array.of(0));

/** `host_pk` and `phone_pk` are the raw 32-byte X25519 public keys. */
export function pairingFingerprint(hostPublicKey: Uint8Array, phonePublicKey: Uint8Array): string {
  if (hostPublicKey.length !== 32 || phonePublicKey.length !== 32) throw new Error("Pairing fingerprint keys must be 32 bytes");
  const digest = sha256(concatBytes(DOMAIN, hostPublicKey, phonePublicKey));
  return `${hex(digest.subarray(0, 2))}·${hex(digest.subarray(2, 4))}`;
}

/** The fingerprint for a pairing offer (its pinned `publicKeyB64`) and this phone's long-lived E2EE secret key. */
export function fingerprintForOffer(hostPublicKeyB64: string, phoneSecretKey: Uint8Array): string {
  const host = Uint8Array.from(atob(hostPublicKeyB64), (character) => character.charCodeAt(0));
  return pairingFingerprint(host, nacl.scalarMult.base(new Uint8Array(phoneSecretKey)));
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
