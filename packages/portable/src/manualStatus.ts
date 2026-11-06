/** Human workflow, separate from an agent's runtime status. */
export const MANUAL_STATUSES = ["backlog", "in_progress", "in_review", "done", "canceled"] as const;
export type ManualStatus = (typeof MANUAL_STATUSES)[number];
export const MANUAL_STATUS_LABELS: Record<ManualStatus, string> = {
  backlog: "Backlog", in_progress: "In progress", in_review: "In review", done: "Done", canceled: "Canceled",
};
export function manualStatusLabel(status?: ManualStatus | null): string {
  return MANUAL_STATUS_LABELS[status ?? "backlog"] ?? MANUAL_STATUS_LABELS.backlog;
}
