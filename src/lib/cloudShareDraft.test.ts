import { describe, expect, it, vi } from "vitest";
import {
  applyShareDraftChanges,
  shareDraftChanges,
  shareDraftDirty,
  reconcileShareDraft,
  type ShareDraft,
} from "./cloudShareDraft";

const base: ShareDraft = {
  access: "organization",
  rows: [
    {
      kind: "person",
      id: "alice",
      name: "Alice",
      role: "viewer",
      canApprove: false,
    },
    {
      kind: "group",
      id: "engineering",
      name: "Engineering",
      role: "driver",
      canApprove: true,
      memberCount: 3,
    },
  ],
};
describe("share drafts", () => {
  it("collapses edits back to their original value and ignores refreshed labels/counts", () => {
    expect(
      shareDraftDirty(base, {
        ...base,
        rows: base.rows.map((row) => ({
          ...row,
          name: "New name",
          memberCount: 5,
        })),
      }),
    ).toBe(false);
    expect(shareDraftDirty(base, { ...base, access: "private" })).toBe(true);
  });
  it("keeps person and group ids separate, with additions, changes and removals in one batch", () => {
    const draft: ShareDraft = {
      ...base,
      rows: [
        { ...base.rows[0]!, role: "driver" },
        {
          kind: "group",
          id: "alice",
          name: "Alice team",
          role: "viewer",
          canApprove: false,
        },
      ],
    };
    expect(shareDraftChanges(base, draft).map((change) => change.key)).toEqual([
      "person:alice",
      "group:engineering",
      "group:alice",
    ]);
  });
  it("keeps successful changes when the middle change fails and retries only the named failure", async () => {
    const draft: ShareDraft = {
      ...base,
      rows: [
        { ...base.rows[0]!, role: "driver" },
        {
          kind: "person",
          id: "bob",
          name: "Bob",
          role: "viewer",
          canApprove: false,
        },
      ],
    };
    const run = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("Permission changed"))
      .mockResolvedValueOnce({});
    const result = await applyShareDraftChanges(base, draft, run, String);
    expect(run).toHaveBeenCalledTimes(3);
    expect(result.failures).toEqual([
      "Engineering (Group): Error: Permission changed",
    ]);
    expect(result.saved.rows.find((row) => row.id === "alice")?.role).toBe(
      "driver",
    );
    expect(result.saved.rows.some((row) => row.id === "bob")).toBe(true);
    expect(
      shareDraftChanges(result.saved, draft).map((change) => change.key),
    ).toEqual(["group:engineering"]);
    const retry = vi.fn().mockResolvedValue({});
    const retried = await applyShareDraftChanges(
      result.saved,
      draft,
      retry,
      String,
    );
    expect(retry).toHaveBeenCalledTimes(1);
    expect(shareDraftDirty(retried.saved, draft)).toBe(false);
  });
  it.each(["person", "group"] as const)(
    "retains uncertainty for applied but lost %s grants and revocations through undo and retry",
    async (kind) => {
      const row = base.rows.find((row) => row.kind === kind)!;
      const original: ShareDraft = {
        access: "organization",
        rows: [{ ...row, role: "viewer" }],
      };
      for (const remove of [false, true]) {
        const intended: ShareDraft = {
          ...original,
          rows: remove ? [] : [{ ...row, role: "driver" }],
        };
        let actual = original;
        const result = await applyShareDraftChanges(
          original,
          intended,
          async () => {
            actual = intended;
            throw { code: "cloud_workspace_request_outcome_unknown" };
          },
          String,
        );
        expect(shareDraftDirty(result.saved, original)).toBe(true);
        const reconciled = reconcileShareDraft(result.saved, original, actual);
        expect(shareDraftDirty(reconciled.saved, reconciled.draft)).toBe(true);
        const retried = await applyShareDraftChanges(
          reconciled.saved,
          reconciled.draft,
          async () => {},
          String,
        );
        expect(shareDraftDirty(retried.saved, reconciled.draft)).toBe(false);
      }
    },
  );
});
