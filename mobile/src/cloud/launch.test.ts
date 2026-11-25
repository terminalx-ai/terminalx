import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudApiError, type CloudCredential, type CloudLifecycle, type CloudPreflight, type CloudProvider, type CloudQuote } from "./api";
import { LAUNCH_RETRY_MS, LaunchAttempt, QUOTE_EXPIRED, SPEND_NOTICE, agentLogins, cleanupFacts, deleteFacts, deleteFailure, deleteRefusal, firstRunSetup, idleChoices, idleValue, launchOrganization, launchProgress, launchProviders, launchRecovery, launchRefusal, mayManage, preflightProblems, pricingNote, problemsTitle, quotedSize, repositoriesRow, repositoryLine, repositoryOf, sizeDetail, sizeValue, stopQuestion, stopState, unanswered } from "./launch";
import { agent37, agent37Setup, boat, boatQuote, boatSetup, claudeKey, codexLogin, githubToken, lifecycle, refuse, server, terminalxCloud, type Answer, type Call } from "./testing/server";

// PRO-530: launching, stopping and deleting a cloud workspace from the phone (25.05, 25.06).

const providers = (...list: unknown[]) => list as CloudProvider[];
const credentials = [codexLogin, claudeKey, githubToken] as CloudCredential[];
const life = (ws: Record<string, unknown> = {}, op: Record<string, unknown> = {}) => lifecycle(ws, op) as unknown as CloudLifecycle;
const noWait = async () => undefined;

afterEach(() => { vi.useRealTimers(); });

describe("what can be launched on", () => {
  it("offers the connected providers that bill directly, in the server's order, and never TerminalX Cloud", () => {
    const { choices, blocked } = launchProviders(providers(terminalxCloud, boat, agent37));
    expect(choices.map((provider) => provider.id)).toEqual(["box", "agent37"]);
    expect(blocked).toBeNull();
  });

  it("says nothing is connected when only TerminalX Cloud is available, or a key needs attention", () => {
    expect(launchProviders(providers(terminalxCloud))).toEqual({ choices: [], blocked: "not-connected" });
    expect(launchProviders(providers(terminalxCloud, { ...boat, availability: "not-connected" })).blocked).toBe("not-connected");
    expect(launchProviders(providers({ ...boat, availability: "attention-required" })).blocked).toBe("not-connected");
    expect(launchProviders([]).blocked).toBe("not-connected");
  });

  it("says launching is paused when every connected provider is closed to new workspaces", () => {
    expect(launchProviders(providers({ ...boat, availability: "disabled-for-create" })).blocked).toBe("paused");
    expect(launchProviders(providers({ ...boat, availability: "disabled-for-create" }, { ...agent37, availability: "not-connected" })).blocked).toBe("not-connected");
  });
});

