import { act, cleanup, fireEvent, render as baseRender, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
const render = (ui: ReactElement) => baseRender(<TooltipProvider>{ui}</TooltipProvider>);
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AccountStatus } from "@/lib/api";
import type { TeamArtifact } from "@/lib/teamArtifacts";

const f = vi.hoisted(() => ({
  status: {} as AccountStatus,
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  drafts: new Map<string, string>(),
  openAgents: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ invoke: (command: string, args?: Record<string, unknown>) => f.invoke(command, args) }));
vi.mock("@/lib/account", () => ({ useAccount: () => ({ status: f.status }) }));
vi.mock("@/lib/organizationRoster", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOrganizationRoster: () => ({ roster: { members: [{ userId: "u-aisha", email: "aisha@example.test", displayName: "Aisha Khan", role: "member" }] }, loading: false, error: null }),
}));
vi.mock("@/lib/drafts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDraft: (tab: string) => f.drafts.get(tab) ?? "",
  setDraft: (tab: string, text: string) => { f.drafts.set(tab, text); return 1; },
  subscribeDrafts: () => () => {},
}));
vi.mock("@/lib/sessions", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), openAgents: f.openAgents }));

import { openTeamArtifact, resetTeamArtifacts, teamArtifactOrg } from "@/lib/teamArtifacts";
import { TeamPanel, publishedAgo } from "./TeamPanel";
import { ArtifactsTab, TemplatePicker, matchTemplates } from "./ArtifactsTab";
import { ArtifactHistory, ArtifactViewer, ARTIFACT_PAGE_POLICY, sandboxedDocument } from "./ArtifactViewer";
import { PublishDialog } from "./shared";

const now = Date.parse("2026-11-27T12:00:00Z");
const artifact = (over: Partial<TeamArtifact>): TeamArtifact => ({
  id: "a1", slug: "weekly-standup", title: "Weekly standup · 2 Nov", description: null, template: false,
  contentType: "text/markdown", sizeBytes: 18_000, version: 3,
  author: { id: "u-aisha", name: null }, updatedBy: { id: "u-aisha", name: null }, source: "#18",
  createdAt: "2026-11-26T10:00:00Z", updatedAt: "2026-11-27T10:00:00Z", canDelete: false, ...over,
});
const standup = artifact({});
const checklist = artifact({ id: "a2", slug: "release-checklist-v3", title: "Release checklist v3", source: null, updatedAt: "2026-11-26T10:00:00Z" });
const migration = artifact({ id: "t1", slug: "migration-plan", title: "Migration plan", template: true, description: "Steps, risks and rollback for a schema change", contentType: "text/html", canDelete: true });
const notes = artifact({ id: "t2", slug: "release-notes", title: "Release notes", template: true, description: "Merged PRs grouped by area" });
const chart = artifact({ id: "t3", slug: "benchmark-chart", title: "Benchmark chart", template: true });

