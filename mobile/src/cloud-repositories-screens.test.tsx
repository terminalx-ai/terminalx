// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Alert, AppState } from "react-native";
import NewWorkspaceScreen from "../app/cloud/new";
import { GITHUB_RETURN_URL, githubReturn } from "./cloud/github";
import { account } from "./cloud/testing/account";
import { NORTHWIND, northwind, northwindGrants } from "./cloud/testing/github";
import { refuse } from "./cloud/testing/server";
import { ATTEMPT_POLL_MS } from "./cloud/useGithubConnect";
import { SEARCH_PAUSE_MS } from "./ui/repositories/ChooseRepositories";
import { stage } from "./ui/testing/kit";

// PRO-537: connect GitHub and choose repositories from the phone (25.11).
// The launch form runs against the real client and catalog, over an account service that answers the
// GitHub App routes as the server's contract says; only GitHub's own pages, in the system browser, are stood in for.
const mocks = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  router: { back: vi.fn(), push: vi.fn(), replace: vi.fn(), dismissAll: vi.fn(), canDismiss: () => true },
  catalog: null as unknown,
  focus: [] as (() => void)[],
  /** Each sign-in sheet opened: where, and how it ends. */
  sheets: [] as { url: string; returnUrl: string; options: unknown; end(result: { type: string; url?: string }): void; open: boolean }[],
  dismissed: 0,
  pages: [] as string[],
  fail: false,
}));
vi.mock("react-native", async () => {
  const native = await import("@mobile/ui/testing/native");
  return { ...native, KeyboardAvoidingView: native.View, ActivityIndicator: () => <i data-busy="true" />, Modal: ({ children }: { children?: unknown }) => <div role="dialog">{children as never}</div> };
});
vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()));
vi.mock("lucide-react-native", async () => (await import("@mobile/ui/testing/kit")).namedIcons());
vi.mock("expo-router", () => ({ Stack: { Screen: () => null }, useLocalSearchParams: () => mocks.params, useRouter: () => mocks.router, useFocusEffect: (run: () => void) => { mocks.focus.push(run); }, usePreventRemove: () => undefined }));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => ({}) }));
vi.mock("expo-crypto", () => ({ randomUUID: () => globalThis.crypto.randomUUID() }));
vi.mock("expo-clipboard", () => ({ getStringAsync: async () => "", hasStringAsync: async () => false }));
vi.mock("expo-web-browser", () => ({
  openAuthSessionAsync: (url: string, returnUrl: string, options: unknown) => {
    if (mocks.fail) return Promise.reject(new Error("no browser"));
    return new Promise((resolve) => {
      const sheet = { url, returnUrl, options, open: true, end: (result: { type: string; url?: string }) => { if (sheet.open) { sheet.open = false; resolve(result); } } };
      mocks.sheets.push(sheet);
    });
  },
  dismissAuthSession: () => { mocks.dismissed += 1; mocks.sheets.at(-1)?.end({ type: "dismiss" }); },
  openBrowserAsync: async (url: string) => { mocks.pages.push(url); return { type: "cancel" }; },
}));
vi.mock("@mobile/cloud/CloudProvider", async () => {
  const { useSyncExternalStore } = await import("react");
  return { useCloudCatalog: () => mocks.catalog, useCatalogSnapshot: (catalog: { subscribe: (listener: () => void) => () => void; getSnapshot: () => unknown }) => useSyncExternalStore(catalog.subscribe, catalog.getSnapshot) };
});

const page = stage();
const alert = vi.mocked(Alert.alert);
type Account = ReturnType<typeof account>;
let held: Account | null = null;

/** Let requests answer and the screen draw; `ms` of the phone's time passes. */
const pass = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const text = (id: string) => page.byId(id)?.textContent ?? null;
const label = (id: string) => page.byId(id)?.getAttribute("aria-label") ?? null;
const disabled = (id: string) => page.byId(id)?.getAttribute("aria-disabled") === "true";
const field = (id: string) => page.byId(id)!.querySelector("input");
const press = async (id: string) => { expect(page.byId(id), id).not.toBeNull(); await page.press(page.byId(id)); await pass(); };
const ticked = (id: string) => page.byId(id)?.querySelector("[data-icon='Check']") != null;
const rows = (id: string) => [...page.byId(id)!.querySelectorAll("[role='checkbox']")].map((row) => row.getAttribute("aria-label"));
const labels = () => [...page.container.querySelectorAll("[aria-label]")].map((node) => node.getAttribute("aria-label"));
const sheet = () => mocks.sheets.at(-1)!;
const endSheet = async (result: { type: string; url?: string }) => { await act(async () => { sheet().end(result); }); await pass(); };
const cameBack = (attemptId = "ghattempt_1") => ({ type: "success", url: `${GITHUB_RETURN_URL}?attemptId=${attemptId}` });

