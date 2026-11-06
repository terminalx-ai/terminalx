import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ listIn: vi.fn() }));
vi.mock("@/lib/organizationMembers", () => ({ organizationMembers: { listIn: mocks.listIn } }));
vi.mock("@/lib/cloudCollab", async (original) => ({
  ...(await original<typeof import("@/lib/cloudCollab")>()),
  useCollab: () => ({ available: true, participants: [{ userId: "alice", role: "driver", canApprove: false, activity: "typing", surfaces: 1, tabId: "tab" }] }),
}));
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
