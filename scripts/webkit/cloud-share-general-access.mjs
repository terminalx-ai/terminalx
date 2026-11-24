#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transformWithEsbuild } from "vite";
import { launch } from "./harness.mjs";
import { createCheckServer } from "./vite-page.mjs";

const entry = `
import { createRoot } from 'react-dom/client';
import { CloudShareDialog } from '/src/components/cloud/CloudShareDialog.tsx';
import { bootAccount } from '/src/lib/account.ts';
import { refreshDataPrivacy } from '/src/lib/dataPrivacy.ts';
import '/src/styles/app.css';

const stub = window.__PW_STUB__;
const orgId = 'org-share';
const status = {
  state: 'signed-in', identity: { name: 'Morgan', email: 'morgan@example.test', organization: 'Procyon Labs', organizationId: orgId },
  expiresAt: null, lastError: null, context: { scope: 'share-fixture', revision: 'share-fixture:1' },
  organizations: [{ id: orgId, name: 'Procyon Labs', role: 'owner' }],
  phase2Readiness: { [orgId]: ['cloud.workspaces.general-access.v1'] },
};
let listed = {
  shares: [], you: { role: 'manager', canApprove: true, canManageShares: true },
  generalAccess: { mode: 'invited_only' }, accessRevision: '9007199254740993',
  capabilities: { canChangeGeneralAccess: true, canGrantAdmin: true, canUseOrganisationWrite: false },
};
window.shareRequests = [];
window.disableGeneralAccess = () => {
  status.phase2Readiness = {};
  stub.emit('account_status', structuredClone(status));
};
Object.assign(stub.answers, {
  account_status: () => structuredClone(status),
  account_refresh_roles: () => ({ status: structuredClone(status), fresh: true }),
  organization_members: { members: [] },
  cloud_workspace_shares: () => structuredClone(listed),
  cloud_workspace_general_access_put: (body) => {
    window.shareRequests.push(body);
    const receipt = { accessRevision: '9007199254740994', generalAccess: body.generalAccess };
    listed = { ...listed, ...receipt };
    return receipt;
  },
});
await refreshDataPrivacy();
await bootAccount();
createRoot(document.getElementById('root')).render(
  <CloudShareDialog workspaceId="workspace-share" orgId={orgId} name="Payments" onClose={() => {}} />
);
`;

const server = await createCheckServer({
  plugins: [{
    resolveId(id) { if (id === "/general-access-entry.tsx") return "\0general-access-entry.tsx"; },
    async load(id) {
      if (id === "\0general-access-entry.tsx") {
        return (await transformWithEsbuild(entry, "general-access-entry.tsx", { loader: "tsx", jsx: "automatic" })).code;
      }
    },
    configureServer(server) {
      server.middlewares.use("/general-access-check", async (_request, response) => {
        response.setHeader("Content-Type", "text/html");
        response.end(await server.transformIndexHtml(
          "/general-access-check", '<div id="root"></div><script type="module" src="/general-access-entry.tsx"></script>',
        ));
      });
    },
  }],
});
const stub = await readFile(new URL("./tauri-stub.js", import.meta.url), "utf8");
let browser;
try {
  await server.listen();
  browser = await launch();
  for (const width of [460, 960]) {
    const page = await browser.newPage({ viewport: { width, height: 720 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.addInitScript(stub);
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/general-access-check`);
      const panel = page.getByRole("region", { name: "General access" });
      const picker = panel.getByRole("combobox", { name: "General access" });
      await picker.waitFor();
      assert.equal(await picker.inputValue(), "invited_only");
      assert.deepEqual(await picker.locator("option").allTextContents(), ["Only people invited", "Everyone at Procyon Labs"]);
      await picker.selectOption("organisation");
      const save = panel.getByRole("button", { name: "Save General access" });
      assert.ok(await panel.getByText("Read", { exact: true }).isVisible());
      assert.deepEqual(await page.evaluate(() => window.shareRequests), []);
      await save.click();
      await save.waitFor({ state: "hidden" });
      assert.deepEqual(await page.evaluate(() => window.shareRequests), [{
        workspaceId: "workspace-share",
        orgId: "org-share",
        accessRevision: "9007199254740993",
        generalAccess: { mode: "organisation", role: "read" },
        contextRevision: "share-fixture:1",
      }]);
      assert.equal(await picker.inputValue(), "organisation");
      assert.ok(await panel.evaluate((node) => node.scrollWidth === node.clientWidth));
      await page.evaluate(() => window.disableGeneralAccess());
      await panel.waitFor({ state: "hidden" });
      assert.deepEqual(errors, []);
      console.log(`PASS General access in WebKit at ${width}px`);
    } catch (error) {
      if (errors.length) console.error(errors.join("\n"));
      throw error;
    } finally {
      await page.close();
    }
  }
} finally {
  await browser?.close();
  await server.close();
}
