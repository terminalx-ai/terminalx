import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { AccountStatus } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  onStatus: null as ((event: { payload: AccountStatus }) => void) | null,
  enabled: true,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, receive: typeof mocks.onStatus) => {
    if (event === "account_status") mocks.onStatus = receive;
    return () => {};
  },
}));
vi.mock("@/lib/pairing", () => ({
  usePairing: () => ({ status: { relay: { phase: "off" }, host: null, accountListing: { state: "off" } } }),
}));
vi.mock("./MachineNameSettings", () => ({ MachineNameSettings: () => null }));
vi.mock("./WorkStatusSettings", () => ({ WorkStatusSettings: () => null }));
vi.mock("./DataPrivacySettings", () => ({ DataPrivacySettings: () => null }));

const { AccountTab } = await import("./AccountTab");
const { AccountSidebarEntry } = await import("@/components/account/AccountSidebarEntry");
const { bootAccount } = await import("@/lib/account");
const { dismissError, useErrorToasts } = await import("@/lib/errorToasts");

function signedIn(organization: "team" | "personal" | null = "team"): AccountStatus {
  const name = organization === "team" ? "Acme" : "Personal";
  return {
    state: "signed-in",
    identity: { name: "Alex Kim", email: "alex@example.com", organization: organization ? name : null, organizationId: organization },
    context: { account: "account", scope: "scope", revision: "scope:1" },
    organizations: organization ? [{ id: organization, name, role: "owner", isPersonal: organization === "personal" }] : [],
    expiresAt: null,
    lastError: null,
  };
}

let status = signedIn();
const publish = () => act(() => mocks.onStatus!({ payload: status }));

beforeAll(async () => {
  mocks.invoke.mockImplementation(async (command: string) => command === "account_status" ? status : undefined);
  await bootAccount();
});
beforeEach(() => {
  status = signedIn();
  mocks.enabled = true;
  mocks.invoke.mockReset().mockImplementation(async (command: string, args?: { name: string }) => {
    if (command === "phase2_desktop_contracts_available") return mocks.enabled;
    if (command === "account_update_display_name") return { ...status, identity: { ...status.identity, name: args!.name } };
    return undefined;
  });
  publish();
});
afterEach(cleanup);

async function openEditor() {
  fireEvent.click(await screen.findByRole("button", { name: "Edit name" }));
  return screen.getByRole<HTMLInputElement>("textbox", { name: "Display name" });
}

function save() {
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

it("shows the current name in the focused editor and cancels without saving", async () => {
  render(<AccountTab />);
  const input = await openEditor();
  expect(input.value).toBe("Alex Kim");
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "Another Name" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("textbox", { name: "Display name" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit name" }));
  expect(within(screen.getByTestId("account-identity")).getByText("Alex Kim")).toBeTruthy();
  expect(mocks.invoke.mock.calls.some(([command]) => command === "account_update_display_name")).toBe(false);
});

it("explains both validation failures without invoking the native save", async () => {
  render(<AccountTab />);
  const input = await openEditor();
  fireEvent.change(input, { target: { value: "   " } });
  save();
  expect(screen.getByRole("alert").textContent).toBe("Enter a display name.");
  fireEvent.change(input, { target: { value: "😀".repeat(51) } });
  save();
  expect(screen.getByRole("alert").textContent).toBe("Display names must be 100 characters or fewer.");
  expect(mocks.invoke.mock.calls.some(([command]) => command === "account_update_display_name")).toBe(false);
});

it.each(["team", "personal", null] as const)("shows the name immediately and displays the right toast for %s", async (organization) => {
  status = signedIn(organization);
  publish();
  render(<><AccountTab /><AccountSidebarEntry onOpenAccount={() => {}} /></>);
  const input = await openEditor();
  fireEvent.change(input, { target: { value: "  Jordan Lee  " } });
  save();
  const identity = within(screen.getByTestId("account-identity"));
  expect(await identity.findByText("Jordan Lee")).toBeTruthy();
  expect(identity.getByText("Saved")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Jordan Lee" })).toBeTruthy();
  const toast = screen.getByRole("status");
  expect(toast.textContent).toContain("Display name updated");
  if (organization === "team") expect(toast.textContent).toContain("Teammates in Acme now see “Jordan Lee” on shared sessions, mentions and nudges.");
  else expect(toast.textContent).toBe("Display name updated");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss display name notification" }));
  expect(screen.queryByRole("status")).toBeNull();
  expect(identity.getByText("Saved")).toBeTruthy();
  expect(mocks.invoke).toHaveBeenCalledWith("account_update_display_name", { name: "Jordan Lee", contextRevision: "scope:1" });
});

it("keeps the typed name and error so the user can retry", async () => {
  let refused = false;
  mocks.invoke.mockImplementation(async (command: string, args?: { name: string }) => {
    if (command === "phase2_desktop_contracts_available") return true;
    if (command === "account_update_display_name") {
      if (!refused) {
        refused = true;
        throw "Couldn’t save your display name. Try again.";
      }
      return { ...status, identity: { ...status.identity, name: args!.name } };
    }
    return undefined;
  });
  render(<AccountTab />);
  const input = await openEditor();
  fireEvent.change(input, { target: { value: "  Jordan Lee  " } });
  save();
  expect((await screen.findByRole("alert")).textContent).toBe("Couldn’t save your display name. Try again.");
  expect(input.value).toBe("  Jordan Lee  ");
  expect(screen.queryByText("Saved")).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
  save();
  expect(await within(screen.getByTestId("account-identity")).findByText("Jordan Lee")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Display name updated");
});

it("keeps the Edit name control hidden with the default-off gate", async () => {
  mocks.enabled = false;
  render(<AccountTab />);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("phase2_desktop_contracts_available"));
  expect(screen.queryByRole("button", { name: "Edit name" })).toBeNull();
});

it("keeps the draft and disables retry when the server lacks the endpoint", async () => {
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "phase2_desktop_contracts_available") return true;
    if (command === "account_update_display_name") throw "display_name_unsupported";
    return undefined;
  });
  render(<AccountTab />);
  const input = await openEditor();
  fireEvent.change(input, { target: { value: "Jordan Lee" } });
  save();
  expect((await screen.findByRole("alert")).textContent).toBe("This server does not support editing display names yet.");
  expect(input.value).toBe("Jordan Lee");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(true);
});

it("reports a completed save after the account changes without applying it to the new account", async () => {
  let finishSave!: (status: AccountStatus) => void;
  function Notices() {
    return useErrorToasts().map((notice) => (
      <button key={notice.id} onClick={() => dismissError(notice.id)}>{notice.title}</button>
    ));
  }
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "phase2_desktop_contracts_available") return true;
    if (command === "account_update_display_name") {
      return new Promise<AccountStatus>((resolve) => { finishSave = resolve; });
    }
    return undefined;
  });
  const saved = { ...status, identity: { ...status.identity!, name: "Jordan Lee" } };
  render(<><AccountTab /><Notices /></>);
  fireEvent.change(await openEditor(), { target: { value: "Jordan Lee" } });
  save();
  status = {
    ...status,
    identity: { ...status.identity!, name: "Other Account" },
    context: { account: "other-account", scope: "other-scope", revision: "other-scope:2" },
  };
  publish();
  await act(async () => finishSave(saved));
  expect(within(screen.getByTestId("account-identity")).getByText("Other Account")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Your display name was saved for your previous account." }));
});
