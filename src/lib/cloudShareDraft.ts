import type { CloudShareRole, CloudWorkspaceShares } from "@/lib/api";

export interface ShareDraftRow {
  kind: "person" | "group";
  id: string;
  name: string;
  role: CloudShareRole;
  canApprove: boolean;
  memberCount?: number;
}
export interface ShareDraft {
  access: "private" | "organization";
  rows: ShareDraftRow[];
}
export interface ShareDraftChange {
  key: string;
  label: string;
  before?: ShareDraftRow;
  after?: ShareDraftRow;
}
export const shareRowKey = (row: ShareDraftRow) => `${row.kind}:${row.id}`;
export function shareDraft(
  listed: CloudWorkspaceShares,
  access: ShareDraft["access"],
): ShareDraft {
  return {
    access,
    rows: [
      ...listed.shares.map(
        (share): ShareDraftRow => ({
          kind: "person",
          id: share.userId,
          name: share.name || share.email,
          role: share.role,
          canApprove: share.canApprove,
        }),
      ),
      ...(listed.groups ?? []).map(
        (group): ShareDraftRow => ({
          kind: "group",
          id: group.groupId,
          name: group.name,
          memberCount: group.memberCount,
          role: group.role,
          canApprove: group.canApprove,
        }),
      ),
    ],
  };
}
export function shareDraftChanges(
  base: ShareDraft,
  draft: ShareDraft,
): ShareDraftChange[] {
  const before = new Map(base.rows.map((row) => [shareRowKey(row), row]));
  const after = new Map(draft.rows.map((row) => [shareRowKey(row), row]));
  return [...new Set([...before.keys(), ...after.keys()])].flatMap((key) => {
    const a = before.get(key),
      b = after.get(key);
    if (a && b && a.role === b.role && a.canApprove === b.canApprove) return [];
    return [
      {
        key,
        label: `${b?.name ?? a!.name}${(b ?? a)!.kind === "group" ? " (Group)" : ""}`,
        before: a,
        after: b,
      },
    ];
  });
}
export function shareDraftDirty(base: ShareDraft, draft: ShareDraft): boolean {
  return (
    base.access !== draft.access || shareDraftChanges(base, draft).length > 0
  );
}
/** Every successful change becomes the new base; failures remain editable and retryable. */
export async function applyShareDraftChanges(
  base: ShareDraft,
  draft: ShareDraft,
  run: (change: ShareDraftChange) => Promise<unknown>,
  explain: (error: unknown) => string,
) {
  let saved = base;
  const failures: string[] = [];
  for (const change of shareDraftChanges(base, draft)) {
    try {
      await run(change);
      saved = {
        ...saved,
        rows: [
          ...saved.rows.filter((row) => shareRowKey(row) !== change.key),
          ...(change.after ? [change.after] : []),
        ],
      };
    } catch (error) {
      failures.push(`${change.label}: ${explain(error)}`);
    }
  }
  return { saved, failures };
}