/** The launch form for `role`, with what the test set up on the server, opened on its Repositories page. */
async function repositories(role: "owner" | "admin" | "member" = "admin", change?: (service: Account) => void) {
  const service = account({ role });
  change?.(service);
  held = service;
  mocks.catalog = service.catalog;
  await service.catalog.refresh();
  await page.show(<NewWorkspaceScreen />);
  await pass();
  await press("pick-repository");
  return service;
}
/** An organization that has connected northwind-labs and chosen some of what it grants. */
const chosen = (names: string[]) => (service: Account) => { service.github.connectInstallation(); service.github.choose(names); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(Date.UTC(2026, 10, 25, 10, 0, 0));
  mocks.params = {};
  mocks.focus = [];
  mocks.sheets = [];
  mocks.pages = [];
  mocks.dismissed = 0;
  mocks.fail = false;
  for (const spy of [mocks.router.back, mocks.router.push, mocks.router.replace, mocks.router.dismissAll, alert]) spy.mockReset();
});
afterEach(() => { held?.catalog.close(); held = null; vi.useRealTimers(); });

describe("before GitHub is connected", () => {
  it("leads with Connect GitHub for an owner or admin, with the typed URL under it", async () => {
    const service = await repositories("admin");
    expect(service.sent("GET", "/github-app")).toHaveLength(1);
    expect(text("github-connect")).toBe("Connect GitHubChoose repositories from a list, private ones included.You finish on GitHub, in the browser, then come back here.Connect GitHubThe app is already installedFor a GitHub account that already has the TerminalX app, with nothing to change on GitHub. It works only with the GitHub account linked to your TerminalX sign-in.");
    expect(page.container.textContent).toContain("Optional. Each repository is cloned before the workspace becomes available.");
    expect(page.container.textContent).toContain("OR TYPE A URL");
    expect(field("repository-url")).not.toBeNull();
    expect(disabled("use-repository")).toBe(true);
    expect(page.byId("no-repository")).not.toBeNull();
  });

  it("tells a member who can connect, in the desktop's words, and still takes a typed URL", async () => {
    await repositories("member");
    expect(page.byId("github-connect")).toBeNull();
    expect(text("github-ask")).toBe("No GitHub installation is connected yet. Only owners and admins can connect GitHub or choose repositories.");
    await page.type(field("repository-url"), "github.com/acme/sandbox");
    await press("use-repository");
    expect(label("pick-repository")).toBe("Repository: acme/sandbox");
  });

  it("offers no connect on a server without a GitHub App: the typed URL is all there is", async () => {
    await repositories("admin", (service) => { service.github.state.configured = false; });
    expect(page.byId("github-connect")).toBeNull();
    expect(page.byId("github-ask")).toBeNull();
    expect(field("repository-url")).not.toBeNull();
  });

  it("shows grey rows while the organization's repositories are read, and says when they could not be", async () => {
    let answer: ((value: unknown) => void) | null = null;
    const service = account({ role: "admin" });
    held = service;
    mocks.catalog = service.catalog;
    await service.catalog.refresh();
    service.state.answer = (call) => (call.path === "/github-app" ? refuse("cloud_workspace_unavailable", 503) : undefined);
    await page.show(<NewWorkspaceScreen />);
    await pass();
    await press("pick-repository");
    expect(text("repositories-failed")).toBe("The organization’s repositories could not be loaded.Try again");
    expect(page.byId("type-url")).not.toBeNull();
    expect(page.container.textContent).toContain("A URL you type is checked when you review the price.");
    // Asked again, it loads.
    service.state.answer = null;
    void answer;
    await page.press(page.byLabel("Try again") ?? page.byText("Try again"));
    await pass();
    expect(page.byId("github-connect")).not.toBeNull();
  });
});

