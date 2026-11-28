// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentLoginScreen from "../app/agent-logins/[provider]";
import { CODEX_LOGIN_ITEM } from "./cloud/codex-login";
import { LOGIN_CONSENT } from "./cloud/logins";
import { credential, DEVICE, loginService, NOW, offline, ORG, refuse } from "./cloud/testing/login-service";
import { themePalette } from "./ui/theme";
import { appearance, stage } from "./ui/testing/kit";

// PRO-529, board 25.04: one agent's login on the phone, against the service's own answers.
const mocks = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  push: vi.fn(), back: vi.fn(), dismissTo: vi.fn(),
  catalog: null as any,
  userId: "user-1" as string | null,
  keychain: new Map<string, string>(),
  browser: vi.fn(async (_url: string) => ({ type: "opened" })),
  clipboard: "",
  alert: vi.fn(),
  appState: new Set<(state: string) => void>(),
}));
vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  return {
    // The header as the stack draws it: its title view, and whether the page can be left by its back button.
    Stack: { Screen: ({ options }: { options: { title: string; headerBackVisible?: boolean; gestureEnabled?: boolean; headerTitle?: () => ReactNode } }) => <div data-testid="screen-header" data-title={options.title} data-back={String(options.headerBackVisible !== false)} data-swipe={String(options.gestureEnabled !== false)}>{options.headerTitle?.()}</div> },
    useLocalSearchParams: () => mocks.params,
    useRouter: () => ({ push: mocks.push, back: mocks.back, dismissTo: mocks.dismissTo }),
    // The page is in front for as long as it is drawn.
    useFocusEffect: (run: () => void | (() => void)) => { useEffect(() => run(), [run]); },
  };
});
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: async (name: string) => mocks.keychain.get(name) ?? null,
  setItemAsync: async (name: string, value: string) => { mocks.keychain.set(name, value); },
  deleteItemAsync: async (name: string) => { mocks.keychain.delete(name); },
}));
vi.mock("expo-web-browser", () => ({ openBrowserAsync: mocks.browser }));
vi.mock("expo-clipboard", () => ({ getStringAsync: async () => mocks.clipboard, setStringAsync: async () => true }));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => ({ session: mocks.userId ? { user: { userId: mocks.userId } } : null }) }));
vi.mock("@mobile/cloud/CloudProvider", () => ({ useCloudCatalog: () => mocks.catalog, useCatalogSnapshot: (catalog: any) => catalog?.getSnapshot() ?? { organizations: [] } }));
vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()));
vi.mock("lucide-react-native", async () => (await import("@mobile/ui/testing/kit")).namedIcons());
vi.mock("react-native", async () => {
  const native = await import("@mobile/ui/testing/native");
  return {
    ...native,
    KeyboardAvoidingView: native.View,
    ActivityIndicator: () => <i data-busy="true" />,
    Keyboard: { addListener: () => ({ remove: () => undefined }) },
    Alert: { alert: mocks.alert },
    AppState: { addEventListener: (_type: string, listener: (state: string) => void) => { mocks.appState.add(listener); return { remove: () => { mocks.appState.delete(listener); } }; } },
  };
});

