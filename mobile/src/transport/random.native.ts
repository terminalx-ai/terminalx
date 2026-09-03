import * as Crypto from "expo-crypto";
import nacl from "tweetnacl";
import type { RandomSource } from "./e2ee-session";

nacl.setPRNG((target: Uint8Array, length: number) => target.set(Crypto.getRandomBytes(length)));

export const secureRandom: RandomSource = {
  bytes: (length) => Crypto.getRandomBytes(length),
};