describe("connecting", () => {
  it("opens GitHub in the system's sign-in session, waits, and on the return link asks the server how it ended", async () => {
    const service = await repositories("owner");
    await press("connect-github");
    expect(service.sent("POST", "/github-app/connect-attempts").map((call) => call.body)).toEqual([{}]);
    // The install address goes to the sign-in session, which shares the browser's GitHub sign-in; it is never drawn.
    expect(sheet()).toMatchObject({ url: "https://github.com/apps/terminalx-cloud/installations/new?state=secret-1", returnUrl: "terminalx://github-app/connect", options: { preferEphemeralSession: false } });
    expect(page.container.innerHTML).not.toContain("secret-1");
    expect(text("github-waiting")).toContain("Waiting for GitHub");
    expect(text("github-waiting")).toContain("Finish in your browser: install the app on GitHub, then confirm the organization on the TerminalX page. This updates once you confirm.");
    expect(text("github-ends")).toBe("This attempt ends in 15:00.");
    // Only Use this repository is offered while it waits.
    expect(page.byId("no-repository")).toBeNull();

    // The person installs the App and confirms on the TerminalX page; the page sends the browser back.
    service.github.finish("ghattempt_1", { connected: northwind });
    await endSheet(cameBack());
    expect(text("github-outcome")).toBe("Connected northwind-labs. Choose which repositories cloud workspaces can use.");
    expect(page.container.textContent).toContain("Only owners and admins choose them. Every member can then pick from them at launch.");
    expect(page.byId("choose-repositories")).not.toBeNull();
    expect(page.byId("type-url")).not.toBeNull();
    // Nothing was canceled, and the status was read again.
    expect(service.sent("POST", "/github-app/connect-attempts/ghattempt_1/cancel")).toHaveLength(0);
    expect(service.sent("GET", "/github-app").length).toBeGreaterThan(1);
  });

  it("connects an App that is already installed through the resume address, which is the one that comes back", async () => {
    const service = await repositories("admin");
    await press("connect-installed");
    expect(service.sent("POST", "/github-app/connect-attempts").map((call) => call.body)).toEqual([{}]);
    expect(sheet()).toMatchObject({ url: "https://github.com/login/oauth/authorize?client_id=Iv1&state=secret-1", returnUrl: "terminalx://github-app/connect", options: { preferEphemeralSession: false } });
    expect(page.container.innerHTML).not.toContain("secret-1");
    // Nothing is installed this time: only the confirmation is left.
    expect(text("github-waiting")).toContain("Finish in your browser: confirm the organization on the TerminalX page. This updates once you confirm.");
    // Android: back in the app with the attempt open, GitHub opens again at the same address.
    await endSheet({ type: "dismiss" });
    await press("open-github-again");
    expect(mocks.sheets[1]!.url).toBe(mocks.sheets[0]!.url);
    service.github.finish("ghattempt_1", { connected: northwind });
    await endSheet(cameBack());
    expect(text("github-outcome")).toContain("Connected northwind-labs.");
  });

  it("offers the already-installed way again after an attempt that ended without connecting", async () => {
    const service = await repositories("admin");
    await press("connect-github");
    // Installed on GitHub, then the sheet closed before the TerminalX page was confirmed: the App stays installed.
    await endSheet({ type: "cancel" });
    expect(text("github-outcome")).toBe("The browser was closed before GitHub finished. Nothing was connected.");
    await press("connect-installed");
    expect(service.sent("POST", "/github-app/connect-attempts")).toHaveLength(2);
    expect(sheet().url).toBe("https://github.com/login/oauth/authorize?client_id=Iv1&state=secret-2");
  });

  it("opens the install page when the server gives no resume address", async () => {
    const service = await repositories("admin");
    service.state.answer = (call) => {
      if (call.path !== "/github-app/connect-attempts") return undefined;
      const answer = service.github.handle(call, "admin") as { body: Record<string, unknown> };
      const { resumeUrl: _none, ...body } = answer.body;
      return { body };
    };
    await press("connect-installed");
    expect(sheet().url).toBe("https://github.com/apps/terminalx-cloud/installations/new?state=secret-1");
    expect(text("github-waiting")).toContain("install the app on GitHub");
  });

  it("says it is checking while the server is asked", async () => {
    let answer: (() => void) | null = null;
    const service = await repositories("admin");
    await press("connect-github");
    service.github.finish("ghattempt_1", { connected: northwind });
    const real = service.state.answer;
    service.state.answer = (call) => {
      if (call.path !== "/github-app/connect-attempts/ghattempt_1") return undefined;
      return new Promise((resolve) => { answer = () => resolve(service.github.handle(call, "admin")!); }) as never;
    };
    await endSheet(cameBack());
    expect(text("github-checking")).toBe("Checking the connection…Back from the browser. TerminalX is asking the account service how it ended.");
    service.state.answer = real;
    await act(async () => { answer!(); });
    await pass();
    expect(text("github-outcome")).toContain("Connected northwind-labs.");
  });

  it("concludes nothing from a link alone: an attempt the server still holds waiting stays waiting", async () => {
    const service = await repositories("admin");
    await press("connect-github");
    await endSheet(cameBack());
    expect(page.byId("github-outcome")).toBeNull();
    expect(text("github-waiting")).toContain("Waiting for GitHub");
    expect(service.github.state.attempts.get("ghattempt_1")!.state).toBe("waiting");
    // A link for some other attempt is not this page's either.
    await press("open-github-again");
    await endSheet(cameBack("ghattempt_of_someone_else"));
    expect(text("github-waiting")).toContain("Waiting for GitHub");
    expect(service.sent("POST", "/github-app/connect-attempts/ghattempt_1/cancel")).toHaveLength(0);
  });

  it("ends the attempt when the browser is closed early, and says nothing was connected", async () => {
    const service = await repositories("admin");
    await press("connect-github");
    await endSheet({ type: "cancel" });
    expect(service.sent("POST", "/github-app/connect-attempts/ghattempt_1/cancel").map((call) => call.body)).toEqual([{}]);
    expect(service.github.state.attempts.get("ghattempt_1")).toMatchObject({ state: "canceled", canceledBy: "mobile" });
    expect(text("github-outcome")).toBe("The browser was closed before GitHub finished. Nothing was connected.");
    expect(text("connect-again")).toBe("Connect GitHub");
    // Starting over is a new attempt.
    await press("connect-again");
    expect(service.sent("POST", "/github-app/connect-attempts")).toHaveLength(2);
    expect(sheet().url).toContain("state=secret-2");
  });

  it("does not cancel what connected just as the browser closed", async () => {
    const service = await repositories("admin");
    await press("connect-github");
    service.github.finish("ghattempt_1", { connected: northwind });
    await endSheet({ type: "cancel" });
    expect(service.sent("POST", "/github-app/connect-attempts/ghattempt_1/cancel")).toHaveLength(0);
    expect(text("github-outcome")).toContain("Connected northwind-labs.");
  });

  it("waits with the time left and a way back to GitHub when the app comes back with the attempt still open, and asks every two seconds", async () => {
    const service = await repositories("admin");
    await press("connect-github");
    // Android: the app is in front again while the tab lives on.
    await endSheet({ type: "dismiss" });
    expect(disabled("open-github-again")).toBe(false);
    const asked = () => service.sent("GET", "/github-app/connect-attempts/ghattempt_1").length;
    const before = asked();
    await pass(ATTEMPT_POLL_MS * 3);
    expect(asked() - before).toBe(3);
    expect(text("github-ends")).toBe("This attempt ends in 14:54.");
    await press("open-github-again");
    expect(mocks.sheets).toHaveLength(2);
    expect(mocks.sheets[1]!.url).toBe(mocks.sheets[0]!.url);
    // Finished on GitHub without the button: the next question finds it, and the sheet is put away.
    service.github.finish("ghattempt_1", { connected: northwind });
    await pass(ATTEMPT_POLL_MS);
    expect(text("github-outcome")).toContain("Connected northwind-labs.");
    expect(mocks.dismissed).toBe(1);
    // It is over: nothing asks any more.
    const after = asked();
    await pass(ATTEMPT_POLL_MS * 3);
    expect(asked()).toBe(after);
  });

  it("asks at once when the app comes to the front, and when the return link reaches the app outside the sheet", async () => {
    const service = await repositories("admin");
    await press("connect-github");
    await endSheet({ type: "dismiss" });
    const asked = () => service.sent("GET", "/github-app/connect-attempts/ghattempt_1").length;
    let before = asked();
    await act(async () => { (AppState as unknown as { emit(state: string): void }).emit("active"); });
    await pass();
    expect(asked() - before).toBe(1);
    before = asked();
    await act(async () => { githubReturn.arrived("ghattempt_of_someone_else"); });
    await pass();
    expect(asked() - before).toBe(0);
    service.github.finish("ghattempt_1", { failed: "github_installation_pending_approval" });
    await act(async () => { githubReturn.arrived("ghattempt_1"); });
    await pass();
    expect(text("github-outcome")).toContain("GitHub sent the installation to an owner of the GitHub organization for approval");
    expect(page.styleOf(page.byId("github-outcome")).borderColor).toContain(page.styleOf(page.byId("github-outcome")).backgroundColor.slice(0, 7));
    expect(text("connect-again")).toBe("Connect again");
  });

  it("cancels from the waiting page, and says so", async () => {
    const service = await repositories("admin");
    await press("connect-github");
    await endSheet({ type: "dismiss" });
    await press("cancel-connect");
    expect(service.github.state.attempts.get("ghattempt_1")!.state).toBe("canceled");
    expect(text("github-outcome")).toBe("Connection canceled.");
    expect(text("connect-again")).toBe("Connect GitHub");
  });

  it("says each way the confirmation page can end it", async () => {
    const service = await repositories("admin");
    await press("connect-github");
    service.github.finish("ghattempt_1", { canceled: "confirmation_page" });
    await endSheet(cameBack());
    expect(text("github-outcome")).toBe("Cancel was chosen on the TerminalX confirmation page in your browser, so nothing was connected. To connect, start again and choose Connect on that page.");
    await press("connect-again");
    service.github.finish("ghattempt_2", { failed: "github_resume_identity_mismatch" });
    await endSheet(cameBack("ghattempt_2"));
    // The plain fallback: the page's security advice is not repeated on the phone.
    expect(text("github-outcome")).toBe("TerminalX could not reach the account service. Try again.");
  });

  it("stops when the attempt's fifteen minutes are up", async () => {
    const service = await repositories("admin");
    await press("connect-github");
    await endSheet({ type: "dismiss" });
    vi.setSystemTime(Date.now() + 15 * 60_000);
    await pass(ATTEMPT_POLL_MS);
    expect(text("github-outcome")).toBe("The connection attempt expired before it was confirmed. Connect again, then finish on GitHub and confirm on the TerminalX page within 15 minutes.");
    const asked = service.sent("GET", "/github-app/connect-attempts/ghattempt_1").length;
    await pass(ATTEMPT_POLL_MS * 2);
    expect(service.sent("GET", "/github-app/connect-attempts/ghattempt_1")).toHaveLength(asked);
  });

  it("cancels a waiting attempt when the page is left", async () => {
    const service = await repositories("admin");
    await press("connect-github");
    await endSheet({ type: "dismiss" });
    await page.press(page.byLabel("Back"));
    await pass();
    expect(service.github.state.attempts.get("ghattempt_1")!.state).toBe("canceled");
    expect(page.byId("review-price")).not.toBeNull();
  });

  it("says when the browser did not open, and when starting was refused", async () => {
    mocks.fail = true;
    const service = await repositories("admin");
    await press("connect-github");
    expect(text("github-outcome")).toBe("TerminalX could not open your browser.");
    expect(service.github.state.attempts.get("ghattempt_1")!.state).toBe("canceled");
    mocks.fail = false;
    service.state.answer = (call) => (call.path === "/github-app/connect-attempts" ? refuse("github_app_unavailable", 503) : undefined);
    await press("connect-again");
    expect(text("github-outcome")).toBe("GitHub could not be reached. Try again in a moment.");
    expect(text("connect-again")).toBe("Try again");
    expect(mocks.sheets).toHaveLength(0);
  });
});

