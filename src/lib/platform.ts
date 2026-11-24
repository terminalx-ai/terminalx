import { profileFor, platformFamily, type PlatformFamily, type PlatformProfile } from "@terminalx/portable/platformProfiles";

export { PLATFORM_PROFILES, profileFor, platformFamily, type PlatformFamily, type PlatformProfile } from "@terminalx/portable/platformProfiles";

declare global {
  interface Window {
    /** The operating system the desktop runs on, set by the app before any page script (`platform_profile.rs`). */
    __TERMINALX_PLATFORM__?: string;
  }
}

/**
 * The system this window runs on: what the desktop app says, else what the
 * browser reports (`navigator.platform`), for a page outside the app and for
 * tests. Null where neither names one this app knows.
 */
export function detectPlatform(injected: string | undefined, browserPlatform: string): PlatformFamily | null {
  const told = platformFamily(injected);
  if (told) return told;
  if (/Mac|iPhone|iPad/.test(browserPlatform)) return "macos";
  if (/^Win/i.test(browserPlatform)) return "windows";
  if (/Linux|X11|BSD/i.test(browserPlatform)) return "linux";
  return null;
}

/** The system as of now, for code that reads it when it runs rather than once at load. */
export function familyNow(): PlatformFamily | null {
  return detectPlatform(
    typeof window === "undefined" ? undefined : window.__TERMINALX_PLATFORM__,
    typeof navigator === "undefined" ? "" : navigator.platform,
  );
}

export const hostFamily: PlatformFamily | null = familyNow();

/** What this window says and draws for the computer it runs on. */
export const profile: PlatformProfile = profileFor(hostFamily);

export const isMac = hostFamily === "macos";
export const isWindows = hostFamily === "windows";

/** "this Mac", "this PC", "this computer". */
export const thisComputer = profile.thisComputer;
/** "This Mac", "This PC", "This computer". */
export const ThisComputer = profile.ThisComputer;
/** "your Mac", "your PC", "your computer". */
export const yourComputer = profile.yourComputer;
/** "Mac", "PC", "computer". */
export const computerWord = profile.computerWord;
/** Where secrets are kept, as a settings row names it: "macOS Keychain", "Windows encrypted store". */
export const secretStore = profile.secretStore ?? "No secret store on this system";
/** "the macOS Keychain", "the Windows encrypted store". */
export const secretStoreThe = profile.secretStoreThe;
/** "the Keychain", "the Windows encrypted store". */
export const secretStoreShort = profile.secretStoreShort;
/** "Keychain", "Encrypted store". */
export const secretStoreWord = profile.secretStoreWord;
/** "Finder", "File Explorer", "File Manager". */
export const fileManager = profile.fileManager;
/** The action that shows a file there: "Reveal in Finder", "Reveal in File Explorer". */
export const revealInFileManager = `Reveal in ${fileManager}`;
