import { hostFamily } from "@/lib/platform";
import type { PlatformFamily } from "@terminalx/portable/platformProfiles";

/**
 * The GitHub CLI's own install command for a system, as its docs give it:
 * WinGet on Windows (the official package), Homebrew on a Mac. Linux has a
 * package per distribution, so it gets the docs page instead (null).
 */
export function ghInstallCommand(family: PlatformFamily | null = hostFamily): string | null {
  if (family === "windows") return "winget install --id GitHub.cli --source winget";
  if (family === "macos") return "brew install gh";
  return null;
}

export const GH_INSTALL_URL = "https://cli.github.com/";
