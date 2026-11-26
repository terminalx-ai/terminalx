// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { plainRead } from "./account/fixtures";
import { accountDeletionText as T } from "./account/deletion";
import { CloudApiError } from "./cloud/api";

// PRO-584, board 26.01: Delete account on the phone. A plain account, a blocked one, and a deletion that failed and is tried again.
const mocks = vi.hoisted(() => ({
  app: null as any,
  catalog: null as any,
  push: vi.fn(),
  dismissTo: vi.fn(),
  openURL: vi.fn(async () => true),
  large: false,
}));
vi.mock("expo-router", () => ({ Stack: { Screen: () => null }, useRouter: () => ({ push: mocks.push, back: vi.fn(), dismissTo: mocks.dismissTo }) }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("lucide-react-native", () => Object.fromEntries(["CalendarClock", "CircleCheck", "ExternalLink", "TriangleAlert", "WifiOff", "X"].map((name) => [name, () => null])));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => mocks.app }));
vi.mock("@mobile/cloud/CloudProvider", () => ({ useCloudCatalog: () => mocks.catalog, useCatalogSnapshot: () => ({ organizations: [] }) }));
vi.mock("@mobile/cloud/provider-names", () => {
  const names = new Map([["org_p", new Map([["box", "Boat"]])]]);
  const store = { subscribe: () => () => undefined, getSnapshot: () => names, need: () => undefined };
  return { providerNamesFor: () => store };
});
vi.mock("@mobile/account/pending-deletion", () => ({ rememberPendingDeletion: async () => undefined }));
vi.mock("@mobile/ui/keyboard", () => ({ useKeyboardShown: () => false, keyboardAvoidingBehavior: () => "padding" }));
vi.mock("@mobile/ui/text-size", () => ({ useLargeText: () => mocks.large }));
vi.mock("@mobile/ui/Spinner", () => ({ Spinner: () => null }));
vi.mock("@mobile/ui/theme", () => ({ useTheme: () => ({ palette: { page: "#000", ink: "#fff", muted: "#999", faint: "#666", border: "#333", warning: "#d6a744", success: "#55b979", danger: "#db695f", raised: "#111" } }) }));
vi.mock("react-native", () => {
  const View = ({ children, testID }: { children?: ReactNode; testID?: string }) => <div data-testid={testID}>{children}</div>;
  return {
    View, KeyboardAvoidingView: View, ScrollView: View,
    Pressable: ({ children, onPress, accessibilityLabel, testID }: any) => <div role="link" data-testid={testID} aria-label={accessibilityLabel} onClick={onPress}>{typeof children === "function" ? children({ pressed: false }) : children}</div>,
    Text: ({ children, accessibilityRole }: any) => <span role={accessibilityRole}>{children}</span>,
    Linking: { openURL: mocks.openURL },
    AppState: { addEventListener: () => ({ remove() {} }) },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  };
});
vi.mock("@mobile/ui/primitives", () => ({
  Button: ({ label, onPress, disabled, testID }: any) => <button data-testid={testID} aria-label={label} disabled={!!disabled} onClick={onPress}>{label}</button>,
  Card: ({ children, testID }: any) => <div data-testid={testID}>{children}</div>,
  SectionTitle: ({ children }: any) => <h2>{children}</h2>,
}));
vi.mock("@mobile/ui/Notice", () => ({ Notice: ({ testID, title, text, action }: any) => <div role="alert" data-testid={testID}>{title}{text}{action ? <button aria-label={action.label} onClick={action.onPress}>{action.label}</button> : null}</div> }));
vi.mock("@mobile/ui/TextField", () => ({
  TextField: ({ label, value, onChangeText, onBlur, disabled, helper, error, testID }: any) => <label data-testid={testID}>{label}<input aria-label={label} value={value} disabled={!!disabled} onChange={(event) => onChangeText(event.currentTarget.value)} onBlur={onBlur} /><span data-testid="field-line">{error || helper}</span></label>,
}));

