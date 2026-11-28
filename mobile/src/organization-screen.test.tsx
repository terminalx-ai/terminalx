// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import OrganizationScreen from "../app/organization/[orgId]";
import { organizationDeletionError } from "@terminalx/portable/organizationDeletion";
import { OrganizationDelete } from "./ui/OrganizationDelete";

// #1292: an owner deletes an organization from the phone, with the desktop's wording and rule.
const mocks = vi.hoisted(() => ({ pages: ["/cloud/compute", "/agent-logins"], copy: vi.fn(async (_text: string) => true), back: vi.fn(), push: vi.fn(), params: { orgId: "org-team" }, catalog: null as any, snapshot: { organizations: [] as any[], saved: false, deletesOrganizations: true } as any }));
vi.mock("expo-clipboard", () => ({ setStringAsync: mocks.copy }));
vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  // The screen comes into view once, when it is drawn.
  return { Stack: { Screen: () => null }, useLocalSearchParams: () => mocks.params, useRouter: () => ({ back: mocks.back, push: mocks.push }), useSitemap: () => ({ contextKey: "", filename: "", href: "/", isInternal: false, isGenerated: false, children: mocks.pages.map((href: string) => ({ contextKey: `.${href}.tsx`, filename: href, href, isInternal: false, isGenerated: false, children: [] })) }), useFocusEffect: (run: () => void) => useEffect(run, [run]) };
});
vi.mock("@mobile/cloud/CloudProvider", () => ({ useCloudCatalog: () => mocks.catalog, useCatalogSnapshot: () => mocks.snapshot }));
vi.mock("@mobile/ui/theme", async (actual) => ({ ...(await actual<typeof import("@mobile/ui/theme")>()), useTheme: () => ({ palette: { danger: "#db695f", border: "#333" } }) }));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View, ScrollView: View, KeyboardAvoidingView: View, Platform: { OS: "ios" },
    // A row that opens a page; the buttons of this screen are its Button's.
    Pressable: ({ children, onPress, accessibilityLabel }: any) => <div role="link" aria-label={accessibilityLabel} onClick={onPress}>{children}</div>,
    Text: ({ children, selectable, testID, accessibilityRole }: any) => <span data-testid={testID} data-selectable={selectable ? "true" : undefined} role={accessibilityRole}>{children}</span>,
    TextInput: ({ accessibilityLabel, value, onChangeText, editable }: any) => <input aria-label={accessibilityLabel} value={value} disabled={editable === false} onChange={(event) => onChangeText(event.currentTarget.value)} />,
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  };
});
vi.mock("@mobile/ui/primitives", () => ({
  Button: ({ label, onPress, disabled, accessibilityLabel }: any) => <button aria-label={accessibilityLabel ?? label} disabled={!!disabled} onClick={onPress}>{label}</button>,
  Card: ({ children }: any) => <div>{children}</div>,
  EmptyState: ({ title, detail }: any) => <div>{title}{detail}</div>,
  SectionTitle: ({ children }: any) => <h2>{children}</h2>,
}));

const team = { orgId: "org-team", name: "Test organization", role: "owner", isPersonal: false };

let root: Root;
let container: HTMLDivElement;
const show = (screen: ReactNode) => act(async () => { root.render(screen); });
const button = (name: string) => container.querySelector(`button[aria-label='${name}']`) as HTMLButtonElement | null;
const input = () => container.querySelector("input[aria-label='Organization name to delete']") as HTMLInputElement;
const type = async (value: string) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input(), value);
  input().dispatchEvent(new Event("input", { bubbles: true }));
});
const click = async (name: string) => act(async () => button(name)!.click());

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.copy.mockReset().mockResolvedValue(true);
  mocks.back.mockReset();
  mocks.params = { orgId: "org-team" };
  mocks.push.mockReset();
  mocks.catalog = { deleteOrganization: vi.fn(async () => {}), api: { providers: vi.fn(async () => []), credentials: vi.fn(async () => []) } };
  mocks.snapshot = { organizations: [{ organization: team }], saved: false, deletesOrganizations: true };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it.each([
  ["an admin", { ...team, role: "admin" }],
  ["a member", { ...team, role: "member" }],
  ["the owner of a personal organization", { ...team, isPersonal: true }],
])("does not offer deletion to %s", async (_who, organization) => {
  mocks.snapshot = { organizations: [{ organization }], saved: false, deletesOrganizations: true };
  await show(<OrganizationScreen />);
  expect(container.textContent).toContain("Test organization");
  expect(container.textContent).not.toContain("Delete organization");
  expect(container.querySelectorAll("button")).toHaveLength(0);
});

