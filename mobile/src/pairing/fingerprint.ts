import { sha256 } from "@noble/hashes/sha256";
import nacl from "tweetnacl";
import { concatBytes, utf8 } from "./bytes";

/**
 * The pairing fingerprint (docs/PAIRING-APPROVAL.md § "Fingerprint"). The Mac
 * shows the same one before it approves a QR pairing: both sides know every
 * input before `e2ee_authenticated`, so nothing crosses the wire for it.
 *
 * The one-time device token from the code is part of it, so a key ground in
 * advance to match this phone's fingerprint is useless, and 64 bits leave no
 * time to grind one while the code is live.
 */
const DOMAIN = concatBytes(utf8("terminalx-pairing-fingerprint.v2"), Uint8Array.of(0));

/** `host_pk` and `phone_pk` are the raw 32-byte X25519 public keys; `tokenDigest` is SHA-256 of the device token. */
export function pairingFingerprint(hostPublicKey: Uint8Array, phonePublicKey: Uint8Array, tokenDigest: Uint8Array): string {
  if (hostPublicKey.length !== 32 || phonePublicKey.length !== 32 || tokenDigest.length !== 32) throw new Error("Pairing fingerprint inputs must be 32 bytes");
  const digest = sha256(concatBytes(DOMAIN, hostPublicKey, phonePublicKey, tokenDigest));
  return [0, 2, 4, 6].map((at) => hex(digest.subarray(at, at + 2))).join("·");
}

/** The fingerprint for a pairing offer (its pinned `publicKeyB64` and one-time `deviceToken`) and this phone's long-lived E2EE secret key. */
export function fingerprintForOffer(offer: { publicKeyB64: string; deviceToken: string }, phoneSecretKey: Uint8Array): string {
  const host = Uint8Array.from(atob(offer.publicKeyB64), (character) => character.charCodeAt(0));
  return pairingFingerprint(host, nacl.scalarMult.base(new Uint8Array(phoneSecretKey)), sha256(utf8(offer.deviceToken)));
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
