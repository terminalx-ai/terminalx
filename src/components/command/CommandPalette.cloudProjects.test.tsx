import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus, CloudWorkspaceListItem } from "@/lib/api";
import type { Project } from "@/types/session";

// PRO-23: Search lists project rows, local and cloud, each saying where it
// is, so two projects of the same name in two organizations read apart.

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), status: null as unknown as AccountStatus, api: { cloudCatalogLoad: vi.fn(), cloudCatalogSave: vi.fn(), cloudRemoteAttach: vi.fn(), cloudWorkspaceResume: vi.fn() } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(), openUrl: vi.fn() }));
vi.mock("@/components/layout/AppShell", () => ({ TITLEBAR_INSET: 78 }));
vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return { ...original, api: new Proxy(original.api, { get: (target, key: string) => (key in mocks.api ? mocks.api[key as keyof typeof mocks.api] : target[key as keyof typeof target]) }) };
});
vi.mock("@/lib/account", () => ({
  useAccount: () => ({ status: mocks.status, ready: true, busy: false }),
  getAccount: () => ({ status: mocks.status, ready: true, busy: false }),
  subscribeAccount: () => () => undefined,
  refreshAccount: vi.fn(),
}));

const { CommandPalette } = await import("./CommandPalette");
const store = await import("@/lib/sessions");
const catalog = await import("@/lib/cloudCatalog");
const prefs = await import("@/lib/prefs");

const local: Project = { path: "/code/accone", name: "accone" };

function blank(id: string, orgId: string, name: string): CloudWorkspaceListItem {
  return {
    workspace: { id, orgId, name, provider: "local-docker", state: "ready", accessMode: "organization", createdAt: 1, updatedAt: 10, lastActivityAt: 20, releaseDisposition: null, repositories: [] },
    latestOperation: null,
  } as unknown as CloudWorkspaceListItem;
}

beforeEach(async () => {
  mocks.status = {
    state: "signed-in",
    identity: { name: "Alice", email: "alice@example.com", organization: "Share Lab", organizationId: "org-share" },
    expiresAt: null,
    lastError: null,
    context: { scope: "s", revision: "s:1" },
    multiOrg: true,
    organizations: [
      { id: "org-share", name: "Share Lab", role: "owner", isPersonal: false, cloud: { enabled: true, flags: {} } },
      { id: "org-second", name: "Second Lab", role: "member", isPersonal: false, cloud: { enabled: true, flags: {} } },
    ],
  } as AccountStatus;
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "list_projects") return { projects: [local], lastSelected: local.path };
    if (command === "list_sessions" || command === "list_workspaces" || command === "list_harnesses") return [];
    return null;
  });
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  prefs.setPrefs({ hiddenOrganizations: [], organizationDisplay: "all", cloudBlankProjects: {} });
  await catalog.ingestCloudList({ workspaces: [blank("w1", "org-share", "accone")] }, "org-share");
  await catalog.ingestCloudList({ workspaces: [blank("w2", "org-second", "accone")] }, "org-second");
  await act(async () => {
    await store.refreshEverything();
    store.selectSession(null);
  });
});

afterEach(() => {
  cleanup();
  catalog.resetCloudCatalog();
});

function search(text: string) {
  render(<CommandPalette open onOpenChange={vi.fn()} onOpenSettings={vi.fn()} onCreated={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Command palette search"), { target: { value: text } });
}

const projectRows = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].filter((row) => row.id === `project:${local.path}` || row.id.startsWith("cloud-project:"));

describe("project rows in Search", () => {
  it("lists a local project and both organizations' projects of the same name, each saying where it is", async () => {
    search("accone");
    await waitFor(() => expect(projectRows()).toHaveLength(3));
    const lines = projectRows().map((row) => row.textContent);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^accone.*Share Lab cloud · no repository$/),
        expect.stringMatching(/^accone.*Second Lab cloud · no repository$/),
        `acconeLocal · ${local.path}`,
      ]),
    );
  });

  it("finds a cloud project by its organization's name", async () => {
    search("second lab");
    await waitFor(() => expect(projectRows().map((row) => row.id)).toEqual(["cloud-project:cloud:org-second:blank/accone"]));
  });

  it("opening a cloud project row focuses it in the sidebar and wakes nothing", async () => {
    search("share lab accone");
    await waitFor(() => expect(projectRows()).toHaveLength(1));
    fireEvent.click(projectRows()[0]);
    await waitFor(() => expect(store.getSessionStore().selectedCloudProject).toBe("cloud:org-share:blank/accone"));
    expect(mocks.api.cloudRemoteAttach).not.toHaveBeenCalled();
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
  });

  it("leaves a hidden organization's projects out until something is typed", async () => {
    prefs.setPrefs({ hiddenOrganizations: ["org-second"] });
    render(<CommandPalette open onOpenChange={vi.fn()} onOpenSettings={vi.fn()} onCreated={vi.fn()} />);
    await waitFor(() => expect(projectRows().map((row) => row.id)).toContain("cloud-project:cloud:org-share:blank/accone"));
    expect(projectRows().map((row) => row.id)).not.toContain("cloud-project:cloud:org-second:blank/accone");
    prefs.setPrefs({ hiddenOrganizations: [] });
  });
});
