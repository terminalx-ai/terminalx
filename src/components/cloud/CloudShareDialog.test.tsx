import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceShare, CloudWorkspaceShares } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  shares: vi.fn(),
  put: vi.fn(),
  revoke: vi.fn(),
  groups: vi.fn(),
  groupSet: vi.fn(),
  members: vi.fn(),
  membersIn: vi.fn(),
  access: vi.fn(),
  workspaces: vi.fn(),
}));
const account = vi.hoisted(() => ({
  status: {
    identity: { organizationId: "org-1", email: "me@example.com" },
    organizations: [{ id: "org-1", role: "owner" }],
  },
}));
vi.mock("@/lib/api", () => ({
  api: {
    cloudWorkspaceShares: mocks.shares,
    cloudWorkspaceSharePut: mocks.put,
    cloudWorkspaceShareRevoke: mocks.revoke,
    cloudOrganizationGroups: mocks.groups,
    cloudWorkspaceGroupShareSet: mocks.groupSet,
    cloudWorkspaceSetAccess: mocks.access,
    cloudWorkspaces: mocks.workspaces,
  },
}));
vi.mock("@/lib/account", () => ({ useAccount: () => account }));
vi.mock("@/lib/organizationMembers", () => ({
  organizationMembers: { list: mocks.members, listIn: mocks.membersIn },
}));
import {
  CloudShareDialog,
  CloudShareDialogHost,
  openShareDialog,
  shareErrorMessage,
  yourAccessText,
} from "./CloudShareDialog";
import { resetPeople } from "@/lib/cloudPeople";

const person: CloudWorkspaceShare = {
  userId: "alice",
  email: "alice@example.com",
  name: "Alice",
  role: "viewer",
  canApprove: false,
  createdBy: "me",
  createdAt: 1,
  updatedAt: 1,
};
let listed: CloudWorkspaceShares;
beforeEach(() => {
  vi.resetAllMocks();
  account.status.identity = {
    organizationId: "org-1",
    email: "me@example.com",
  };
  listed = {
    shares: [person],
    groups: [],
    you: { role: "manager", canApprove: true, canManageShares: true },
  };
  mocks.shares.mockImplementation(async () => listed);
  mocks.groups.mockResolvedValue({
    groups: [{ id: "engineering", name: "Engineering", memberCount: 3 }],
  });
  mocks.members.mockResolvedValue({
    members: [
      {
        userId: "me",
        email: "me@example.com",
        displayName: "Me",
        role: "owner",
      },
      {
        userId: "alice",
        email: "alice@example.com",
        displayName: "Alice",
        role: "member",
      },
      {
        userId: "bob",
        email: "bob@example.com",
        displayName: "Bob",
        role: "member",
      },
    ],
  });
  mocks.membersIn.mockImplementation(async (org: string) =>
    org === "org-1"
      ? mocks.members()
      : {
          members: [
            {
              userId: "dana",
              email: "dana@example.com",
              displayName: "Dana",
              role: "member",
            },
          ],
        },
  );
  mocks.put.mockResolvedValue({ share: person });
  mocks.revoke.mockResolvedValue({ share: person });
  mocks.groupSet.mockResolvedValue({ groupId: "engineering" });
  mocks.access.mockImplementation(async (_id: string, accessMode: string) => ({
    accessMode,
  }));
  mocks.workspaces.mockResolvedValue({
    workspaces: [{ workspace: { id: "ws", accessMode: "organization" } }],
  });
});
afterEach(() => {
  cleanup();
  resetPeople();
  openShareDialog(null);
});
const show = (
  props: Partial<React.ComponentProps<typeof CloudShareDialog>> = {},
) =>
  render(
    <CloudShareDialog
      orgId="org-1"
      workspaceId="ws"
      name="Payments"
      createdBy="me"
      onClose={vi.fn()}
      {...props}
    />,
  );
