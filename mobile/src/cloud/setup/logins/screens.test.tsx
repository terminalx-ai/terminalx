// @vitest-environment jsdom
import { act, useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stage } from "@mobile/ui/testing/kit";
import { CloudApiError } from "../../api";
import { LoginsListScreen } from "./ListScreen";
import { LoginProviderScreen } from "./ProviderScreen";
import { CodexSignInScreen } from "./SignInScreen";
import { resetDeviceLogins } from "./device";
import { AUTHORIZATION, REVOKE_TEXT } from "./words";

// PRO-529: board 25.04, every state it draws, with its sentences and which buttons are on.
const mocks = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  api: null as any,
  role: "admin",
  router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
  alert: vi.fn(),
  openBrowser: vi.fn(async () => ({ type: "dismiss" })),
  appState: { currentState: "active" as string, listeners: [] as ((state: string) => void)[] },
}));
vi.mock("react-native", async () => ({
  ...(await import("@mobile/ui/testing/native")),
  KeyboardAvoidingView: (await import("@mobile/ui/testing/native")).View,
  ActivityIndicator: ({ testID }: { testID?: string }) => <span data-testid={testID} role="progressbar" />,
  Alert: { alert: mocks.alert },
  AppState: {
    get currentState() { return mocks.appState.currentState; },
    addEventListener: (_: string, listener: (state: string) => void) => { mocks.appState.listeners.push(listener); return { remove: () => { mocks.appState.listeners = mocks.appState.listeners.filter((entry) => entry !== listener); } }; },
  },
}));
vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()));
vi.mock("lucide-react-native", async () => (await import("@mobile/ui/testing/kit")).namedIcons());
vi.mock("expo-router", () => ({
  Stack: { Screen: ({ options }: { options: { title: string; headerTitle?: () => ReactNode; headerBackVisible?: boolean } }) => <div data-testid="screen-header" data-back={options.headerBackVisible === false ? "hidden" : "shown"}><span data-testid="screen-title">{options.title}</span>{options.headerTitle ? <div data-testid="header-title">{options.headerTitle()}</div> : null}</div> },
  Redirect: ({ href }: { href: string }) => <div data-testid="redirect">{href}</div>,
  useLocalSearchParams: () => mocks.params,
  useRouter: () => mocks.router,
  // In view from the first render, out of view when the page goes, as the navigator does.
  useFocusEffect: (effect: () => void | (() => void)) => useEffect(() => effect(), [effect]),
}));
vi.mock("expo-web-browser", () => ({ openBrowserAsync: mocks.openBrowser }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true), getStringAsync: vi.fn(async () => "") }));
vi.mock("../../CloudProvider", () => ({
  useCloudCatalog: () => (mocks.api ? { api: mocks.api } : null),
  useCatalogSnapshot: () => ({ organizations: [{ organization: { orgId: "org-1", name: "Northwind", role: mocks.role }, workspaces: [], error: null, loaded: true }], loading: false, error: null, refreshedAt: 1, saved: false, titles: {}, deletesOrganizations: false }),
}));

const page = stage();
const NOV_23 = new Date(2026, 10, 23, 12).getTime();
const credential = (provider: string, fields: Record<string, unknown> = {}) => ({ id: `cred-${provider}`, provider, authKind: "api-key", fingerprint: "sha256:5be2d913", version: 1, updatedAt: NOV_23, state: "connected", sharedUse: "organization", epoch: 1, ...fields });
const CODE = { attemptId: "a1", deviceAuthId: "d1", userCode: "K7QM-4TXP", verificationUri: "https://auth.example.invalid/device", intervalSeconds: 5, expiresInSeconds: 900 };
const SECRET = "sk-placeholder-0123456789";

