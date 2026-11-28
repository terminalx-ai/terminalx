// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Alert } from "react-native";
import NewWorkspaceScreen from "../app/cloud/new";
import DeleteWorkspaceScreen from "../app/cloud/delete";
import { QUOTE_EXPIRED, SPEND_NOTICE } from "./cloud/launch";
import { account } from "./cloud/testing/account";
import { operation, refuse, terminalxCloud, workspace, boat } from "./cloud/testing/server";
import { LAUNCH_POLL_MS, LaunchProgress, OPEN_AFTER_MS } from "./ui/LaunchProgress";
import { priceText } from "./ui/PriceLines";
import { appearance, stage } from "./ui/testing/kit";
import { workspaceActions } from "./ui/workspace-actions";

// PRO-530: launch, stop and delete a cloud workspace from the phone (25.05, 25.06).
// Each screen runs against the real client and catalog, over an account service that answers as the server does.
const mocks = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  router: { back: vi.fn(), push: vi.fn(), replace: vi.fn(), dismissAll: vi.fn(), canDismiss: () => true },
  catalog: null as unknown,
  focus: [] as (() => void)[],
}));
vi.mock("react-native", async () => {
  const native = await import("@mobile/ui/testing/native");
  return { ...native, KeyboardAvoidingView: native.View, ActivityIndicator: () => <i data-busy="true" />, Modal: ({ children }: { children?: unknown }) => <div role="dialog">{children as never}</div> };
});
vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()));
vi.mock("expo-router", () => ({ Stack: { Screen: () => null }, useLocalSearchParams: () => mocks.params, useRouter: () => mocks.router, useFocusEffect: (run: () => void) => { mocks.focus.push(run); }, usePreventRemove: () => undefined }));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => ({}) }));
vi.mock("expo-crypto", () => ({ randomUUID: () => globalThis.crypto.randomUUID() }));
vi.mock("expo-clipboard", () => ({ getStringAsync: async () => "", hasStringAsync: async () => false }));
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
const disabled = (id: string) => page.byId(id)?.getAttribute("aria-disabled") === "true";
const field = (id: string) => page.byId(id)!.querySelector("input");
/** Press the button of the last alert that has this label. */
const answer = async (label: string) => {
  const buttons = alert.mock.calls.at(-1)![2]!;
  await act(async () => { buttons.find((button) => button.text === label)!.onPress?.(); });
  await pass();
};

async function signedIn(start: Parameters<typeof account>[0] = {}, change?: (service: Account) => void) {
  const service = account(start);
  change?.(service);
  held = service;
  mocks.catalog = service.catalog;
  await service.catalog.refresh();
  return service;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(Date.UTC(2026, 10, 23, 10, 0, 0));
  mocks.params = {};
  mocks.focus = [];
  for (const spy of [mocks.router.back, mocks.router.push, mocks.router.replace, mocks.router.dismissAll, alert]) spy.mockReset();
});
afterEach(() => { held?.catalog.close(); held = null; vi.useRealTimers(); });

