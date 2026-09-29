import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceShare, CloudWorkspaceShares } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  shares: vi.fn(),
  put: vi.fn(),
  revoke: vi.fn(),
  members: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  api: { cloudWorkspaceShares: mocks.shares, cloudWorkspaceSharePut: mocks.put, cloudWorkspaceShareRevoke: mocks.revoke },
}));
vi.mock("@/lib/organizationMembers", () => ({ organizationMembers: { list: mocks.members } }));

import { CloudShareDialog, shareErrorMessage } from "./CloudShareDialog";
import { personName, resetPeople } from "@/lib/cloudPeople";

const share = (fields: Partial<CloudWorkspaceShare> = {}): CloudWorkspaceShare => ({
  userId: "u-alice",
  email: "alice@example.com",
  name: "Alice",
  role: "viewer",
  canApprove: false,
  createdBy: "u-me",
  createdAt: 1,
  updatedAt: 1,
  ...fields,
});

let listed: CloudWorkspaceShares;

beforeEach(() => {
  listed = { shares: [share()], you: { role: "manager", canApprove: true, canManageShares: true } };
  mocks.shares.mockReset().mockImplementation(async () => listed);
  mocks.put.mockReset().mockImplementation(async (_ws: string, userId: string, role: string, canApprove: boolean) => {
    const next = share({ userId, role: role as CloudWorkspaceShare["role"], canApprove, name: userId === "u-bob" ? "Bob" : "Alice", email: `${userId}@example.com` });
    listed = { ...listed, shares: [...listed.shares.filter((s) => s.userId !== userId), next] };
    return { share: next, created: true };
  });
  mocks.revoke.mockReset().mockImplementation(async (_ws: string, userId: string) => {
    const gone = listed.shares.find((s) => s.userId === userId)!;
    listed = { ...listed, shares: listed.shares.filter((s) => s.userId !== userId) };
    return { share: gone };
  });
  mocks.members.mockReset().mockResolvedValue({
    members: [
      { userId: "u-me", email: "me@example.com", displayName: "Me", role: "owner" },
      { userId: "u-alice", email: "alice@example.com", displayName: "Alice", role: "member" },
      { userId: "u-bob", email: "bob@example.com", displayName: "Bob", role: "member" },
      { userId: "u-admin", email: "carol@example.com", displayName: "Carol", role: "admin" },
    ],
    pendingInvites: [],
    viewerRole: "owner",
    canManageMembers: true,
    contextRevision: "r1",
  });
});

afterEach(() => {
  cleanup();
  resetPeople();
});

const dialog = () => render(<CloudShareDialog workspaceId="ws-1" name="Payments" onClose={() => undefined} />);

describe("share dialog", () => {
  it("adds someone from the roster who is not shared yet", async () => {
    dialog();
    await screen.findByTestId("cloud-share-row");
    const picker = screen.getByLabelText("Add person") as HTMLSelectElement;
    await waitFor(() => expect(within(picker).queryByText(/Bob/)).toBeTruthy());
    // Already shared people are not offered again.
    expect(within(picker).queryByText(/Alice/)).toBeNull();
    fireEvent.change(picker, { target: { value: "u-bob" } });
    fireEvent.change(screen.getByLabelText("New person's role"), { target: { value: "driver" } });
    fireEvent.click(screen.getByRole("switch", { name: "New person can approve permissions" }));
    fireEvent.click(screen.getByRole("button", { name: /Share/ }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith("ws-1", "u-bob", "driver", true));
    await waitFor(() => expect(screen.getAllByTestId("cloud-share-row")).toHaveLength(2));
    // Their name is known wherever the workspace shows them now.
    expect(personName("u-bob")).toBe("Bob");
  });

  it("changes a share's role and approval, and revokes it", async () => {
    dialog();
    const row = await screen.findByTestId("cloud-share-row");
    fireEvent.change(within(row).getByLabelText("Role for Alice"), { target: { value: "driver" } });
    await waitFor(() => expect(mocks.put).toHaveBeenLastCalledWith("ws-1", "u-alice", "driver", false));
    fireEvent.click(within(await screen.findByTestId("cloud-share-row")).getByRole("switch", { name: "Can approve permissions: Alice" }));
    await waitFor(() => expect(mocks.put).toHaveBeenLastCalledWith("ws-1", "u-alice", "driver", true));
    fireEvent.click(within(await screen.findByTestId("cloud-share-row")).getByRole("button", { name: "Revoke Alice" }));
    await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith("ws-1", "u-alice"));
    await waitFor(() => expect(screen.queryByTestId("cloud-share-row")).toBeNull());
  });

  it("says in words why a share was refused", async () => {
    mocks.put.mockRejectedValueOnce({ code: "cloud_workspace_share_redundant", status: 409 });
    dialog();
    await screen.findByTestId("cloud-share-row");
    await waitFor(() => expect(within(screen.getByLabelText("Add person")).queryByText(/Carol/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Add person"), { target: { value: "u-admin" } });
    fireEvent.click(screen.getByRole("button", { name: /Share/ }));
    expect((await screen.findByTestId("cloud-share-error")).textContent).toBe("Carol already has access as owner/admin/creator.");

    mocks.put.mockRejectedValueOnce({ code: "cloud_workspace_share_requires_organization_access", status: 409 });
    fireEvent.click(screen.getByRole("button", { name: /Share/ }));
    await waitFor(() => expect(screen.getByTestId("cloud-share-error").textContent).toBe("Make the workspace visible to the organization first."));

    expect(shareErrorMessage({ code: "cloud_workspace_share_limit" })).toMatch(/maximum number of people \(64\)/);
    expect(shareErrorMessage({ code: "cloud_workspace_share_forbidden" })).toBe(
      "Only organization admins and the workspace's creator can change who it is shared with.",
    );
  });

  it("shows a read-only list and their own role to someone who cannot manage shares", async () => {
    listed = { shares: [share({ role: "driver", canApprove: true })], you: { role: "viewer", canApprove: true, canManageShares: false } };
    dialog();
    const row = await screen.findByTestId("cloud-share-row");
    expect(row.textContent).toContain("Driver · can approve");
    expect(screen.getByTestId("cloud-share-you").textContent).toBe("Your access: Viewer (can read everything, not send), can approve permissions.");
    expect(screen.queryByLabelText("Add person")).toBeNull();
    expect(screen.queryByRole("button", { name: /Revoke/ })).toBeNull();
    expect(within(row).queryByRole("combobox")).toBeNull();
  });
});