const page = stage();
// The boards' palettes: Ember when dark, Den when light.
const ember = themePalette("Ember", "dark");
let service: ReturnType<typeof loginService>;
const organization = (role = "owner") => ({ organization: { orgId: ORG, name: "Northwind", role, isPersonal: false }, workspaces: [] });
function serve(stored: Parameters<typeof loginService>[0] = [], provider = "codex", params: Record<string, string> = {}) {
  service = loginService(stored);
  mocks.catalog = { api: service.api, getSnapshot: () => ({ organizations: [organization()] }) };
  mocks.params = { orgId: ORG, provider, ...params };
}
const pass = (milliseconds = 0) => act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
const open = async () => { await page.show(<AgentLoginScreen />); await pass(); };
const text = () => page.container.textContent ?? "";
const button = (label: string) => [...page.container.querySelectorAll<HTMLElement>('[role="button"]')].find((element) => element.textContent === label) ?? null;
const off = (label: string) => button(label)?.getAttribute("aria-disabled") === "true";
const press = async (label: string) => { await page.press(button(label)); await pass(); };
const consent = () => page.byLabel(LOGIN_CONSENT) as HTMLInputElement;
const agree = async () => { await act(async () => { consent().click(); }); };
const header = () => page.byId("screen-header")!;
const notice = () => page.byId("codex-sign-in-notice");
const code = () => page.byId("one-time-code");
const polls = () => service.sent("POST", "/codex/device-poll");
const answerAlert = async (label: string) => {
  const buttons = mocks.alert.mock.calls.at(-1)![2] as { text: string; onPress?: () => void }[];
  await act(async () => { buttons.find((entry) => entry.text === label)!.onPress?.(); });
  await pass();
};
const background = async (state: string) => { await act(async () => { for (const listener of [...mocks.appState]) listener(state); }); await pass(); };
/** A code on the page, as after choosing ChatGPT, authorizing, and asking for it. */
async function withCode() {
  serve();
  await open();
  await agree();
  await press("Get a sign-in code");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.push.mockReset(); mocks.back.mockReset(); mocks.dismissTo.mockReset(); mocks.alert.mockReset();
  mocks.browser.mockReset().mockResolvedValue({ type: "opened" });
  mocks.keychain.clear(); mocks.appState.clear();
  mocks.clipboard = ""; mocks.userId = "user-1";
});
afterEach(() => { vi.useRealTimers(); });

