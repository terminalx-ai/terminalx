import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudGeneralAccess, type EveryonePolicy } from "./CloudGeneralAccess";

afterEach(cleanup);

describe("General access presentation alternatives awaiting product policy", () => {
  it("cannot propose a grant while the policy is unanswered", () => {
    const changed = vi.fn();
    render(<CloudGeneralAccess orgName="Example" value={null} policy={null} allTabsRequireApproval={null} disabled={false} onChange={changed} />);
    fireEvent.change(screen.getByLabelText("General access"), { target: { value: "everyone" } });
    expect(changed).not.toHaveBeenCalled();
  });

  it.each(["warn", "require-approvals"] as const)("uses only the supplied default for the %s alternative", (write) => {
    const changed = vi.fn();
    const policy: EveryonePolicy = { defaultRole: "viewer", write };
    render(<CloudGeneralAccess orgName="Example" value={null} policy={policy} allTabsRequireApproval={true} disabled={false} onChange={changed} />);
    fireEvent.change(screen.getByLabelText("General access"), { target: { value: "everyone" } });
    expect(changed).toHaveBeenCalledExactlyOnceWith("viewer");
  });

  it.each([false, null])("holds Write when approvals are required and tab approval state is %s", (allTabsRequireApproval) => {
    const changed = vi.fn();
    render(<CloudGeneralAccess orgName="Example" value="viewer" policy={{ defaultRole: "viewer", write: "require-approvals" }} allTabsRequireApproval={allTabsRequireApproval} disabled={false} onChange={changed} />);
    fireEvent.change(screen.getByLabelText("Everyone access level"), { target: { value: "driver" } });
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByText("Write for everyone requires approval on every agent tab.")).toBeTruthy();
  });

  it("shows the exact organization-scoped warning for the warning alternative", () => {
    render(<CloudGeneralAccess orgName="Example" value="driver" policy={{ defaultRole: "viewer", write: "warn" }} allTabsRequireApproval={false} disabled={false} onChange={() => undefined} />);
    expect(screen.getByRole("alert").textContent).toBe("Everyone at Example will be able to run commands through agents here.");
  });
});
