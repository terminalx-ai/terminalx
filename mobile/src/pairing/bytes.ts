export function concatBytes(...values: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.length;
  }
  return output;
}

export const utf8 = (value: string) => new TextEncoder().encode(value);

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  if (base64Url(bytes) !== value) throw new Error("invalid_account_pairing_base64url");
  return bytes;
}

export const uint16 = (value: number) => Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