function client(credentials: unknown[] = []) {
  return {
    credentials: vi.fn(async () => credentials),
    saveCredential: vi.fn(async (_org: string, provider: string) => credential(provider)),
    revokeCredential: vi.fn(async (_org: string, provider: string) => credential(provider, { state: "revoked" })),
    deleteCredential: vi.fn(async () => undefined),
    startCodexLogin: vi.fn(async () => CODE),
    pollCodexLogin: vi.fn(async () => ({ status: "pending" })),
    cancelCodexLogin: vi.fn(async () => "canceled"),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const text = () => page.container.textContent ?? "";
const button = (label: string) => (page.byText(label)?.closest("[role=button]") ?? null) as HTMLElement | null;
const isOn = (label: string) => { const found = button(label); expect(found, `button ${label}`).not.toBeNull(); return found!.getAttribute("aria-disabled") !== "true"; };
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
/** The buttons of the last alert, pressed by name. */
const alertButton = (name: string) => (mocks.alert.mock.calls.at(-1)![2] as { text: string; onPress?: () => void }[]).find((entry) => entry.text === name)!;

beforeEach(() => {
  mocks.params = { orgId: "org-1" };
  mocks.api = client();
  mocks.role = "admin";
  mocks.router.push.mockReset(); mocks.router.replace.mockReset(); mocks.router.back.mockReset();
  mocks.alert.mockReset();
  mocks.openBrowser.mockClear();
  mocks.appState.currentState = "active";
  mocks.appState.listeners = [];
  resetDeviceLogins();
});
afterEach(() => { vi.useRealTimers(); });

describe("the list", () => {
  it("nothing connected yet: each agent says how it can sign in, and one is enough", async () => {
    await page.show(<LoginsListScreen />);
    await settle();
    expect(page.byId("header-title")?.textContent).toBe("Agent logins" + "Northwind");
    expect(text()).toContain("What each agent signs in with on this organization’s cloud workspaces. Members use these logins; they do not sign in themselves.");
    expect(page.byId("login-row-codex")?.getAttribute("aria-label")).toBe("Codex, Not connected, ChatGPT sign-in or API key");
    expect(page.byId("login-row-claude")?.getAttribute("aria-label")).toBe("Claude Code, Not connected, API key");
    expect(page.byId("login-row-cursor")?.getAttribute("aria-label")).toBe("Cursor, Not connected, API key");
    expect(page.byId("login-row-github")?.getAttribute("aria-label")).toBe("GitHub, Not connected, A token, for private repositories");
    expect(text()).toContain("One agent is enough to launch a workspace.");
    await page.press(page.byId("login-row-claude"));
    expect(mocks.router.push).toHaveBeenCalledWith("/cloud/logins/claude?orgId=org-1");
  });

  it("some connected: the server's four states, the kind, whose account, when it changed", async () => {
    mocks.api = client([
      credential("codex", { authKind: "oauth-credentials-json", displayIdentity: "alex@example.com" }),
      credential("claude", { state: "sign-in-required", updatedAt: new Date(2026, 10, 2, 12).getTime() }),
      credential("cursor", { state: "revoked", updatedAt: new Date(2026, 9, 14, 12).getTime() }),
      credential("github", { authKind: "personal-access-token" }),
    ]);
    await page.show(<LoginsListScreen />);
    await settle();
    expect(page.byId("login-row-codex")?.getAttribute("aria-label")).toBe("Codex, Connected, Subscription login · alex@example.com");
    expect(page.byId("login-row-claude")?.getAttribute("aria-label")).toBe("Claude Code, Sign-in required, API key · Updated 2 Nov");
    expect(page.byId("login-row-cursor")?.getAttribute("aria-label")).toBe("Cursor, Revoked, API key · Updated 14 Oct");
    expect(page.byId("login-row-github")?.getAttribute("aria-label")).toBe("GitHub, Connected, Personal access token · Updated 23 Nov");
    expect(text()).not.toContain("One agent is enough");
  });

  it("a member's view: told who manages it, and the list is not asked for", async () => {
    mocks.role = "member";
    await page.show(<LoginsListScreen />);
    await settle();
    expect(page.byId("logins-member")?.textContent).toBe("Owners and admins manage agent logins. You use them when you launch a workspace in Northwind.");
    expect(mocks.api.credentials).not.toHaveBeenCalled();
    expect(page.byId("login-row-codex")).toBeNull();
  });

  it("could not be read: the board's sentence, and Try again reads it again", async () => {
    mocks.api.credentials.mockRejectedValueOnce(new CloudApiError("cloud_workspace_unavailable", null, "network"));
    await page.show(<LoginsListScreen />);
    await settle();
    expect(text()).toContain("Agent logins could not be read");
    expect(text()).toContain("The service could not be reached. Nothing was changed.");
    expect(isOn("Try again")).toBe(true);
    await page.press(button("Try again"));
    await settle();
    expect(mocks.api.credentials).toHaveBeenCalledTimes(2);
    expect(page.byId("login-row-codex")).not.toBeNull();
  });
});

describe("Codex: choose how, and authorize", () => {
  it("Get a sign-in code is off until the console's authorization is switched on", async () => {
    mocks.params = { orgId: "org-1", provider: "codex" };
    await page.show(<LoginProviderScreen />);
    await settle();
    expect(text()).toContain("How Codex signs in on Northwind’s cloud workspaces.");
    expect(page.byId("choice-chatgpt")?.getAttribute("aria-selected")).toBe("true");
    expect(text()).toContain("Needs “Allow device code login” switched on in ChatGPT’s security settings.");
    expect(isOn("Get a sign-in code")).toBe(false);
    await page.press(page.byLabel(AUTHORIZATION));
    expect(isOn("Get a sign-in code")).toBe(true);
    await page.press(button("Get a sign-in code"));
    expect(mocks.router.replace).toHaveBeenCalledWith("/cloud/logins/codex-sign-in?orgId=org-1&authorized=1");
    expect(mocks.api.startCodexLogin).not.toHaveBeenCalled();
  });

  it("API key shows the key form in place of the sign-in", async () => {
    mocks.params = { orgId: "org-1", provider: "codex" };
    await page.show(<LoginProviderScreen />);
    await settle();
    await page.press(page.byId("choice-api-key"));
    expect(text()).toContain("Codex API key");
    expect(button("Get a sign-in code")).toBeNull();
    expect(isOn("Save")).toBe(false);
  });
});

describe("Codex: sign in with ChatGPT", () => {
  beforeEach(() => { mocks.params = { orgId: "org-1", authorized: "1" }; });

  it("asking for a code: the console's words and Cancel; leaving gives the code up on the server", async () => {
    const start = deferred<typeof CODE>();
    mocks.api.startCodexLogin.mockReturnValueOnce(start.promise);
    await page.show(<CodexSignInScreen />);
    expect(text()).toContain("Getting a code from OpenAI…");
    expect(isOn("Cancel")).toBe(true);
    await page.press(button("Cancel"));
    expect(mocks.router.back).toHaveBeenCalled();
    await act(async () => { start.resolve(CODE); await start.promise; });
    await settle();
    expect(mocks.api.cancelCodexLogin).toHaveBeenCalledWith("org-1", CODE);
  });

  it("the code: large, counting down, with Open sign-in page first", async () => {
    await page.show(<CodexSignInScreen />);
    await settle();
    expect(page.byId("one-time-code")?.textContent).toBe("K7QM-4TXP");
    expect(page.byId("one-time-code-expiry")?.textContent).toMatch(/^expires in 1[45]:\d\d$/);
    expect(text()).toContain("Open OpenAI’s sign-in page, sign in with the ChatGPT account the organization pays for, and enter this code. Then come back here.");
    expect(isOn("Open sign-in page")).toBe(true);
    expect(isOn("Cancel sign-in")).toBe(true);
    expect(page.byId("screen-header")?.getAttribute("data-back")).toBe("hidden");
  });

  it("back from the browser, waiting: the page opened in the browser sheet, and the console's waiting sentence", async () => {
    await page.show(<CodexSignInScreen />);
    await settle();
    await page.press(button("Open sign-in page"));
    expect(mocks.openBrowser).toHaveBeenCalledWith("https://auth.example.invalid/device");
    expect(text()).toContain("Waiting for approval… Open the link, sign in, and enter the code.");
    expect(isOn("Open sign-in page again")).toBe(true);
    expect(page.byId("one-time-code")?.textContent).toBe("K7QM-4TXP");
  });

  it("connected: the account OpenAI reported, and Done goes back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    mocks.api.pollCodexLogin.mockResolvedValueOnce({ status: "complete", credential: credential("codex", { authKind: "oauth-credentials-json", displayIdentity: "alex@example.com" }) });
    await page.show(<CodexSignInScreen />);
    await settle();
    await tick(5000);
    expect(mocks.api.pollCodexLogin).toHaveBeenCalledWith("org-1", CODE, { organizationSharing: true, machineInstallation: true });
    expect(text()).toContain("Codex connected as alex@example.com.");
    expect(text()).toContain("Northwind’s cloud workspaces sign Codex in with this ChatGPT plan.");
    await page.press(button("Done"));
    expect(mocks.router.back).toHaveBeenCalled();
  });

  it("cancel asks first, then tells the server: canceled, with a new code or back to the list", async () => {
    await page.show(<CodexSignInScreen />);
    await settle();
    await page.press(button("Cancel sign-in"));
    expect(mocks.alert.mock.calls[0]![0]).toBe("Cancel this sign-in?");
    expect(mocks.alert.mock.calls[0]![1]).toBe("The code stops working. Nothing is saved.");
    expect((mocks.alert.mock.calls[0]![2] as { text: string }[]).map((entry) => entry.text)).toEqual(["Keep waiting", "Cancel sign-in"]);
    expect(mocks.api.cancelCodexLogin).not.toHaveBeenCalled();
    await act(async () => { alertButton("Cancel sign-in").onPress!(); });
    await settle();
    expect(mocks.api.cancelCodexLogin).toHaveBeenCalledWith("org-1", CODE);
    expect(page.byId("sign-in-ended")?.textContent).toBe("Sign-in canceled. Nothing was saved.");
    expect(page.byId("one-time-code")?.getAttribute("aria-label")).toContain("no longer valid");
    expect(isOn("Get a new code")).toBe(true);
    await page.press(button("Back to agent logins"));
    expect(mocks.router.back).toHaveBeenCalled();
    await page.press(button("Get a new code"));
    await settle();
    expect(mocks.api.startCodexLogin).toHaveBeenCalledTimes(2);
  });

  it("the code expired: the console's sentence", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    mocks.api.pollCodexLogin.mockResolvedValueOnce({ status: "expired" });
    await page.show(<CodexSignInScreen />);
    await settle();
    await tick(5000);
    expect(page.byId("sign-in-ended")?.textContent).toBe("The code expired. Start device login again.");
    expect(isOn("Get a new code")).toBe(true);
    expect(button("Back to agent logins")).toBeNull();
  });

  it("the code expired by the clock, as the server said", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    mocks.api.startCodexLogin.mockResolvedValueOnce({ ...CODE, expiresInSeconds: 8, intervalSeconds: 60 });
    await page.show(<CodexSignInScreen />);
    await settle();
    await tick(9000);
    expect(page.byId("sign-in-ended")?.textContent).toBe("The code expired. Start device login again.");
  });

  it("OpenAI refused it: the console's sentence", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    mocks.api.pollCodexLogin.mockResolvedValueOnce({ status: "failed" });
    await page.show(<CodexSignInScreen />);
    await settle();
    await tick(5000);
    expect(page.byId("sign-in-ended")?.textContent).toBe("Device login failed. Start it again.");
  });

  it("no network while waiting: the code is still good until its time, and waiting carries on", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const offline = new CloudApiError("cloud_workspace_unavailable", null, "network");
    mocks.api.pollCodexLogin.mockRejectedValueOnce(offline).mockResolvedValueOnce({ status: "pending" });
    await page.show(<CodexSignInScreen />);
    await settle();
    await tick(5000);
    expect(page.byId("sign-in-offline-notice")?.textContent).toMatch(/^Offline\. The code is still good until \d\d:\d\d; this page carries on when the phone is back online\.$/);
    expect(isOn("Cancel sign-in")).toBe(false);
    expect(button("Open sign-in page")).toBeNull();
    await tick(5000);
    expect(mocks.api.pollCodexLogin).toHaveBeenCalledTimes(2);
    expect(page.byId("sign-in-offline-notice")).toBeNull();
    expect(isOn("Cancel sign-in")).toBe(true);
  });

  it("device sign-in is unavailable: the other way in is offered", async () => {
    mocks.api.startCodexLogin.mockRejectedValueOnce(new CloudApiError("cloud_workspace_device_auth_unavailable", 503));
    await page.show(<CodexSignInScreen />);
    await settle();
    expect(text()).toContain("OpenAI’s device sign-in is not answering right now. Try again in a moment, or use an API key.");
    expect(isOn("Try again")).toBe(true);
    await page.press(button("Use an API key"));
    expect(mocks.router.replace).toHaveBeenCalledWith("/cloud/logins/codex?orgId=org-1&how=api-key");
    await page.press(button("Try again"));
    await settle();
    expect(page.byId("one-time-code")?.textContent).toBe("K7QM-4TXP");
  });

  it("without the admin's authorization nothing is asked: the form asks for it", async () => {
    mocks.params = { orgId: "org-1" };
    await page.show(<CodexSignInScreen />);
    await settle();
    expect(page.byId("redirect")?.textContent).toBe("/cloud/logins/codex?orgId=org-1&how=chatgpt");
    expect(mocks.api.startCodexLogin).not.toHaveBeenCalled();
  });

  it("coming back to the page continues the same login and never starts a second", async () => {
    await page.show(<CodexSignInScreen key="first" />);
    await settle();
    await page.press(button("Open sign-in page"));
    await page.show(<div />);
    await page.show(<CodexSignInScreen key="again" />);
    await settle();
    expect(mocks.api.startCodexLogin).toHaveBeenCalledTimes(1);
    expect(page.byId("one-time-code")?.textContent).toBe("K7QM-4TXP");
    expect(text()).toContain("Waiting for approval…");
  });

  it("two pages at once share the one request for a code", async () => {
    const start = deferred<typeof CODE>();
    mocks.api.startCodexLogin.mockReturnValueOnce(start.promise);
    await page.show(<><CodexSignInScreen key="a" /><CodexSignInScreen key="b" /></>);
    await act(async () => { start.resolve(CODE); await start.promise; });
    await settle();
    expect(mocks.api.startCodexLogin).toHaveBeenCalledTimes(1);
  });

  it("asks only while the page is shown and the app is active", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    await page.show(<CodexSignInScreen />);
    await settle();
    await tick(5000);
    expect(mocks.api.pollCodexLogin).toHaveBeenCalledTimes(1);
    // The app goes to the background: nothing is asked.
    await act(async () => { mocks.appState.currentState = "background"; mocks.appState.listeners.forEach((listener) => listener("background")); });
    await tick(30_000);
    expect(mocks.api.pollCodexLogin).toHaveBeenCalledTimes(1);
    // Back in front: asked again at once, about the same login.
    await act(async () => { mocks.appState.currentState = "active"; mocks.appState.listeners.forEach((listener) => listener("active")); });
    await tick(0);
    expect(mocks.api.pollCodexLogin).toHaveBeenCalledTimes(2);
    expect(mocks.api.pollCodexLogin.mock.calls[1]![1]).toEqual(CODE);
    // The page is left: nothing more is asked.
    await page.show(<div />);
    await tick(30_000);
    expect(mocks.api.pollCodexLogin).toHaveBeenCalledTimes(2);
    expect(mocks.api.startCodexLogin).toHaveBeenCalledTimes(1);
  });
});

