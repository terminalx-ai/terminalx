import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  offerPreparation: vi.fn(),
  runPreparation: vi.fn(),
  stopPreparation: vi.fn(),
  proposeRecipe: vi.fn(),
  applyRecipe: vi.fn(),
  build: vi.fn(),
  cloudWorkspaceDelete: vi.fn(),
  catalog: { orgs: {} as Record<string, { workspaces: { workspace: Record<string, unknown> }[] }> },
}));

vi.mock("@/lib/api", () => ({ api: { cloudWorkspaceDelete: mocks.cloudWorkspaceDelete } }));
vi.mock("@/lib/cloudCatalog", () => ({ refreshCloudWorkspaces: vi.fn(() => Promise.resolve()), useCloudCatalog: () => mocks.catalog }));
vi.mock("@/lib/environmentPreparation", async (original) => ({
  ...(await original<typeof import("@/lib/environmentPreparation")>()),
  offerPreparation: mocks.offerPreparation,
  runPreparation: mocks.runPreparation,
  stopPreparation: mocks.stopPreparation,
}));
vi.mock("@/lib/organizationEnvironment", async (original) => ({
  ...(await original<typeof import("@/lib/organizationEnvironment")>()),
  organizationEnvironment: { proposeRecipe: mocks.proposeRecipe, applyRecipe: mocks.applyRecipe, build: mocks.build },
}));

const { PreparationError } = await import("@/lib/environmentPreparation");
const { resetEnvironmentRunForTest } = await import("@/lib/environmentRun");
const { ConfigureEnvironmentWithAgent, parseRepositories } = await import("./ConfigureEnvironmentWithAgent");
type Status = import("@/lib/organizationEnvironment").EnvironmentStatus;
type Observations = import("@/lib/organizationEnvironment").RecipeObservations;

const status = (overrides: Partial<Status> = {}): Status => ({
  provider: "local-docker",
  supported: true,
  canManage: true,
  retainedVersions: 2,
  template: { revision: 3, definition: { installScript: "", repositories: [{ owner: "acme", name: "widgets", defaultBranch: "main", setup: [] }] }, updatedAt: 1 },
  activeVersion: null,
  rebuildRequired: true,
  pendingChanges: [],
  versions: [],
  contextRevision: "rev-1",
  ...overrides,
});
const offer = { provider: "local-docker", quote: { id: "quote-1", activeHourlyMicros: 20_000, currency: "USD", pricing: "provider-rate" }, idleSuspendMinutes: 5, running: 1, runningLimit: 3, agents: ["claude", "codex"], contextRevision: "rev-1" };
const observations = (observedBy: Observations["observedBy"]): Observations => ({
  observedBy,
  machine: { status: "passed", exitCode: 0, durationMs: 1000 },
  repositories: [
    {
      owner: "acme",
      name: "widgets",
      commit: "a".repeat(40),
      checks: [
        { kind: "install", command: "pnpm install", status: "passed", exitCode: 0, durationMs: 9000, preexisting: false },
        { kind: "lint", command: "pnpm lint", status: "passed", exitCode: 0, durationMs: null, preexisting: false },
        { kind: "test", command: "pnpm test", status: "failed", exitCode: 1, durationMs: null, preexisting: true },
        { kind: "build", command: "pnpm build", status: "passed", exitCode: 0, durationMs: null, preexisting: false },
        { kind: "start", command: "", status: "skipped", exitCode: null, durationMs: null, preexisting: false },
      ],
    },
  ],
});
const result = (observedBy: Observations["observedBy"] = "verification") => ({
  workspaceId: "workspace_1",
  proposal: { definition: { installScript: "apt-get install -y jq", repositories: [{ owner: "acme", name: "widgets", defaultBranch: "main", setup: [{ workingDirectory: ".", script: "pnpm install" }] }] }, repositories: [] },
  observations: observations(observedBy),
  sources: [{ owner: "acme", name: "widgets", branch: "main", commit: "a".repeat(40), agentCheckout: "same" as "same" | "differs" | "unknown" }],
  machine: "stopping" as "stopping" | "busy" | "failed" | "deleted",
});