const save = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByText("Saving…")).toBeNull());
};
const add = async (key: string) => {
  await waitFor(() =>
    expect(
      Array.from(
        (screen.getByLabelText("Add person or group") as HTMLSelectElement)
          .options,
      ).some((option) => option.value === key),
    ).toBe(true),
  );
  fireEvent.change(screen.getByLabelText("Add person or group"), {
    target: { value: key },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
};

describe("draft sharing", () => {
  it("stages role, approval and removal with no network mutations until Save", async () => {
    show();
    await screen.findByText("Alice");
    fireEvent.change(screen.getByLabelText("Role for Alice"), {
      target: { value: "driver" },
    });
    fireEvent.click(screen.getByLabelText("Can approve permissions: Alice"));
    expect(mocks.put).not.toHaveBeenCalled();
    await save();
    expect(mocks.put).toHaveBeenCalledWith(
      "ws",
      "alice",
      "driver",
      true,
      "org-1",
    );
    fireEvent.click(screen.getByLabelText("Revoke Alice"));
    expect(mocks.revoke).not.toHaveBeenCalled();
    await save();
    expect(mocks.revoke).toHaveBeenCalledWith("ws", "alice", "org-1");
  });
  it("labels group rows and saves a group grant separately from a direct share", async () => {
    show();
    await screen.findByRole("option", {
      name: "Engineering (Group · 3 members)",
    });
    await add("group:engineering");
    expect(screen.getByText("Group · 3 members")).toBeTruthy();
    expect(mocks.groupSet).not.toHaveBeenCalled();
    await save();
    expect(mocks.groupSet).toHaveBeenCalledWith(
      "ws",
      "engineering",
      "viewer",
      false,
      "org-1",
    );
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it("names a failed middle change while retaining both successful changes and retries only that failure", async () => {
    listed.groups = [
      {
        groupId: "engineering",
        name: "Engineering",
        role: "viewer",
        canApprove: false,
        memberCount: 3,
      },
    ];
    mocks.groupSet
      .mockRejectedValueOnce({ code: "cloud_workspace_share_forbidden" })
      .mockResolvedValueOnce({});
    show();
    await screen.findByText("Alice");
    fireEvent.change(screen.getByLabelText("Role for Alice"), {
      target: { value: "driver" },
    });
    fireEvent.click(screen.getByLabelText("Revoke Engineering"));
    await add("person:bob");
    await save();
    expect(mocks.put).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert").textContent).toContain(
      "Engineering (Group):",
    );
    await save();
    expect(mocks.put).toHaveBeenCalledTimes(2);
    expect(mocks.groupSet).toHaveBeenCalledTimes(2);
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
  it.each(["Close", "Cancel"])(
    "guards %s, allows keeping edits and discards only on confirmation",
    async (button) => {
      const onClose = vi.fn();
      show({ onClose });
      await screen.findByText("Alice");
      fireEvent.click(screen.getByLabelText("Revoke Alice"));
      fireEvent.click(screen.getByRole("button", { name: button }));
      expect(onClose).not.toHaveBeenCalled();
      expect(
        screen.getByRole("alertdialog", { name: "Discard access changes?" }),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
      expect(screen.queryByRole("alertdialog")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: button }));
      fireEvent.click(screen.getByRole("button", { name: "Discard" }));
      expect(onClose).toHaveBeenCalledOnce();
      expect(mocks.revoke).not.toHaveBeenCalled();
    },
  );
  it("guards Escape when dirty and closes a clean dialog directly", async () => {
    const onClose = vi.fn();
    show({ onClose });
    await screen.findByText("Alice");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByLabelText("Revoke Alice"));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("alertdialog", { name: "Discard access changes?" }),
    ).toBeTruthy();
  });
  it("does not lose a pending save on close or apply the same batch twice", async () => {
    let finish!: () => void;
    mocks.put.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const onClose = vi.fn();
    show({ onClose });
    await screen.findByText("Alice");
    fireEvent.change(screen.getByLabelText("Role for Alice"), {
      target: { value: "driver" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.put).toHaveBeenCalledOnce();
    await act(async () => finish());
  });
  it("stages private-to-shared visibility after confirmation and applies it before the group", async () => {
    listed.shares = [];
    show({ accessMode: "private" });
    await screen.findByRole("option", {
      name: "Engineering (Group · 3 members)",
    });
    await add("group:engineering");
    expect(mocks.access).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Make visible and share" }),
    );
    expect(mocks.access).not.toHaveBeenCalled();
    await save();
    expect(mocks.access).toHaveBeenCalledWith("ws", "organization", "org-1");
    expect(mocks.access.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.groupSet.mock.invocationCallOrder[0]!,
    );
  });
  it("does not apply grants when visibility is refused, and names the failed step", async () => {
    listed.shares = [];
    mocks.access.mockRejectedValue({ code: "organization_admin_required" });
    show({ accessMode: "private" });
    await screen.findByRole("option", {
      name: "Engineering (Group · 3 members)",
    });
    await add("group:engineering");
    fireEvent.click(
      screen.getByRole("button", { name: "Make visible and share" }),
    );
    await save();
    expect(mocks.groupSet).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain(
      "Workspace visibility:",
    );
  });
  it("keeps a successful visibility change when sharing fails, without repeating visibility on retry", async () => {
    listed.shares = [];
    mocks.groupSet
      .mockRejectedValueOnce({ code: "cloud_workspace_share_forbidden" })
      .mockResolvedValueOnce({});
    show({ accessMode: "private" });
    await screen.findByRole("option", {
      name: "Engineering (Group · 3 members)",
    });
    await add("group:engineering");
    fireEvent.click(
      screen.getByRole("button", { name: "Make visible and share" }),
    );
    await save();
    await save();
    expect(mocks.access).toHaveBeenCalledOnce();
    expect(mocks.groupSet).toHaveBeenCalledTimes(2);
  });
  it("reconciles unknown visibility before granting and blocks saving when it remains unknown", async () => {
    listed.shares = [];
    mocks.access.mockRejectedValue({
      code: "cloud_workspace_request_outcome_unknown",
    });
    mocks.workspaces.mockRejectedValueOnce(new Error("offline"));
    show({ accessMode: "private" });
    await screen.findByRole("option", {
      name: "Engineering (Group · 3 members)",
    });
    await add("group:engineering");
    fireEvent.click(
      screen.getByRole("button", { name: "Make visible and share" }),
    );
    await save();
    expect(mocks.groupSet).not.toHaveBeenCalled();
    expect(screen.getByTestId("cloud-share-access-unknown")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() =>
      expect(screen.queryByTestId("cloud-share-access-unknown")).toBeNull(),
    );
    await save();
    expect(mocks.access).toHaveBeenCalledOnce();
    expect(mocks.groupSet).toHaveBeenCalledOnce();
  });
  it("makes private only after confirmation and Save, clearing direct and group drafts together", async () => {
    listed.groups = [
      {
        groupId: "engineering",
        name: "Engineering",
        memberCount: 3,
        role: "viewer",
        canApprove: false,
      },
    ];
    const onClose = vi.fn();
    show({ createdBy: "alice", onClose });
    await screen.findByText("Alice");
    fireEvent.click(screen.getByRole("button", { name: "Make private again" }));
    expect(screen.getByTestId("cloud-private-confirm").textContent).toContain(
      "You did not create it",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Revoke all and make private" }),
    );
    expect(mocks.access).not.toHaveBeenCalled();
    await save();
    expect(mocks.access).toHaveBeenCalledWith("ws", "private", "org-1");
    expect(onClose).toHaveBeenCalledOnce();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
  it("retains a read-only view and limits visibility changes to organization managers", async () => {
    listed.you = { role: "viewer", canApprove: false, canManageShares: false };
    show();
    await screen.findByText("Alice");
    expect(
      screen.getByRole("heading", { name: "Who has access" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByLabelText("Revoke Alice")).toBeNull();
  });
  it("loads the specified organization's roster and fences a late response after switching organizations", async () => {
    let finish!: (value: CloudWorkspaceShares) => void;
    mocks.shares.mockImplementationOnce(
      () =>
        new Promise<CloudWorkspaceShares>((resolve) => {
          finish = resolve;
        }),
    );
    const view = show();
    view.rerender(
      <CloudShareDialog
        orgId="org-2"
        workspaceId="other"
        name="Other"
        onClose={vi.fn()}
      />,
    );
    await screen.findByRole("option", { name: "Dana" });
    expect(mocks.membersIn).toHaveBeenCalledWith("org-2");
    await act(async () =>
      finish({ ...listed, shares: [{ ...person, name: "Stale Alice" }] }),
    );
    expect(screen.queryByText("Stale Alice")).toBeNull();
  });
  it("refreshes members on reopen and never offers admins or the creator", async () => {
    const view = show({ createdBy: "bob" });
    await screen.findByText("Alice");
    expect(
      within(screen.getByLabelText("Add person or group")).queryByText("Me"),
    ).toBeNull();
    expect(
      within(screen.getByLabelText("Add person or group")).queryByText("Bob"),
    ).toBeNull();
    view.unmount();
    show();
    await screen.findByRole("option", { name: "Bob" });
    expect(mocks.members).toHaveBeenCalledTimes(2);
  });
  it.each(["person", "group"] as const)(
    "reconciles applied but lost %s PUT and DELETE, preserving undo and guarding close",
    async (kind) => {
      const name = kind === "person" ? "Alice" : "Engineering";
      const key = kind === "person" ? "person:alice" : "group:engineering";
      if (kind === "group")
        listed.groups = [
          {
            groupId: "engineering",
            name,
            memberCount: 3,
            role: "viewer",
            canApprove: false,
          },
        ];
      const mutation = kind === "person" ? mocks.put : mocks.groupSet;
      mutation.mockImplementationOnce(async () => {
        listed =
          kind === "person"
            ? { ...listed, shares: [{ ...person, role: "driver" }] }
            : {
                ...listed,
                groups: [{ ...listed.groups![0]!, role: "driver" }],
              };
        throw { code: "cloud_workspace_request_outcome_unknown" };
      });
      const onClose = vi.fn();
      show({ onClose });
      await screen.findByLabelText(`Role for ${name}`);
      fireEvent.change(screen.getByLabelText(`Role for ${name}`), {
        target: { value: "driver" },
      });
      await save();
      fireEvent.change(screen.getByLabelText(`Role for ${name}`), {
        target: { value: "viewer" },
      });
      expect(
        (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
      await save();
      expect(mutation).toHaveBeenCalledTimes(2);
      const revoke = kind === "person" ? mocks.revoke : mocks.groupSet;
      revoke.mockImplementationOnce(async () => {
        listed =
          kind === "person"
            ? { ...listed, shares: [] }
            : { ...listed, groups: [] };
        throw { code: "cloud_workspace_request_outcome_unknown" };
      });
      fireEvent.click(screen.getByLabelText(`Revoke ${name}`));
      await save();
      expect(
        (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      await add(key);
      expect(
        (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
      await save();
      expect(mutation.mock.calls.at(-1)?.[2]).toBe("viewer");
    },
  );
  it.each([
    ["person", false],
    ["person", true],
    ["group", false],
    ["group", true],
  ] as const)(
    "keeps uncertain %s changes (remove=%s) unresolved when refresh fails, even after undo",
    async (kind, remove) => {
      const name = kind === "person" ? "Alice" : "Engineering";
      if (kind === "group")
        listed.groups = [
          {
            groupId: "engineering",
            name,
            memberCount: 3,
            role: "viewer",
            canApprove: false,
          },
        ];
      const mutation =
        kind === "person"
          ? remove
            ? mocks.revoke
            : mocks.put
          : mocks.groupSet;
      mutation.mockImplementationOnce(async () => {
        listed =
          kind === "person"
            ? {
                ...listed,
                shares: remove ? [] : [{ ...person, role: "driver" }],
              }
            : {
                ...listed,
                groups: remove
                  ? []
                  : [{ ...listed.groups![0]!, role: "driver" }],
              };
        mocks.shares.mockRejectedValueOnce(new Error("offline"));
        throw { code: "cloud_workspace_request_outcome_unknown" };
      });
      const onClose = vi.fn();
      show({ onClose });
      await screen.findByLabelText(`Role for ${name}`);
      if (remove) fireEvent.click(screen.getByLabelText(`Revoke ${name}`));
      else
        fireEvent.change(screen.getByLabelText(`Role for ${name}`), {
          target: { value: "driver" },
        });
      await save();
      if (remove)
        await add(kind === "person" ? "person:alice" : "group:engineering");
      else
        fireEvent.change(screen.getByLabelText(`Role for ${name}`), {
          target: { value: "viewer" },
        });
      expect(screen.getByTestId("cloud-share-rows-unknown")).toBeTruthy();
      expect(
        (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
      fireEvent.click(screen.getByRole("button", { name: "Check access" }));
      await waitFor(() =>
        expect(screen.queryByTestId("cloud-share-rows-unknown")).toBeNull(),
      );
      expect(
        (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
      await save();
      if (remove && kind === "person") {
        expect(mocks.revoke).toHaveBeenCalledOnce();
        expect(mocks.put).toHaveBeenCalledWith(
          "ws",
          "alice",
          "viewer",
          false,
          "org-1",
        );
      } else expect(mutation).toHaveBeenCalledTimes(2);
    },
  );
  it("refreshes departed people after a failure and preserves successful and unrelated failed edits", async () => {
    mocks.put.mockImplementation(
      async (_ws: string, id: string, role: "viewer" | "driver") => {
        if (id === "alice") {
          listed = { ...listed, shares: [] };
          mocks.members.mockResolvedValue({
            members: [
              {
                userId: "bob",
                email: "bob@example.com",
                displayName: "Bob",
                role: "member",
              },
            ],
          });
          throw { code: "organization_member_not_found" };
        }
        listed = {
          ...listed,
          shares: [
            ...listed.shares,
            { ...person, userId: id, name: "Bob", role },
          ],
        };
        return {};
      },
    );
    mocks.groupSet.mockRejectedValue({
      code: "cloud_workspace_share_forbidden",
    });
    show();
    await screen.findByText("Alice");
    fireEvent.change(screen.getByLabelText("Role for Alice"), {
      target: { value: "driver" },
    });
    await add("person:bob");
    await add("group:engineering");
    await save();
    expect(screen.queryByLabelText("Role for Alice")).toBeNull();
    expect(
      within(screen.getByLabelText("Add person or group")).queryByText("Alice"),
    ).toBeNull();
    expect(screen.getByLabelText("Role for Bob")).toBeTruthy();
    expect(screen.getByLabelText("Role for Engineering")).toBeTruthy();
    await save();
    expect(mocks.put).toHaveBeenCalledTimes(2);
    expect(mocks.groupSet).toHaveBeenCalledTimes(2);
    expect(mocks.members).toHaveBeenCalledTimes(2);
  });
  it("does not let an older roster response resurrect a departed member (#501)", async () => {
    let finish!: (value: {
      members: {
        userId: string;
        email: string;
        displayName: string;
        role: string;
      }[];
    }) => void;
    mocks.members.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mocks.put.mockImplementationOnce(async () => {
      listed = { ...listed, shares: [] };
      mocks.members.mockResolvedValue({ members: [] });
      throw { code: "organization_member_not_found" };
    });
    show();
    await screen.findByText("Alice");
    fireEvent.change(screen.getByLabelText("Role for Alice"), {
      target: { value: "driver" },
    });
    await save();
    await act(async () =>
      finish({
        members: [
          {
            userId: "alice",
            email: person.email,
            displayName: "Alice",
            role: "member",
          },
        ],
      }),
    );
    expect(screen.queryByLabelText("Role for Alice")).toBeNull();
    expect(
      within(screen.getByLabelText("Add person or group")).queryByText("Alice"),
    ).toBeNull();
  });
  it("settles removal of an already deleted group after verifying its absence", async () => {
    listed.groups = [
      {
        groupId: "engineering",
        name: "Engineering",
        memberCount: 3,
        role: "viewer",
        canApprove: false,
      },
    ];
    mocks.groupSet.mockImplementationOnce(async () => {
      listed = { ...listed, groups: [] };
      mocks.groups.mockResolvedValue({ groups: [] });
      throw { code: "organization_group_not_found" };
    });
    show();
    await screen.findByText("Engineering");
    fireEvent.click(screen.getByLabelText("Revoke Engineering"));
    await save();
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      within(screen.getByLabelText("Add person or group")).queryByText(
        /Engineering/,
      ),
    ).toBeNull();
    expect(mocks.groupSet).toHaveBeenCalledOnce();
  });
  it("does not refresh an old workspace after an uncertain save completes in a new context", async () => {
    let fail!: (error: unknown) => void;
    mocks.put.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const view = show();
    await screen.findByText("Alice");
    fireEvent.change(screen.getByLabelText("Role for Alice"), {
      target: { value: "driver" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    listed = { ...listed, shares: [] };
    view.rerender(
      <CloudShareDialog
        orgId="org-2"
        workspaceId="other"
        name="Other"
        onClose={vi.fn()}
      />,
    );
    await screen.findByRole("option", { name: "Dana" });
    await act(async () =>
      fail({ code: "cloud_workspace_request_outcome_unknown" }),
    );
    expect(mocks.shares).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("cloud-share-rows-unknown")).toBeNull();
  });
  it("opens through the shared host", async () => {
    render(<CloudShareDialogHost />);
    act(() =>
      openShareDialog({ orgId: "org-1", workspaceId: "ws", name: "Payments" }),
    );
    await screen.findByText("Alice");
  });
  it("preserves the existing role and credential explanations", () => {
    expect(
      yourAccessText(
        { role: "manager", canApprove: true, canManageShares: true },
        "owner",
      ),
    ).toContain("Owner");
    expect(
      yourAccessText(
        { role: "driver", canApprove: false, canManageShares: false },
        "member",
      ),
    ).toContain("typing in terminals also needs");
    expect(
      shareErrorMessage({
        code: "cloud_workspace_share_credential_restricted",
      }),
    ).toContain("agent login");
    expect(
      shareErrorMessage({ code: "cloud_workspace_share_personal_route" }),
    ).toContain("creator's own model credential");
  });
});