describe("a key or token", () => {
  const fill = async () => {
    await page.type(page.byLabel("Claude Code API key"), SECRET);
    await page.type(page.byLabel("Whose account this is"), "alex@example.com");
    await page.press(page.byLabel(AUTHORIZATION));
  };
  beforeEach(() => { mocks.params = { orgId: "org-1", provider: "claude" }; });

  it("Claude Code, empty: Paste, the helper, and Save off until a key and the authorization", async () => {
    await page.show(<LoginProviderScreen />);
    await settle();
    expect(page.byId("screen-title")?.textContent).toBe("Claude Code");
    expect(text()).toContain("How Claude Code signs in on Northwind’s cloud workspaces.");
    expect(page.byLabel("Paste Claude Code API key")).not.toBeNull();
    expect(text()).toContain("Sent once, encrypted, and never shown again. It is checked before it is saved.");
    expect(text()).toContain("optional");
    expect(page.byId("choice-chatgpt")).toBeNull();
    expect(isOn("Save")).toBe(false);
    await page.type(page.byLabel("Claude Code API key"), SECRET);
    expect(isOn("Save")).toBe(false);
    await page.press(page.byLabel(AUTHORIZATION));
    expect(isOn("Save")).toBe(true);
  });

  it("checking: sent once with the authorization and no sharing setting; the page is locked while it is checked", async () => {
    const save = deferred<unknown>();
    mocks.api.saveCredential.mockReturnValueOnce(save.promise);
    await page.show(<LoginProviderScreen />);
    await settle();
    await fill();
    await page.press(button("Save"));
    expect(mocks.api.saveCredential).toHaveBeenCalledTimes(1);
    expect(mocks.api.saveCredential).toHaveBeenCalledWith("org-1", "claude", { authKind: "api-key", secret: SECRET, displayIdentity: "alex@example.com" }, { organizationSharing: true, machineInstallation: true });
    expect(isOn("Checking the key…")).toBe(false);
    expect(text()).not.toContain(SECRET);
    await act(async () => { save.resolve(credential("claude")); await save.promise; });
    await settle();
    expect(mocks.router.back).toHaveBeenCalled();
  });

  it("the key failed the check: the console's sentence, and the field is emptied", async () => {
    mocks.api.saveCredential.mockRejectedValueOnce(new CloudApiError("cloud_workspace_credential_invalid", 422));
    await page.show(<LoginProviderScreen />);
    await settle();
    await fill();
    await page.press(button("Save"));
    await settle();
    expect(text()).toContain("The Claude Code credential failed verification. It may have expired. Paste a fresh key.");
    expect((page.byLabel("Claude Code API key") as HTMLInputElement).value).toBe("");
    expect(isOn("Save")).toBe(false);
    expect(text()).not.toContain(SECRET);
  });

  it("the check could not run: said, and the key stays for another try", async () => {
    mocks.api.saveCredential.mockRejectedValueOnce(new CloudApiError("cloud_workspace_credential_verification_unavailable", 503));
    await page.show(<LoginProviderScreen />);
    await settle();
    await fill();
    await page.press(button("Save"));
    await settle();
    expect(page.byId("login-notice")?.textContent).toBe("Verification is temporarily unavailable. The key was not saved. Try again in a moment.");
    expect(isOn("Save")).toBe(true);
    await page.press(button("Save"));
    await settle();
    expect(mocks.api.saveCredential).toHaveBeenCalledTimes(2);
    expect(mocks.api.saveCredential.mock.calls[1]![2]).toMatchObject({ secret: SECRET });
  });

  it("a code the board has no sentence for gets the generic one, never the code", async () => {
    mocks.api.saveCredential.mockRejectedValueOnce(new CloudApiError("cloud_something_new", 400));
    await page.show(<LoginProviderScreen />);
    await settle();
    await fill();
    await page.press(button("Save"));
    await settle();
    expect(page.byId("login-notice")?.textContent).toBe("That did not work. Try again in a moment.");
    expect(text()).not.toContain("cloud_something_new");
  });

  it("GitHub: the same form, for a personal access token", async () => {
    mocks.params = { orgId: "org-1", provider: "github" };
    await page.show(<LoginProviderScreen />);
    await settle();
    expect(text()).toContain("What clones private repositories into Northwind’s cloud workspaces.");
    expect(page.byLabel("GitHub personal access token")).not.toBeNull();
    expect(isOn("Save")).toBe(false);
    await page.type(page.byLabel("GitHub personal access token"), SECRET);
    await page.press(page.byLabel(AUTHORIZATION));
    await page.press(button("Save"));
    await settle();
    expect(mocks.api.saveCredential).toHaveBeenCalledWith("org-1", "github", { authKind: "personal-access-token", secret: SECRET, displayIdentity: null }, { organizationSharing: true, machineInstallation: true });
  });

  it("the secret reaches no log, no navigation and no page text", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "info")];
    mocks.api.saveCredential.mockRejectedValueOnce(new CloudApiError("cloud_workspace_credential_invalid", 422));
    await page.show(<LoginProviderScreen />);
    await settle();
    await fill();
    await page.press(button("Save"));
    await settle();
    const everything = JSON.stringify([...logs.flatMap((spy) => spy.mock.calls), mocks.router.push.mock.calls, mocks.router.replace.mock.calls, mocks.alert.mock.calls, page.container.innerHTML]);
    expect(everything).not.toContain(SECRET);
    logs.forEach((spy) => spy.mockRestore());
  });
});

