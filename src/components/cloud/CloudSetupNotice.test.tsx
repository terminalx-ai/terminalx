import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CloudSetupNotice } from "./CloudSetupNotice";
const account = vi.hoisted(() => ({ status: { state: "signed-in", identity: { email: "new-member@example.com" }, organizations: [{ id: "org", role: "member", cloudComputerReady: true as boolean | undefined }] } }));
vi.mock("@/lib/account", () => ({ useAccount: () => account }));
vi.mock("@/lib/cloudCatalog", () => ({ defaultOrgId: () => "org" }));
afterEach(cleanup);
it("a fresh member with no visible workspaces sees a ready organization whose only workspace is admin-private", () => {
  localStorage.clear(); account.status.organizations[0].cloudComputerReady = true;
  render(<CloudSetupNotice />); expect(screen.queryByRole("status")).toBeNull();
});
it("shows the server's unfinished readiness to members", () => {
  account.status.organizations[0].cloudComputerReady = false;
  render(<CloudSetupNotice />); expect(screen.getByText("Computer isn't ready yet")).toBeTruthy(); expect(screen.getByText("View computer")).toBeTruthy();
});
it("does not guess readiness when an older server supplies no answer", () => {
  account.status.organizations[0].cloudComputerReady = undefined;
  render(<CloudSetupNotice members />); expect(screen.queryByRole("status")).toBeNull();
});