describe("Codex: sign in with ChatGPT", () => {
  it("asks for the authorization before any code is asked for", async () => {
    serve();
    await open();
    expect(header().textContent).toBe("Codex");
    expect(text()).toContain("How Codex signs in on Northwind’s cloud workspaces.");
    expect(page.byLabel("Sign in with ChatGPT")!.getAttribute("aria-selected")).toBe("true");
    expect(text()).toContain("Needs “Allow device code login” switched on in ChatGPT’s security settings.");
    expect(consent().checked).toBe(false);
    expect(off("Get a sign-in code")).toBe(true);
    await press("Get a sign-in code");
    expect(service.starts).toBe(0);
    await agree();
    expect(off("Get a sign-in code")).toBe(false);
  });

  it("says a code is on its way, and can be left before it arrives", async () => {
    serve();
    let arrive!: () => void;
    service.on("POST", "/codex/device-start", () => new Promise((resolve) => { arrive = () => resolve({ body: DEVICE }); }));
    await open();
    await agree();
    await press("Get a sign-in code");
    expect(header().dataset.title).toBe("Sign in with ChatGPT");
    expect(page.byLabel("Getting a code from OpenAI…")!.getAttribute("role")).toBe("progressbar");
    expect(header().dataset.back).toBe("false");
    await press("Cancel");
    expect(button("Get a sign-in code")).not.toBeNull();
    arrive();
    await pass();
    // The code that arrived late is stopped, and never shown.
    expect(code()).toBeNull();
    expect(service.sent("POST", "/codex/device-cancel")).toHaveLength(1);
  });

  it("shows the code with its time left and the way to OpenAI's page", async () => {
    await withCode();
    expect(code()!.textContent).toBe("K7QM-4TXP");
    expect(page.byId("one-time-code-expiry")!.textContent).toBe("expires in 15:00");
    expect(text()).toContain("Open OpenAI’s sign-in page, sign in with the ChatGPT account the organization pays for, and enter this code. Then come back here.");
    // The one primary action: the accent fill.
    expect(page.styleOf(button("Open sign-in page")).backgroundColor).toBe(ember.accent);
    expect(page.styleOf(button("Cancel sign-in")).backgroundColor).toBe(ember.raised);
    expect(button("Cancel sign-in")).not.toBeNull();
    // Not left by the back button while a code is good: Cancel sign-in is the way out.
    expect(header().dataset.back).toBe("false");
    expect(header().dataset.swipe).toBe("false");
  });

  it("waiting: opens OpenAI's page, keeps the code in view, and asks until the answer comes", async () => {
    await withCode();
    await press("Open sign-in page");
    expect(mocks.browser).toHaveBeenCalledExactlyOnceWith("https://auth.openai.com/codex/device");
    expect(page.byLabel("Waiting for approval… Open the link, sign in, and enter the code.")).not.toBeNull();
    expect(code()!.textContent).toBe("K7QM-4TXP");
    expect(button("Open sign-in page again")).not.toBeNull();
    expect(button("Open sign-in page")).toBeNull();
    await pass(5_000);
    expect(polls()).toHaveLength(1);
    expect(polls()[0]!.body).toEqual({ attemptId: "attempt_1", deviceAuthId: "device-auth-1", userCode: "K7QM-4TXP", confirmOrganizationSharing: true, confirmMachineInstallation: true });
    await pass(10_000);
    expect(polls()).toHaveLength(3);
    expect(page.byLabel("Waiting for approval… Open the link, sign in, and enter the code.")).not.toBeNull();
    expect(page.byId("one-time-code-expiry")!.textContent).toBe("expires in 14:45");
  });

  it("connected: says whose plan it is, and Done goes back", async () => {
    await withCode();
    await press("Open sign-in page");
    service.device = "complete";
    await pass(5_000);
    expect(text()).toContain("Codex connected as alex@example.com.");
    expect(text()).toContain("Northwind’s cloud workspaces sign Codex in with this ChatGPT plan.");
    expect(page.icon("CircleCheck")!.dataset.color).toBe(ember.success);
    expect(code()).toBeNull();
    expect(header().dataset.back).toBe("true");
    expect(mocks.keychain.has(CODEX_LOGIN_ITEM)).toBe(false);
    await press("Done");
    expect(mocks.back).toHaveBeenCalledTimes(1);
    await pass(60_000);
    expect(polls()).toHaveLength(1);
  });

  it("expired code: struck through, with the console's sentence and a new code one tap away", async () => {
    await withCode();
    await pass(900_000);
    expect(notice()!.textContent).toBe("The code expired. Start device login again.");
    expect(notice()!.getAttribute("role")).toBe("alert");
    expect(page.styleOf(code())).toMatchObject({ textDecorationLine: "line-through" });
    expect(page.byId("one-time-code-expiry")).toBeNull();
    expect(page.byLabel("Copy code")).toBeNull();
    expect(button("Cancel sign-in")).toBeNull();
    const asked = polls().length;
    await pass(60_000);
    expect(polls()).toHaveLength(asked);
    await press("Get a new code");
    expect(service.starts).toBe(2);
    expect(page.byId("one-time-code-expiry")!.textContent).toBe("expires in 15:00");
  });

  it("expired code: the service's word for it ends the wait too", async () => {
    await withCode();
    service.device = "expired";
    await pass(5_000);
    expect(notice()!.textContent).toBe("The code expired. Start device login again.");
  });

  it("cancelled: asks first, tells the service, and saves nothing", async () => {
    await withCode();
    await press("Cancel sign-in");
    expect(mocks.alert).toHaveBeenCalledExactlyOnceWith("Cancel this sign-in?", "The code stops working. Nothing is saved.", [expect.objectContaining({ text: "Cancel sign-in", style: "destructive" }), expect.objectContaining({ text: "Keep waiting", style: "cancel" })]);
    expect(service.sent("POST", "/codex/device-cancel")).toHaveLength(0);
    await answerAlert("Cancel sign-in");
    expect(service.sent("POST", "/codex/device-cancel")[0]!.body).toEqual({ attemptId: "attempt_1", deviceAuthId: "device-auth-1", userCode: "K7QM-4TXP" });
    expect(notice()!.textContent).toBe("Sign-in canceled. Nothing was saved.");
    expect(notice()!.getAttribute("role")).toBeNull();
    expect(page.styleOf(code())).toMatchObject({ textDecorationLine: "line-through" });
    expect(header().dataset.back).toBe("true");
    expect(mocks.keychain.has(CODEX_LOGIN_ITEM)).toBe(false);
    await pass(60_000);
    expect(polls()).toHaveLength(0);
    await press("Back to agent logins");
    expect(mocks.dismissTo).toHaveBeenCalledExactlyOnceWith({ pathname: "/agent-logins", params: { orgId: ORG } });
  });

  it("cancelled: Keep waiting changes nothing", async () => {
    await withCode();
    await press("Cancel sign-in");
    await answerAlert("Keep waiting");
    expect(service.sent("POST", "/codex/device-cancel")).toHaveLength(0);
    expect(page.byId("one-time-code-expiry")).not.toBeNull();
    await pass(5_000);
    expect(polls()).toHaveLength(1);
  });

  it("cancelled too late: a sign-in approved first is kept and shown", async () => {
    await withCode();
    service.on("POST", "/codex/device-cancel", () => ({ body: { status: "connected" } }));
    service.device = "complete";
    await press("Cancel sign-in");
    await answerAlert("Cancel sign-in");
    expect(text()).toContain("Codex connected as alex@example.com.");
  });

  it("refused: OpenAI's no is said in the console's words, with the code struck through", async () => {
    await withCode();
    service.device = "failed";
    await pass(5_000);
    expect(notice()!.textContent).toBe("Device login failed. Start it again.");
    expect(notice()!.getAttribute("role")).toBe("alert");
    expect(page.styleOf(notice()).borderColor).toBe(`${ember.danger}57`);
    expect(page.styleOf(code())).toMatchObject({ textDecorationLine: "line-through" });
    expect(button("Back to agent logins")).toBeNull();
    await pass(60_000);
    expect(polls()).toHaveLength(1);
    await press("Get a new code");
    expect(service.starts).toBe(2);
  });

  it("refused: someone who is no longer an admin is told so", async () => {
    await withCode();
    service.on("POST", "/codex/device-poll", () => refuse("organization_admin_required", 403));
    await pass(5_000);
    expect(notice()!.textContent).toBe("Only an organization owner or administrator can manage agent logins.");
  });

  it("no network while waiting: says until when the code is good, and carries on by itself", async () => {
    await withCode();
    service.on("POST", "/codex/device-poll", offline);
    await pass(5_000);
    const until = new Date(NOW + 900_000);
    expect(notice()!.textContent).toBe(`Offline. The code is still good until ${until.getHours()}:${String(until.getMinutes()).padStart(2, "0")}; this page carries on when the phone is back online.`);
    expect(page.icon("WifiOff")).not.toBeNull();
    expect(code()!.textContent).toBe("K7QM-4TXP");
    expect(off("Cancel sign-in")).toBe(true);
    expect(button("Open sign-in page")).toBeNull();
    // U-09: while offline, users are not trapped — back button, swipe gesture, and Leave for now are enabled.
    expect(header().dataset.back).toBe("true");
    expect(header().dataset.swipe).toBe("true");
    expect(button("Leave for now")).not.toBeNull();
    expect(off("Leave for now")).toBe(false);
    service.restore("POST", "/codex/device-poll");
    await pass(5_000);
    expect(notice()).toBeNull();
    expect(button("Open sign-in page")).not.toBeNull();
    expect(header().dataset.back).toBe("false");
    expect(header().dataset.swipe).toBe("false");
  });

  it("offline while waiting: Leave for now returns to agent logins without clearing the saved attempt", async () => {
    await withCode();
    service.on("POST", "/codex/device-poll", offline);
    await pass(5_000);
    await press("Leave for now");
    expect(mocks.dismissTo).toHaveBeenCalledExactlyOnceWith({ pathname: "/agent-logins", params: { orgId: ORG } });
    expect(mocks.keychain.has(CODEX_LOGIN_ITEM)).toBe(true);
  });

  it("device sign-in unavailable: offers another try and the other way in", async () => {
    serve();
    service.on("POST", "/codex/device-start", () => refuse("cloud_workspace_device_auth_unavailable", 503));
    await open();
    await agree();
    await press("Get a sign-in code");
    expect(notice()!.textContent).toBe("OpenAI’s device sign-in is not answering right now. Try again in a moment, or use an API key.");
    expect(code()).toBeNull();
    expect(header().dataset.back).toBe("true");
    service.restore("POST", "/codex/device-start");
    await press("Use an API key");
    expect(page.byLabel("API key")!.getAttribute("aria-selected")).toBe("true");
    expect(page.byLabel("Codex API key")).not.toBeNull();
    // The authorization given for the sign-in stands for the key too.
    expect(consent().checked).toBe(true);
  });

  it("leaving the app and coming back carries on with the same code: nothing is asked meanwhile, and no second login starts", async () => {
    await withCode();
    await background("background");
    await pass(120_000);
    expect(polls()).toHaveLength(0);
    await background("active");
    expect(polls()).toHaveLength(1);
    expect(code()!.textContent).toBe("K7QM-4TXP");
    expect(service.starts).toBe(1);
  });

  it("the app closed and opened again: the page opens on the same code, waiting", async () => {
    await withCode();
    await press("Open sign-in page");
    const kept = mocks.keychain.get(CODEX_LOGIN_ITEM)!;
    expect(JSON.parse(kept)).toMatchObject({ userId: "user-1", orgId: ORG, opened: true, login: { userCode: "K7QM-4TXP" } });
    // A new run of the app: a new page, a new client, the same keychain.
    await page.show(null);
    await pass(60_000);
    serve();
    await open();
    expect(header().dataset.title).toBe("Sign in with ChatGPT");
    expect(code()!.textContent).toBe("K7QM-4TXP");
    expect(page.byId("one-time-code-expiry")!.textContent).toBe("expires in 14:00");
    expect(page.byLabel("Waiting for approval… Open the link, sign in, and enter the code.")).not.toBeNull();
    expect(service.starts).toBe(0);
    expect(polls()).toHaveLength(1);
  });

  it("an attempt kept by another person is dropped, not carried on", async () => {
    await withCode();
    await page.show(null);
    mocks.userId = "user-2";
    serve();
    await open();
    expect(code()).toBeNull();
    expect(button("Get a sign-in code")).not.toBeNull();
    expect(mocks.keychain.has(CODEX_LOGIN_ITEM)).toBe(false);
    expect(polls()).toHaveLength(0);
  });

  it("is drawn in the light palette too", async () => {
    appearance.scheme = "light";
    await withCode();
    expect(page.styleOf(code())).toMatchObject({ color: themePalette("Den", "light").ink, backgroundColor: themePalette("Den", "light").raised });
  });
});