describe("choosing for the organization", () => {
  const connected = async (change?: (service: Account) => void) => {
    const service = await repositories("admin", (made) => { made.github.connectInstallation(); change?.(made); });
    // With nothing chosen yet the page leads with the button; once there is a set it is a row under the list.
    await press(page.byId("choose-repositories") ? "choose-repositories" : "choose-more");
    return service;
  };

  it("says nothing is chosen yet, and opens the installation's list as GitHub has it", async () => {
    const service = await repositories("admin", (made) => made.github.connectInstallation());
    expect(text("repositories-none-admin")).toBe("No repositories yetNo repositories are chosen yet. Choose the ones every workspace may clone.");
    await press("choose-repositories");
    expect(service.sent("GET", `/github-app/installations/${NORTHWIND}/repositories`)).toHaveLength(1);
    expect(page.container.textContent).toContain("Choose repositories");
    expect(page.container.textContent).toContain("For every workspace");
    expect(page.container.textContent).toContain("Pick the repositories cloud workspaces clone. Every workspace gets its own copy of each one.");
    expect(rows("organization-list")).toEqual([
      "northwind-labs/checkout, Private, main", "northwind-labs/api, Private, main", "northwind-labs/web, Public, main", "northwind-labs/infra, Private, production",
      "northwind-labs/mobile, Private, develop", "northwind-labs/docs, Public, main", "northwind-labs/design-tokens, Public, main",
    ]);
    // A private one carries a lock, a public one a globe.
    expect(page.byId("grant-northwind-labs/checkout")!.querySelector("[data-icon='Lock']")).not.toBeNull();
    expect(page.byId("grant-northwind-labs/web")!.querySelector("[data-icon='Globe']")).not.toBeNull();
    expect(text("save-repositories")).toBe("Save");
    expect(disabled("save-repositories")).toBe(true);
  });

  it("saves the whole set, and the launch picker then lists it", async () => {
    const service = await connected();
    await press("grant-northwind-labs/checkout");
    await press("grant-northwind-labs/api");
    await press("grant-northwind-labs/web");
    expect(text("organization-count")).toBe("All repositories it grants3 chosen");
    expect(text("save-repositories")).toBe("Save · 3 chosen");
    await press("save-repositories");
    expect(service.sent("PUT", "/github-app/repositories").map((call) => call.body)).toEqual([{ repositories: [{ installationId: NORTHWIND, githubRepositoryId: 101 }, { installationId: NORTHWIND, githubRepositoryId: 102 }, { installationId: NORTHWIND, githubRepositoryId: 103 }] }]);
    expect(rows("repositories-list")).toEqual(["northwind-labs/checkout, Private, main", "northwind-labs/api, Private, main", "northwind-labs/web, Public, main"]);
    expect(page.byId("choose-more")).not.toBeNull();
  });

  it("searches GitHub through the server after a pause in typing, and keeps what the search hides ticked", async () => {
    const service = await connected(chosen(["checkout", "api"]) as never);
    const asked = () => service.calls.filter((call) => call.path.startsWith(`/github-app/installations/${NORTHWIND}/repositories`)).map((call) => call.path);
    await page.type(field("organization-search"), "do");
    await page.type(field("organization-search"), "doc");
    await pass(SEARCH_PAUSE_MS - 1);
    expect(asked()).toHaveLength(1);
    await pass(1);
    expect(asked().at(-1)).toBe(`/github-app/installations/${NORTHWIND}/repositories?query=doc`);
    expect(rows("organization-list")).toEqual(["northwind-labs/docs, Public, main"]);
    await press("grant-northwind-labs/docs");
    expect(text("save-repositories")).toBe("Save · 3 chosen");
    await press("save-repositories");
    expect(service.github.state.repositories.map((repository) => repository.fullName)).toEqual(["northwind-labs/checkout", "northwind-labs/api", "northwind-labs/docs"]);
  });

  it("says when nothing matches, and when the installation grants nothing, with the way to GitHub", async () => {
    const service = await connected();
    await page.type(field("organization-search"), "billing");
    await pass(SEARCH_PAUSE_MS);
    expect(text("organization-no-match")).toBe("No repositories match.Search looks through everything the installation grants, on GitHub.");
    service.github.state.granted.set(NORTHWIND, []);
    await page.type(field("organization-search"), "");
    await pass(SEARCH_PAUSE_MS);
    expect(text("grants-none")).toBe("No repositoriesThis installation grants no repositories. Grant some on GitHub, then refresh.");
    // Back from GitHub's page, what it grants is asked of GitHub again.
    service.github.state.granted.set(NORTHWIND, northwindGrants.slice(0, 2));
    await press("manage-on-github");
    expect(mocks.pages).toEqual([northwind.manageUrl]);
    expect(service.calls.at(-1)!.path).toBe(`/github-app/installations/${NORTHWIND}/repositories?refresh=1`);
    expect(rows("organization-list")).toHaveLength(2);
  });

  it("says a long list is cut, and names chosen repositories the installation stopped granting", async () => {
    await connected((service) => {
      service.github.choose(["checkout", "api"]);
      service.github.state.truncated.add(NORTHWIND);
      service.github.state.granted.set(NORTHWIND, northwindGrants.filter((grant) => grant.githubRepositoryId !== 102));
      service.github.state.repositories = service.github.state.repositories.map((repository) => (repository.githubRepositoryId === 102 ? { ...repository, state: "missing", reason: "github_repository_not_granted" } : repository));
    });
    expect(text("organization-truncated")).toBe("Only the first 1,000 repositories are listed. Search to narrow the list.");
    expect(text("organization-missing")).toBe("These chosen repositories are no longer granted to the installation and are removed when you save: northwind-labs/api. To keep them, grant them on GitHub, then refresh.");
    expect(text("save-repositories")).toBe("Save · 1 chosen");
    expect(disabled("save-repositories")).toBe(false);
  }, 10_000);

  it("says why a save was refused, reads the list again from GitHub, and drops the tick GitHub no longer lists", async () => {
    const service = await connected();
    await press("grant-northwind-labs/checkout");
    await press("grant-northwind-labs/docs");
    // The installation stops granting docs between the list and the save.
    service.github.state.granted.set(NORTHWIND, northwindGrants.filter((grant) => grant.githubRepositoryId !== 106));
    await press("save-repositories");
    expect(text("save-refusal")).toBe("One or more of the chosen repositories is no longer accessible to the installation. The list has been refreshed.");
    expect(service.github.state.repositories).toEqual([]);
    expect(service.calls.filter((call) => call.path.endsWith("/repositories?refresh=1"))).toHaveLength(1);
    expect(page.byId("grant-northwind-labs/docs")).toBeNull();
    expect(text("save-repositories")).toBe("Save · 1 chosen");
    await press("save-repositories");
    expect(service.github.state.repositories.map((repository) => repository.fullName)).toEqual(["northwind-labs/checkout"]);
  });

  it("asks GitHub itself once after a refused save, and the next search uses the server's own list again", async () => {
    const service = await connected();
    await press("grant-northwind-labs/checkout");
    await press("grant-northwind-labs/docs");
    service.github.state.granted.set(NORTHWIND, northwindGrants.filter((grant) => grant.githubRepositoryId !== 106));
    await press("save-repositories");
    const lists = () => service.calls.filter((call) => call.path.startsWith(`/github-app/installations/${NORTHWIND}/repositories`)).map((call) => call.path.split("repositories")[1]);
    expect(lists().at(-1)).toBe("?refresh=1");
    await page.type(field("organization-search"), "api");
    await pass(SEARCH_PAUSE_MS);
    expect(lists().at(-1)).toBe("?query=api");
    await page.type(field("organization-search"), "");
    await pass(SEARCH_PAUSE_MS);
    expect(lists().at(-1)).toBe("");
    expect(lists().filter((asked) => asked.includes("refresh"))).toHaveLength(1);
  });

  it("names what a save drops from a suspended account, and does not call that the person's unsaved work", async () => {
    const acme = { ...northwind, id: "ghinst_acme", installationId: 222, accountLogin: "acme", state: "suspended" };
    const service = await connected((made) => {
      made.github.choose(["checkout"]);
      made.github.connectInstallation(acme, [{ githubRepositoryId: 901, fullName: "acme/site", defaultBranch: "main", private: true }]);
      made.github.state.repositories.push({ id: "ghrepo_901", installationId: "ghinst_acme", githubRepositoryId: 901, fullName: "acme/site", cloneUrl: "https://github.com/acme/site.git", defaultBranch: "main", private: true, state: "installation-suspended", reason: null, lastVerifiedAt: 0 });
    });
    expect(text("organization-dropped")).toBe("These chosen repositories cannot be reached now, because their installation is suspended or uninstalled on GitHub, and are removed when you save: acme/site.");
    // A save would change the set, so it is offered; nothing was ticked, so leaving asks nothing.
    expect(disabled("save-repositories")).toBe(false);
    await page.press(page.byLabel("Back"));
    await pass();
    expect(alert).not.toHaveBeenCalled();
    expect(page.byId("organization-list")).toBeNull();
    void service;
  });

  it("asks before leaving with ticks that are not saved", async () => {
    await connected();
    await press("grant-northwind-labs/checkout");
    await page.press(page.byLabel("Back"));
    expect(alert.mock.calls.at(-1)!.slice(0, 2)).toEqual(["Leave without saving?", "The repositories you chose are not saved for the organization yet."]);
    expect(page.byId("organization-list")).not.toBeNull();
    await act(async () => { alert.mock.calls.at(-1)![2]!.find((button) => button.text === "Leave")!.onPress?.(); });
    expect(page.byId("repositories-none-admin")).not.toBeNull();
  });
});