describe("the form's choices", () => {
  it("lists the server's idle times shortest first with never last, and drops what an organization's limit rules out", () => {
    expect(idleChoices(boatSetup)).toEqual([5, 10, 15, 30, 60, 0]);
    expect(idleChoices(agent37Setup)).toEqual([5, 10, 15, 30, 60]);
    expect(idleChoices({ allowedIdleSuspendMinutes: [60, 0, 5, 30], maxIdleSuspendMinutes: 30 })).toEqual([5, 30]);
    expect([idleValue(15), idleValue(0), idleValue(1)]).toEqual(["After 15 minutes", "Never", "After 1 minute"]);
  });

  it("writes a size with its rate where the provider gives one, and its machine as the console does", () => {
    expect(sizeValue(boatSetup.machineClasses[0], "$0.018")).toBe("Small · $0.018 / hour");
    expect(sizeValue(agent37Setup.machineClasses[0], null)).toBe("2 vCPU · 4 GB RAM");
    expect(sizeDetail(boatSetup.machineClasses[0])).toBe("2 vCPU · 4 GiB memory · 40 GiB disk");
    expect(sizeDetail({ vcpu: 1, memoryMiB: 1536, diskGiB: 20 })).toBe("1 vCPU · 1.5 GiB memory · 20 GiB disk");
    expect(quotedSize(boatQuote(0).configuration as CloudQuote["configuration"])).toBe("Small · 2 vCPU · 4 GiB · 40 GiB");
  });

  it("says a size once when its name already is its machine, and keeps its rate on a line that is not cut off (PRO-565)", () => {
    // Agent37 names a size by its machine: the review does not follow it with the machine again.
    const named = { ...boatQuote(0).configuration, machineClassLabel: "2 vCPU · 4 GB RAM · 20 GB disk", vcpu: 2, memoryMiB: 4096, diskGiB: 20 } as CloudQuote["configuration"];
    expect(quotedSize(named)).toBe("2 vCPU · 4 GB RAM · 20 GB disk");
    // On the form the name fills the row, so the rate takes the second line.
    expect(sizeValue({ label: "2 vCPU · 4 GB RAM · 20 GB disk" }, "$0.014")).toBe("2 vCPU · 4 GB RAM · 20 GB disk\n$0.014 / hour");
    expect(sizeValue({ label: "Small" }, "$0.018")).toBe("Small · $0.018 / hour");
  });

  it("opens + on the first organization that has a provider to launch on, and on the first when none has (PRO-557)", () => {
    const personal = { orgId: "org-p" }, demo = { orgId: "org-d" }, other = { orgId: "org-o" };
    const lists: Record<string, CloudProvider[] | null> = { "org-p": providers({ ...boat, availability: "not-connected" }), "org-d": providers(boat), "org-o": providers(agent37) };
    expect(launchOrganization([personal, demo, other], (orgId) => lists[orgId])).toBe(demo);
    // TerminalX Cloud alone is not something the phone launches on; a list that did not answer is not known to launch.
    expect(launchOrganization([personal, demo], (orgId) => ({ "org-p": providers(terminalxCloud), "org-d": null } as Record<string, CloudProvider[] | null>)[orgId])).toBe(personal);
    expect(launchOrganization([personal], () => undefined)).toBe(personal);
    expect(launchOrganization([], () => undefined)).toBeNull();
  });

  it("says who bills in the provider's own line, then the console's sentence on the prices", () => {
    expect(pricingNote(boat as CloudProvider, "estimate")).toBe("Per second, billed by Boat. Prices shown are estimates.");
    expect(pricingNote(boat as CloudProvider, "provider-rate")).toBe("Per second, billed by Boat. Prices come from the provider's live rates.");
    expect(SPEND_NOTICE).toBe("Your cloud provider bills this machine directly, not TerminalX.");
  });
});