describe("a key or token", () => {
  const field = () => page.byLabel("Claude Code API key") as HTMLInputElement;
  const SECRET = "sk-ant-api03-phone-test-key";

  it("is empty with Save off until a key is entered and the authorization is given", async () => {
    serve([], "claude");
    await open();
    expect(header().textContent).toBe("Claude Code");
    expect(text()).toContain("How Claude Code signs in on Northwind’s cloud workspaces.");
    expect(text()).toContain("Sent once, encrypted, and never shown again. It is checked before it is saved.");
    expect(field().type).toBe("password");
    expect(page.byLabel("Paste Claude Code API key")).not.toBeNull();
    expect(page.byLabel("Whose account this is")!.getAttribute("placeholder")).toBe("A name or email, shown to admins");
    expect(off("Save")).toBe(true);
    await page.type(field(), SECRET);
    expect(off("Save")).toBe(true);
    await agree();
    expect(off("Save")).toBe(false);
    await act(async () => { consent().click(); });
    expect(off("Save")).toBe(true);
    expect(service.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });

  it("sends the key once with both confirmations, and empties the field the moment it is sent", async () => {
    serve([], "claude");
    let answer!: () => void;
    service.on("PUT", "/claude", () => new Promise((resolve) => { answer = () => resolve({ body: credential("claude", { displayIdentity: "alex@example.com" }) }); }));
    await open();
    await page.type(field(), `  ${SECRET}\n`);
    await page.type(page.byLabel("Whose account this is"), " alex@example.com ");
    await agree();
    await press("Save");
    // Sent, not yet answered: the phone already holds nothing of it.
    expect(service.sent("PUT", "/claude")).toHaveLength(1);
    expect(service.sent("PUT", "/claude")[0]!.body).toEqual({ authKind: "api-key", secret: SECRET, displayIdentity: "alex@example.com", confirmOrganizationSharing: true, confirmMachineInstallation: true });
    expect(field().value).toBe("");
    expect(page.container.innerHTML).not.toContain(SECRET);
    expect(button("Checking the key…")).not.toBeNull();
    expect(off("Checking the key…")).toBe(true);
    expect(field().disabled).toBe(true);
    expect(mocks.back).not.toHaveBeenCalled();
    await act(async () => { answer(); });
    await pass();
    expect(mocks.back).toHaveBeenCalledTimes(1);
    expect(service.sent("PUT", "/claude")).toHaveLength(1);
    expect(page.container.innerHTML).not.toContain(SECRET);
  });

  it("a pasted key is only ever dots", async () => {
    serve([], "claude");
    mocks.clipboard = `${SECRET}\n`;
    await open();
    await page.press(page.byLabel("Paste Claude Code API key"));
    await pass();
    expect(page.container.innerHTML).not.toContain(SECRET);
    expect(text()).toContain("•".repeat(24));
    await agree();
    await press("Save");
    expect(service.sent("PUT", "/claude")[0]!.body.secret).toBe(SECRET);
    expect(text()).not.toContain("•".repeat(24));
  });

  it("the key failed the check: the console's sentence under an emptied field", async () => {
    serve([], "claude");
    service.on("PUT", "/claude", () => refuse("cloud_workspace_credential_invalid", 422));
    await open();
    await page.type(field(), SECRET);
    await agree();
    await press("Save");
    const said = [...page.container.querySelectorAll('[role="alert"]')].map((element) => element.textContent);
    expect(said).toEqual(["The Claude Code credential failed verification. It may have expired. Paste a fresh key."]);
    expect(field().value).toBe("");
    expect(field().disabled).toBe(false);
    expect(off("Save")).toBe(true);
    expect(consent().checked).toBe(true);
    expect(mocks.back).not.toHaveBeenCalled();
    // A fresh key takes the sentence away.
    await page.type(field(), "sk-ant-fresh");
    expect(page.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("the check could not run: says the key was not saved", async () => {
    serve([], "claude");
    service.on("PUT", "/claude", () => refuse("cloud_workspace_credential_verification_unavailable", 503));
    await open();
    await page.type(field(), SECRET);
    await agree();
    await press("Save");
    expect(page.byId("login-key-problem")!.textContent).toBe("Verification is temporarily unavailable. The key was not saved. Try again in a moment.");
    expect(field().value).toBe("");
    expect(page.container.innerHTML).not.toContain(SECRET);
    expect(button("Save")).not.toBeNull();
  });

  it("no answer at all: does not claim the key was or was not saved", async () => {
    serve([], "claude");
    service.on("PUT", "/claude", offline);
    await open();
    await page.type(field(), SECRET);
    await agree();
    await press("Save");
    expect(page.byId("login-key-problem")!.textContent).toBe("The service could not be reached. The key may not have been saved: check Claude Code in Agent logins before trying again.");
    expect(field().value).toBe("");
  });

  it.each([
    ["cursor", "Cursor API key", "How Cursor signs in on Northwind’s cloud workspaces.", "api-key"],
    ["github", "GitHub personal access token", "What clones private repositories into Northwind’s cloud workspaces.", "personal-access-token"],
  ])("is the same form for %s, with its own label", async (provider, label, purpose, authKind) => {
    serve([], provider);
    await open();
    expect(text()).toContain(purpose);
    await page.type(page.byLabel(label), "secret-value-1234");
    await agree();
    await press("Save");
    expect(service.sent("PUT", `/${provider}`)[0]!.body).toEqual({ authKind, secret: "secret-value-1234", displayIdentity: null, confirmOrganizationSharing: true, confirmMachineInstallation: true });
  });

  it("GitHub's check says token, not key", async () => {
    serve([], "github");
    service.on("PUT", "/github", () => refuse("cloud_workspace_credential_invalid", 422));
    await open();
    await page.type(page.byLabel("GitHub personal access token"), "ghp_example");
    await agree();
    await press("Save");
    expect(page.container.querySelector('[role="alert"]')!.textContent).toBe("The GitHub credential failed verification. It may have expired. Paste a fresh token.");
  });

  it("Codex takes an API key through the same form, chosen beside the ChatGPT sign-in", async () => {
    serve();
    await open();
    await page.press(page.byLabel("API key"));
    expect(page.byLabel("API key")!.getAttribute("data-hint")).toBe("Billed per token by OpenAI.");
    expect(button("Get a sign-in code")).toBeNull();
    await page.type(page.byLabel("Codex API key"), "sk-codex-example");
    await agree();
    await press("Save");
    expect(service.sent("PUT", "/codex")[0]!.body).toMatchObject({ authKind: "api-key", secret: "sk-codex-example" });
    expect(service.starts).toBe(0);
  });
});

describe("a saved login", () => {
  const claude = credential("claude", { displayIdentity: "alex@example.com" });
  const facts = () => [...page.byId("saved-login-facts")!.children].map((row) => row.getAttribute("aria-label"));

  it("shows what it is by its fingerprint, never the login", async () => {
    serve([claude], "claude");
    await open();
    expect(header().getAttribute("data-title")).toBe("Claude Code");
    expect(header().textContent).toBe("Claude CodeNorthwind");
    expect(page.byLabel("Claude Code, Connected, API key")).not.toBeNull();
    expect(facts()).toEqual(["Account: alex@example.com", "Key: sha256:5be2d913", "Updated: 23 Nov 2026"]);
    expect(text()).toContain("The login itself is never shown again. The line above is a fingerprint, to tell one login from another.");
    expect(button("Replace")).not.toBeNull();
    expect(button("Revoke…")).not.toBeNull();
    expect(button("Remove…")).toBeNull();
  });

  it("Replace opens the form again, over the saved login", async () => {
    serve([claude], "claude");
    await open();
    await press("Replace");
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith({ pathname: "/agent-logins/[provider]", params: { provider: "claude", orgId: ORG, replace: "1" } });
    serve([claude], "claude", { replace: "1" });
    await open();
    expect(page.byId("saved-login")).toBeNull();
    expect(page.byLabel("Claude Code API key")).not.toBeNull();
  });

  it("Revoke asks first, then keeps the row as revoked and offers Remove", async () => {
    serve([claude], "claude");
    await open();
    await press("Revoke…");
    expect(mocks.alert).toHaveBeenCalledExactlyOnceWith("Revoke Claude Code’s login?", "Workspaces no longer receive it. Replace it to use this agent again.", [expect.objectContaining({ text: "Cancel", style: "cancel" }), expect.objectContaining({ text: "Revoke", style: "destructive" })]);
    expect(service.sent("POST", "/claude/revoke")).toHaveLength(0);
    await answerAlert("Revoke");
    expect(service.sent("POST", "/claude/revoke")).toHaveLength(1);
    expect(page.byLabel("Claude Code, Revoked, API key")).not.toBeNull();
    expect(button("Revoke…")).toBeNull();
    expect(button("Remove…")).not.toBeNull();
    expect(button("Replace")).not.toBeNull();
  });

  it("Remove asks first, deletes the stored key, and goes back to the list", async () => {
    serve([credential("cursor", { state: "revoked" })], "cursor");
    await open();
    await press("Remove…");
    expect(mocks.alert).toHaveBeenCalledExactlyOnceWith("Remove Cursor’s login?", "The stored key is deleted. Cursor shows as not connected until a new key is saved.", [expect.objectContaining({ text: "Cancel" }), expect.objectContaining({ text: "Remove", style: "destructive" })]);
    await answerAlert("Remove");
    expect(service.calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([`/v1/mobile/orgs/${ORG}/cloud-workspace-credentials/cursor`]);
    expect(mocks.back).toHaveBeenCalledTimes(1);
  });

  it("Remove refused while a workspace was set up with the login: says so, and changes nothing", async () => {
    serve([credential("cursor", { state: "revoked" })], "cursor");
    service.on("DELETE", "/cursor", () => refuse("cloud_workspace_credential_in_use", 409));
    await open();
    await press("Remove…");
    await answerAlert("Remove");
    expect(mocks.alert).toHaveBeenLastCalledWith("Still in use", "A workspace was set up with this login. Delete that workspace first, or replace the login instead.", [{ text: "OK" }]);
    expect(mocks.back).not.toHaveBeenCalled();
    expect(page.byLabel("Cursor, Revoked, API key")).not.toBeNull();
    expect(off("Remove…")).toBe(false);
  });

  it("a revoke that did not reach the service is said, and nothing is shown as changed", async () => {
    serve([claude], "claude");
    service.on("POST", "/claude/revoke", offline);
    await open();
    await press("Revoke…");
    await answerAlert("Revoke");
    expect(page.byId("saved-login-problem")!.textContent).toBe("The service could not be reached. Nothing was changed.");
    expect(page.byLabel("Claude Code, Connected, API key")).not.toBeNull();
  });

  it("sign-in required: says who stopped accepting it, and signing in again starts from the authorization", async () => {
    serve([credential("codex", { authKind: "oauth-credentials-json", displayIdentity: "alex@example.com", state: "sign-in-required" })]);
    await open();
    expect(page.byLabel("Codex, Sign-in required, Subscription login")).not.toBeNull();
    expect(page.byId("saved-login-notice")!.textContent).toBe("OpenAI no longer accepts this login. Sign in again to keep Codex working in Northwind’s workspaces.");
    expect(facts()).toEqual(["Account: alex@example.com", "Key: sha256:5be2d913", "Updated: 23 Nov 2026"]);
    expect(button("Revoke…")).not.toBeNull();
    await press("Sign in again");
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith({ pathname: "/agent-logins/[provider]", params: { provider: "codex", orgId: ORG, replace: "1" } });
    expect(service.starts).toBe(0);
  });

  it("a key its issuer stopped accepting is replaced, not signed in again", async () => {
    serve([credential("claude", { state: "sign-in-required" })], "claude");
    await open();
    expect(page.byId("saved-login-notice")!.textContent).toBe("Anthropic no longer accepts this login. Replace it to keep Claude Code working in Northwind’s workspaces.");
    expect(button("Replace")).not.toBeNull();
    expect(button("Sign in again")).toBeNull();
  });
});

describe("who and what may be shown", () => {
  it("tells a member who manages agent logins, and offers no form", async () => {
    serve([], "claude");
    service.on("GET", "", () => refuse("organization_admin_required", 403));
    await open();
    expect(page.byId("agent-logins-member")!.textContent).toBe("Owners and admins manage agent logins. You use them when you launch a workspace in Northwind.");
    expect(page.container.querySelector("input")).toBeNull();
  });

  it("says when the logins could not be read, and reads again on Try again", async () => {
    serve([credential("claude")], "claude");
    service.on("GET", "", offline);
    await open();
    expect(text()).toContain("Agent logins could not be read");
    expect(text()).toContain("The service could not be reached. Nothing was changed.");
    service.restore("GET", "");
    await press("Try again");
    expect(page.byId("saved-login")).not.toBeNull();
  });

  it("knows only the four logins the service keeps", async () => {
    serve([], "gemini");
    await open();
    expect(text()).toContain("Login unavailable");
    expect(service.calls).toHaveLength(0);
  });

  it("shows nothing of an organization that is not on the account", async () => {
    serve([], "claude");
    mocks.params = { orgId: "org-other", provider: "claude" };
    await open();
    expect(text()).toContain("Organization unavailable");
    expect(service.calls).toHaveLength(0);
  });
});
