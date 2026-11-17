import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CloudApi, CloudApiError } from "./api";
import { CloudCatalog } from "./catalog";

/**
 * Starting a stopped workspace from the phone, against the cloud test server
 * (#988): the account service's local stack (`bun run cloud:local:up` in the
 * terminalx-server repository), with its local-docker provider. Nothing here is
 * faked: the phone's own catalog and API client call the real
 * `POST /v1/mobile/orgs/:orgId/cloud-workspaces/:workspaceId/resume`, and the
 * workspace is followed in the real list until it runs.
 *
 * It runs when `TERMINALX_CLOUD_TEST_SERVER` names a JSON file describing that
 * stack, and is skipped otherwise (CI has no stack):
 *
 *   { "origin": "http://127.0.0.1:42220", "orgId": "…", "workspaceId": "…",
 *     "managerToken": "…", "driverToken": "…" }
 *
 * - `workspaceId`: a workspace of that organization, suspended.
 * - `managerToken`: a mobile access token of its creator.
 * - `driverToken`: a mobile access token of an organization member it is shared with as a driver.
 * - `mobileLifecycleLocalDocker`: true once the server's mobile lifecycle routes serve the stack's
 *   local-docker provider. Older stacks with a fixed provider set in the mobile
 *   lifecycle routes return `cloud_workspace_not_found` for a manager's resume.
 */
interface TestServer {
  origin: string;
  orgId: string;
  workspaceId: string;
  managerToken: string;
  driverToken: string;
  mobileLifecycleLocalDocker?: boolean;
}

const configPath = process.env.TERMINALX_CLOUD_TEST_SERVER;
const server: TestServer | null = configPath ? JSON.parse(readFileSync(configPath, "utf8")) : null;

// Older test stacks need local-docker named explicitly when listing workspaces.
const withLocalDocker: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  const providersHeader = "X-TerminalX-Cloud-Workspace-Providers";
  headers.set(providersHeader, [headers.get(providersHeader), "local-docker"].filter(Boolean).join(","));
  return fetch(input, { ...init, headers });
};

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => void values.set(key, value),
    delete: async (key: string) => void values.delete(key),
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => void values.set(key, value),
    removeItem: async (key: string) => void values.delete(key),
    getAllKeys: async () => [...values.keys()],
  };
}

function phone(token: string): CloudCatalog {
  const storage = memoryStorage();
  const api = new CloudApi({ origin: server!.origin, accessToken: async () => token, fetch: withLocalDocker });
  return new CloudCatalog({ api, secrets: storage, storage, clientInstallationId: `server-test-${token.slice(0, 6)}`, appVersion: "test" });
}

const stateOf = (catalog: CloudCatalog) => catalog.workspace(server!.orgId, server!.workspaceId)?.state ?? null;

async function until(what: string, ready: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await ready())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 1_000));
  }
}

describe.skipIf(!server)("starting a stopped workspace from the phone, against the cloud test server (#988)", () => {
  it("refuses a driver's Start, and leaves the workspace stopped", async () => {
    const driver = phone(server!.driverToken);
    try {
      await driver.refresh();
      // A driver sees it, as a driver, and the server will not start it for them with Start: only by a message (§11.2).
      expect(stateOf(driver)).toBe("suspended");
      expect(driver.workspace(server!.orgId, server!.workspaceId)?.you?.role).toBe("driver");
      const refused = await driver.start(server!.orgId, server!.workspaceId).then(() => null, (error: unknown) => error);
      expect(refused).toBeInstanceOf(CloudApiError);
      expect(refused).toMatchObject({ code: "cloud_workspace_manager_required", status: 403 });
      await driver.refresh();
      expect(stateOf(driver)).toBe("suspended");
    } finally {
      driver.close();
    }
  });

  it.skipIf(!server?.mobileLifecycleLocalDocker)("starts it for a manager, from the server's 202 answer, until it runs", async () => {
    const manager = phone(server!.managerToken);
    try {
      await manager.refresh();
      expect(stateOf(manager)).toBe("suspended");
      expect(manager.workspace(server!.orgId, server!.workspaceId)?.you?.role).toBe("manager");
      await manager.start(server!.orgId, server!.workspaceId);
      expect(["resuming", "ready"]).toContain(stateOf(manager));
      expect(manager.workspace(server!.orgId, server!.workspaceId)?.latestOperation).toMatchObject({ action: "resume" });
      await until("the workspace to run", async () => {
        await manager.refresh();
        return stateOf(manager) === "ready";
      }, 4 * 60_000);
    } finally {
      manager.close();
    }
  }, 5 * 60_000);
});