describe("picking for a launch", () => {
  const all = ["checkout", "api", "web", "infra", "mobile", "docs"];

  it("lists the organization's repositories to every member, with no way to change the organization's set for a member", async () => {
    await repositories("member", chosen(all));
    expect(rows("repositories-list")).toHaveLength(6);
    expect(text("repositories-count")).toBe("Choose up to five");
    expect(page.byId("type-url")).not.toBeNull();
    expect(page.byId("choose-more")).toBeNull();
    expect(text("without-repository")).toBe("Use without a repository");
  });

  it("tells a member when nothing is chosen for workspaces yet", async () => {
    await repositories("member", (service) => service.github.connectInstallation());
    expect(text("repositories-none-member")).toBe("No repositories yetNo repositories are chosen for cloud workspaces. An owner or admin chooses them.");
    expect(page.byId("choose-repositories")).toBeNull();
    expect(page.byId("type-url")).not.toBeNull();
  });

  it("ticks repositories, counts them, and puts them on the form", async () => {
    await repositories("admin", chosen(all));
    await press("repository-northwind-labs/checkout");
    await press("repository-northwind-labs/api");
    expect(ticked("repository-northwind-labs/checkout")).toBe(true);
    expect(ticked("repository-northwind-labs/web")).toBe(false);
    expect(text("repositories-count")).toBe("Choose up to five2 of 5 chosen");
    expect(text("use-repositories")).toBe("Use 2 repositories");
    // Chosen ones are also at the top, each with the branch it is cloned at.
    expect(label("chosen-northwind-labs/api")).toBe("northwind-labs/api, branch or tag: main");
    await press("use-repositories");
    expect(label("pick-repository")).toBe("Repositories: checkout and 1 more");
  });

  it("filters on the phone as each letter is typed, by name, and keeps what the search hides chosen", async () => {
    const service = await repositories("admin", chosen([...all, "design-tokens"]));
    await press("repository-northwind-labs/checkout");
    const requests = service.calls.length;
    await page.type(field("repository-search"), "s");
    expect(rows("repositories-list")).toEqual(["northwind-labs/docs, Public, main", "northwind-labs/design-tokens, Public, main"]);
    expect(service.calls).toHaveLength(requests);
    expect(text("use-repositories")).toBe("Use 1 repository");
    await page.type(field("repository-search"), "billing");
    expect(text("repositories-no-match")).toBe("No repositories match.Only the repositories chosen for this organization’s workspaces are listed.");
    expect(page.byId("type-url")).not.toBeNull();
  });

  it("takes five at most: the rest dim, a line says why, and unticking one brings them back", async () => {
    await repositories("admin", chosen(all));
    for (const name of all.slice(0, 5)) await press(`repository-northwind-labs/${name}`);
    expect(text("repositories-count")).toBe("Choose up to five5 of 5 chosen");
    expect(disabled("repository-northwind-labs/docs")).toBe(true);
    expect(page.styleOf(page.byId("repository-northwind-labs/docs")).opacity).toBe(0.5);
    expect(text("repositories-full")).toBe("A workspace takes up to five repositories. Remove one to choose another.");
    // A typed URL would be a sixth.
    expect(disabled("type-url")).toBe(true);
    await press("repository-northwind-labs/api");
    expect(disabled("repository-northwind-labs/docs")).toBe(false);
    expect(page.byId("repositories-full")).toBeNull();
  });

  it("shows a repository the installation no longer grants, not pickable, with the desktop's reason", async () => {
    await repositories("admin", (service) => {
      chosen(["checkout", "api"])(service);
      service.github.state.repositories = service.github.state.repositories.map((repository) => (repository.githubRepositoryId === 102 ? { ...repository, state: "missing", reason: "github_repository_not_granted" } : repository));
    });
    expect(label("repository-northwind-labs/api")).toBe("northwind-labs/api, Private, main, The installation no longer grants this repository. Grant it again in the installation's settings on GitHub.");
    expect(disabled("repository-northwind-labs/api")).toBe(true);
    expect(page.byId("repository-northwind-labs/api")!.querySelector("[data-icon='TriangleAlert']")).not.toBeNull();
    expect(disabled("repository-northwind-labs/checkout")).toBe(false);
  });

  it("says once that an installation is suspended on GitHub, over its dimmed repositories", async () => {
    await repositories("member", (service) => {
      service.github.connectInstallation({ ...northwind, state: "suspended" });
      service.github.choose(["checkout", "api"]);
      service.github.state.repositories = service.github.state.repositories.map((repository) => ({ ...repository, state: "installation-suspended" }));
    });
    expect(text("installation-suspended")).toBe("northwind-labs is suspended on GitHubThe installation is suspended on GitHub, so no workspace can reach its repositories until it is unsuspended.");
    expect(disabled("repository-northwind-labs/checkout")).toBe(true);
    // Nothing can be picked, so there is nothing to search or count.
    expect(page.byId("repository-search")).toBeNull();
    expect(page.byId("type-url")).not.toBeNull();
  });
});