const onSaved = vi.fn();
const mount = (props: Partial<{ status: Status }> = {}) => render(<ConfigureEnvironmentWithAgent status={props.status ?? status()} organizationId="org-1" onSaved={onSaved} />);
const open = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Configure with an agent…" }));
  return screen.findByLabelText("Before the machine starts");
};

beforeEach(() => {
  resetEnvironmentRunForTest();
  mocks.catalog.orgs = {};
  mocks.offerPreparation.mockResolvedValue(offer);
  mocks.runPreparation.mockResolvedValue(result());
  mocks.proposeRecipe.mockResolvedValue({});
  mocks.stopPreparation.mockResolvedValue("stopping");
  mocks.cloudWorkspaceDelete.mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("asks before any machine starts: what it costs, the running limit, and when it is stopped", async () => {
  mount();
  expect(mocks.offerPreparation).not.toHaveBeenCalled();
  const before = await open();
  expect(before.textContent).toMatch(/starts a cloud machine on the organization's Local Docker account/);
  expect(before.textContent).toMatch(/bills that account for it: about \$0\.02 an hour/);
  expect(before.textContent).toMatch(/counts toward the running limit: 1 of 3 are running now/);
  expect(before.textContent).toMatch(/after 60 minutes, whichever comes first\. The server enforces the 60 minutes even if this app is closed/);
  expect(before.textContent).toMatch(/none of the organization's configured secrets/);
  expect(before.textContent).toMatch(/login for the agent you choose, and read access to the repositories you name, are placed on the machine/);
  expect(before.textContent).toMatch(/permissions bypassed.*Name only repositories you trust/);
  expect((within(before).getByLabelText("Repositories to prepare") as HTMLTextAreaElement).value).toBe("acme/widgets@main");
  fireEvent.click(within(before).getByRole("button", { name: "Show what the agent is asked" }));
  const asked = within(before).getByLabelText("What the agent is asked");
  expect(asked.textContent).toMatch(/Never edit code, tests or configuration to make a check pass/);
  // Shown whole, with the token this run will check for.
  expect(asked.className).not.toMatch(/max-h|overflow-auto/);
  expect(asked.textContent).toMatch(/"token": "[0-9a-f-]{36}"/);
  expect(mocks.runPreparation).not.toHaveBeenCalled();
  fireEvent.click(within(before).getByRole("button", { name: "Cancel" }));
  expect(mocks.runPreparation).not.toHaveBeenCalled();
});

it("refuses at the running limit with the reason, and starts nothing", async () => {
  mocks.offerPreparation.mockRejectedValue(new PreparationError("running-limit", "The organization is at its running limit (3 of 3 running). Stop a workspace first."));
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Configure with an agent…" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/at its running limit \(3 of 3 running\)/);
  expect(screen.queryByLabelText("Before the machine starts")).toBeNull();
  expect(mocks.runPreparation).not.toHaveBeenCalled();
});

it("starts only on the confirming press, for the chosen repositories and agent", async () => {
  let finish: (value: unknown) => void = () => undefined;
  mocks.runPreparation.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  mount();
  const before = await open();
  fireEvent.change(within(before).getByLabelText("Repositories to prepare"), { target: { value: "acme/widgets\nacme/api@release" } });
  fireEvent.change(within(before).getByLabelText("Agent"), { target: { value: "codex" } });
  fireEvent.click(within(before).getByRole("button", { name: "Start the machine" }));
  expect(mocks.runPreparation).toHaveBeenCalledTimes(1);
  expect(mocks.runPreparation.mock.calls[0][0]).toMatchObject({
    agent: "codex",
    idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    token: expect.stringMatching(/^[0-9a-f-]{36}$/),
    repositories: [
      { owner: "acme", name: "widgets", defaultBranch: "main" },
      { owner: "acme", name: "api", defaultBranch: "release" },
    ],
  });
  expect((await screen.findByRole("status")).textContent).toMatch(/Starting the preparation machine/);
  expect(screen.getByRole("button", { name: "Cancel and stop the machine" })).toBeTruthy();
  await act(async () => finish(result()));
});

it("will not start with repositories it cannot read, none, or too many", async () => {
  mount();
  const before = await open();
  const start = within(before).getByRole("button", { name: "Start the machine" }) as HTMLButtonElement;
  const area = within(before).getByLabelText("Repositories to prepare");
  for (const [value, message] of [
    ["not a repository", /one repository per line/],
    ["", /at least one repository/],
    [["a/1", "a/2", "a/3", "a/4", "a/5", "a/6"].join("\n"), /at most 5 repositories/],
    ["acme/widgets\nACME/widgets", /one repository per line/],
  ] as const) {
    fireEvent.change(area, { target: { value } });
    expect(start.disabled).toBe(true);
    expect(before.textContent).toMatch(message);
  }
  expect(parseRepositories("acme/widgets@feature/x")).toEqual([{ owner: "acme", name: "widgets", defaultBranch: "feature/x" }]);
});

it("shows the proposal for review with a failing check as failing, and saving stores a recipe without applying or building", async () => {
  mount();
  fireEvent.click(within(await open()).getByRole("button", { name: "Start the machine" }));
  const review = await screen.findByLabelText("Proposed recipe");
  expect(review.textContent).toMatch(/against the current template \(revision 3\)\. The preparation machine is being stopped\. 1 check failed\./);
  const who = within(review).getByLabelText("Who observed the results").textContent ?? "";
  expect(who).toMatch(/Re-run by TerminalX on the preparation machine/);
  expect(who).toMatch(/not an independent result\. That comes only from building a version/);
  expect(who).not.toMatch(/Observed by TerminalX/);
  expect(review.textContent).toMatch(/Checked at commit aaaaaaaaaaaa, fetched from GitHub/);
  expect(within(review).queryByRole("note")).toBeNull();
  expect(within(review).getByLabelText("Proposed machine setup").textContent).toMatch(/apt-get install -y jq/);
  expect(within(review).getByLabelText("Proposed setup for acme/widgets").textContent).toMatch(/pnpm install/);
  const rows = within(within(review).getByLabelText("Results for acme/widgets")).getAllByRole("row").slice(1);
  expect(rows).toHaveLength(5);
  expect(rows[2].textContent).toMatch(/Failed \(also fails without this recipe's setup\) \(exit 1\)/);
  expect(review.textContent).not.toMatch(/already failing before/);
  expect(review.textContent).toMatch(/does not change the template and builds nothing/);

  fireEvent.click(within(review).getByRole("button", { name: "Save as a recipe" }));
  await waitFor(() => expect(mocks.proposeRecipe).toHaveBeenCalledTimes(1));
  const [provider, recipe, contextRevision] = mocks.proposeRecipe.mock.calls[0];
  expect([provider, contextRevision]).toEqual(["local-docker", "rev-1"]);
  expect(recipe).toMatchObject({ baseRevision: 3, sourceWorkspaceId: "workspace_1", definition: { installScript: "apt-get install -y jq" }, observations: { v: 1, observedBy: "verification" } });
  expect(recipe.observations.repositories[0].checks[2]).toEqual({ kind: "test", command: "pnpm test", status: "failed", exitCode: 1, preexisting: true });
  expect((await screen.findByRole("status")).textContent).toMatch(/Apply it to change the template, then build a version; each is its own step/);
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(mocks.applyRecipe).not.toHaveBeenCalled();
  expect(mocks.build).not.toHaveBeenCalled();
});

it("labels results that are only the agent's report, on the review and in what is saved", async () => {
  mocks.runPreparation.mockResolvedValue(result("agent"));
  mount();
  fireEvent.click(within(await open()).getByRole("button", { name: "Start the machine" }));
  const review = await screen.findByLabelText("Proposed recipe");
  expect(within(review).getByLabelText("Who observed the results").textContent).toMatch(/Reported by the agent\. TerminalX did not run these commands itself/);
  fireEvent.click(within(review).getByRole("button", { name: "Save as a recipe" }));
  await waitFor(() => expect(mocks.proposeRecipe).toHaveBeenCalled());
  expect(mocks.proposeRecipe.mock.calls[0][1].observations.observedBy).toBe("agent");
});

it("keeps a run going when the screen is closed, and shows its result when it is opened again", async () => {
  let finish: (value: unknown) => void = () => undefined;
  mocks.runPreparation.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  const first = mount();
  fireEvent.click(within(await open()).getByRole("button", { name: "Start the machine" }));
  await screen.findByRole("status");
  first.unmount();
  expect(mocks.runPreparation.mock.calls[0][1].signal.aborted).toBe(false);
  await act(async () => finish(result()));
  mount();
  expect(await screen.findByLabelText("Proposed recipe")).toBeTruthy();
});

it("says when the agent's own copy was not what GitHub has, and when the machine could not be stopped", async () => {
  mocks.runPreparation.mockResolvedValue({ ...result(), sources: [{ owner: "acme", name: "widgets", branch: "main", commit: "b".repeat(40), agentCheckout: "differs" }], machine: "failed" });
  mount();
  fireEvent.click(within(await open()).getByRole("button", { name: "Start the machine" }));
  const review = await screen.findByLabelText("Proposed recipe");
  expect(within(review).getByRole("note").textContent).toMatch(/agent's own copy of acme\/widgets had commits or changed files that are not on GitHub\. They were not checked: the results below are for main as GitHub has it \(bbbbbbbbbbbb\)/);
  expect(review.textContent).toMatch(/TerminalX could not stop the preparation machine\. Stop it from the list below/);
  expect(review.textContent).not.toMatch(/is being stopped/);
});

it("does not say nothing failed of checks that never ran", async () => {
  const none = observations("verification");
  none.machine = null;
  none.repositories[0].checks = none.repositories[0].checks.map((check) => ({ ...check, status: "not-run", exitCode: null, preexisting: false }));
  mocks.runPreparation.mockResolvedValue({ ...result(), observations: none });
  mount();
  fireEvent.click(within(await open()).getByRole("button", { name: "Start the machine" }));
  const review = await screen.findByLabelText("Proposed recipe");
  expect(review.textContent).toMatch(/No check failed, but 5 did not run\./);
});

it("after a start that got no answer, says a machine may exist and retries with the same key, not a new one", async () => {
  mocks.runPreparation.mockRejectedValueOnce(new PreparationError("create-outcome-unknown", "TerminalX did not get an answer, so a preparation machine may have been started."));
  mount();
  fireEvent.click(within(await open()).getByRole("button", { name: "Start the machine" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/may have been started/);
  expect(screen.getByRole("alert").textContent).not.toMatch(/Nothing was started/);
  mocks.runPreparation.mockResolvedValueOnce(result());
  fireEvent.click(screen.getByRole("button", { name: "Try again (the same machine, not a second one)" }));
  await screen.findByLabelText("Proposed recipe");
  expect(mocks.runPreparation).toHaveBeenCalledTimes(2);
  expect(mocks.runPreparation.mock.calls[1][0].idempotencyKey).toBe(mocks.runPreparation.mock.calls[0][0].idempotencyKey);
  expect(mocks.runPreparation.mock.calls[1][0].token).toBe(mocks.runPreparation.mock.calls[0][0].token);
  // A refusal offers no such retry: nothing was made.
  cleanup();
  resetEnvironmentRunForTest();
  mocks.runPreparation.mockRejectedValueOnce(new PreparationError("create-refused", "The organization is at its running limit. Stop a workspace first."));
  mount();
  fireEvent.click(within(await open()).getByRole("button", { name: "Start the machine" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
});

it("does not throw away another provider's unsaved proposal", async () => {
  const first = mount();
  fireEvent.click(within(await open()).getByRole("button", { name: "Start the machine" }));
  await screen.findByLabelText("Proposed recipe");
  first.unmount();
  mount({ status: status({ provider: "hetzner" }) });
  const button = screen.getByRole("button", { name: "Configure with an agent…" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(screen.getByLabelText("Configure with an agent").textContent).toMatch(/A proposal for another provider is waiting to be saved or discarded there/);
  fireEvent.click(button);
  expect(mocks.offerPreparation).toHaveBeenCalledTimes(1);
  cleanup();
  mount();
  expect(await screen.findByLabelText("Proposed recipe")).toBeTruthy();
});

it("cancels on request, and cancels a run that belongs to another account context", async () => {
  mocks.runPreparation.mockImplementation(
    (_request: unknown, handle: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => handle.signal.addEventListener("abort", () => reject(new PreparationError("canceled", "Canceled. The preparation machine is being stopped.", "stopping")))),
  );
  const first = mount();
  fireEvent.click(within(await open()).getByRole("button", { name: "Start the machine" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel and stop the machine" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/Canceled\. The preparation machine is being stopped/);
  expect(screen.queryByLabelText("Proposed recipe")).toBeNull();

  fireEvent.click(within(await open()).getByRole("button", { name: "Start the machine" }));
  await screen.findByRole("button", { name: "Cancel and stop the machine" });
  first.unmount();
  mount({ status: status({ contextRevision: "rev-2" }) });
  await waitFor(() => expect(mocks.runPreparation.mock.calls[1][1].signal.aborted).toBe(true));
  expect(mocks.proposeRecipe).not.toHaveBeenCalled();
});

it("lists preparation machines as such, with stop, and delete only after a confirmation", async () => {
  mocks.catalog.orgs = {
    "org-1": {
      workspaces: [
        { workspace: { id: "w-run", orgId: "org-1", name: "Environment preparation 2026-10-12 14:00", provider: "local-docker", state: "ready", preparation: { stopAfter: Date.now() + 600_000 } } },
        { workspace: { id: "w-old", orgId: "org-1", name: "Environment preparation 2026-10-11 09:00", provider: "local-docker", state: "suspended", preparation: { stopAfter: Date.now() - 600_000 } } },
        { workspace: { id: "w-plain", orgId: "org-1", name: "Ordinary", provider: "local-docker", state: "ready" } },
        { workspace: { id: "w-other", orgId: "org-1", name: "Other provider", provider: "hetzner", state: "ready", preparation: { stopAfter: Date.now() + 600_000 } } },
      ],
    },
  };
  mount();
  const items = within(screen.getByLabelText("Preparation machines")).getAllByRole("listitem");
  expect(items).toHaveLength(2);
  expect(items[0].textContent).toMatch(/Preparation machine · Environment preparation 2026-10-12 14:00 · running, stopped by/);
  expect(items[1].textContent).toMatch(/stopped/);
  expect(items[1].textContent).toMatch(/cannot be started again after its time limit/);
  expect(within(items[1]).queryByRole("button", { name: "Stop" })).toBeNull();
  fireEvent.click(within(items[0]).getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(mocks.stopPreparation).toHaveBeenCalledWith(expect.objectContaining({ id: "w-run" })));
  expect(mocks.cloudWorkspaceDelete).not.toHaveBeenCalled();
  // A stop the server would not take is said as that, and never becomes a delete.
  mocks.stopPreparation.mockResolvedValueOnce("busy");
  fireEvent.click(within(items[0]).getByRole("button", { name: "Stop" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/already changing state, so it was not asked to stop again/);
  expect(mocks.cloudWorkspaceDelete).not.toHaveBeenCalled();
  fireEvent.click(within(items[1]).getByRole("button", { name: "Delete…" }));
  expect(mocks.cloudWorkspaceDelete).not.toHaveBeenCalled();
  fireEvent.click(within(items[1]).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(mocks.cloudWorkspaceDelete).toHaveBeenCalledWith("w-old", true, "org-1"));
});