describe("the repository", () => {
  it("takes a GitHub repository however it is typed or pasted, as the clone URL the server accepts", () => {
    for (const typed of ["github.com/acme/app", "https://github.com/acme/app", " https://github.com/acme/app.git ", "http://www.github.com/acme/app/", "GitHub.com/acme/app"]) {
      expect(repositoryOf(typed)).toEqual({ cloneUrl: "https://github.com/acme/app", fullName: "acme/app" });
    }
  });

  it("takes nothing else", () => {
    for (const typed of ["", "acme/app", "https://gitlab.com/acme/app", "github.com/acme", "github.com/acme/app/tree/main", "github.com/../app", "github.com/acme/..", "git@github.com:acme/app.git", "github.com/acme/app?x=1"]) {
      expect(repositoryOf(typed)).toBeNull();
    }
  });

  it("builds the setup as the console does: the repository, the saved GitHub token with it, and the ticked agents", () => {
    const repository = repositoryOf("github.com/acme/app")!;
    expect(firstRunSetup({ repositories: [{ ...repository, ref: " main " }], agentIds: ["cred_codex"] }, credentials)).toEqual({ credentialIds: ["cred_github", "cred_codex"], repositories: [{ cloneUrl: "https://github.com/acme/app", ref: "main" }] });
    expect(firstRunSetup({ repositories: [{ ...repository, ref: "" }], agentIds: [] }, credentials)).toEqual({ credentialIds: ["cred_github"], repositories: [{ cloneUrl: "https://github.com/acme/app" }] });
    // Without a repository the GitHub token is not installed.
    expect(firstRunSetup({ repositories: [], agentIds: ["cred_codex", "cred_claude"] }, credentials)).toEqual({ credentialIds: ["cred_codex", "cred_claude"] });
    // Nothing chosen: a bare workspace, with no setup sent at all.
    expect(firstRunSetup({ repositories: [], agentIds: [] }, credentials)).toBeUndefined();
  });

  it("sends several repositories in the order they were chosen, each with its own branch (25.11)", () => {
    const repositories = [{ ...repositoryOf("github.com/acme/app")!, ref: "" }, { ...repositoryOf("github.com/acme/api")!, ref: "release/2.4" }];
    expect(firstRunSetup({ repositories, agentIds: [] }, [])).toEqual({ credentialIds: [], repositories: [{ cloneUrl: "https://github.com/acme/app" }, { cloneUrl: "https://github.com/acme/api", ref: "release/2.4" }] });
  });

  it("says on the form's row what is chosen: nothing, the one repository, or the first one's name and how many more", () => {
    expect(repositoriesRow([])).toEqual({ label: "Repository", value: "None" });
    expect(repositoriesRow([{ fullName: "acme/checkout" }])).toEqual({ label: "Repository", value: "acme/checkout" });
    expect(repositoriesRow([{ fullName: "acme/checkout" }, { fullName: "acme/api" }, { fullName: "other/sandbox" }])).toEqual({ label: "Repositories", value: "checkout and 2 more" });
  });

  it("writes a repository on the review with the branch it is cloned at: the typed one, else its default, else none", () => {
    expect(repositoryLine({ fullName: "acme/api", ref: " release/2.4 ", defaultBranch: "main" })).toBe("acme/api · release/2.4");
    expect(repositoryLine({ fullName: "acme/checkout", ref: "", defaultBranch: "main" })).toBe("acme/checkout · main");
    expect(repositoryLine({ fullName: "acme/sandbox", ref: "" })).toBe("acme/sandbox");
  });

  it("offers only agent logins that work, never the GitHub token and never an id that is not a stored login", () => {
    const revoked = { ...claudeKey, state: "revoked" } as CloudCredential;
    expect(agentLogins([codexLogin as CloudCredential, revoked, githubToken as CloudCredential]).map((login) => login.id)).toEqual(["cred_codex"]);
    expect(firstRunSetup({ repositories: [], agentIds: ["cred_claude", "made-up"] }, [codexLogin as CloudCredential, revoked])).toBeUndefined();
  });
});

describe("a refused launch", () => {
  it("says, in the desktop's sentence, that a repository is not in the organization's environment image", () => {
    expect(launchRefusal(new CloudApiError("cloud_environment_repository_not_in_image", 409))).toEqual({ text: "That repository is not in the organization's environment image. Add it and rebuild the environment first.", fix: null, closed: false });
  });
});