describe("branches, a typed URL, and the review", () => {
  it("gives each chosen repository its own branch or tag; empty means its default branch, which the sheet names", async () => {
    await repositories("admin", chosen(["checkout", "api"]));
    await press("repository-northwind-labs/api");
    await press("chosen-northwind-labs/api");
    expect(text("branch-sheet")).toContain("Branch or tagnorthwind-labs/api");
    expect(text("branch-sheet")).toContain("Leave it empty to clone main, the repository’s default branch.");
    await page.type(field("branch-ref"), " release/2.4 ");
    await press("branch-done");
    expect(page.byId("branch-sheet")).toBeNull();
    expect(label("chosen-northwind-labs/api")).toBe("northwind-labs/api, branch or tag: release/2.4");
    // Removing it from the sheet unticks it in the list.
    await press("chosen-northwind-labs/api");
    await press("branch-remove");
    expect(ticked("repository-northwind-labs/api")).toBe(false);
    expect(page.byId("chosen-repositories")).toBeNull();
  });

  it("adds a typed URL beside picked ones, as one of the five, and refuses what is not a repository", async () => {
    await repositories("admin", chosen(["checkout", "api"]));
    await press("repository-northwind-labs/checkout");
    await press("type-url");
    expect(page.container.textContent).toContain("Type a URL");
    expect(page.container.textContent).toContain("For a repository that is not in the list. It is checked when you review the price.");
    await page.type(field("repository-url"), "acme sandbox");
    await press("add-repository");
    expect(text("repository-url")).toContain("Enter a GitHub repository URL like https://github.com/organization/repository.");
    await page.type(field("repository-url"), "github.com/acme/sandbox");
    await press("add-repository");
    expect(label("chosen-acme/sandbox")).toBe("acme/sandbox, typed URL, branch or tag: Default branch");
    expect(page.byId("chosen-acme/sandbox")!.textContent).toContain("Typed URL");
    expect(text("repositories-count")).toBe("Choose up to five2 of 5 chosen");
    expect(text("use-repositories")).toBe("Use 2 repositories");
  });

  it("takes a typed URL of a listed repository as that repository, not as a second one", async () => {
    await repositories("admin", chosen(["checkout", "api"]));
    await press("type-url");
    await page.type(field("repository-url"), "https://github.com/Northwind-Labs/API.git");
    await page.type(field("repository-ref"), "v2");
    await press("add-repository");
    expect(ticked("repository-northwind-labs/api")).toBe(true);
    expect(label("chosen-northwind-labs/api")).toBe("northwind-labs/api, branch or tag: v2");
  });

  it("checks and reviews every repository with its branch, and sends them all to the launch", async () => {
    const service = await repositories("admin", chosen(["checkout", "api"]));
    await press("repository-northwind-labs/checkout");
    await press("repository-northwind-labs/api");
    await press("chosen-northwind-labs/api");
    await page.type(field("branch-ref"), "release/2.4");
    await press("branch-done");
    await press("type-url");
    await page.type(field("repository-url"), "github.com/acme/sandbox");
    await press("add-repository");
    await press("use-repositories");
    expect(label("pick-repository")).toBe("Repositories: checkout and 2 more");
    await page.type(field("workspace-name"), "Checkout redesign");
    await press("review-price");
    const sent = [{ sourceProvider: "github", cloneUrl: "https://github.com/northwind-labs/checkout" }, { sourceProvider: "github", cloneUrl: "https://github.com/northwind-labs/api", ref: "release/2.4" }, { sourceProvider: "github", cloneUrl: "https://github.com/acme/sandbox" }];
    expect(service.sent("POST", "/cloud-workspaces/preflight")[0]!.body).toEqual({ setup: { version: 1, credentialIds: ["cred_codex", "cred_claude"], repositories: sent } });
    // Several are one to a line under the label, each with the branch it is cloned at.
    expect(labels()).toContain("Repositories: northwind-labs/checkout · main\nnorthwind-labs/api · release/2.4\nacme/sandbox");
    await press("launch");
    await act(async () => { alert.mock.calls.at(-1)![2]!.find((button) => button.text === "Launch")!.onPress?.(); });
    await pass();
    expect((service.sent("POST", "/cloud-workspaces")[0]!.body as { setup: unknown }).setup).toEqual({ version: 1, credentialIds: ["cred_codex", "cred_claude"], repositories: sent });
  });

  it("marks, in the list of chosen ones, the repository and the branch the check before pricing refused", async () => {
    const service = await repositories("admin", chosen(["checkout", "api"]));
    service.state.preflight = { version: 1, ready: false, checks: [{ kind: "repository", cloneUrl: "https://github.com/northwind-labs/api.git", status: "failed", errorCode: "cloud_workspace_repository_ref_not_found" }] };
    await press("repository-northwind-labs/checkout");
    await press("repository-northwind-labs/api");
    await press("use-repositories");
    await page.type(field("workspace-name"), "Checkout redesign");
    await press("review-price");
    expect(text("preflight-problems")).toContain("northwind-labs/api: that branch or tag was not found in the repository.");
    await press("pick-repository");
    expect(label("chosen-northwind-labs/api")).toBe("northwind-labs/api, branch or tag: main. That branch or tag was not found in the repository.");
    expect(label("chosen-northwind-labs/checkout")).toBe("northwind-labs/checkout, branch or tag: main");
  });

  it("says on the review, in the desktop's sentence, when a repository is not in the organization's environment image", async () => {
    const service = await repositories("admin", chosen(["checkout"]));
    await press("repository-northwind-labs/checkout");
    await press("use-repositories");
    expect(label("pick-repository")).toBe("Repository: northwind-labs/checkout");
    await page.type(field("workspace-name"), "Checkout redesign");
    await press("review-price");
    expect(page.byLabel("Repository: northwind-labs/checkout · main")).not.toBeNull();
    service.state.answer = (call) => (call.path === "/cloud-workspaces" && call.method === "POST" ? refuse("cloud_environment_repository_not_in_image", 409) : undefined);
    await press("launch");
    await act(async () => { alert.mock.calls.at(-1)![2]!.find((button) => button.text === "Launch")!.onPress?.(); });
    await pass();
    expect(text("launch-refusal")).toBe("That repository is not in the organization's environment image. Add it and rebuild the environment first.");
  });
});