describe("the launch form", () => {
  const form = async (start?: Parameters<typeof account>[0], change?: (service: Account) => void) => {
    const service = await signedIn(start, change);
    await page.show(<NewWorkspaceScreen />);
    await pass();
    return service;
  };
  const toReview = async (name = "Checkout redesign") => {
    await page.type(field("workspace-name"), name);
    await page.press(page.byId("review-price"));
    await pass();
  };

  it("offers the providers that bill directly and never TerminalX Cloud", async () => {
    await form({}, (service) => { service.state.providers = [terminalxCloud, ...service.state.providers]; });
    await page.press(page.byId("pick-provider"));
    const choices = [...page.byId("choice-sheet")!.querySelectorAll("[data-testid^='choice-']")].map((row) => row.getAttribute("data-testid"));
    expect(choices).toEqual(["choice-box", "choice-agent37"]);
    expect(page.byId("choice-sheet")!.textContent).not.toContain("TerminalX Cloud");
    expect(page.byLabel("Boat, Per second, billed by Boat")!.getAttribute("aria-selected")).toBe("true");
  });

  it("fills the form with what the server's setup answer offers: its default size with its rate, its region, its idle time", async () => {
    const service = await form();
    expect(service.sent("GET", "/cloud-workspaces/setup?provider=box")).toHaveLength(1);
    expect(page.byId("pick-size")!.getAttribute("aria-label")).toBe(`Size: Small · ${priceText(18_000, "USD")} / hour`);
    // Boat places the machine itself: its region is stated, not chosen.
    expect(page.byLabel("Region: Automatic EU placement")).not.toBeNull();
    expect(page.byId("pick-region")).toBeNull();
    expect(page.byId("pick-stop-when-idle")!.getAttribute("aria-label")).toBe("Stop when idle: After 15 minutes");
    // The sizes are the server's, each with its machine and its rate.
    await page.press(page.byId("pick-size"));
    expect([...page.byId("choice-sheet")!.querySelectorAll("[data-testid^='choice-']")].map((row) => row.getAttribute("aria-label"))).toEqual([
      `Small, 2 vCPU · 4 GiB memory · 40 GiB disk, ${priceText(18_000, "USD")}, per active hour`,
      `Default, 4 vCPU · 8 GiB memory · 80 GiB disk, ${priceText(36_000, "USD")}, per active hour`,
      `Large, 8 vCPU · 16 GiB memory · 100 GiB disk, ${priceText(72_000, "USD")}, per active hour`,
    ]);
    await page.press(page.byId("choice-large"));
    expect(page.byId("choice-sheet")).toBeNull();
    expect(page.byId("pick-size")!.getAttribute("aria-label")).toContain("Large");
  });

  it("reads the other provider's choices when it is picked: Agent37's regions are chosen, and its organization limit drops Never", async () => {
    const service = await form();
    await page.press(page.byId("pick-provider"));
    await page.press(page.byId("choice-agent37"));
    await pass();
    expect(service.sent("GET", "/cloud-workspaces/setup?provider=agent37")).toHaveLength(1);
    expect(page.byId("pick-size")!.getAttribute("aria-label")).toBe("Size: 2 vCPU · 4 GB RAM");
    await page.press(page.byId("pick-region"));
    expect(page.byId("choice-sheet")!.textContent).toContain("France");
    await page.press(page.byId("choice-fr"));
    await page.press(page.byId("pick-stop-when-idle"));
    expect(page.byId("choice-0")).toBeNull();
    expect(page.byId("choice-60")).not.toBeNull();
  });

  it("offers the organization's working agent logins, ticked, and no model to choose: the server's setup answer has none", async () => {
    await form();
    expect(page.byId("agent-codex")!.getAttribute("aria-label")).toBe("Codex, alex@example.com");
    expect(page.byId("agent-claude")).not.toBeNull();
    // The first task (PRO-547) states the agent's own default, with nothing to pick.
    expect(page.byLabel("Model: Agent’s default")).not.toBeNull();
    expect(page.byId("pick-model")).toBeNull();
  });

  it("does not price until it has a name", async () => {
    const service = await form();
    expect(disabled("review-price")).toBe(true);
    await page.type(field("workspace-name"), "   ");
    expect(disabled("review-price")).toBe(true);
    await page.type(field("workspace-name"), "Checkout redesign");
    expect(disabled("review-price")).toBe(false);
    expect(service.sent("POST", "/cloud-workspaces/quote")).toHaveLength(0);
  });

  it("says there is nothing to launch on, and where to connect it", async () => {
    await form({}, (service) => { service.state.providers = [terminalxCloud, { ...boat, availability: "not-connected" }]; });
    expect(page.byId("launch-not-connected")!.textContent).toContain("Connect compute first");
    expect(page.byId("launch-not-connected")!.textContent).toContain("Acme has no provider to launch on yet.");
    expect(page.byId("workspace-name")).toBeNull();
    // The Compute page itself (25.03), which goes back to the form: not the organization's page (PRO-559).
    await page.press(page.byText("Connect compute"));
    expect(mocks.router.push).toHaveBeenCalledWith({ pathname: "/cloud/compute", params: { orgId: "org-1" } });
  });

  describe("opened by + with several organizations (PRO-557)", () => {
    // The account's first organization is the personal one, with no compute; Acme, after it, can launch.
    const several = (personalProviders: unknown[] = [{ ...boat, availability: "not-connected" }]) => (service: Account) => {
      service.state.answer = ({ path }) => {
        if (path.endsWith("/v1/desktop/auth/capabilities")) return { body: { cloud: { userId: "u" }, organizations: [{ orgId: "org-p", name: "Personal (alex@example.com)", role: "owner", isPersonal: true }, { orgId: "org-1", name: "Acme", role: "admin" }], capabilities: { flags: {}, refreshedAt: 1 } } };
        if (path.endsWith("/orgs/org-p/cloud-providers")) return { body: { providers: personalProviders } };
        if (path.endsWith("/orgs/org-p/cloud-workspace-credentials")) return { body: { credentials: [] } };
        if (path.endsWith("/orgs/org-p/cloud-workspaces")) return { body: { workspaces: [], tombstones: [] } };
        return undefined;
      };
    };

    it("opens the organization that can launch, not the first in the list", async () => {
      await form({}, several());
      expect(page.byId("launch-not-connected")).toBeNull();
      expect(page.byId("workspace-name")).not.toBeNull();
      expect(page.byId("pick-organization")!.getAttribute("aria-label")).toBe("Organization: Acme");
    });

    it("opens the first when none can launch, and lets another be picked from Connect compute first", async () => {
      await form({}, (service) => { several()(service); service.state.providers = [{ ...boat, availability: "not-connected" }]; });
      expect(page.byId("launch-not-connected")!.textContent).toContain("Personal (alex@example.com) has no provider to launch on yet.");
      // The organization row is on this state too, and opens the same sheet as on the form.
      await page.press(page.byId("pick-organization"));
      await page.press(page.byId("choice-org-1"));
      await pass();
      expect(page.byId("launch-not-connected")!.textContent).toContain("Acme has no provider to launch on yet.");
      await page.press(page.byText("Connect compute"));
      expect(mocks.router.push).toHaveBeenLastCalledWith({ pathname: "/cloud/compute", params: { orgId: "org-1" } });
    });

    it("launches where it was opened for, whatever the others can do", async () => {
      mocks.params = { orgId: "org-p" };
      await form({}, several());
      expect(page.byId("launch-not-connected")!.textContent).toContain("Personal (alex@example.com) has no provider to launch on yet.");
      expect(page.byId("pick-organization")!.getAttribute("aria-label")).toBe("Organization: Personal (alex@example.com)");
    });
  });

  it("says new workspaces are paused, with nothing to press", async () => {
    await form({}, (service) => { service.state.providers = [{ ...boat, availability: "disabled-for-create" }]; });
    expect(page.byId("launch-paused")!.textContent).toContain("New workspaces are pausedNew cloud workspaces are paused for this organization.");
    expect(page.byId("launch-paused")!.querySelectorAll("[role='button']")).toHaveLength(0);
  });

  it("says the service could not be reached, and reads again on Try again", async () => {
    let online = false;
    const service = await form({}, (made) => { made.state.answer = (call) => (!online && call.path === "/cloud-providers" ? "offline" : undefined); });
    expect(page.byId("launch-unreachable")!.textContent).toContain("Sizes and prices could not be read");
    online = true;
    await page.press(page.byText("Try again"));
    await pass();
    expect(page.byId("workspace-name")).not.toBeNull();
    expect(service.sent("GET", "/cloud-providers")).toHaveLength(2);
  });

  it("lets a member launch without choosing logins the server does not show them", async () => {
    await form({ role: "member" });
    expect(page.byId("agent-codex")).toBeNull();
    await toReview();
    expect(text("review-facts")).toContain("AgentsNone");
  });

  it("lists what preflight found and asks for no price", async () => {
    const service = await form({}, (made) => {
      made.state.preflight = { version: 1, ready: false, checks: [{ kind: "agent-credential", agent: "codex", status: "failed", errorCode: "cloud_agent_credential_reauth_required" }, { kind: "credential", provider: "claude", credentialId: "cred_claude", status: "failed", errorCode: "cloud_workspace_credential_invalid" }] };
    });
    await toReview();
    expect(text("preflight-problems")).toBe("Two things to fix before this can be pricedCodex: sign-in required.The Claude Code credential failed verification. It may have expired.");
    expect(page.byId("preflight-problems")!.getAttribute("role")).toBe("alert");
    expect(service.sent("POST", "/cloud-workspaces/quote")).toHaveLength(0);
    expect(disabled("review-price")).toBe(true);
    // Changing the form clears what was said about the old one.
    await page.press(page.byId("agent-codex"));
    expect(page.byId("preflight-problems")).toBeNull();
    expect(disabled("review-price")).toBe(false);
  });

  it("checks a typed repository with the saved logins, and sends a private one to where a token is added", async () => {
    const service = await form({}, (made) => {
      made.state.preflight = { version: 1, ready: false, checks: [{ kind: "repository", cloneUrl: "https://github.com/acme/app", status: "failed", errorCode: "cloud_workspace_repository_credential_required" }] };
    });
    await page.press(page.byId("pick-repository"));
    await page.type(field("repository-url"), "not a repository");
    await page.press(page.byId("use-repository"));
    expect(text("repository-url")).toContain("Enter a GitHub repository");
    await page.type(field("repository-url"), "github.com/acme/app");
    await page.type(field("repository-ref"), "main");
    await page.press(page.byId("use-repository"));
    expect(page.byId("pick-repository")!.getAttribute("aria-label")).toBe("Repository: acme/app");
    await toReview();
    expect(service.sent("POST", "/cloud-workspaces/preflight")[0].body).toEqual({ setup: { version: 1, credentialIds: ["cred_codex", "cred_claude"], repositories: [{ sourceProvider: "github", cloneUrl: "https://github.com/acme/app", ref: "main" }] } });
    expect(text("preflight-problems")).toContain("acme/app: this repository needs a GitHub personal access token.");
    await page.press(page.byId("pick-repository"));
    await page.press(page.byId("add-github-token"));
    expect(mocks.router.push).toHaveBeenCalledWith({ pathname: "/organization/[orgId]", params: { orgId: "org-1" } });
  });

  it("shows a refusal to price on the form, in words", async () => {
    await form({}, (made) => { made.state.answer = (call) => (call.path === "/cloud-workspaces/quote" ? refuse("cloud_workspace_policy_denied", 422) : undefined); });
    await toReview();
    expect(text("form-refusal")).toBe("That size, region or idle setting is not allowed by this organization’s limits.");
    expect(page.byId("review-facts")).toBeNull();
  });

  describe("review", () => {
    it("shows what will be launched and the server's quote, in dark and in light", async () => {
      await form();
      await toReview();
      expect(text("review-facts")).toBe("NameCheckout redesignProviderBoatSizeSmall · 2 vCPU · 4 GiB · 40 GiBRegionAutomatic EU placementStops when idleAfter 15 minutesRepositoryNoneAgentsCodex, Claude Code");
      expect(text("review-price")).toContain(`Per active hour${priceText(18_000, "USD")}`);
      expect(text("review-price")).toContain(`Always on, 30 days${priceText(12_960_000, "USD")}`);
      expect(text("price-holds")).toBe("Per second, billed by Boat. Prices shown are estimates. This price holds for 5:00.");
      const dark = page.styleOf(page.byText("Per active hour")).color;
      appearance.scheme = "light";
      await page.show(<NewWorkspaceScreen />);
      expect(page.styleOf(page.byText("Per active hour")).color).not.toBe(dark);
    });

    it("creates nothing until the person says yes to the spend, in the console's sentence", async () => {
      const service = await form();
      await toReview();
      await page.press(page.byId("launch"));
      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert.mock.calls[0].slice(0, 2)).toEqual(["Launch and start spending?", SPEND_NOTICE]);
      expect(alert.mock.calls[0][2]!.map((button) => button.text)).toEqual(["Cancel", "Launch"]);
      await answer("Cancel");
      expect(service.sent("POST", "/cloud-workspaces")).toHaveLength(0);
      expect(service.state.workspaces.size).toBe(0);
    });

    it("launches the quote once, and opens the workspace's page on its operation", async () => {
      const service = await form();
      await toReview();
      await page.press(page.byId("launch"));
      await answer("Launch");
      const sent = service.sent("POST", "/cloud-workspaces");
      expect(sent).toHaveLength(1);
      expect(sent[0].body).toEqual({ name: "Checkout redesign", quoteId: "quote_1", confirmProviderSpend: true, setup: { version: 1, credentialIds: ["cred_codex", "cred_claude"] }, launch: { v: 1, agent: "codex", mode: "manual" } });
      expect(sent[0].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(mocks.router.replace).toHaveBeenCalledWith({ pathname: "/cloud/[workspaceId]", params: { workspaceId: "ws-2", orgId: "org-1", operationId: "op-3", title: "Checkout redesign" } });
      // The list has it at once, before the next read of the list.
      expect(service.catalog.getSnapshot().organizations[0].workspaces.map((item) => item.workspace.id)).toEqual(["ws-2"]);
    });

    it("asks for a new price when the quote runs out, and never launches the old one", async () => {
      const service = await form();
      await toReview();
      await pass(service.state.quoteHoldsMs + 1_000);
      expect(text("price-expired")).toBe(QUOTE_EXPIRED);
      expect(page.byId("launch")).toBeNull();
      expect(service.sent("POST", "/cloud-workspaces")).toHaveLength(0);
      // The provider's rate moved meanwhile: the new price says so.
      service.state.hourlyMicros = 20_000;
      await page.press(page.byId("new-price"));
      await pass();
      expect(service.sent("POST", "/cloud-workspaces/quote")).toHaveLength(2);
      expect(page.byId("price-expired")).toBeNull();
      expect(text("price-changed")).toBe(`The price changed since you last looked: it was ${priceText(18_000, "USD")} per active hour.`);
      expect(text("review-price")).toContain(priceText(20_000, "USD"));
      await page.press(page.byId("launch"));
      await answer("Launch");
      expect(service.sent("POST", "/cloud-workspaces").map((call) => (call.body as { quoteId: string }).quoteId)).toEqual(["quote_2"]);
    });

    it("takes the server's word that a quote expired: nothing is launched, a new price is asked for", async () => {
      const service = await form();
      await toReview();
      // The server's clock is ahead of the phone's countdown.
      service.state.quotes.clear();
      await page.press(page.byId("launch"));
      await answer("Launch");
      expect(text("price-expired")).toBe(QUOTE_EXPIRED);
      expect(page.byId("new-price")).not.toBeNull();
      expect(service.state.workspaces.size).toBe(0);
      expect(mocks.router.replace).not.toHaveBeenCalled();
    });

    it("does not launch a second workspace when the first answer is lost: the same key is asked again", async () => {
      const service = await form();
      await toReview();
      // The request reaches the server, which starts the launch; the answer never reaches the phone.
      let lost = false;
      service.state.answer = (call) => {
        if (lost || call.method !== "POST" || call.path !== "/cloud-workspaces") return undefined;
        lost = true;
        service.handle(call);
        return "offline";
      };
      await page.press(page.byId("launch"));
      await answer("Launch");
      expect(text("launch-unanswered")).toBe("No answer came back. Checking whether the launch started; nothing is launched twice.");
      expect(text("launch")).toBe("Checking whether it started…");
      expect(disabled("launch")).toBe(true);
      await pass(2_000);
      const sent = service.sent("POST", "/cloud-workspaces");
      expect(sent).toHaveLength(2);
      expect(sent[1].headers["Idempotency-Key"]).toBe(sent[0].headers["Idempotency-Key"]);
      expect(service.state.workspaces.size).toBe(1);
      expect(mocks.router.replace).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ workspaceId: "ws-2", operationId: "op-3" }) }));
    });

    it("keeps the key when the phone stays offline, and Check again asks about the same launch without asking to spend again", async () => {
      const service = await form();
      await toReview();
      let online = false;
      service.state.answer = (call) => (!online && call.method === "POST" && call.path === "/cloud-workspaces" ? "offline" : undefined);
      await page.press(page.byId("launch"));
      await answer("Launch");
      await pass(20_000);
      expect(text("launch")).toBe("Check again");
      expect(text("launch-unanswered")).not.toBeNull();
      online = true;
      await page.press(page.byId("launch"));
      await pass();
      expect(alert).toHaveBeenCalledTimes(1);
      expect(new Set(service.sent("POST", "/cloud-workspaces").map((call) => call.headers["Idempotency-Key"])).size).toBe(1);
      expect(service.state.workspaces.size).toBe(1);
    });

    it("says a refusal to launch in words, and sends a rejected key to where it is replaced", async () => {
      const service = await form();
      await toReview();
      service.state.answer = (call) => (call.method === "POST" && call.path === "/cloud-workspaces" ? refuse("cloud_provider_connection_attention_required", 409) : undefined);
      await page.press(page.byId("launch"));
      await answer("Launch");
      expect(text("launch-refusal")).toBe("Boat rejected the stored key on its last check. Replace the key to continue.Connect compute");
      expect(service.state.workspaces.size).toBe(0);
      // Launch stays: once the key is replaced, the same price is launched from here, after asking again.
      expect(disabled("launch")).toBe(false);
      service.state.answer = null;
      await page.press(page.byId("launch"));
      expect(alert).toHaveBeenCalledTimes(2);
      await answer("Launch");
      expect(page.byId("launch-refusal")).toBeNull();
      expect(service.state.workspaces.size).toBe(1);
    });

    it("lets a refusal that only asks to wait be tried again from the same page", async () => {
      const service = await form();
      await toReview();
      service.state.answer = (call) => (call.method === "POST" && call.path === "/cloud-workspaces" ? refuse("cloud_workspace_rate_limited", 429) : undefined);
      await page.press(page.byId("launch"));
      await answer("Launch");
      expect(text("launch-refusal")).toBe("Too many requests just now. Try again in a moment.");
      expect(disabled("launch")).toBe(false);
      expect(text("launch")).toBe("Launch workspace");
    });

    describe("after a launch that got no answer", () => {
      /** The launch reached the server (unless `arrives` is false) and no answer reached the phone, through every retry. */
      const lostLaunch = async (arrives = true) => {
        const service = await form();
        await toReview();
        let started = !arrives;
        const online = { value: false };
        service.state.answer = (call) => {
          if (online.value || call.method !== "POST" || call.path !== "/cloud-workspaces") return undefined;
          if (!started) { started = true; service.handle(call); }
          return "offline";
        };
        await page.press(page.byId("launch"));
        await answer("Launch");
        await pass(20_000);
        expect(text("launch")).toBe("Check again");
        return { service, online };
      };
      const keys = (service: Account) => new Set(service.sent("POST", "/cloud-workspaces").map((call) => call.headers["Idempotency-Key"]));

      it("offers no new price when the quote runs out: only the same launch can be asked about, and it is found", async () => {
        const { service, online } = await lostLaunch();
        await pass(service.state.quoteHoldsMs);
        // The price has run out, and the launch may be running: nothing here can start another.
        expect(page.byId("new-price")).toBeNull();
        expect(page.byId("price-expired")).toBeNull();
        expect(text("launch-unanswered")).not.toBeNull();
        expect(text("launch")).toBe("Check again");
        online.value = true;
        await page.press(page.byId("launch"));
        await pass();
        expect(alert).toHaveBeenCalledTimes(1);
        expect(keys(service).size).toBe(1);
        expect(service.sent("POST", "/cloud-workspaces/quote")).toHaveLength(1);
        expect(service.state.workspaces.size).toBe(1);
        expect(mocks.router.replace).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ workspaceId: "ws-2" }) }));
      });

      it("does not go back to the form to price again while the launch may have started", async () => {
        const { service } = await lostLaunch();
        await page.press(page.byLabel("Back"));
        expect(page.byId("review-facts")).not.toBeNull();
        expect(page.byId("review-price")).not.toBeNull();
        expect(page.byId("workspace-name")).toBeNull();
        expect(service.sent("POST", "/cloud-workspaces/quote")).toHaveLength(1);
      });

      it("keeps asking under the same key when the answer says nothing of the first request", async () => {
        const { service, online } = await lostLaunch();
        online.value = true;
        service.state.answer = (call) => (call.method === "POST" && call.path === "/cloud-workspaces" ? refuse("cloud_workspace_rate_limited", 429) : undefined);
        await page.press(page.byId("launch"));
        await pass();
        expect(text("launch")).toBe("Check again");
        expect(page.byId("new-price")).toBeNull();
        service.state.answer = null;
        await page.press(page.byId("launch"));
        await pass();
        expect(keys(service).size).toBe(1);
        expect(service.state.workspaces.size).toBe(1);
      });

      it("asks for a new price once the server says it holds no launch under that key", async () => {
        // The request never arrived, and by the time the phone is back the quote has run out.
        const { service, online } = await lostLaunch(false);
        await pass(service.state.quoteHoldsMs);
        online.value = true;
        await page.press(page.byId("launch"));
        await pass();
        expect(page.byId("launch-unanswered")).toBeNull();
        expect(text("price-expired")).toBe(QUOTE_EXPIRED);
        expect(service.state.workspaces.size).toBe(0);
        await page.press(page.byId("new-price"));
        await pass();
        await page.press(page.byId("launch"));
        await answer("Launch");
        expect(service.state.workspaces.size).toBe(1);
      });
    });
  });
});