describe("preflight problems", () => {
  const check = (checks: unknown[], ready = false) => ({ version: 1, ready, checks }) as CloudPreflight;
  const repositories = [{ ...repositoryOf("github.com/acme/app")!, ref: "" }];

  it("says nothing when every check passed", () => {
    expect(preflightProblems(check([{ kind: "repository", cloneUrl: "https://github.com/acme/app", status: "verified" }], true), { repositories }, credentials)).toBeNull();
  });

  it("lists every failed check in the console's sentences, named by what it is about", () => {
    const problems = preflightProblems(check([
      { kind: "repository", cloneUrl: "https://github.com/acme/app", status: "failed", errorCode: "cloud_workspace_repository_credential_required" },
      { kind: "agent-credential", agent: "codex", status: "failed", errorCode: "cloud_agent_credential_reauth_required" },
    ]), { repositories }, credentials)!;
    expect(problems.items).toEqual(["acme/app: this repository needs a GitHub personal access token.", "Codex: sign-in required."]);
    expect(problemsTitle(problems.items.length)).toBe("Two things to fix before this can be priced");
    expect(problems).toMatchObject({ repository: "This repository needs a GitHub personal access token.", ref: null, needsGithubToken: true });
  });

  it("puts a branch that is not there on the branch field", () => {
    const problems = preflightProblems(check([{ kind: "repository", cloneUrl: "https://github.com/acme/app", status: "failed", errorCode: "cloud_workspace_repository_ref_not_found" }]), { repositories }, credentials)!;
    expect(problems).toMatchObject({ repository: null, ref: "That branch or tag was not found in the repository.", needsGithubToken: false });
    expect(problemsTitle(1)).toBe("One thing to fix before this can be priced");
  });

  it("names the login a failed credential check is about, and has a sentence for a code it does not know", () => {
    const problems = preflightProblems(check([
      { kind: "credential", provider: "claude", credentialId: "cred_claude", status: "failed", errorCode: "cloud_workspace_credential_invalid" },
      { kind: "agent-credential", status: "failed", errorCode: "cloud_workspace_agent_credential_required" },
      { kind: "repository", status: "failed", errorCode: "a_code_from_later", retryable: true },
    ]), { repositories }, credentials)!;
    expect(problems.items).toEqual([
      "The Claude Code credential failed verification. It may have expired.",
      "Connect at least one AI agent.",
      "acme/app: verification is temporarily unavailable. Try again in a moment.",
    ]);
  });

  it("says of each repository what failed for it, when several are chosen", () => {
    const several = [...repositories, { ...repositoryOf("github.com/acme/api")!, ref: "gone" }];
    const problems = preflightProblems(check([
      { kind: "repository", cloneUrl: "https://github.com/Acme/App.git", status: "failed", errorCode: "cloud_workspace_repository_not_accessible" },
      { kind: "repository", cloneUrl: "https://github.com/acme/api", status: "failed", errorCode: "cloud_workspace_repository_ref_not_found" },
      { kind: "repository", status: "failed", errorCode: "cloud_workspace_repository_verification_unavailable" },
    ]), { repositories: several }, credentials)!;
    expect(problems.byRepository).toEqual({
      "acme/app": { repository: "The repository is not accessible with the provided credentials.", ref: null },
      "acme/api": { repository: null, ref: "That branch or tag was not found in the repository." },
    });
    // A check that names no repository cannot be pinned on one of several.
    expect(problems.items.at(-1)).toBe("Repository: verification is temporarily unavailable. Try again in a moment.");
  });

  it("does not call a setup ready that the server did not, even with no check named", () => {
    expect(preflightProblems(check([]), { repositories }, credentials)?.items).toEqual(["Verification is temporarily unavailable. Try again in a moment."]);
  });
});

describe("refusals", () => {
  const refusal = (code: string, status: number) => launchRefusal(new CloudApiError(code, status), "Boat");

  it("asks for a new price when the estimate expired or what it priced changed", () => {
    expect(refusal("cloud_workspace_quote_expired", 409)).toEqual({ text: QUOTE_EXPIRED, fix: "new-price", closed: false });
    expect(refusal("cloud_environment_changed", 409).fix).toBe("new-price");
  });

  it("sends a missing or rejected key to compute", () => {
    expect(refusal("cloud_provider_connection_required", 409)).toEqual({ text: "Connect a compute provider first.", fix: "compute", closed: false });
    expect(refusal("cloud_provider_connection_attention_required", 409)).toEqual({ text: "Boat rejected the stored key on its last check. Replace the key to continue.", fix: "compute", closed: false });
  });

  it("closes the form while new workspaces are paused or the runtime is not ready", () => {
    expect(refusal("cloud_provisioning_paused", 409)).toMatchObject({ text: "New cloud workspaces are paused for this organization.", closed: true });
    expect(refusal("cloud_provider_creation_disabled", 409).closed).toBe(true);
    expect(refusal("cloud_workspace_runtime_not_ready", 503)).toMatchObject({ closed: true, text: expect.stringContaining("not available yet") });
  });

  it("says each limit in its own words", () => {
    expect(refusal("cloud_workspace_quota_exceeded", 409).text).toBe("This organization has reached its limit on cloud workspaces, stopped ones included. Delete one, then try again.");
    expect(refusal("cloud_workspace_policy_denied", 422).text).toBe("That size, region or idle setting is not allowed by this organization’s limits.");
    expect(refusal("terminalx_pro_required", 402).text).toBe("An active TerminalX Pro license is required to start machines TerminalX hosts.");
    expect(refusal("cloud_workspace_rate_limited", 429).text).toBe("Too many requests just now. Try again in a moment.");
    expect(refusal("cloud_provider_unavailable", 503).text).toBe("The cloud provider is not answering right now.");
  });

  it("never shows a code it has no sentence for, and says a lost connection as one", () => {
    expect(refusal("a_code_from_later", 409).text).toBe("That did not work. Try again in a moment.");
    expect(launchRefusal(new CloudApiError("cloud_workspace_unavailable", null, "network")).text).toBe("The service could not be reached. Nothing was launched.");
    expect(launchRefusal(new Error("boom")).text).toBe("That did not work. Try again in a moment.");
  });

  it("tells an answer that never came from a refusal", () => {
    expect(unanswered(new CloudApiError("cloud_workspace_unavailable", null, "timeout"))).toBe(true);
    expect(unanswered(new CloudApiError("cloud_workspace_unavailable", 502, "unreadable"))).toBe(true);
    expect(unanswered(new CloudApiError("cloud_provider_unavailable", 503))).toBe(false);
    expect(unanswered(new CloudApiError("cloud_workspace_quote_expired", 409))).toBe(false);
  });
});

