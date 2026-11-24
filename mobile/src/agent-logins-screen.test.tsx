// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AgentLoginsScreen from "../app/agent-logins/index";
import { credential, loginService, NOW, offline, ORG, refuse } from "./cloud/testing/login-service";
import { stage } from "./ui/testing/kit";

// PRO-529, board 25.04 "The list": an organization's agent logins and their state.
const mocks = vi.hoisted(() => ({ params: {} as Record<string, string>, push: vi.fn(), catalog: null as any, focus: new Set<() => void>() }));
vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  return {
    Stack: { Screen: ({ options }: { options: { title: string; headerTitle?: () => ReactNode } }) => <div data-testid="screen-header" data-title={options.title}>{options.headerTitle?.()}</div> },
    useLocalSearchParams: () => mocks.params,
    useRouter: () => ({ push: mocks.push }),
    // In front while drawn; a test brings the page to the front again with `refocus`.
    useFocusEffect: (run: () => void) => { useEffect(() => { run(); mocks.focus.add(run); return () => { mocks.focus.delete(run); }; }, [run]); },
  };
});
vi.mock("@mobile/cloud/CloudProvider", () => ({ useCloudCatalog: () => mocks.catalog, useCatalogSnapshot: (catalog: any) => catalog?.getSnapshot() ?? { organizations: [] } }));
vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()));
vi.mock("lucide-react-native", async () => (await import("@mobile/ui/testing/kit")).namedIcons());
vi.mock("react-native", async () => {
  const native = await import("@mobile/ui/testing/native");
  return { ...native, KeyboardAvoidingView: native.View, ActivityIndicator: () => <i data-busy="true" />, Keyboard: { addListener: () => ({ remove: () => undefined }) } };
});

const page = stage();
let service: ReturnType<typeof loginService>;
function serve(stored: Parameters<typeof loginService>[0] = [], name = "Northwind") {
  service = loginService(stored);
  mocks.catalog = { api: service.api, getSnapshot: () => ({ organizations: [{ organization: { orgId: ORG, name, role: "owner", isPersonal: false }, workspaces: [] }] }) };
  mocks.params = { orgId: ORG };
}
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const open = async () => { await page.show(<AgentLoginsScreen />); await settle(); };
const text = () => page.container.textContent ?? "";
const rows = () => [...page.container.querySelectorAll('[data-testid^="agent-login-"]')].map((row) => row.getAttribute("aria-label"));
const reads = () => service.sent("GET", "");

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); mocks.push.mockReset(); mocks.focus.clear(); });
afterEach(() => { vi.useRealTimers(); });

it("nothing connected yet: each agent says how it can sign in", async () => {
  serve();
  await open();
  expect(page.byId("screen-header")!.textContent).toBe("Agent loginsNorthwind");
  expect(text()).toContain("What each agent signs in with on this organization’s cloud workspaces. Members use these logins; they do not sign in themselves.");
  expect(text()).toContain("AGENTS");
  expect(text()).toContain("REPOSITORIES");
  expect(rows()).toEqual([
    "Codex, Not connected, ChatGPT sign-in or API key",
    "Claude Code, Not connected, API key",
    "Cursor, Not connected, API key",
    "GitHub, Not connected, A token, for private repositories",
  ]);
  expect(text()).toContain("One agent is enough to launch a workspace.");
  expect(reads()).toHaveLength(1);
});

it("some connected: the service's four states, with the kind and whose account or when it changed", async () => {
  serve([
    credential("codex", { authKind: "oauth-credentials-json", displayIdentity: "alex@example.com" }),
    credential("claude", { state: "sign-in-required", updatedAt: Date.UTC(2026, 10, 2, 12) }),
    credential("cursor", { state: "revoked", updatedAt: Date.UTC(2026, 9, 14, 12) }),
    credential("github"),
  ]);
  await open();
  expect(rows()).toEqual([
    "Codex, Connected, Subscription login · alex@example.com",
    "Claude Code, Sign-in required, API key · Updated 2 Nov",
    "Cursor, Revoked, API key · Updated 14 Oct",
    "GitHub, Connected, Personal access token · Updated 23 Nov",
  ]);
  expect(text()).not.toContain("One agent is enough to launch a workspace.");
});

it("a login the service calls disconnected reads as not connected, and one it does not know is not listed", async () => {
  serve([credential("claude", { state: "disconnected" }), credential("gemini")]);
  await open();
  expect(rows()).toEqual([
    "Codex, Not connected, ChatGPT sign-in or API key",
    "Claude Code, Not connected, API key",
    "Cursor, Not connected, API key",
    "GitHub, Not connected, A token, for private repositories",
  ]);
});

it("a row opens that agent's page", async () => {
  serve();
  await open();
  await page.press(page.byId("agent-login-claude"));
  expect(mocks.push).toHaveBeenCalledExactlyOnceWith({ pathname: "/agent-logins/[provider]", params: { provider: "claude", orgId: ORG } });
});

it("reads the list again when the page comes back to the front, without blanking what it shows", async () => {
  serve();
  await open();
  service.credentials = [credential("claude")];
  let answer!: () => void;
  service.on("GET", "", () => new Promise((resolve) => { answer = () => resolve({ body: { credentials: service.credentials } }); }));
  await act(async () => { for (const run of [...mocks.focus]) run(); });
  expect(rows()).toHaveLength(4);
  await act(async () => { answer(); });
  await settle();
  expect(rows()[1]).toBe("Claude Code, Connected, API key · Updated 23 Nov");
});

it("a member's view: told who manages agent logins, with no rows", async () => {
  serve([], "Acme");
  service.on("GET", "", () => refuse("organization_admin_required", 403));
  await open();
  const note = page.byId("agent-logins-member")!;
  expect(note.textContent).toBe("Owners and admins manage agent logins. You use them when you launch a workspace in Acme.");
  expect(note.getAttribute("role")).toBeNull();
  expect(page.icon("Info")).not.toBeNull();
  expect(rows()).toEqual([]);
});

it("could not be read: says so, and Try again reads it", async () => {
  serve([credential("github")]);
  service.on("GET", "", offline);
  await open();
  expect(text()).toContain("Agent logins could not be read");
  expect(text()).toContain("The service could not be reached. Nothing was changed.");
  expect(page.icon("CloudOff")).not.toBeNull();
  expect(rows()).toEqual([]);
  service.restore("GET", "");
  await page.press([...page.container.querySelectorAll<HTMLElement>('[role="button"]')].find((element) => element.textContent === "Try again")!);
  await settle();
  expect(rows()[3]).toBe("GitHub, Connected, Personal access token · Updated 23 Nov");
});

it("signed out, or an organization not on the account: nothing is asked", async () => {
  serve();
  mocks.params = { orgId: "org-other" };
  await open();
  expect(text()).toContain("Organization unavailable");
  mocks.catalog = null;
  await open();
  expect(text()).toContain("Sign in to see your organizations.");
  expect(service.calls).toHaveLength(0);
});
