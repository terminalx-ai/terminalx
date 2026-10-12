import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { organizationEnvironment, type EnvironmentRecipe, type EnvironmentStatus, type EnvironmentVersion } from "@/lib/organizationEnvironment";
import { OrganizationEnvironment } from "./OrganizationEnvironment";

vi.mock("@/lib/api", () => ({ api: { cloudProviders: vi.fn() } }));
vi.mock("@/lib/organizationEnvironment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/organizationEnvironment")>()),
  organizationEnvironment: {
    status: vi.fn(),
    update: vi.fn(),
    build: vi.fn(),
    version: vi.fn(),
    retry: vi.fn(),
    cancel: vi.fn(),
    rollback: vi.fn(),
    recipes: vi.fn(),
    applyRecipe: vi.fn(),
    dismissRecipe: vi.fn(),
  },
}));

const environment = vi.mocked(organizationEnvironment);
const providers = vi.mocked(api.cloudProviders);

const version = (overrides: Partial<EnvironmentVersion> = {}): EnvironmentVersion => ({
  id: "version-2",
  number: 2,
  state: "succeeded",
  stage: "complete",
  publication: "published",
  configurationRevision: 3,
  errorCode: null,
  failurePhase: null,
  retryOf: null,
  repositories: [{ owner: "acme", name: "widgets", defaultBranch: "main", commit: "0123456789abcdef0123456789abcdef01234567" }],
  createdAt: Date.UTC(2026, 9, 1),
  startedAt: null,
  finishedAt: Date.UTC(2026, 9, 1),
  publishedAt: Date.UTC(2026, 9, 1),
  rollbackAvailable: false,
  logs: null,
  ...overrides,
});

const status = (overrides: Partial<EnvironmentStatus> = {}): EnvironmentStatus => ({
  provider: "local-docker",
  supported: true,
  canManage: true,
  retainedVersions: 2,
  template: {
    revision: 3,
    definition: {
      installScript: "apt-get install -y jq",
      repositories: [{ owner: "acme", name: "widgets", defaultBranch: "main", setup: [{ workingDirectory: ".", script: "pnpm install" }] }],
    },
    updatedAt: Date.UTC(2026, 9, 1),
  },
  activeVersion: version(),
  rebuildRequired: false,
  pendingChanges: [],
  versions: [version(), version({ id: "version-1", number: 1, publication: "retained", rollbackAvailable: true, configurationRevision: 2 })],
  contextRevision: "rev-1",
  ...overrides,
});

const recipe = (overrides: Partial<EnvironmentRecipe> = {}): EnvironmentRecipe => ({
  id: "recipe-1",
  provider: "local-docker",
  state: "proposed",
  baseRevision: 3,
  definition: {
    installScript: "apt-get install -y jq ripgrep",
    repositories: [{ owner: "acme", name: "widgets", defaultBranch: "main", setup: [{ workingDirectory: ".", script: "pnpm install --frozen-lockfile" }] }],
  },
  observations: {
    observedBy: "verification",
    machine: { status: "passed", exitCode: 0, durationMs: 41_000 },
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
  },
  createdAt: Date.UTC(2026, 9, 2),
  decidedAt: null,
  appliedRevision: null,
  ...overrides,
});

const provider = (id: string, connected = true) => ({ id, displayName: id, availability: "available", canManage: true, connection: connected ? { state: "connected" } : null, capabilities: {} });

const mount = () => render(<OrganizationEnvironment contextRevision="rev-1" />);
const settled = () => screen.findByLabelText("Environment template");