describe("launching once", () => {
  const input = { name: "Checkout redesign", quoteId: "quote_5b1e", setup: { credentialIds: ["cred_codex"] } };
  const keys = () => { let made = 0; return () => `key-${++made}`; };
  const creates = (calls: Call[]) => calls.filter((call) => call.method === "POST" && call.path === "/cloud-workspaces");

  it("sends the person's yes, the quote and one idempotency key, and answers with the workspace and its operation", async () => {
    const { api, calls } = server(() => ({ status: 202, body: lifecycle() }));
    const answer = await new LaunchAttempt(api, keys(), noWait).launch("org-1", input);
    expect(answer.operation.id).toBe("op-9");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/cloud-workspaces", body: { name: "Checkout redesign", quoteId: "quote_5b1e", confirmProviderSpend: true, setup: { version: 1, credentialIds: ["cred_codex"] } } });
    expect(calls[0].headers["Idempotency-Key"]).toBe("key-1");
  });

  it("asks again with the same key after a timeout, so the launch the server already started is the one answered", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // The first request reaches the server, which starts the machine; its answer is lost.
    const started = new Map<string, unknown>();
    const { api, calls } = server((call) => {
      const key = call.headers["Idempotency-Key"]!;
      const first = !started.has(key);
      if (first) started.set(key, lifecycle());
      return first ? "timeout" : { status: 200, body: started.get(key) };
    }, { timeoutMs: 1_000 });
    const unansweredTold = vi.fn();
    const pending = new LaunchAttempt(api, keys(), noWait).launch("org-1", input, unansweredTold);
    await vi.advanceTimersByTimeAsync(1_000);
    const answer = await pending;
    expect(answer.workspace.id).toBe("ws-9");
    expect(unansweredTold).toHaveBeenCalledTimes(1);
    expect(creates(calls).map((call) => call.headers["Idempotency-Key"])).toEqual(["key-1", "key-1"]);
    // One key reached the server, so it started one workspace.
    expect(started.size).toBe(1);
  });

  it("keeps the key when every try goes unanswered, and uses it again when the person tries once more", async () => {
    let online = false;
    const { api, calls } = server((): Answer => (online ? { status: 200, body: lifecycle() } : "offline"));
    const waits: number[] = [];
    const attempt = new LaunchAttempt(api, keys(), async (ms) => { waits.push(ms); });
    await expect(attempt.launch("org-1", input)).rejects.toMatchObject({ reason: "network" });
    expect(waits).toEqual([...LAUNCH_RETRY_MS]);
    expect(calls).toHaveLength(LAUNCH_RETRY_MS.length + 1);
    online = true;
    await attempt.launch("org-1", input);
    expect(new Set(calls.map((call) => call.headers["Idempotency-Key"]))).toEqual(new Set(["key-1"]));
  });

  it("does not retry a refusal, and never launches on an expired quote", async () => {
    const { api, calls } = server(() => refuse("cloud_workspace_quote_expired", 409));
    const attempt = new LaunchAttempt(api, keys(), noWait);
    await expect(attempt.launch("org-1", input)).rejects.toMatchObject({ code: "cloud_workspace_quote_expired", refusal: "quote-expired" });
    expect(calls).toHaveLength(1);
  });

  it("gives a different launch its own key: a new quote, another name, or the next launch after one that worked", async () => {
    const { api, calls } = server(() => ({ status: 202, body: lifecycle() }));
    const attempt = new LaunchAttempt(api, keys(), noWait);
    await attempt.launch("org-1", input);
    await attempt.launch("org-1", input);
    await attempt.launch("org-1", { ...input, quoteId: "quote_next" });
    const { api: refusing, calls: refusals } = server(() => refuse("cloud_workspace_quota_exceeded", 409));
    const refused = new LaunchAttempt(refusing, keys(), noWait);
    await refused.launch("org-1", input).catch(() => undefined);
    await refused.launch("org-1", { ...input, name: "Another" }).catch(() => undefined);
    expect(calls.map((call) => call.headers["Idempotency-Key"])).toEqual(["key-1", "key-2", "key-3"]);
    expect(refusals.map((call) => call.headers["Idempotency-Key"])).toEqual(["key-1", "key-2"]);
  });
});

