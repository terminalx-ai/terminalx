import { PairingFailure } from "./errors";
import { createPairingOfferSchema, type PairingOffer } from "./contracts";

const INPUT_LIMIT = 128 * 1_024 + 1_024;

export function extractPairingCodeFromUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length > INPUT_LIMIT) return null;
  const match = /^terminalx:\/\/([^/?#]*)([^?#]*)?/i.exec(trimmed);
  const path = match?.[2] ?? "";
  if (!match || match[1]?.toLowerCase() !== "pair" || (path !== "" && path !== "/")) return null;
  const queryStart = trimmed.indexOf("?", match[0].length);
  if (queryStart >= 0) {
    const query = trimmed.slice(queryStart + 1).split("#")[0] ?? "";
    const code = new URLSearchParams(query).get("code");
    if (code) return code;
  }
  const hashStart = trimmed.indexOf("#", match[0].length);
  return hashStart >= 0 ? trimmed.slice(hashStart + 1) || null : null;
}

/**
 * The computer's name, when the pairing link carries one (`&name=`, PRO-87).
 * It rides beside the offer, not in it; a bare code has none. The caller
 * cleans it before use: it is a label, never part of the offer's checks.
 */
export function extractPairingNameFromUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length > INPUT_LIMIT || !/^terminalx:\/\/pair(?:\/)?\?/i.test(trimmed)) return null;
  const query = trimmed.slice(trimmed.indexOf("?") + 1).split("#")[0] ?? "";
  try {
    return new URLSearchParams(query).get("name");
  } catch {
    return null;
  }
}

export function parsePairingCode(input: string, now: () => number = Date.now): PairingOffer | null {
  try { return parsePairingCodeOrThrow(input, now); }
  catch { return null; }
}

export function parsePairingCodeOrThrow(input: string, now: () => number = Date.now): PairingOffer {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > INPUT_LIMIT) throw new PairingFailure("parsing");
  try {
    const encoded = /^terminalx:\/\//i.test(trimmed) ? extractPairingCodeFromUrl(trimmed) : trimmed;
    if (!encoded || encoded.length > 128 * 1_024) throw new PairingFailure("parsing");
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(encoded.length + ((4 - (encoded.length % 4)) % 4), "=");
    const value = JSON.parse(atob(padded));
    const timestamp = now();
    const result = createPairingOfferSchema(() => timestamp).safeParse(value);
    if (result.success) return result.data;
    // Only classify expiry when all other schema and pinned-host checks passed.
    if (result.error.issues.every((issue) => issue.path.join(".") === "relay.inviteExpiresAt") &&
        typeof value?.relay?.inviteExpiresAt === "number" && value.relay.inviteExpiresAt <= timestamp) {
      throw new PairingFailure("parsing", "expired-offer");
    }
    throw new PairingFailure("parsing");
  } catch (cause) {
    throw cause instanceof PairingFailure ? cause : new PairingFailure("parsing");
  }
}
