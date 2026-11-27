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

/** A Polar customer portal (PRO-596): https on polar.sh or a subdomain, nothing else. */
export function polarPortalUrl(raw: string | undefined): string | undefined {
  if (!raw?.startsWith("https://")) return undefined;
  try {
    const url = new URL(raw);
    const polar = url.hostname === "polar.sh" || url.hostname.endsWith(".polar.sh");
    if (url.protocol === "https:" && polar && !url.port && !url.username && !url.password) return url.href;
  } catch {
    return undefined;
  }
}