describe("progress", () => {
  it("places a launch at the operation's stage, with Cancel while the server allows it", () => {
    expect(launchProgress(life())).toEqual({ phase: "launching", stage: 0, status: "running", cancelable: true });
    expect(launchProgress(life({}, { state: "running", stage: "creating-machine" }))).toMatchObject({ phase: "launching", stage: 2, cancelable: true });
    expect(launchProgress(life({}, { state: "running", stage: "connecting-relay", cancelable: false }))).toMatchObject({ stage: 4, cancelable: false });
  });

  it("shows what the runtime reports under the stage it belongs to", () => {
    const events = [{ code: "runtime-installation-started", occurredAt: 3 }, { code: "repository-cloning", occurredAt: 5 }, { code: "credentials-ready", occurredAt: 4 }];
    expect(launchProgress(life({}, { state: "running", stage: "bootstrapping", cancelable: false, events })).detail).toBe("Cloning the repository");
    expect(launchProgress(life({}, { state: "running", stage: "creating-machine", events })).detail).toBeUndefined();
  });

  it("is running once the operation succeeded", () => {
    expect(launchProgress(life({ state: "ready" }, { state: "succeeded", stage: "ready", cancelable: false }))).toEqual({ phase: "running", stage: 5, status: "finished", cancelable: false });
  });

  it("keeps a cancel at the stage the launch had reached", () => {
    expect(launchProgress(life({}, { state: "cancel-requested", stage: "cleanup", cancelable: false }), 2)).toEqual({ phase: "canceling", stage: 2, status: "running", detail: "Cleaning up", cancelable: false });
    expect(launchProgress(life({ state: "destroyed" }, { state: "canceled", stage: "cleanup", cancelable: false }), 2)).toEqual({ phase: "canceled", stage: 2, status: "failed", detail: "Canceled", cancelable: false });
  });

  it("says why a launch failed where it failed", () => {
    expect(launchProgress(life({ state: "attention-required" }, { state: "failed", stage: "bootstrapping", cancelable: false, errorCode: "bootstrap_failed" }))).toMatchObject({ phase: "failed", stage: 3, status: "failed", detail: "Installing or starting the runtime on the machine failed." });
    expect(launchProgress(life({ state: "attention-required" }, { state: "failed", stage: "preflight", errorCode: "cloud_provider_credential_invalid" })).detail).toBe("The provider rejected the API key.");
    expect(launchProgress(life({ state: "attention-required" }, { state: "failed", stage: "creating-machine", errorCode: "something_new" })).detail).toBe("Something failed on the provider side.");
  });

  it("offers what the server would take next, and nothing to someone who does not manage the workspace", () => {
    const failed = (ws: Record<string, unknown>, op: Record<string, unknown>) => { const { workspace, operation } = life({ state: "attention-required", ...ws }, { state: "failed", ...op }); return launchRecovery(workspace, operation); };
    expect(failed({}, { errorCode: "bootstrap_failed" })).toBe("retry-setup");
    expect(failed({}, { errorCode: "cloud_provider_credential_invalid" })).toBe("fix-key");
    expect(failed({}, { errorCode: "cloud_workspace_provisioning_timeout" })).toBe("delete");
    expect(failed({}, { errorCode: "cloud_workspace_runtime_unsupported" })).toBe("delete");
    expect(failed({ provider: "machine0" }, { errorCode: "bootstrap_failed" })).toBe("delete");
    expect(failed({ you: { role: "driver", canApprove: false } }, { errorCode: "bootstrap_failed" })).toBe("ask-admin");
  });
});

