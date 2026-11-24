import profiles from "./platformProfiles.json";

/** An operating system as Rust's `std::env::consts::OS` names it. */
export type PlatformFamily = "macos" | "windows" | "linux";

/**
 * What the app says and draws for one operating system. The desktop's Rust
 * side reads the same file, so the window and the messages it shows from the
 * runtime use the same words.
 */
export interface PlatformProfile {
  /** The system's own name, as the machine tags show it: "macOS". */
  osName: string;
  /** The icon a computer of this system is drawn with. */
  icon: "monitor" | "server";
  /** "Mac", "PC", "computer". */
  computerWord: string;
  thisComputer: string;
  ThisComputer: string;
  yourComputer: string;
  /** Where secrets are kept, as a label: "macOS Keychain"; null where the system has no store. */
  secretStore: string | null;
  /** The same in a sentence: "in the macOS Keychain". */
  secretStoreThe: string;
  /** Its short name in a sentence: "kept in the Keychain". */
  secretStoreShort: string;
  /** Its short name on its own, as a chip shows it: "Keychain". */
  secretStoreWord: string;
  /** Where the system shows the computer's name; null where there is no one place. */
  aboutSettingsPath: string | null;
  /** The app that shows files, as a menu names it: "Finder", "File Explorer", "File Manager". */
  fileManager: string;
  /** Modifier glyphs (⌘⌥⇧⌃) or their names (Ctrl, Alt, Shift). */
  keyStyle: "symbols" | "words";
  /** What goes between the keys of a shortcut: "⇧⌘D", "Ctrl+Shift+D". */
  keyJoiner: string;
}

export const PLATFORM_PROFILES: Record<PlatformFamily, PlatformProfile> = profiles as Record<PlatformFamily, PlatformProfile>;

/** A family this app knows, or null. */
export function platformFamily(name: string | null | undefined): PlatformFamily | null {
  return name === "macos" || name === "windows" || name === "linux" ? name : null;
}

/** The profile for a family; an unknown one is spoken of as a Linux computer is, by plain nouns. */
export function profileFor(family: string | null | undefined): PlatformProfile {
  return PLATFORM_PROFILES[platformFamily(family) ?? "linux"];
}