let listed: TeamArtifact[] = [];
let page: string | null = null;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now });
  resetTeamArtifacts();
  openTeamArtifact(null);
  f.drafts.clear();
  f.openAgents.mockReset();
  listed = [standup, checklist, migration, notes, chart];
  page = null;
  f.status = {
    state: "signed-in", identity: { organizationId: "org", organization: "Northwind" }, expiresAt: null, lastError: null,
    organizations: [{ id: "org", name: "Northwind", role: "member" }],
    phase2Readiness: { org: ["team.artifacts.v1"] },
  } as unknown as AccountStatus;
  f.invoke.mockReset();
  f.invoke.mockImplementation(async (command, args) => {
    if (command === "team_artifacts_list") return { artifacts: listed };
    if (command === "team_artifact_delete") { listed = listed.filter((item) => item.id !== args?.artifactId); return { deleted: true, id: args?.artifactId }; }
    if (command === "team_artifact_get") {
      const found = listed.find((item) => item.id === args?.artifactId)!;
      return { artifact: found, versions: [3, 2, 1].map((version) => ({ version, contentType: found.contentType, sizeBytes: 10, note: version === 3 ? "Added Sam's blockers" : null, source: "#18", author: found.author, createdAt: "2026-11-27T10:00:00Z" })) };
    }
    if (command === "team_artifact_content") return { artifactId: args?.artifactId, version: args?.version, contentType: listed.find((item) => item.id === args?.artifactId)!.contentType, content: page ?? "<h1>Plan</h1><script>parent.postMessage('x','*')</script>" };
    if (command === "team_artifact_pick_file") return { name: "plan.html", content: "<h1>Plan</h1>", refused: null };
    if (command === "team_artifact_publish") return { artifact: { ...migration, version: 2 }, created: false };
    if (command === "team_artifact_version_delete") return { deleted: true, artifactId: args?.artifactId, version: args?.version };
    throw new Error(command);
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("is off until the server says the organization has team artifacts", () => {
  expect(teamArtifactOrg(f.status)).toBe("org");
  expect(teamArtifactOrg({ ...f.status, phase2Readiness: { org: [] } } as AccountStatus)).toBeNull();
  expect(teamArtifactOrg({ ...f.status, state: "signed-out" } as AccountStatus)).toBeNull();
});

it("lists team artifacts newest first, templates apart, and the publish command (13.17)", async () => {
  render(<TeamPanel orgId="org" selectedId={null} onCollapse={() => {}} />);
  const list = await screen.findByTestId("team-artifacts-list");
  const rows = within(list).getAllByTestId("team-artifact-row");
  expect(rows.map((row) => row.textContent)).toEqual(["Weekly standup · 2 Novfrom #18AK2h ago", "Release checklist v3team artifactAKyesterday"]);
  expect(within(screen.getByTestId("team-templates-list")).getAllByTestId("team-template-row").map((row) => row.textContent)).toEqual(["Migration plan@migration-plan", "Release notes@release-notes", "Benchmark chart@benchmark-chart"]);
  expect(screen.getByText("Team").nextSibling?.textContent).toBe("Northwind");
  expect(screen.getByTestId("team-artifacts-cli").textContent).toBe("$ terminalx artifact publish standup.md --org northwind");
  expect(screen.getByRole("button", { name: "Publish…" })).toBeTruthy();
});

it("shows a teammate's publish within a minute without a reload", async () => {
  render(<TeamPanel orgId="org" selectedId={null} onCollapse={() => {}} />);
  await screen.findByTestId("team-artifacts-list");
  listed = [artifact({ id: "a9", title: "Q4 roadmap", updatedAt: new Date(now).toISOString() }), ...listed];
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  await waitFor(() => expect(screen.getAllByTestId("team-artifact-row")[0].textContent).toContain("Q4 roadmap"));
});

it("opens an artifact in the viewer from the panel", async () => {
  render(<TeamPanel orgId="org" selectedId={null} onCollapse={() => {}} />);
  fireEvent.click((await screen.findAllByTestId("team-artifact-row"))[0]);
  render(<ArtifactViewer open={{ orgId: "org", id: "a1", version: null }} history={false} onHistory={() => {}} />);
  expect(await screen.findByTestId("team-artifact-byline")).toBeTruthy();
  expect(screen.getByTestId("team-artifact-byline").textContent).toBe("AKAisha Khan · from #18 · 2h ago");
});

it("renders published HTML only in a script-less, opaque-origin sandbox with a policy that loads nothing", async () => {
  listed = [migration];
  render(<ArtifactViewer open={{ orgId: "org", id: "t1", version: null }} history={false} onHistory={() => {}} />);
  const frame = (await screen.findByTestId("team-artifact-html")) as HTMLIFrameElement;
  // An empty sandbox: no allow-scripts, no allow-same-origin, no forms, popups or top navigation.
  expect(frame.getAttribute("sandbox")).toBe("");
  expect(frame.getAttribute("src")).toBeNull();
  const doc = frame.getAttribute("srcdoc") ?? "";
  expect(doc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_PAGE_POLICY}">`)).toBe(true);
  expect(ARTIFACT_PAGE_POLICY).toContain("script-src 'none'");
  expect(ARTIFACT_PAGE_POLICY).toContain("default-src 'none'");
  // The page's own markup comes after the policy, never before it.
  expect(doc.indexOf("<script>")).toBeGreaterThan(doc.indexOf("Content-Security-Policy"));
  expect(sandboxedDocument("<svg onload=alert(1)>")).toMatch(/^<!doctype html><meta http-equiv="Content-Security-Policy"/);
});

it("shows an older version with the way back, and lets the author prune it (13.33)", async () => {
  listed = [{ ...standup, canDelete: true }];
  render(<><ArtifactViewer open={{ orgId: "org", id: "a1", version: 2 }} history onHistory={() => {}} /><ArtifactHistory open={{ orgId: "org", id: "a1", version: 2 }} onClose={() => {}} /></>);
  const banner = await screen.findByTestId("team-artifact-old-version");
  expect(banner.textContent).toContain("You're viewing v2 from 2h ago.");
  expect(banner.textContent).toContain("v3 is the current version.");
  const history = screen.getByTestId("team-artifact-history");
  await waitFor(() => expect(within(history).getAllByTestId("team-artifact-version")).toHaveLength(3));
  expect(within(history).getByText("Current")).toBeTruthy();
  expect(within(history).getByText("Everyone at Northwind")).toBeTruthy();
  expect(within(history).getByText("18 KB · Markdown")).toBeTruthy();
  // The current version has no delete; the older ones do.
  expect(within(history).getAllByTestId("team-artifact-prune").map((button) => button.getAttribute("aria-label"))).toEqual(["Delete v2", "Delete v1"]);
  fireEvent.click(within(history).getByRole("button", { name: "Delete v1" }));
  await waitFor(() => expect(f.invoke).toHaveBeenCalledWith("team_artifact_version_delete", { orgId: "org", artifactId: "a1", version: 1 }));
});

it("starts from a team template: search, insert the @slug, and the empty and no-match states (06.04, 06.13, 06.14)", async () => {
  f.drafts.set("tab-1", "Plan the seats column");
  render(<ArtifactsTab orgId="org" tabId="tab-1" />);
  expect(screen.getByText("Nothing published yet")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Start from a template" }));
  const picker = await screen.findByTestId("team-template-picker");
  expect(within(picker).getByText("Team templates · Northwind")).toBeTruthy();
  await waitFor(() => expect(within(picker).getAllByTestId("team-template")).toHaveLength(3));
  fireEvent.click(within(picker).getByText("Migration plan"));
  expect(f.drafts.get("tab-1")).toBe("Plan the seats column @migration-plan ");
  expect(within(picker).getByText("Inserts the @slug in the composer. The agent fills the template in and publishes it.")).toBeTruthy();

  fireEvent.change(within(picker).getByLabelText("Search templates"), { target: { value: "billing" } });
  const none = within(picker).getByTestId("team-templates-no-match");
  expect(none.textContent).toContain("No templates match “billing”");
  expect(none.textContent).toContain("Northwind has 3 templates: Migration plan, Release notes and Benchmark chart.");
  fireEvent.click(within(none).getByRole("button", { name: "Clear search" }));
  expect(within(picker).getAllByTestId("team-template")).toHaveLength(3);
  expect(matchTemplates([migration, notes, chart], "@release")).toEqual([notes]);
});

it("says how to publish the first template when there is none (06.13)", async () => {
  listed = [standup];
  render(<TemplatePicker orgId="org" tabId="tab-1" />);
  const none = await screen.findByTestId("team-templates-none");
  expect(none.textContent).toContain("No team templates yet");
  expect(none.textContent).toContain("Publish any artifact as a template and everyone in Northwind can start from it.");
  expect(none.textContent).toContain("--template migration-plan");
});

it("offers Delete template… only to those who may, and confirms first (06.15)", async () => {
  render(<TemplatePicker orgId="org" tabId="tab-1" />);
  await waitFor(() => expect(screen.getAllByTestId("team-template")).toHaveLength(3));
  fireEvent.pointerDown(screen.getByRole("button", { name: "Release notes actions" }), { button: 0, ctrlKey: false });
  expect(await screen.findByRole("menuitem", { name: "Insert @release-notes" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Preview" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "Delete template…" })).toBeNull();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

  fireEvent.pointerDown(screen.getByRole("button", { name: "Migration plan actions" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete template…" }));
  expect(await screen.findByText("Delete template Migration plan?")).toBeTruthy();
  expect(screen.getByText("This permanently deletes @migration-plan for everyone in Northwind. Artifacts made from it keep their content.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Delete template" }));
  await waitFor(() => expect(f.invoke).toHaveBeenCalledWith("team_artifact_delete", { orgId: "org", artifactId: "t1" }));
  await waitFor(() => expect(screen.getAllByTestId("team-template")).toHaveLength(2));
});

it("previews a template on the overview", async () => {
  render(<TemplatePicker orgId="org" tabId="tab-1" />);
  await waitFor(() => expect(screen.getAllByTestId("team-template")).toHaveLength(3));
  fireEvent.pointerDown(screen.getByRole("button", { name: "Benchmark chart actions" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Preview" }));
  expect(f.openAgents).toHaveBeenCalled();
});

it("words a panel's age as the design does", () => {
  expect(publishedAgo("2026-11-27T10:00:00Z", now)).toBe("2h ago");
  expect(publishedAgo("2026-11-26T10:00:00Z", now)).toBe("yesterday");
  expect(publishedAgo("2026-11-23T10:00:00Z", now)).toBe("4 days ago");
});

it("draws no raw HTML from a Markdown artifact, so a <picture> cannot load a remote image", async () => {
  page = "# Standup\n\n<picture><source srcset=\"https://tracker.example/pixel.png\"><img src=\"https://tracker.example/pixel.png\"></picture>\n\nDone.";
  listed = [standup];
  const view = render(<ArtifactViewer open={{ orgId: "org", id: "a1", version: null }} history={false} onHistory={() => {}} />);
  await screen.findByText("Done.");
  expect(view.container.querySelector("picture, source, img")).toBeNull();
  expect(view.container.innerHTML).not.toContain("tracker.example");
});

async function publishTemplate(title: string) {
  render(<PublishDialog orgId="org" onClose={() => {}} onPublished={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose file…" }));
  await screen.findByText("plan.html");
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: title } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Template for new sessions" }));
}

it("the picker is asked for with the organization, so its readiness is checked first", async () => {
  render(<PublishDialog orgId="org" onClose={() => {}} onPublished={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose file…" }));
  await waitFor(() => expect(f.invoke).toHaveBeenCalledWith("team_artifact_pick_file", { orgId: "org" }));
});

it("never publishes a template over a slug in use by default; its author may choose a new version (slug clash)", async () => {
  await publishTemplate("Migration plan");
  const taken = await screen.findByTestId("team-artifact-slug-taken");
  expect(taken.textContent).toContain("@migration-plan is already “Migration plan”.");
  const publish = screen.getByRole("button", { name: "Publish" });
  expect((publish as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(taken).getByRole("checkbox", { name: "Add as a new version of @migration-plan" }));
  const asVersion = screen.getByRole("button", { name: "Publish v4" });
  expect((asVersion as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(asVersion);
  await waitFor(() => expect(f.invoke).toHaveBeenCalledWith("team_artifact_publish", { orgId: "org", input: { title: "Migration plan", contentType: "text/html", content: "<h1>Plan</h1>", template: true, slug: "migration-plan", expect: { version: 3 } } }));
});

it("someone else's slug must be changed: no new version is offered", async () => {
  await publishTemplate("Release notes");
  const taken = await screen.findByTestId("team-artifact-slug-taken");
  expect(taken.textContent).toContain("Choose another slug. Only its author and admins can add a version.");
  expect(within(taken).queryByRole("checkbox")).toBeNull();
  expect((screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Template slug"), { target: { value: "release-notes-q4" } });
  expect(screen.queryByTestId("team-artifact-slug-taken")).toBeNull();
  expect((screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(false);
  // Held on the server to what the dialog showed: nobody had the slug.
  fireEvent.click(screen.getByRole("button", { name: "Publish" }));
  await waitFor(() => expect(f.invoke).toHaveBeenCalledWith("team_artifact_publish", { orgId: "org", input: expect.objectContaining({ slug: "release-notes-q4", expect: "new" }) }));
});

it("a slug a teammate took after the dialog looked is refused by the server and shown at once", async () => {
  const fallback = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation(async (command, args) => {
    if (command === "team_artifact_publish") {
      listed = [...listed, { ...migration, id: "taken", slug: "q4-plan", title: "Q4 plan", canDelete: false }];
      throw { code: "team_artifact_slug_taken", message: "team_artifact_slug_taken" };
    }
    return fallback(command, args);
  });
  await publishTemplate("Q4 plan");
  const publish = screen.getByRole("button", { name: "Publish" });
  await waitFor(() => expect((publish as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(publish);
  expect(await screen.findByText(/A teammate published this slug, or a new version of it, just now/)).toBeTruthy();
  // The list is read again, so the clash shows and Publish waits for another slug.
  expect((await screen.findByTestId("team-artifact-slug-taken")).textContent).toContain("@q4-plan is already “Q4 plan”.");
  expect((screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(true);
});