it("offers it to the owner with the shared warning, and waits for a fresh list before offering it", async () => {
  mocks.snapshot = { organizations: [{ organization: team }], saved: true, deletesOrganizations: true };
  await show(<OrganizationScreen />);
  expect(button("Delete organization…")).toBeNull();
  mocks.snapshot = { organizations: [{ organization: team }], saved: false, deletesOrganizations: true };
  await show(<OrganizationScreen />);
  expect(container.textContent).toContain("Permanently delete Test organization. Members will lose access. This cannot be undone.");
  expect(button("Delete organization…")).not.toBeNull();
});

it("shows the name selectable, copies it in one tap, and a pasted copy with stray spaces deletes the exact name", async () => {
  await show(<OrganizationScreen />);
  await click("Delete organization…");
  const name = container.querySelector("[data-testid='organization-delete-name']")!;
  expect(name.textContent).toBe("Test organization");
  expect(name.getAttribute("data-selectable")).toBe("true");
  expect(button("Delete Test organization permanently")!.disabled).toBe(true);
  await click("Copy name");
  expect(mocks.copy).toHaveBeenCalledExactlyOnceWith("Test organization");
  expect(button("Copy name")!.textContent).toBe("Copied");
  await type("test organization");
  expect(button("Delete Test organization permanently")!.disabled).toBe(true);
  await type(" Test organization  ");
  expect(button("Delete Test organization permanently")!.disabled).toBe(false);
  await click("Delete Test organization permanently");
  expect(mocks.catalog.deleteOrganization).toHaveBeenCalledExactlyOnceWith("org-team", "Test organization");
  expect(mocks.back).toHaveBeenCalledTimes(1);
  // The confirmation is spent: nothing is left to send again while the screen goes away.
  expect(button("Delete Test organization permanently")).toBeNull();
});

it("shows a refusal in the shared words, keeps what was typed, and never retries on its own", async () => {
  const remove = vi.fn(async () => { throw Object.assign(new Error("blocked"), { code: "organization_delete_blocked", blockers: ["cloud_cleanup_required", "server detail"] }); });
  const onDeleted = vi.fn();
  await show(<OrganizationDelete organization={team} remove={remove} onDeleted={onDeleted} />);
  await click("Delete organization…");
  await type("Test organization");
  await click("Delete Test organization permanently");
  const alert = container.querySelector("[role='alert']")!.textContent!;
  expect(alert).toContain("Finish cloud cleanup");
  expect(alert).toContain("Use Cloud cleanup");
  expect(alert).not.toContain("server detail");
  expect(input().value).toBe("Test organization");
  expect(remove).toHaveBeenCalledTimes(1);
  expect(onDeleted).not.toHaveBeenCalled();
});

it("words an expired sign-in as the desktop does", async () => {
  const remove = vi.fn(async () => { throw Object.assign(new Error("401"), { code: "invalid_access_token" }); });
  await show(<OrganizationDelete organization={team} remove={remove} onDeleted={vi.fn()} />);
  await click("Delete organization…");
  await type("Test organization");
  await click("Delete Test organization permanently");
  expect(container.querySelector("[role='alert']")!.textContent).toBe(organizationDeletionError({ code: "invalid_access_token" }));
});

it("points the owner to the desktop app or the web console while the server does not take deletion from a phone", async () => {
  mocks.snapshot = { organizations: [{ organization: team }], saved: false, deletesOrganizations: false };
  await show(<OrganizationScreen />);
  expect(button("Delete organization…")).toBeNull();
  expect(container.textContent).toContain("use the TerminalX desktop app or the web console");
  mocks.snapshot = { organizations: [{ organization: { ...team, role: "admin" } }], saved: false, deletesOrganizations: false };
  await show(<OrganizationScreen />);
  expect(container.textContent).not.toContain("delete this organization");
});

it("drops an open confirmation when the organization is renamed or the role changes", async () => {
  const remove = vi.fn();
  await show(<OrganizationDelete organization={team} remove={remove} onDeleted={vi.fn()} />);
  await click("Delete organization…");
  await type("Test organization");
  await show(<OrganizationDelete organization={{ ...team, name: "Renamed" }} remove={remove} onDeleted={vi.fn()} />);
  expect(container.querySelector("input")).toBeNull();
  await click("Delete organization…");
  expect(container.querySelector("[data-testid='organization-delete-name']")!.textContent).toBe("Renamed");
  await show(<OrganizationDelete organization={{ ...team, name: "Renamed", role: "admin" }} remove={remove} onDeleted={vi.fn()} />);
  expect(container.querySelectorAll("button")).toHaveLength(0);
  expect(remove).not.toHaveBeenCalled();
});