describe("stop and delete", () => {
  it("lets only a manager manage", () => {
    expect(mayManage(life().workspace)).toBe(true);
    expect(mayManage(life({ you: { role: "driver", canApprove: true } }).workspace)).toBe(false);
    expect(mayManage(life({ you: null }).workspace)).toBe(false);
    expect(mayManage(null)).toBe(false);
  });

  it("reads stopping and a failed stop from the list", () => {
    expect(stopState({ state: "ready" }, { action: "suspend", state: "running" })).toBe("stopping");
    expect(stopState({ state: "suspending" }, null)).toBe("stopping");
    expect(stopState({ state: "attention-required" }, { action: "suspend", state: "failed" })).toBe("failed");
    expect(stopState({ state: "suspended" }, { action: "suspend", state: "succeeded" })).toBeNull();
    expect(stopState({ state: "attention-required" }, { action: "resume", state: "failed" })).toBeNull();
    expect(stopState({ state: "ready" }, { action: null, state: "succeeded" })).toBeNull();
  });

  it("asks before stopping with the provider's own billing line and nothing more about cost", () => {
    expect(stopQuestion(boat as CloudProvider, false)).toEqual({ title: "Stop this workspace?", message: "Its agents stop until it is started again. Boat: per second, billed by Boat." });
    expect(stopQuestion(agent37 as CloudProvider, true)).toEqual({ title: "Stop while an agent is working?", message: "An agent is in the middle of a turn. Stopping interrupts it; what it has not saved may be lost. Agent37: per minute from your Agent37 wallet; only disk bills while asleep." });
    expect(stopQuestion(null, false).message).toBe("Its agents stop until it is started again.");
  });

  it("states the console's four facts with the provider's name", () => {
    expect(deleteFacts("Boat")).toEqual([
      { label: "Compute", value: "The machine is removed." },
      { label: "Data", value: "Its disk, snapshots and saved conversations are removed once Boat confirms." },
      { label: "Charges", value: "Stop once Boat confirms the removal." },
      { label: "Undo", value: "Not possible." },
    ]);
  });

  it("says why a delete was refused, and that nothing was deleted when no answer came", () => {
    expect(deleteRefusal(new CloudApiError("cloud_workspace_active_work", 409))).toBe("An agent is working here, or is waiting for an answer. Stop it or answer it, then delete.");
    expect(deleteRefusal(new CloudApiError("cloud_workspace_operation_in_progress", 409))).toBe("Something else is still under way on this workspace. Try again when it has finished.");
    expect(deleteRefusal(new CloudApiError("cloud_workspace_unavailable", null, "network"))).toBe("No answer came back, so the delete may or may not have started. Check the workspace in the Cloud tab before trying again.");
    expect(deleteRefusal(new CloudApiError("cloud_workspace_unavailable", null, "timeout"))).not.toContain("Nothing was deleted");
    // The server itself said it could not be reached past the gateway: that is an answer, and nothing was deleted.
    expect(deleteRefusal(new CloudApiError("cloud_workspace_unavailable", 503))).toBe("The service could not be reached. Nothing was deleted. Try again in a moment.");
  });

  it("reports a delete's cleanup in plain words, leaving out a kind it does not know", () => {
    expect(cleanupFacts({ complete: false, items: [
      { kind: "runtime-credentials", state: "removed" }, { kind: "client-attachments", state: "removed" }, { kind: "provider-compute", state: "unconfirmed" },
      { kind: "provider-storage", state: "retained-by-provider" }, { kind: "workspace-content", state: "pending" }, { kind: "something-new", state: "removed" },
    ] })).toEqual([
      { label: "Runtime credentials", value: "Removed", tone: "success" },
      { label: "Phones and desktops", value: "Disconnected", tone: "success" },
      { label: "Machine", value: "Not confirmed", tone: "danger" },
      { label: "Disk and snapshots", value: "Kept by the provider", tone: "warning" },
      { label: "Saved conversations", value: "Pending", tone: "warning" },
    ]);
  });

  it("says a refused delete as the console does", () => {
    expect(deleteFailure({ errorCode: "cloud_provider_permission_denied", providerErrorCode: "403" }, "Boat")).toBe("Boat refused to delete this machine (403). Check it in your Boat dashboard; if it is still there, delete it there, then press Delete again to clear it here.");
    expect(deleteFailure({ errorCode: "cloud_provider_unavailable" }, "Boat")).toBe("The provider could not be reached. It may be down or blocking requests.");
  });
});