const { default: DeleteAccountScreen } = await import("../app/delete-account");

let root: Root;
let container: HTMLDivElement;
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const byTestId = (id: string) => container.querySelector(`[data-testid='${id}']`) as HTMLElement | null;
const confirmButton = () => byTestId("delete-account-confirm") as HTMLButtonElement;
const field = () => container.querySelector(`input[aria-label='${T.typeLabel}']`) as HTMLInputElement;
const type = (value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field(), value);
  field().dispatchEvent(new Event("input", { bubbles: true }));
});
const show = async () => { await act(async () => { root.render(<DeleteAccountScreen />); }); await flush(); };

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.large = false;
  mocks.openURL.mockClear();
  mocks.dismissTo.mockClear();
  mocks.app = {
    session: { user: { userId: "user-alex", email: "alex@example.com" } },
    online: true,
    reauthenticate: vi.fn(async () => "signed-in"),
    forgetDeletedAccount: vi.fn(async () => { mocks.app.session = null; }),
    signOut: vi.fn(async () => undefined),
  };
  mocks.catalog = { api: { accountDeletion: vi.fn(async () => plainRead()), requestAccountDeletion: vi.fn(async () => ({ id: "del_1", kind: "self", state: "scheduled", requestedAt: "2026-11-25T12:00:00.000Z", deleteAfter: "2026-12-09T12:00:00.000Z" })) } };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("a plain account: says the grace, what goes and what is kept, and deletes once the address is typed", async () => {
  await show();
  expect(container.textContent).toContain(T.lede(14));
  expect(container.textContent).toContain("Your personal organization, Alex Rivera");
  expect(container.textContent).toContain("You leave Contoso Labs; it keeps its work");
  expect(container.textContent).toContain(T.kept(90));
  expect(container.textContent).toContain(T.reauthDone);
  expect(container.textContent).not.toContain(T.blockedHead.toUpperCase());
  expect(confirmButton().disabled).toBe(true);

  await type("alex@example.co");
  expect(confirmButton().disabled).toBe(true);
  await act(async () => field().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(byTestId("field-line")!.textContent).toBe(T.mismatch);

  await type(" ALEX@example.com ");
  expect(confirmButton().disabled).toBe(false);
  await act(async () => confirmButton().click());
  await flush();
  // The account's own address goes, never what was typed.
  expect(mocks.catalog.api.requestAccountDeletion).toHaveBeenCalledWith("alex@example.com");
  expect(mocks.app.forgetDeletedAccount).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain(T.doneHead("9 December 2026"));
  expect(container.textContent).toContain(T.doneKeep("9 December 2026"));
  expect(container.textContent).toContain(T.doneAfter("9 December 2026"));
  await act(async () => (byTestId("delete-account-done") as HTMLButtonElement).click());
  expect(mocks.dismissTo).toHaveBeenCalledWith("/settings");
});

it("a blocked account: lists what stands in the way, opens the web console to hand over, and keeps the button off", async () => {
  const read = plainRead();
  read.blockers = [{ code: "sole_owner_with_members", organizationId: "org_1", organizationName: "Northwind", otherMembers: 4 }];
  read.deleted.runningWorkspaces = [{ id: "ws_1", name: "scratch", provider: "box", organizationId: "org_p" }];
  mocks.catalog.api.accountDeletion.mockResolvedValue(read);
  await show();
  const blockers = byTestId("delete-account-blockers")!;
  expect(blockers.textContent).toContain("Hand over Northwind");
  expect(blockers.textContent).toContain(T.ownerPhone);
  // Running cloud workspaces never stand in the way: they are under What is deleted.
  expect(blockers.textContent).not.toContain("scratch");
  expect(byTestId("delete-account-gone")!.textContent).toContain("scratch in Alex Rivera: stopped when you confirm, deleted after the 14 days");
  expect(container.textContent).toContain(T.blockedConfirm);
  expect(field()).toBeNull();
  expect(confirmButton().disabled).toBe(true);
  await act(async () => (container.querySelector(`button[aria-label='${T.openConsole}']`) as HTMLButtonElement).click());
  expect(mocks.openURL).toHaveBeenCalledWith("https://console.terminalx.ai/organizations/org_1");
  expect(mocks.catalog.api.requestAccountDeletion).not.toHaveBeenCalled();
});

it("a failed deletion: says nothing was deleted, keeps what was typed, and Delete account tries again", async () => {
  const read = plainRead();
  read.deleted.runningWorkspaces = [{ id: "ws_1", name: "checkout-redesign", provider: "box", organizationId: "org_p" }, { id: "ws_2", name: "scratch", provider: "box", organizationId: "org_p" }];
  mocks.catalog.api.accountDeletion.mockResolvedValue(read);
  let answer!: (value: unknown) => void;
  mocks.catalog.api.requestAccountDeletion.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
  await show();
  await type("alex@example.com");
  await act(async () => confirmButton().click());
  // While running ones are stopped at the provider, the button says so.
  expect(confirmButton().textContent).toBe(T.stopping);
  expect(confirmButton().disabled).toBe(true);
  await act(async () => answer({ id: "del_1", kind: "self", state: "refused", requestedAt: "2026-11-25T12:00:00.000Z", failure: { code: "workspace_stop_failed", provider: "box", workspaceId: "ws_2", workspaceName: "scratch", reason: "provider_timed_out", stopped: [{ workspaceId: "ws_1", workspaceName: "checkout-redesign" }] } }));
  await flush();
  expect(byTestId("delete-account-refused")!.textContent).toBe(`${T.failStop("Boat", "scratch", "the provider is not answering")} ${T.failStopKept(["checkout-redesign"])}`);
  expect(field().value).toBe("alex@example.com");
  expect(mocks.app.forgetDeletedAccount).not.toHaveBeenCalled();
  expect(confirmButton().disabled).toBe(false);
  await act(async () => confirmButton().click());
  await flush();
  expect(mocks.catalog.api.requestAccountDeletion).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain(T.doneHead("9 December 2026"));
});

it("a refusal that changed nothing says so, and a stale sign-in asks to sign in again before typing", async () => {
  mocks.catalog.api.requestAccountDeletion.mockRejectedValueOnce(new CloudApiError("account_deletion_busy", 409));
  await show();
  await type("alex@example.com");
  await act(async () => confirmButton().click());
  await flush();
  expect(byTestId("delete-account-refused")!.textContent).toBe(T.failRefused);

  mocks.catalog.api.requestAccountDeletion.mockRejectedValueOnce(new CloudApiError("account_deletion_recent_sign_in_required", 403));
  await act(async () => confirmButton().click());
  await flush();
  expect(byTestId("delete-account-stale")!.textContent).toBe(T.failStale);
  expect(field().disabled).toBe(true);
  expect(confirmButton().disabled).toBe(true);
  await act(async () => (byTestId("delete-account-sign-in") as HTMLButtonElement).click());
  await flush();
  expect(mocks.app.reauthenticate).toHaveBeenCalledTimes(1);
  expect(byTestId("delete-account-stale")).toBeNull();
  expect(field().disabled).toBe(false);
});

it("offline: nothing is sent", async () => {
  mocks.app.online = false;
  await show();
  await type("alex@example.com");
  await act(async () => confirmButton().click());
  expect(byTestId("delete-account-offline")!.textContent).toBe(T.offline);
  expect(mocks.catalog.api.requestAccountDeletion).not.toHaveBeenCalled();
});

it("at the accessibility text sizes the sign-out sentence moves into the page, above the field", async () => {
  mocks.large = true;
  await show();
  const text = container.textContent!;
  expect(text.indexOf("You will be signed out on every device.")).toBeLessThan(text.indexOf(T.typeLabel));
  expect(text.split("You will be signed out on every device.").length).toBe(2);
});
