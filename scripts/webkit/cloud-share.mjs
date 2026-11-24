#!/usr/bin/env node
// Share-dialog layout and desktop bridge behavior in the same WebKit harness as
// the existing organization roster checks. All account and SaaS replies are fixtures.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transformWithEsbuild } from "vite";
import { createCheckServer } from "./vite-page.mjs";
import { launch } from "./harness.mjs";

const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TooltipProvider } from '/src/components/ui/tooltip.tsx';
import { CloudShareDialog } from '/src/components/cloud/CloudShareDialog.tsx';
import { bootAccount } from '/src/lib/account.ts';
import { refreshDataPrivacy } from '/src/lib/dataPrivacy.ts';
import '/src/styles/app.css';

const stub = window.__PW_STUB__;
const orgId = 'org-a';
const contextRevision = 'groups-fixture:1';
const orgName = 'Analytical Engines';
const members = [
  { userId: 'me', email: 'owner@example.test', displayName: 'Workspace Owner', role: 'owner' },
  { userId: 'ada', email: 'ada@example.test', displayName: 'Ada Lovelace', role: 'member' },
  { userId: 'grace', email: 'grace@example.test', displayName: 'Grace Hopper', role: 'member' },
];
const group = { id: 'release', name: 'Release crew', memberCount: 3 };
const added = { id: 'review', name: 'Review crew with a long name to exercise the available row width', memberCount: 1 };
const groupShare = { groupId: group.id, role: 'viewer', canApprove: false, group };
const ada = { userId: 'ada', email: members[1].email, role: 'viewer', name: members[1].displayName, canApprove: false, createdBy: 'me', createdAt: 1, updatedAt: 1 };
const snapshot = { shares: [ada], you: { role: 'manager', canApprove: true, canManageShares: true } };
const responses = { ...snapshot, accessRevision: 'revision:1', groupShares: [groupShare] };
const status = { state: 'signed-in', identity: { email: members[0].email, name: members[0].displayName, organization: orgName, organizationId: orgId },
  context: { scope: 'groups-fixture', account: 'me', revision: contextRevision }, expiresAt: null, lastError: null, organizations: [
    { id: orgId, name: orgName, role: 'owner', isPersonal: false, cloud: { enabled: true, flags: { 'team.roster.v1': true } } },
  ], phase2Readiness: window.__GROUPS_TEST__ ? { [orgId]: ['cloud.workspace-groups.v1'] } : {} };
