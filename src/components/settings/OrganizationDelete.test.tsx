import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizationDelete } from "./OrganizationDelete";
import type { OrganizationSummary } from "@/lib/api";

const consoleOpen = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/api", () => ({ api: { organizationConsoleOpen: consoleOpen } }));

const organization: OrganizationSummary = { id: "org-test", name: "Test organization", role: "owner", isPersonal: false };
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const typeName = (name = organization.name) => fireEvent.change(screen.getByLabelText("Organization name to delete"), { target: { value: name } });
const open = () => fireEvent.click(screen.getByRole("button", { name: "Delete organization…" }));
const confirm = () => screen.getByRole("button", { name: `Delete ${organization.name} permanently` }) as HTMLButtonElement;
afterEach(cleanup);

describe("OrganizationDelete", () => {
  it.each(["admin", "member", "unknown"])("offers no deletion to %s", (role) => {
    const remove = vi.fn();
    render(<OrganizationDelete organization={{ ...organization, role }} contextRevision="r1" remove={remove} onDeleted={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });

  it("requires the exact named test organization and sends its captured organization/context only once", async () => {
    const sent = deferred();
    const remove = vi.fn(() => sent.promise);
    const onDeleted = vi.fn();
    render(<OrganizationDelete organization={organization} contextRevision="r1" remove={remove} onDeleted={onDeleted} />);
    open();
    expect(confirm().disabled).toBe(true);
    typeName("test organization");
    expect(confirm().disabled).toBe(true);
    typeName();
    fireEvent.click(confirm());
    fireEvent.click(confirm());
    expect(remove).toHaveBeenCalledExactlyOnceWith({ organizationId: "org-test", contextRevision: "r1", confirmationName: "Test organization" });
    expect(onDeleted).not.toHaveBeenCalled();
    await act(async () => sent.resolve());
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it("cancel spends the typed name without sending", () => {
    const remove = vi.fn();
    render(<OrganizationDelete organization={organization} contextRevision="r1" remove={remove} onDeleted={vi.fn()} />);
    open(); typeName();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    open();
    expect(confirm().disabled).toBe(true);
    expect(remove).not.toHaveBeenCalled();
  });

  it("shows backend cleanup guidance, retains the exact name, and never retries a refusal automatically", async () => {
    const remove = vi.fn().mockRejectedValue({ code: "organization_delete_blocked" });
    const onDeleted = vi.fn();
    render(<OrganizationDelete organization={organization} contextRevision="r1" remove={remove} onDeleted={onDeleted} />);
    open(); typeName(); fireEvent.click(confirm());
    expect((await screen.findByRole("alert")).textContent).toContain("Finish cloud cleanup");
    expect(onDeleted).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Organization name to delete") as HTMLInputElement).value).toBe(organization.name);
    expect(remove).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Open Test organization cleanup settings" }));
    await waitFor(() => expect(consoleOpen).toHaveBeenCalledWith("org-test"));
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("invalidates an unsent confirmation when the account context changes", () => {
    const remove = vi.fn(); const onDeleted = vi.fn();
    const view = (revision: string) => <OrganizationDelete organization={organization} contextRevision={revision} remove={remove} onDeleted={onDeleted} />;
    const { rerender } = render(view("r1"));
    open(); typeName(); rerender(view("r2"));
    expect(screen.queryByLabelText("Organization name to delete")).toBeNull();
    open(); expect(confirm().disabled).toBe(true);
    expect(remove).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)("does not let a late %s navigate or display an old error in another organization", async (settle) => {
    const sent = deferred(); const remove = vi.fn(() => sent.promise); const onDeleted = vi.fn();
    const view = (org: OrganizationSummary) => <OrganizationDelete organization={org} contextRevision="r1" remove={remove} onDeleted={onDeleted} />;
    const { rerender } = render(view(organization));
    open(); typeName(); fireEvent.click(confirm());
    rerender(view({ ...organization, id: "org-b", name: "Beta" }));
    await act(async () => { if (settle === "resolve") sent.resolve(); else sent.reject(new Error("Old failure")); });
    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    open();
    expect(screen.getByText("Type Beta to confirm deletion")).toBeTruthy();
  });

  it("revoking the owner role removes the confirmation", () => {
    const remove = vi.fn(); const onDeleted = vi.fn();
    const view = (role: string) => <OrganizationDelete organization={{ ...organization, role }} contextRevision="r1" remove={remove} onDeleted={onDeleted} />;
    const { rerender } = render(view("owner")); open(); typeName(); rerender(view("admin"));
    expect(screen.queryByLabelText("Organization name to delete")).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });

  it("renders the eligibility restriction instead of a destructive button", async () => {
    render(<OrganizationDelete organization={{ ...organization, isPersonal: true }} contextRevision="r1" unavailableReason="Personal organizations cannot be deleted." remove={vi.fn()} onDeleted={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Personal organizations cannot be deleted.")).toBeTruthy());
    expect(screen.queryByRole("button")).toBeNull();
  });
});