describe("a saved login", () => {
  it("connected: present by its fingerprint, with Replace and Revoke", async () => {
    mocks.params = { orgId: "org-1", provider: "claude" };
    mocks.api = client([credential("claude", { displayIdentity: "alex@example.com" })]);
    await page.show(<LoginProviderScreen />);
    await settle();
    expect(page.byId("header-title")?.textContent).toBe("Claude Code" + "Northwind");
    expect(page.byLabel("Account: alex@example.com")).not.toBeNull();
    expect(page.byLabel("Key: sha256:5be2d913")).not.toBeNull();
    expect(page.byLabel("Updated: 23 Nov 2026")).not.toBeNull();
    expect(text()).toContain("The login itself is never shown again. The line above is a fingerprint, to tell one login from another.");
    expect(isOn("Replace")).toBe(true);
    expect(isOn("Revoke…")).toBe(true);
    expect(button("Remove…")).toBeNull();
    await page.press(button("Replace"));
    expect(page.byLabel("Claude Code API key")).not.toBeNull();
  });

  it("sign-in required: OpenAI's sentence, and Sign in again starts the device login", async () => {
    mocks.params = { orgId: "org-1", provider: "codex" };
    mocks.api = client([credential("codex", { authKind: "oauth-credentials-json", state: "sign-in-required", displayIdentity: "alex@example.com" })]);
    await page.show(<LoginProviderScreen />);
    await settle();
    expect(page.byId("login-sign-in-required")?.textContent).toBe("OpenAI no longer accepts this login. Sign in again to keep Codex working in Northwind’s workspaces.");
    expect(isOn("Sign in again")).toBe(true);
    expect(isOn("Revoke…")).toBe(true);
    await page.press(button("Sign in again"));
    expect(page.byId("choice-chatgpt")?.getAttribute("aria-selected")).toBe("true");
    expect(button("Get a sign-in code")).not.toBeNull();
  });

  it("revoke asks first, with the owner's sentence word for word", async () => {
    mocks.params = { orgId: "org-1", provider: "claude" };
    mocks.api = client([credential("claude")]);
    await page.show(<LoginProviderScreen />);
    await settle();
    await page.press(button("Revoke…"));
    expect(mocks.alert.mock.calls[0]![0]).toBe("Revoke Claude Code’s login?");
    expect(mocks.alert.mock.calls[0]![1]).toBe("New workspaces and new sessions stop getting it. Sessions already running keep the access they were given until it expires.");
    expect(REVOKE_TEXT).toBe("New workspaces and new sessions stop getting it. Sessions already running keep the access they were given until it expires.");
    expect(mocks.api.revokeCredential).not.toHaveBeenCalled();
    mocks.api.credentials.mockResolvedValue([credential("claude", { state: "revoked" })]);
    await act(async () => { alertButton("Revoke").onPress!(); });
    await settle();
    expect(mocks.api.revokeCredential).toHaveBeenCalledWith("org-1", "claude");
    expect(isOn("Remove…")).toBe(true);
  });

  it("remove asks first, once a login is revoked; removed, the page goes back", async () => {
    mocks.params = { orgId: "org-1", provider: "cursor" };
    mocks.api = client([credential("cursor", { state: "revoked" })]);
    await page.show(<LoginProviderScreen />);
    await settle();
    expect(isOn("Replace")).toBe(true);
    await page.press(button("Remove…"));
    expect(mocks.alert.mock.calls[0]![0]).toBe("Remove Cursor’s login?");
    expect(mocks.alert.mock.calls[0]![1]).toBe("The stored key is deleted. Cursor shows as not connected until a new key is saved.");
    await act(async () => { alertButton("Remove").onPress!(); });
    await settle();
    expect(mocks.api.deleteCredential).toHaveBeenCalledWith("org-1", "cursor");
    expect(mocks.router.back).toHaveBeenCalled();
  });

  it("remove refused: still in use, in the board's words", async () => {
    mocks.params = { orgId: "org-1", provider: "cursor" };
    mocks.api = client([credential("cursor", { state: "revoked" })]);
    mocks.api.deleteCredential.mockRejectedValueOnce(new CloudApiError("cloud_workspace_credential_in_use", 409));
    await page.show(<LoginProviderScreen />);
    await settle();
    await page.press(button("Remove…"));
    await act(async () => { alertButton("Remove").onPress!(); });
    await settle();
    expect(mocks.alert.mock.calls[1]![0]).toBe("Still in use");
    expect(mocks.alert.mock.calls[1]![1]).toBe("A workspace that is running was set up with this login. Delete that workspace first, or replace the login instead.");
    expect(mocks.router.back).not.toHaveBeenCalled();
  });
});