const roster = { members, pendingInvites: [], viewerRole: 'owner', canManageMembers: true, canInvite: true, contextRevision };
const calls = window.__SHARE_CALLS__ = [];
Object.assign(stub.answers, {
  account_status: status,
  account_refresh_roles: { status, fresh: true },
  data_privacy_status: { enabled: false, managed: false },
  organization_members: roster,
  organization_members_in: roster,
  cloud_workspace_shares: ({ contextRevision: asked }) => {
    calls.push(['shares', asked ?? null]);
    return structuredClone(asked ? responses : snapshot);
  },
  cloud_workspace_groups: (args) => {
    calls.push(['groups', args]);
    return args.cursor ? { groups: [added], nextCursor: null } : { groups: [group], nextCursor: 'page:2' };
  },
  cloud_workspace_shares_apply: ({ request, ...scope }) => {
    calls.push(['apply', { request, ...scope }]);
    responses.accessRevision = 'revision:2';
    responses.shares = [{ ...ada, role: 'driver' }];
    return { ...responses, results: request.changes.map((change) => change.subject.type === 'group'
      ? { id: change.id, status: 'failed', code: 'organization_group_not_found', message: 'The group could not be found.' }
      : { id: change.id, status: 'applied' }) };
  },
});
await refreshDataPrivacy();
await bootAccount();
function App() {
  const [open, setOpen] = useState(false);
  return <TooltipProvider>
    <button onClick={() => setOpen(true)}>Open Share</button>
    {open && <CloudShareDialog orgId={orgId} workspaceId="workspace" name="Team workspace" createdBy="me" onClose={() => setOpen(false)} />}
  </TooltipProvider>;
}
createRoot(document.getElementById('root')).render(<App />);
`;

const server = await createCheckServer({
  server: { host: "127.0.0.1" },
  plugins: [{
    resolveId(id) { if (id === "/cloud-share-entry.tsx") return "\0cloud-share-entry.tsx"; },
    async load(id) {
      if (id === "\0cloud-share-entry.tsx") return (await transformWithEsbuild(entry, "cloud-share-entry.tsx", { loader: "tsx", jsx: "automatic" })).code;
    },
    configureServer(server) {
      server.middlewares.use("/cloud-share-check", async (_request, response) => {
        response.setHeader("Content-Type", "text/html");
        response.end(await server.transformIndexHtml("/cloud-share-check", '<div id="root"></div><script type="module" src="/cloud-share-entry.tsx"></script>'));
      });
    },
  }],
});
const stub = await readFile(new URL("./tauri-stub.js", import.meta.url), "utf8");
let browser;
try {
  await server.listen();
  browser = await launch();
  for (const { enabled, width, height } of [{ enabled: false, width: 960, height: 700 }, { enabled: true, width: 960, height: 700 }, { enabled: true, width: 600, height: 450 }]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
    page.setDefaultTimeout(15_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(`window.__GROUPS_TEST__ = ${enabled};\n${stub}`);
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/cloud-share-check`);
    await page.getByRole("button", { name: "Open Share" }).click();
    const dialog = page.getByRole("dialog", { name: "Share Team workspace" });
    const calls = () => page.evaluate(() => window.__SHARE_CALLS__);
    await dialog.getByTestId("cloud-share-you").waitFor();
    const fits = async (surface) => {
      const box = await surface.boundingBox();
      assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1);
      assert.ok(await surface.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), "dialog has no horizontal overflow");
    };
    await fits(dialog);

    if (!enabled) {
      await dialog.getByRole("combobox", { name: "Add person" }).waitFor();
      assert.equal(await dialog.getByRole("button", { name: "Save", exact: true }).count(), 0);
      assert.equal(await dialog.getByText("Release crew").count(), 0);
      assert.deepEqual(await calls(), [["shares", null]]);
    } else {
      await dialog.getByText("Group · 3 members").waitFor();
      const save = dialog.getByRole("button", { name: "Save", exact: true });
      assert.equal(await save.isEnabled(), false);
      await dialog.getByRole("combobox", { name: "Role for Ada Lovelace" }).selectOption("driver");
      const search = dialog.getByRole("searchbox", { name: "Add people or groups from Analytical Engines" });
      await search.fill("crew & %");
      const shared = dialog.getByRole("button", { name: /Release crew.*Already added/ });
      await shared.waitFor();
      assert.equal(await shared.isEnabled(), false);
      await dialog.getByRole("button", { name: "More groups" }).click();
      await dialog.getByRole("button", { name: /Review crew with a long name/ }).click();
      await dialog.getByText(/2 unsaved changes/).waitFor();
      await fits(dialog);
      await page.keyboard.press("Escape");
      const discard = page.getByRole("dialog", { name: "Discard access changes?" });
      await discard.getByText(/Review crew.*Add as Viewer/).waitFor();
      await discard.getByText(/Ada Lovelace.*Change to Driver/).waitFor();
      await fits(discard);
      await discard.getByRole("button", { name: "Keep editing" }).click();
      assert.equal((await calls()).filter(([command]) => command === "apply").length, 0);
      await save.click();
      await dialog.getByText(/The group could not be found/).waitFor();
      assert.equal(await dialog.getByRole("combobox", { name: "Role for Ada Lovelace" }).inputValue(), "driver");
      await dialog.getByText("1 of 2 changes saved.").waitFor();
      await fits(dialog);
      const mutations = (await calls()).filter(([command]) => command === "apply");
      assert.equal(mutations.length, 1);
      assert.equal(mutations[0][1].request.changes.length, 2);
      assert.equal(mutations[0][1].request.accessRevision, "revision:1");
      const queries = (await calls()).filter(([command, args]) => command === "groups" && args.query === "crew & %");
      assert.deepEqual(queries.map(([, args]) => args.cursor), [null, "page:2"]);
      assert.ok(queries.every(([, args]) => args.orgId === "org-a" && args.contextRevision === "groups-fixture:1"));
    }

    assert.deepEqual(errors, []);
    console.log(`ok   cloud share: ${enabled ? "enabled staged editor" : "held legacy dialog"} fits ${width} × ${height}`);
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