it("says the organization is gone when it is no longer listed", async () => {
  mocks.snapshot = { organizations: [], saved: false, deletesOrganizations: true };
  await show(<OrganizationScreen />);
  expect(container.textContent).toContain("Organization unavailable");
});

// 25.02: the organization's compute and agent logins, read from the server; each row opens its page for whoever manages them.
const provider = (displayName: string, fields: Record<string, unknown> = {}) => ({ id: displayName.toLowerCase(), displayName, availability: "available", canManage: true, connection: { state: "connected", connectedAt: 1 }, descriptor: { label: displayName, credentialSource: "organization" }, ...fields });
const login = (name: string, state = "connected") => ({ id: `c-${name}`, provider: name, state });
const row = (name: string) => container.querySelector(`[role='link'][aria-label^='${name}']`) as HTMLElement | null;

it("shows what compute and which agent logins the organization has, and opens each for its owner", async () => {
  mocks.catalog.api.providers.mockResolvedValue([provider("Boat"), provider("TerminalX Cloud", { descriptor: { label: "TerminalX Cloud", credentialSource: "platform" } })]);
  mocks.catalog.api.credentials.mockResolvedValue([login("codex"), login("claude"), login("cursor", "revoked"), login("github")]);
  await show(<OrganizationScreen />);
  expect(mocks.catalog.api.providers).toHaveBeenCalledExactlyOnceWith("org-team");
  expect(container.textContent).toContain("Cloud workspaces");
  // Compute TerminalX holds the key for is not something this organization connected.
  expect(row("Compute")!.getAttribute("aria-label")).toBe("Compute, Boat · connected");
  expect(row("Agent logins")!.getAttribute("aria-label")).toBe("Agent logins, Codex, Claude Code · connected");
  expect(container.textContent).toContain("Owners and admins manage these. Members use them when they launch a workspace.");
  await act(async () => row("Compute")!.click());
  expect(mocks.push).toHaveBeenLastCalledWith({ pathname: "/cloud/compute", params: { orgId: "org-team" } });
  await act(async () => row("Agent logins")!.click());
  expect(mocks.push).toHaveBeenLastCalledWith({ pathname: "/agent-logins", params: { orgId: "org-team" } });
});

it("shows the rows and opens neither while their pages are not in the app", async () => {
  mocks.pages = [];
  mocks.catalog.api.providers.mockResolvedValue([]);
  mocks.catalog.api.credentials.mockResolvedValue([]);
  await show(<OrganizationScreen />);
  mocks.pages = ["/cloud/compute", "/agent-logins"];
  expect(container.textContent).toContain("Agent logins");
  expect(row("Compute")).toBeNull();
  expect(row("Agent logins")).toBeNull();
});

it("says when nothing is connected", async () => {
  await show(<OrganizationScreen />);
  expect(row("Compute")!.getAttribute("aria-label")).toBe("Compute, Not connected");
  expect(row("Agent logins")!.getAttribute("aria-label")).toBe("Agent logins, Not connected");
});

it("says a key needs attention and that a list could not be read, never a guess", async () => {
  mocks.catalog.api.providers.mockResolvedValue([provider("Boat", { availability: "attention-required", connection: { state: "attention-required", connectedAt: 1 } })]);
  mocks.catalog.api.credentials.mockRejectedValue(new Error("offline"));
  await show(<OrganizationScreen />);
  expect(row("Compute")!.getAttribute("aria-label")).toBe("Compute, Boat · needs attention");
  expect(row("Agent logins")!.getAttribute("aria-label")).toBe("Agent logins, Could not be read.");
});

it("shows a member the rows without a way in", async () => {
  mocks.snapshot = { organizations: [{ organization: { ...team, role: "member" } }], saved: false, deletesOrganizations: true };
  mocks.catalog.api.providers.mockResolvedValue([provider("Boat", { canManage: false })]);
  await show(<OrganizationScreen />);
  expect(container.textContent).toContain("Boat · connected");
  expect(row("Compute")).toBeNull();
  expect(row("Agent logins")).toBeNull();
});