describe("a launch in progress", () => {
  const launched = async (op: Record<string, unknown> = {}, ws: Record<string, unknown> = {}) => {
    const service = await signedIn({ workspaces: [{ workspace: workspace(ws), latestOperation: operation(op) }] });
    const on = { onOpen: vi.fn(), onDelete: vi.fn(), onRetried: vi.fn(), onBack: vi.fn(), onLaunchAgain: vi.fn(), onFixKey: vi.fn(), onAgentLogins: vi.fn() };
    await page.show(<LaunchProgress catalog={service.catalog} orgId="org-1" operationId="op-9" title="Checkout redesign" {...on} />);
    await pass();
    return { service, on };
  };
  const stages = () => [0, 1, 2, 3, 4, 5].map((index) => page.byId(`operation-stage-${index}`)!.getAttribute("aria-label"));

  it("shows the operation's stage, read again every few seconds, with Cancel while the server allows it", async () => {
    const { service } = await launched({ state: "running", stage: "creating-machine" });
    expect(text("launch-head")).toBe("Launching…");
    expect(text("launch-state-line")).toBe("Starting · You are a manager");
    expect(stages().slice(0, 4)).toEqual(["Queued, done", "Checking the provider, done", "Creating the machine, in progress", "Installing the runtime, not started"]);
    expect(text("launch-note")).toBe("You can leave this page. The launch carries on, and the workspace shows in the Cloud tab.");
    expect(disabled("cancel-launch")).toBe(false);
    service.advance("op-9", { stage: "bootstrapping", cancelable: false, events: [{ code: "repository-cloning", occurredAt: 5 }] });
    await pass(LAUNCH_POLL_MS);
    expect(stages()[3]).toBe("Installing the runtime, in progress: Cloning the repository");
    expect(text("launch-note")).toBe("It can no longer be canceled. Once it is running you can stop or delete it.");
    expect(disabled("cancel-launch")).toBe(true);
  });

  it("opens the workspace by itself once it runs, or at once on Open workspace", async () => {
    const { service, on } = await launched({ state: "running", stage: "connecting-relay", cancelable: false });
    service.advance("op-9", { state: "succeeded", stage: "ready" }, { state: "ready" });
    await pass(LAUNCH_POLL_MS);
    expect(text("launch-head")).toBe("Checkout redesign is running");
    expect(text("launch-note")).toBe("Opening it in a moment…");
    expect(stages().every((label) => label!.endsWith(", done"))).toBe(true);
    expect(on.onOpen).not.toHaveBeenCalled();
    await pass(OPEN_AFTER_MS);
    expect(on.onOpen).toHaveBeenCalledTimes(1);
    // Settled: the operation is not read again.
    const reads = service.sent("GET", "/cloud-workspace-operations/op-9").length;
    await pass(LAUNCH_POLL_MS * 3);
    expect(service.sent("GET", "/cloud-workspace-operations/op-9")).toHaveLength(reads);
    await page.press(page.byId("open-workspace"));
    expect(on.onOpen).toHaveBeenCalledTimes(2);
  });

  it("cancels only after asking, then shows the cleanup where the launch had got to", async () => {
    const { service, on } = await launched({ state: "running", stage: "creating-machine" });
    await page.press(page.byId("cancel-launch"));
    expect(alert.mock.calls[0].slice(0, 2)).toEqual(["Cancel this launch?", "The machine being created is removed."]);
    expect(alert.mock.calls[0][2]!.map((button) => button.text)).toEqual(["Cancel launch", "Keep launching"]);
    await answer("Keep launching");
    expect(service.sent("POST", "/cloud-workspace-operations/op-9/cancel")).toHaveLength(0);
    await page.press(page.byId("cancel-launch"));
    await answer("Cancel launch");
    expect(service.sent("POST", "/cloud-workspace-operations/op-9/cancel")).toHaveLength(1);
    expect(text("launch-head")).toBe("Canceling…");
    expect(stages()[2]).toBe("Creating the machine, in progress: Cleaning up");
    expect(text("launch-note")).toBe("Removing what was created so far.");
    expect(disabled("cancel-launch")).toBe(true);
    service.advance("op-9", { state: "canceled" }, { state: "destroyed" });
    await pass(LAUNCH_POLL_MS);
    expect(text("launch-head")).toBe("Launch canceled");
    expect(stages()[2]).toBe("Creating the machine, failed: Canceled");
    expect(text("launch-note")).toBe("The machine was removed. Launching again asks for a new price.");
    await page.press(page.byId("launch-again"));
    expect(on.onLaunchAgain).toHaveBeenCalledTimes(1);
    await page.press(page.byText("Back to Cloud"));
    expect(on.onBack).toHaveBeenCalledTimes(1);
  });

  it("says why a launch failed part-way and what it left: the machine exists, setup can be retried on it or it can be deleted", async () => {
    const { service, on } = await launched({ state: "running", stage: "bootstrapping", cancelable: false });
    service.advance("op-9", { state: "failed", errorCode: "bootstrap_failed" }, { state: "attention-required" });
    await pass(LAUNCH_POLL_MS);
    expect(text("launch-head")).toBe("The launch failed");
    expect(stages()).toEqual(["Queued, done", "Checking the provider, done", "Creating the machine, done", "Installing the runtime, failed: Installing or starting the runtime on the machine failed.", "Connecting to the relay, not started", "Ready, not started"]);
    expect(text("launch-left")).toBe("The machine exists. Retry setup tries again on the same machine; delete it if you would rather start over.");
    expect(page.byId("cancel-launch")).toBeNull();
    // The list shows it as it now stands.
    expect(service.catalog.getSnapshot().organizations[0].workspaces[0].workspace.state).toBe("attention-required");
    await page.press(page.byId("delete-workspace"));
    expect(on.onDelete).toHaveBeenCalledWith("ws-9");
    await page.press(page.byId("retry-setup"));
    await pass();
    expect(service.sent("POST", "/cloud-workspaces/ws-9/resume")).toHaveLength(1);
    expect(on.onRetried).toHaveBeenCalledTimes(1);
  });

  it("sends a rejected key to where it is fixed, and says no machine was created when it failed before one was", async () => {
    const { on } = await launched({ state: "failed", stage: "preflight", cancelable: false, errorCode: "cloud_provider_credential_invalid" }, { state: "attention-required" });
    expect(stages()[1]).toBe("Checking the provider, failed: The provider rejected the API key.");
    expect(text("launch-note")).toBe("No machine was created. Connect a working key, then launch again.");
    await page.press(page.byId("fix-key"));
    expect(on.onFixKey).toHaveBeenCalledTimes(1);
    expect(page.byId("retry-setup")).toBeNull();
  });

  it("offers only delete when the machine never answered, naming the provider's dashboard", async () => {
    await launched({ state: "failed", stage: "connecting-relay", cancelable: false, errorCode: "cloud_workspace_provisioning_timeout" }, { state: "attention-required" });
    expect(text("launch-left")).toBe("Delete it and launch a new one. Check Boat’s dashboard if a machine is still listed there.");
    expect(page.byId("retry-setup")).toBeNull();
    expect(page.byId("delete-workspace")).not.toBeNull();
    expect(page.byText("Back to Cloud")).not.toBeNull();
  });

  it("offers nothing to someone who does not manage the workspace", async () => {
    await launched({ state: "failed", stage: "bootstrapping", cancelable: false, errorCode: "bootstrap_failed" }, { state: "attention-required", you: { role: "driver", canApprove: false, canManageShares: false } });
    expect(text("launch-note")).toBe("An organization admin can retry or fix this.");
    expect(page.byId("retry-setup")).toBeNull();
    expect(page.byId("delete-workspace")).toBeNull();
  });

  it("says it is offline, keeps the launch going, and catches up when the phone is back", async () => {
    const { service } = await launched({ state: "running", stage: "creating-machine" });
    service.state.answer = (call) => (call.path.startsWith("/cloud-workspace-operations/") ? "offline" : undefined);
    await pass(LAUNCH_POLL_MS);
    expect(text("launch-offline")).toBe("Offline. The launch carries on without the phone; this page catches up when it is back online.");
    expect(text("launch-state-line")).toBe("Offline");
    expect(disabled("cancel-launch")).toBe(true);
    expect(stages()[2]).toBe("Creating the machine, in progress");
    service.state.answer = null;
    service.advance("op-9", { stage: "connecting-relay", cancelable: false });
    await pass(LAUNCH_POLL_MS);
    expect(page.byId("launch-offline")).toBeNull();
    expect(stages()[4]).toBe("Connecting to the relay, in progress");
  });

  it("says a refusal to cancel in words and keeps watching", async () => {
    const { service } = await launched({ state: "running", stage: "creating-machine" });
    service.state.answer = (call) => (call.path.endsWith("/cancel") ? refuse("cloud_workspace_operation_in_progress", 409) : undefined);
    await page.press(page.byId("cancel-launch"));
    await answer("Cancel launch");
    expect(page.byId("launch-problem")!.getAttribute("role")).toBe("alert");
    expect(text("launch-head")).toBe("Launching…");
  });
});

