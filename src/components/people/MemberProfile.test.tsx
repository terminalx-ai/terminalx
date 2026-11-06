import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { MemberProfile } from "./MemberProfile";
const member = { userId: "alice", displayName: "Alice Example", email: "alice@example.com", role: "admin", photoUrl: "https://example.com/alice.png", createdAt: new Date(2025, 1, 3).getTime() };
afterEach(cleanup);
it("opens a profile with a photo, organization role, join date and presence", async () => {
  render(<MemberProfile member={member} online className="size-7" />);
  fireEvent.click(screen.getByRole("button", { name: "View profile: Alice Example" }));
  const profile = await screen.findByRole("dialog", { name: "Profile of Alice Example" });
  expect(within(profile).getByText("alice@example.com")).toBeTruthy();
  expect(within(profile).getByText("Admin")).toBeTruthy();
  expect(within(profile).getByText(`Joined ${new Date(member.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}`)).toBeTruthy();
  expect(within(profile).getByLabelText("Online")).toBeTruthy();
  expect(within(profile).getByRole("img", { name: "Alice Example" }).getAttribute("src")).toBe(member.photoUrl);
  fireEvent.keyDown(profile, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button")));
});
it("falls back to initials for missing and broken photos and unknown dates", async () => {
  render(<MemberProfile member={{ ...member, createdAt: undefined }} />);
  fireEvent.error(screen.getByRole("img"));
  expect(screen.getByRole("button").textContent).toBe("AE");
  fireEvent.click(screen.getByRole("button"));
  const profile = await screen.findByRole("dialog");
  expect(within(profile).getByText("Join date unavailable")).toBeTruthy();
  expect(within(profile).getByLabelText("Presence unavailable")).toBeTruthy();
});
