import nacl from "tweetnacl";
import type { RandomSource } from "./e2ee-session";

export const secureRandom: RandomSource = {
  bytes: (length) => nacl.randomBytes(length),
};
