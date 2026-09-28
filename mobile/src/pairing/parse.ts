import { createPairingOfferSchema, type PairingOffer } from "./contracts";
import { PairingError } from "./errors";

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

export function parsePairingCode(input: string, now: () => number = Date.now): PairingOffer | null {
  try { return requirePairingCode(input, now); } catch { return null; }
}

export function requirePairingCode(input: string, now: () => number = Date.now): PairingOffer {
  try {
    const trimmed = input.trim();
    if (!trimmed || trimmed.length > INPUT_LIMIT) throw new Error();
    const encoded = /^terminalx:\/\//i.test(trimmed) ? extractPairingCodeFromUrl(trimmed) : trimmed;
    if (!encoded || encoded.length > 128 * 1_024) throw new Error();
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(encoded.length + ((4 - (encoded.length % 4)) % 4), "=");
    const value = JSON.parse(atob(padded));
    const parsed = createPairingOfferSchema(now).safeParse(value);
    if (parsed.success) return parsed.data;
    if (parsed.error.issues.every((issue) => issue.path.join(".") === "relay.inviteExpiresAt") &&
        typeof value?.relay?.inviteExpiresAt === "number" && value.relay.inviteExpiresAt <= now()) {
      throw new PairingError("parsing", "expired-offer");
    }
    throw new Error();
  } catch (error) {
    if (error instanceof PairingError) throw error;
    throw new PairingError("parsing", "invalid-offer");
  }
}
