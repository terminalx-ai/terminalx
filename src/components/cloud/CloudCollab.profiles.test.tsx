import { refreshRosterFlags } from "@/test/rosterFlags";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ listIn: vi.fn(), list: vi.fn().mockResolvedValue({ members: [] }) }));
vi.mock("@/lib/organizationMembers", () => ({ organizationMembers: mocks }));
vi.mock("@/lib/cloudCollab", async (original) => ({
  ...(await original<typeof import("@/lib/cloudCollab")>()),
  useCollab: () => ({ available: true, participants: [{ userId: "alice", role: "driver", canApprove: false, activity: "typing", surfaces: 1, tabId: "tab" }] }),
}));
vi.mock("@/lib/account", async () => (await import("@/test/rosterFlags")).rosterFlagAccountMock);
beforeEach(() => refreshRosterFlags());
import { ParticipantsBar, PresenceAvatars } from "./CloudCollab";
import { resetPeople } from "@/lib/cloudPeople";
afterEach(() => { cleanup(); resetPeople(); });
it.each([ParticipantsBar, PresenceAvatars])("opens an organization profile from presence (%#)", async (Component) => {
  mocks.listIn.mockResolvedValue({ members: [{ userId: "alice", displayName: "Alice", email: "alice@example.com", role: "admin", createdAt: 1234 }], contextRevision: "" });
  render(<Component collabKey="cloud:org-b:workspace" you={null} tabLabel={() => "Editor"} />);
  fireEvent.click(await screen.findByRole("button", { name: "View profile: Alice" }));
  const profile = await screen.findByRole("dialog", { name: "Profile of Alice" });
  expect(within(profile).getByText("alice@example.com")).toBeTruthy();
  expect(within(profile).getByText("Admin")).toBeTruthy();
  expect(within(profile).getByLabelText("Online")).toBeTruthy();
  expect(mocks.listIn).toHaveBeenCalledWith("org-b");
});

it.each([ParticipantsBar, PresenceAvatars])("returns to initials when an open presence profile is killed (%#)", async (Component) => {
  mocks.listIn.mockResolvedValue({ members: [{ userId: "alice", displayName: "Alice", email: "alice@example.com", role: "member" }], contextRevision: "" });
  render(<Component collabKey="cloud:org-b:workspace" you={null} tabLabel={() => "Editor"} />);
  fireEvent.click(await screen.findByRole("button", { name: "View profile: Alice" }));
  await screen.findByRole("dialog");
  act(() => refreshRosterFlags([]));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("button", { name: /View profile/ })).toBeNull();
});

it("uses the workspace organization's flag, even when the active organization has profiles", async () => {
  refreshRosterFlags(["org-1"]);
  mocks.listIn.mockClear();
  render(<ParticipantsBar collabKey="cloud:org-b:workspace" you={null} tabLabel={() => "Editor"} />);
  expect(screen.queryByRole("button", { name: /View profile/ })).toBeNull();
  expect(mocks.listIn).not.toHaveBeenCalled();
});
