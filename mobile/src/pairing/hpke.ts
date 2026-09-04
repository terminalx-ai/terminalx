import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519";
import { expand, extract } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { concatBytes, decodeBase64Url, uint16, utf8 } from "./bytes";

const VERSION = utf8("HPKE-v1");
const KEM_SUITE = concatBytes(utf8("KEM"), uint16(0x0020));
const HPKE_SUITE = concatBytes(utf8("HPKE"), uint16(0x0020), uint16(0x0001), uint16(0x0003));
const EMPTY = new Uint8Array();

const labeledExtract = (suite: Uint8Array, salt: Uint8Array, label: string, keyMaterial: Uint8Array) => extract(sha256, concatBytes(VERSION, suite, utf8(label), keyMaterial), salt);
const labeledExpand = (suite: Uint8Array, key: Uint8Array, label: string, info: Uint8Array, length: number) => expand(sha256, key, concatBytes(uint16(length), VERSION, suite, utf8(label), info), length);

export function openAccountPairingEnvelope(input: { recipientPrivateKey: Uint8Array; encapsulatedKey: string; ciphertext: string; associatedData: string }): Uint8Array {
  const encapsulatedKey = decodeBase64Url(input.encapsulatedKey);
  if (input.recipientPrivateKey.length !== 32 || encapsulatedKey.length !== 32) throw new Error("invalid_account_pairing_hpke_key");
  const publicKey = x25519.getPublicKey(input.recipientPrivateKey);
  const dh = x25519.getSharedSecret(input.recipientPrivateKey, encapsulatedKey);
  if (dh.every((byte) => byte === 0)) throw new Error("invalid_account_pairing_hpke_key");
  const eaePrk = labeledExtract(KEM_SUITE, EMPTY, "eae_prk", dh);
  const sharedSecret = labeledExpand(KEM_SUITE, eaePrk, "shared_secret", concatBytes(encapsulatedKey, publicKey), 32);
  const pskIdHash = labeledExtract(HPKE_SUITE, EMPTY, "psk_id_hash", EMPTY);
  const infoHash = labeledExtract(HPKE_SUITE, EMPTY, "info_hash", EMPTY);
  const context = concatBytes(Uint8Array.of(0), pskIdHash, infoHash);
  const secret = labeledExtract(HPKE_SUITE, sharedSecret, "secret", EMPTY);
  const key = labeledExpand(HPKE_SUITE, secret, "key", context, 32);
  const nonce = labeledExpand(HPKE_SUITE, secret, "base_nonce", context, 12);
  return chacha20poly1305(key, nonce, decodeBase64Url(input.associatedData)).decrypt(decodeBase64Url(input.ciphertext));
}