describe("stop and start", () => {
  const actionsFor = async (ws: Record<string, unknown>, op: Record<string, unknown> | null = null, role: "admin" | "member" = "admin") => {
    const service = await signedIn({ role, workspaces: [{ workspace: workspace({ state: "ready", ...ws }), latestOperation: op ? operation(op) : null }] });
    const openDelete = vi.fn();
    const read = () => workspaceActions({ catalog: service.catalog, item: service.catalog.getSnapshot().organizations[0].workspaces[0], openDelete });
    return { service, openDelete, read };
  };
  const run = async (actions: ReturnType<typeof workspaceActions>, label: string) => { await act(async () => { actions.find((action) => action.label === label)!.run(); }); await pass(); };

  it("offers a manager Stop and Delete on a running workspace, Start on a stopped one, and nothing to anyone else", async () => {
    expect((await actionsFor({})).read().map((action) => [action.label, action.destructive ?? false])).toEqual([["Stop workspace", false], ["Delete workspace…", true]]);
    held!.catalog.close();
    expect((await actionsFor({ state: "suspended" })).read().map((action) => action.label)).toEqual(["Start workspace", "Delete workspace…"]);
    held!.catalog.close();
    expect((await actionsFor({ you: { role: "driver", canApprove: true, canManageShares: false } }, null, "member")).read()).toEqual([]);
  });

  it("asks before stopping, quoting the provider's own billing line, and stops on yes", async () => {
    const { service, read } = await actionsFor({});
    await run(read(), "Stop workspace");
    expect(alert.mock.calls[0].slice(0, 2)).toEqual(["Stop this workspace?", "Its agents stop until it is started again. Boat: per second, billed by Boat."]);
    await answer("Cancel");
    expect(service.sent("POST", "/cloud-workspaces/ws-9/suspend")).toHaveLength(0);
    await run(read(), "Stop workspace");
    await answer("Stop");
    expect(service.sent("POST", "/cloud-workspaces/ws-9/suspend")).toHaveLength(1);
    // The list shows it stopping at once; Stop is no longer offered.
    expect(service.catalog.getSnapshot().organizations[0].workspaces[0].latestOperation).toMatchObject({ action: "suspend", state: "queued" });
    expect(read().map((action) => action.label)).toEqual(["Delete workspace…"]);
  });

  it("keeps showing it stopping when a list read from before the stop lands after it", async () => {
    const { service, read } = await actionsFor({});
    // A read of the list is under way, and answers with the workspace as it was before the stop.
    let land = () => undefined as void;
    const before = { body: service.handle({ path: "/cloud-workspaces", method: "GET", headers: {}, body: undefined }) };
    service.state.answer = (call) => (call.method === "GET" && call.path === "/cloud-workspaces" ? new Promise((resolve) => { land = () => resolve((before.body as { body: unknown })); }) as never : undefined);
    const reading = service.catalog.refresh();
    await pass();
    await run(read(), "Stop workspace");
    await answer("Stop");
    service.state.answer = null;
    await act(async () => { land(); await reading; });
    expect(service.catalog.getSnapshot().organizations[0].workspaces[0].latestOperation).toMatchObject({ action: "suspend", state: "queued" });
    expect(read().map((action) => action.label)).toEqual(["Delete workspace…"]);
    await pass();
    expect(service.catalog.getSnapshot().organizations[0].workspaces[0].latestOperation).toMatchObject({ action: "suspend" });
  });

  it("says an agent is working before stopping it, with the stop as the destructive answer", async () => {
    const { service, read } = await actionsFor({ runtimeActivity: { online: true, activeTurns: 1 } });
    await run(read(), "Stop workspace");
    expect(alert.mock.calls[0][0]).toBe("Stop while an agent is working?");
    expect(alert.mock.calls[0][2]!.map((button) => [button.text, button.style])).toEqual([["Stop anyway", "destructive"], ["Cancel", "cancel"]]);
    await answer("Stop anyway");
    expect(service.sent("POST", "/cloud-workspaces/ws-9/suspend")).toHaveLength(1);
  });

  it("says it cannot stop right now when something else is under way", async () => {
    const { service, read } = await actionsFor({});
    service.state.answer = (call) => (call.path.endsWith("/suspend") ? refuse("cloud_workspace_operation_in_progress", 409) : undefined);
    await run(read(), "Stop workspace");
    await answer("Stop");
    expect(alert.mock.calls.at(-1)![0]).toBe("Not right now");
    expect(read().map((action) => action.label)).toEqual(["Stop workspace", "Delete workspace…"]);
  });

  it("offers Retry stop after a stop that failed, without asking again", async () => {
    const { service, read } = await actionsFor({ state: "attention-required" }, { type: "lifecycle", action: "suspend", state: "failed", cancelable: false, errorCode: "cloud_provider_unavailable" });
    expect(read().map((action) => action.label)).toEqual(["Retry stop", "Delete workspace…"]);
    await run(read(), "Retry stop");
    expect(alert).not.toHaveBeenCalled();
    expect(service.sent("POST", "/cloud-workspaces/ws-9/suspend")).toHaveLength(1);
  });

  it("starts a stopped workspace after the existing confirmation", async () => {
    const { service, read } = await actionsFor({ state: "suspended" });
    await run(read(), "Start workspace");
    expect(alert.mock.calls[0].slice(0, 2)).toEqual(["Start this workspace?", "It is billed to the organization while it runs."]);
    await answer("Start");
    expect(service.sent("POST", "/cloud-workspaces/ws-9/resume")).toHaveLength(1);
  });

  it("opens the delete page for Delete", async () => {
    const { openDelete, read } = await actionsFor({});
    await run(read(), "Delete workspace…");
    expect(openDelete).toHaveBeenCalledTimes(1);
  });
});

