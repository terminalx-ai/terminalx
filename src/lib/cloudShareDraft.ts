import type {
  CloudAccessApply,
  CloudShareRole,
  CloudShareSubject,
  CloudWorkspaceShares,
} from "@/lib/api";

export type ShareRow = {
  subject: CloudShareSubject;
  name: string;
  detail?: string;
  role: CloudShareRole;
  canApprove: boolean;
};

export type ShareEdit = { op: "put" | "remove"; row: ShareRow };

export function shareRowKey({ subject }: ShareRow): string {
  return `${subject.type}:${subject.id}`;
}

export function shareRows(snapshot: CloudWorkspaceShares): ShareRow[] {
  return [
    ...snapshot.shares.map((share): ShareRow => ({
      subject: { type: "user", id: share.userId },
      name: share.name || share.email,
      detail: share.name ? share.email : undefined,
      role: share.role,
      canApprove: share.canApprove,
    })),
    ...(snapshot.groupShares ?? []).map(({ group, role, canApprove }): ShareRow => ({
      subject: { type: "group", id: group.id },
      name: group.name,
      detail: groupDetail(group.memberCount),
      role,
      canApprove,
    })),
  ];
}

export function groupDetail(memberCount: number): string {
  return `Group · ${memberCount} ${memberCount === 1 ? "member" : "members"}`;
}

export function pendingShareEdits(base: ShareRow[], edits: ShareEdit[]): ShareEdit[] {
  const bySubject = new Map(base.map((row) => [shareRowKey(row), row]));
  return edits.flatMap((edit) => {
    const saved = bySubject.get(shareRowKey(edit.row));
    if (edit.op === "remove") return saved ? [{ ...edit, row: saved }] : [];
    if (saved?.role === edit.row.role && saved.canApprove === edit.row.canApprove) return [];
    const row = saved ? { ...saved, role: edit.row.role, canApprove: edit.row.canApprove } : edit.row;
    return [{ ...edit, row }];
  });
}

export function replaceShareEdit(edits: ShareEdit[], row: ShareRow, op?: ShareEdit["op"]): ShareEdit[] {
  const others = edits.filter((edit) => shareRowKey(edit.row) !== shareRowKey(row));
  return op ? [...others, { op, row }] : others;
}

/** Keep fields changed by another manager when this draft did not edit them. */
export function rebaseShareEdits(before: ShareRow[], after: ShareRow[], edits: ShareEdit[]): ShareEdit[] {
  const previous = new Map(before.map((row) => [shareRowKey(row), row]));
  const current = new Map(after.map((row) => [shareRowKey(row), row]));
  return pendingShareEdits(after, edits.map((edit) => {
    const key = shareRowKey(edit.row);
    const from = previous.get(key);
    const to = current.get(key);
    if (edit.op !== "put" || !from || !to) return edit;
    const role = from.role === edit.row.role ? to.role : edit.row.role;
    const canApprove = role === "manager" || (from.canApprove === edit.row.canApprove ? to.canApprove : edit.row.canApprove);
    return { ...edit, row: { ...to, role, canApprove } };
  }));
}

export function buildShareRequest(accessRevision: string, edits: ShareEdit[]) {
  // Put replacement admins first so the server's last-admin check can pass.
  const order = (edit: ShareEdit) => edit.op === "remove" ? 1 : edit.row.role === "manager" ? 0 : 2;
  const ordered = [...edits].sort((a, b) => order(a) - order(b));
  const request: CloudAccessApply = {
    accessRevision,
    requestId: crypto.randomUUID(),
    changes: ordered.map(({ op, row }, index) => ({
      id: `change-${index + 1}`,
      subject: row.subject,
      ...(op === "put" ? { op, role: row.role, canApprove: row.canApprove } : { op }),
    })),
  };
  return { request, ordered };
}
