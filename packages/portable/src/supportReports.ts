export const supportConsole = "https://console.terminalx.ai/support-reports";
export const reportPath = "/v1/support";
const hour = 60 * 60 * 1000;
export const reportWindows = [1, 24, 168] as const;
export type ReportHours = typeof reportWindows[number];

export const features = ["sign-in", "connection", "startup", "cloud", "other"] as const;
export const symptoms = ["unavailable", "disconnected", "failed", "slow", "unexpected"] as const;
export type Problem = { feature: typeof features[number]; symptom: typeof symptoms[number] };
export type ReportEvent = { at: number; kind: string; classification?: string };
export type SourceStatus = "included" | "empty" | "omitted" | "unavailable" | "failed";
export type ReportWindow = { from: number; to: number };
export type LocalSource = {
  status: SourceStatus;
  platform: string;
  appVersion: string;
  capturedAt: number;
  truncated: boolean;
  events: ReportEvent[];
};
export type ServerSource = Pick<LocalSource, "status" | "capturedAt" | "truncated" | "events"> & { version?: string };
export type ServerPreview = ReportWindow & { key: string; server: ServerSource };
export type PreviewRequest = { to: number; hours: ReportHours; server: boolean } | { reference: string; server: false };
export type Submission = { v: 1; key: string; problem?: Problem; local: LocalSource };

export const supportReference = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const versionPattern = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc|dev)(?:\.\d{1,6})?)?(?: \(\d{1,9}\))?$/;

export function reportWindow(to: number, hours: ReportHours): ReportWindow {
  return { from: to - hours * hour, to };
}

export function localReportSource(
  metadata: { platform: string; appVersion: string },
  window: ReportWindow,
  allowedKinds: readonly string[],
  observed: readonly ReportEvent[] | SourceStatus,
  classifications: readonly string[] = [],
): LocalSource {
  const matching = typeof observed === "string" ? [] : observed
    .filter(({ at, kind }) => Number.isSafeInteger(at) && at >= window.from && at <= window.to && allowedKinds.includes(kind))
    .sort((a, b) => b.at - a.at);
  return {
    platform: metadata.platform,
    appVersion: versionPattern.test(metadata.appVersion) ? metadata.appVersion : "unknown",
    capturedAt: Date.now(),
    status: typeof observed === "string" ? observed : matching.length ? "included" : "empty",
    truncated: matching.length > 100,
    events: matching.slice(0, 100).map(({ at, kind, classification }) => ({
      at, kind, ...(classification !== undefined && classifications.includes(classification) && { classification }),
    })),
  };
}

const messages: Record<string, string> = {
  unauthorized: "Sign in to TerminalX and try again.",
  support_report_not_found: "The reference is unavailable, expired, or already has a contribution from this type of device.",
  support_preview_expired: "This preview has expired. Prepare a new preview to continue.",
  support_report_retry_mismatch: "The draft changed after a send attempt. Use the original preview to check delivery.",
  support_report_rate_limited: "Too many reports were prepared. Try again later or copy the reviewed report.",
  support_report_too_large: "The report is too large. Shorten the time window or copy the reviewed report.",
  support_reports_unavailable: "Support reporting is unavailable on this server. You can copy the reviewed local report.",
  privacy: "Data privacy mode blocks sending. You can copy the reviewed local report.",
};

export function supportError(reason: unknown, action: "preview" | "submit" | "copy" = "submit"): string {
  const code = typeof reason === "string" ? reason : reason instanceof Error ? reason.message : "";
  if (Object.hasOwn(messages, code)) return messages[code];
  if (action === "preview") return "The server preview is unavailable. Try again or copy the reviewed local report if available.";
  if (action === "copy") return "The report could not be copied. Try again.";
  return "Delivery could not be confirmed. Retry with the same preview or copy the report.";
}

export function reportExport(
  device: "desktop" | "mobile",
  window: ReportWindow,
  problem: Problem | undefined,
  local: LocalSource,
) {
  return JSON.stringify({ v: 1, ...window, problem, [device]: local }, null, 2);
}

export type PreparedReport = ReportWindow & {
  key: string | null;
  server: ServerSource;
  local: LocalSource;
  error?: string;
};

export async function prepareReport(
  input: PreviewRequest,
  fetchPreview: (input: PreviewRequest) => Promise<ServerPreview>,
  collectLocal: (window: ReportWindow) => LocalSource | Promise<LocalSource>,
): Promise<PreparedReport> {
  let preview: ServerPreview;
  try {
    preview = await fetchPreview(input);
  } catch (cause) {
    if ("reference" in input) throw cause;
    const window = reportWindow(input.to, input.hours);
    return {
      ...window,
      key: null,
      server: { status: input.server ? "unavailable" : "omitted", capturedAt: Date.now(), events: [], truncated: false },
      local: await collectLocal(window),
      error: supportError(cause, "preview"),
    };
  }
  return { ...preview, local: await collectLocal(preview) };
}

export const sourceLabels: Record<SourceStatus, string> = {
  included: "Included",
  empty: "No events in this window",
  omitted: "Omitted",
  unavailable: "Unavailable",
  failed: "Collection failed",
};