describe("the delete page", () => {
  const open = async (ws: Record<string, unknown> = {}, op: Record<string, unknown> | null = null, change?: (service: Account) => void) => {
    const service = await signedIn({ workspaces: [{ workspace: workspace({ state: "ready", ...ws }), latestOperation: op ? operation(op) : null }] }, change);
    mocks.params = { orgId: "org-1", workspaceId: "ws-9" };
    await page.show(<DeleteWorkspaceScreen />);
    await pass();
    return service;
  };
  const acknowledge = () => page.press(page.byId("delete-acknowledge")!.querySelector("input"));

  it("states the console's four facts with the provider's name, and keeps Delete off until the switch is on", async () => {
    const service = await open();
    expect(text("delete-title")).toBe("Delete Checkout redesign permanently?");
    expect(text("delete-facts")).toBe("ComputeThe machine is removed.DataIts disk, snapshots and saved conversations are removed once Boat confirms.ChargesStop once Boat confirms the removal.UndoNot possible.");
    expect(disabled("delete-permanently")).toBe(true);
    await page.press(page.byId("delete-permanently"));
    await pass();
    expect(service.sent("POST", "/cloud-workspaces/ws-9/delete")).toHaveLength(0);
    await acknowledge();
    expect(disabled("delete-permanently")).toBe(false);
  });

  it("deletes once, then returns to the Cloud tab with the row being deleted", async () => {
    const service = await open();
    await acknowledge();
    await page.press(page.byId("delete-permanently"));
    await pass();
    expect(service.sent("POST", "/cloud-workspaces/ws-9/delete")).toHaveLength(1);
    expect(mocks.router.dismissAll).toHaveBeenCalledTimes(1);
    expect(page.byId("delete-permanently")).toBeNull();
    expect(page.container.textContent).toContain("Deleting…");
    expect(service.catalog.getSnapshot().organizations[0].workspaces[0].latestOperation).toMatchObject({ action: "delete" });
  });

  it("says why a delete was refused above the buttons, and deletes nothing", async () => {
    const service = await open({}, null, (made) => { made.state.answer = (call) => (call.path.endsWith("/delete") ? refuse("cloud_workspace_active_work", 409) : undefined); });
    await acknowledge();
    await page.press(page.byId("delete-permanently"));
    await pass();
    expect(text("delete-refusal")).toBe("An agent is working here, or is waiting for an answer. Stop it or answer it, then delete.");
    expect(page.byId("delete-refusal")!.nextElementSibling).toBe(page.byId("delete-permanently"));
    expect(mocks.router.dismissAll).not.toHaveBeenCalled();
    expect(text("delete-permanently")).toBe("Delete permanently");
    expect(service.state.workspaces.get("ws-9")!.state).toBe("ready");
  });

  it("does not say nothing was deleted when no answer came: the delete may have started, and the list is read", async () => {
    const service = await open({}, null, (made) => { made.state.answer = (call) => (call.path.endsWith("/delete") ? (made.handle(call), "offline") : undefined); });
    await acknowledge();
    await page.press(page.byId("delete-permanently"));
    await pass();
    expect(text("delete-refusal")).toBe("No answer came back, so the delete may or may not have started. Check the workspace in the Cloud tab before trying again.");
    // The list was read: it shows the delete the server did start.
    expect(service.catalog.getSnapshot().organizations[0].workspaces[0].latestOperation).toMatchObject({ action: "delete" });
  });

  it("leads with why the provider refused a delete and what was and was not removed", async () => {
    await open({ state: "attention-required" }, {
      type: "lifecycle", action: "delete", state: "failed", cancelable: false, errorCode: "cloud_provider_permission_denied", providerErrorCode: "403",
      cleanup: { complete: false, items: [{ kind: "runtime-credentials", state: "removed" }, { kind: "client-attachments", state: "removed" }, { kind: "provider-compute", state: "unconfirmed" }, { kind: "provider-storage", state: "pending" }] },
    });
    expect(text("delete-failed")).toBe("Boat refused to delete this machine (403). Check it in your Boat dashboard; if it is still there, delete it there, then press Delete again to clear it here.");
    expect(text("cleanup-report")).toBe("Runtime credentialsRemovedPhones and desktopsDisconnectedMachineNot confirmedDisk and snapshotsPending");
    expect(page.container.textContent).toContain("Until Boat confirms, the machine may still be billed.");
    expect(text("delete-permanently")).toBe("Delete again");
    expect(disabled("delete-permanently")).toBe(true);
  });

  it("does not offer deletion to someone who does not manage the workspace", async () => {
    await open({ you: { role: "driver", canApprove: true, canManageShares: false } });
    expect(page.container.textContent).toContain("You cannot delete this workspace");
    expect(page.byId("delete-permanently")).toBeNull();
  });

  it("draws the facts in the light palette too", async () => {
    await open();
    const dark = page.styleOf(page.byId("delete-title")).color;
    appearance.scheme = "light";
    await page.show(<DeleteWorkspaceScreen />);
    expect(page.styleOf(page.byId("delete-title")).color).not.toBe(dark);
  });
});

