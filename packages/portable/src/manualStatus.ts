/** Human workflow, separate from an agent's runtime status. */
export const MANUAL_STATUSES = ["backlog", "in_progress", "in_review", "done", "canceled"] as const;
export type ManualStatus = (typeof MANUAL_STATUSES)[number];
export const MANUAL_STATUS_LABELS: Record<ManualStatus, string> = {
  backlog: "Backlog", in_progress: "In progress", in_review: "In review", done: "Done", canceled: "Canceled",
};
/** Older clients keep sessions from newer runtimes visible in Backlog. */
export function normalizeManualStatus(status: unknown): ManualStatus {
  return MANUAL_STATUSES.includes(status as ManualStatus) ? status as ManualStatus : "backlog";
}
export function manualStatusLabel(status?: unknown): string {
  return MANUAL_STATUS_LABELS[normalizeManualStatus(status)];
}