beforeEach(() => {
  providers.mockResolvedValue({ providers: [provider("local-docker")] } as never);
  environment.status.mockResolvedValue(status());
  environment.recipes.mockResolvedValue({ recipes: [recipe()], contextRevision: "rev-1" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("shows the machine install script and each repository's setup as separate fields", async () => {
  mount();
  const form = await settled();
  expect((within(form).getByLabelText("Machine install script") as HTMLInputElement).value).toBe("apt-get install -y jq");
  const repository = within(form).getByLabelText("Setup for acme/widgets");
  expect((within(repository).getByLabelText("Script of step 1 for acme/widgets") as HTMLInputElement).value).toBe("pnpm install");
  expect(within(repository).queryByLabelText("Machine install script")).toBeNull();
  expect(screen.getByText(/Revision 3, saved/)).toBeTruthy();
  expect(environment.status).toHaveBeenCalledWith("local-docker");
});

it("shows a member the active version and nothing to edit, and asks for no recipes", async () => {
  environment.status.mockResolvedValue(status({ canManage: false }));
  mount();
  const active = await screen.findByLabelText("Active environment version");
  expect(active.textContent).toMatch(/start from version 2/);
  expect(active.textContent).toMatch(/acme\/widgets on main at 0123456/);
  expect(screen.queryByLabelText("Environment template")).toBeNull();
  expect(screen.queryByLabelText("Environment versions")).toBeNull();
  expect(screen.queryByLabelText("Environment recipes")).toBeNull();
  expect(environment.recipes).not.toHaveBeenCalled();
});

it("says so when the provider cannot build environment images", async () => {
  environment.status.mockResolvedValue(status({ supported: false, template: null, activeVersion: null, versions: [] }));
  mount();
  expect((await screen.findByRole("status")).textContent).toMatch(/cannot build environment images yet/);
  expect(screen.queryByLabelText("Environment template")).toBeNull();
  expect(environment.recipes).not.toHaveBeenCalled();
});

it("saves an edit against the revision the draft started from, and builds nothing", async () => {
  environment.update.mockResolvedValue(status());
  mount();
  const form = await settled();
  const save = within(form).getByRole("button", { name: "Save template" });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(within(form).getByLabelText("Machine install script"), { target: { value: "apt-get install -y ripgrep" } });
  fireEvent.click(save);
  await waitFor(() => expect(environment.update).toHaveBeenCalledTimes(1));
  expect(environment.update).toHaveBeenCalledWith(
    "local-docker",
    3,
    { installScript: "apt-get install -y ripgrep", repositories: [{ owner: "acme", name: "widgets", defaultBranch: "main", setup: [{ workingDirectory: ".", script: "pnpm install" }] }] },
    "rev-1",
  );
  expect(environment.build).not.toHaveBeenCalled();
});

it("does not save over a revision someone else made while the draft was open", async () => {
  mount();
  const form = await settled();
  fireEvent.change(within(form).getByLabelText("Machine install script"), { target: { value: "mine" } });
  environment.status.mockResolvedValue(status({ template: { revision: 4, definition: { installScript: "theirs", repositories: [] }, updatedAt: 1 } }));
  fireEvent.click(screen.getByLabelText("Refresh cloud environment"));
  expect(await screen.findByText(/changed since you started editing \(it is now revision 4\)/)).toBeTruthy();
  expect((within(form).getByLabelText("Machine install script") as HTMLInputElement).value).toBe("mine");
  expect((within(form).getByRole("button", { name: "Save template" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(form).getByRole("button", { name: "Discard changes" }));
  expect((within(form).getByLabelText("Machine install script") as HTMLInputElement).value).toBe("theirs");
});

it("asks before a build starts a machine, and sends nothing until confirmed", async () => {
  environment.status.mockResolvedValue(status({ rebuildRequired: true, pendingChanges: ["install-script", "setup-steps"] }));
  environment.build.mockResolvedValue(version({ id: "version-3", number: 3, state: "queued", stage: "queued", publication: null }));
  mount();
  await settled();
  const section = screen.getByLabelText("Build a version");
  expect(section.textContent).toMatch(/Not built yet: the machine install script, repository setup steps\./);
  fireEvent.click(within(section).getByRole("button", { name: "Build version…" }));
  expect(section.textContent).toMatch(/starts a temporary builder machine on Local Docker/);
  expect(section.textContent).toMatch(/bills the organization's account/);
  expect(environment.build).not.toHaveBeenCalled();
  fireEvent.click(within(section).getByRole("button", { name: "Cancel" }));
  expect(environment.build).not.toHaveBeenCalled();
  fireEvent.click(within(section).getByRole("button", { name: "Build version…" }));
  fireEvent.click(within(section).getByRole("button", { name: "Start build" }));
  await waitFor(() => expect(environment.build).toHaveBeenCalledTimes(1));
  expect(environment.build).toHaveBeenCalledWith("local-docker", expect.stringMatching(/^[0-9a-f-]{36}$/), true, "rev-1");
});

it("replays the same build after a lost response and starts a new one after a refusal", async () => {
  environment.status.mockResolvedValue(status({ rebuildRequired: true }));
  mount();
  await settled();
  const press = async () => {
    const section = screen.getByLabelText("Build a version");
    fireEvent.click(await within(section).findByRole("button", { name: "Build version…" }));
    fireEvent.click(within(section).getByRole("button", { name: "Start build" }));
  };
  environment.build.mockRejectedValueOnce({ code: "cloud_environment_outcome_unknown", status: null });
  await press();
  expect((await screen.findByRole("alert")).textContent).toMatch(/may or may not have been applied/);
  environment.build.mockRejectedValueOnce({ code: "cloud_provisioning_paused", status: 409 });
  await press();
  await waitFor(() => expect(environment.build).toHaveBeenCalledTimes(2));
  expect(environment.build.mock.calls[1][1]).toBe(environment.build.mock.calls[0][1]);
  await waitFor(() => expect((screen.getByRole("alert")).textContent).toMatch(/paused for this organization/));
  environment.build.mockResolvedValueOnce(version());
  await press();
  await waitFor(() => expect(environment.build).toHaveBeenCalledTimes(3));
  expect(environment.build.mock.calls[2][1]).not.toBe(environment.build.mock.calls[0][1]);
});

it("will not build a template with unsaved changes", async () => {
  mount();
  const form = await settled();
  fireEvent.change(within(form).getByLabelText("Machine install script"), { target: { value: "changed" } });
  const section = screen.getByLabelText("Build a version");
  expect((within(section).getByRole("button", { name: "Build version…" }) as HTMLButtonElement).disabled).toBe(true);
  expect(section.textContent).toMatch(/Save or discard your changes first/);
});

it("lists versions with their state and rolls back only after a confirmation", async () => {
  environment.rollback.mockResolvedValue("rev-1");
  mount();
  await settled();
  const versions = screen.getByLabelText("Environment versions");
  expect(within(versions).getByLabelText("Version 2").textContent).toMatch(/Built · Active/);
  const previous = within(versions).getByLabelText("Version 1");
  expect(previous.textContent).toMatch(/Kept for rollback/);
  expect(within(within(versions).getByLabelText("Version 2")).queryByRole("button", { name: "Roll back to this…" })).toBeNull();
  fireEvent.click(within(previous).getByRole("button", { name: "Roll back to this…" }));
  expect(previous.textContent).toMatch(/Running workspaces and the template are not changed/);
  expect(environment.rollback).not.toHaveBeenCalled();
  fireEvent.click(within(previous).getByRole("button", { name: "Roll back" }));
  await waitFor(() => expect(environment.rollback).toHaveBeenCalledWith("version-1", "rev-1"));
});

it("shows a failed build as failed, with where it failed, and asks before building again", async () => {
  const failed = version({ id: "version-3", number: 3, state: "failed", stage: "install", failurePhase: "install", errorCode: "cloud_environment_install_failed", publication: null });
  environment.status.mockResolvedValue(status({ versions: [failed, version()] }));
  environment.retry.mockResolvedValue(version());
  environment.version.mockResolvedValue({ ...failed, logs: [{ phase: "install", content: "E: Unable to locate package", occurredAt: 1 }] });
  mount();
  await settled();
  const row = screen.getByLabelText("Version 3");
  expect(row.textContent).toMatch(/Failed while running the machine install script/);
  expect(row.textContent).toMatch(/cloud_environment_install_failed/);
  fireEvent.click(within(row).getByRole("button", { name: "Show log" }));
  expect((await within(row).findByLabelText("Build log of version 3")).textContent).toMatch(/\[install\] E: Unable to locate package/);
  fireEvent.click(within(row).getByRole("button", { name: "Build again…" }));
  expect(environment.retry).not.toHaveBeenCalled();
  fireEvent.click(within(row).getByRole("button", { name: "Start build" }));
  await waitFor(() => expect(environment.retry).toHaveBeenCalledWith("version-3", true, "rev-1"));
});

it("lists a recipe as a proposal with its five results shown separately and a failure shown as a failure", async () => {
  mount();
  await settled();
  const recipes = screen.getByLabelText("Environment recipes");
  expect(recipes.textContent).toMatch(/1 check failed\./);
  expect(recipes.textContent).toMatch(/it changes nothing until an admin applies it/);
  expect(within(recipes).getByLabelText("Who observed the results").textContent).toMatch(/Observed by TerminalX/);
  const machine = within(recipes).getByLabelText("Proposed machine setup");
  expect(machine.textContent).toMatch(/apt-get install -y jq ripgrep/);
  expect(machine.textContent).toMatch(/Changes the current script/);
  expect(machine.textContent).not.toMatch(/pnpm/);
  const repository = within(recipes).getByLabelText("Proposed setup for acme/widgets");
  expect(repository.textContent).toMatch(/pnpm install --frozen-lockfile/);
  expect(repository.textContent).not.toMatch(/apt-get/);
  const rows = within(within(recipes).getByLabelText("Results for acme/widgets")).getAllByRole("row").slice(1);
  expect(rows.map((row) => within(row).getAllByRole("cell")[0].textContent)).toEqual(["Install", "Lint", "Test", "Build", "Start"]);
  expect(rows[2].textContent).toMatch(/pnpm test/);
  expect(rows[2].textContent).toMatch(/Failed \(already failing before this recipe\) \(exit 1\)/);
  expect(rows[2].textContent).not.toMatch(/Passed/);
  expect(rows[4].textContent).toMatch(/Skipped/);
});

it("labels results that are only the agent's own report as such", async () => {
  environment.recipes.mockResolvedValue({ recipes: [recipe({ observations: { ...recipe().observations, observedBy: "agent" } })], contextRevision: "rev-1" });
  mount();
  await settled();
  const who = screen.getByLabelText("Who observed the results");
  expect(who.textContent).toMatch(/Reported by the agent\. TerminalX did not run these commands itself\./);
  expect(who.textContent).not.toMatch(/Observed by TerminalX/);
});

it("applies a recipe only after a confirmation that says what it replaces", async () => {
  environment.applyRecipe.mockResolvedValue("rev-1");
  mount();
  await settled();
  const recipes = screen.getByLabelText("Environment recipes");
  fireEvent.click(within(recipes).getByRole("button", { name: "Apply…" }));
  expect(recipes.textContent).toMatch(/Replace the template's machine script and repository setup with this recipe\? 1 check failed\. Nothing is built/);
  expect(environment.applyRecipe).not.toHaveBeenCalled();
  fireEvent.click(within(recipes).getByRole("button", { name: "Apply to template" }));
  await waitFor(() => expect(environment.applyRecipe).toHaveBeenCalledWith("recipe-1", true, "rev-1"));
  expect(environment.build).not.toHaveBeenCalled();
  expect(environment.update).not.toHaveBeenCalled();
});

it("does not offer to apply a recipe made against an older template, or over unsaved edits", async () => {
  environment.recipes.mockResolvedValue({ recipes: [recipe({ baseRevision: 2 })], contextRevision: "rev-1" });
  const { unmount } = mount();
  await settled();
  expect((screen.getByRole("button", { name: "Apply…" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByLabelText("Environment recipes").textContent).toMatch(/made against revision 2; the template is at 3/);
  unmount();

  environment.recipes.mockResolvedValue({ recipes: [recipe()], contextRevision: "rev-1" });
  mount();
  const form = await settled();
  expect((screen.getByRole("button", { name: "Apply…" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(within(form).getByLabelText("Machine install script"), { target: { value: "edited" } });
  expect((screen.getByRole("button", { name: "Apply…" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByLabelText("Environment recipes").textContent).toMatch(/Save or discard your template changes first/);
});

it("dismisses a recipe and shows decided ones without actions", async () => {
  environment.recipes.mockResolvedValue({ recipes: [recipe(), recipe({ id: "recipe-0", state: "applied", appliedRevision: 3, createdAt: Date.UTC(2026, 8, 1) })], contextRevision: "rev-1" });
  environment.dismissRecipe.mockResolvedValue(recipe({ state: "dismissed" }));
  mount();
  await settled();
  expect(screen.getByLabelText("Environment recipes").textContent).toMatch(/Applied as revision 3/);
  expect(screen.getAllByRole("button", { name: "Apply…" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(environment.dismissRecipe).toHaveBeenCalledWith("recipe-1", "rev-1"));
});

it("leaves recipes out on a server that does not offer them", async () => {
  environment.recipes.mockRejectedValue({ code: "not_found", status: 404 });
  mount();
  await settled();
  await waitFor(() => expect(environment.recipes).toHaveBeenCalled());
  expect(screen.queryByLabelText("Environment recipes")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("picks a connected provider and loads another when chosen", async () => {
  providers.mockResolvedValue({ providers: [provider("box", false), provider("local-docker"), provider("hetzner")] } as never);
  mount();
  await settled();
  expect(environment.status).toHaveBeenCalledWith("local-docker");
  environment.status.mockResolvedValue(status({ provider: "hetzner", supported: false, template: null, activeVersion: null, versions: [] }));
  fireEvent.change(screen.getByLabelText("Environment provider"), { target: { value: "hetzner" } });
  expect((await screen.findByRole("status")).textContent).toMatch(/Hetzner cannot build environment images yet/);
  expect(environment.status).toHaveBeenLastCalledWith("hetzner");
});

it("offers a retry when the environment cannot be loaded", async () => {
  environment.status.mockRejectedValueOnce({ code: "cloud_environment_unavailable", status: null });
  mount();
  expect(await screen.findByText(/could not reach the account service/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await settled();
});