describe("U-61: system back handling and launch idempotency guard", () => {
  it("intercepts hardware Back on review to return to form, and blocks dismissal while a launch is unanswered", async () => {
    const { BackHandler } = await import("@mobile/ui/testing/native");
    const service = await signedIn({}, (made) => {
      made.state.answer = (call) => (call.method === "POST" && call.path.endsWith("/cloud-workspaces") ? "offline" : undefined);
    });
    await page.show(<NewWorkspaceScreen />);
    await pass();
    await page.type(field("workspace-name"), "Checkout redesign");
    await page.press(page.byId("review-price"));
    await pass();
    expect(page.byId("review-facts")).not.toBeNull();
    // Hardware Back from review returns to form (does not pop the screen).
    let handled = false;
    await act(async () => { handled = BackHandler.emit(); });
    expect(handled).toBe(true);
    expect(page.byId("review-facts")).toBeNull();
    expect(field("workspace-name")!.value).toBe("Checkout redesign");
    // Go back to review and attempt launch that gets no answer.
    await page.press(page.byId("review-price"));
    await pass();
    await page.press(page.byId("launch"));
    await answer("Launch");
    expect(page.byId("launch-unanswered")).not.toBeNull();
    // Hardware Back while unanswered MUST stay on review so the idempotency key is preserved.
    await act(async () => { handled = BackHandler.emit(); });
    expect(handled).toBe(true);
    expect(page.byId("review-facts")).not.toBeNull();
    expect(service.sent("POST", "/cloud-workspaces")).toHaveLength(1);
  });
});
