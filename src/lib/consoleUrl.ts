/** Validate projected console destinations before copying or opening them. */
export function consoleUrl(raw: string | undefined): string | undefined {
  if (!raw?.startsWith("https://")) return undefined;
  try {
    const url = new URL(raw);
    if (url.origin === "https://console.terminalx.ai" && !url.username && !url.password) {
      return url.href;
    }
  } catch {
    return undefined;
  }
}
