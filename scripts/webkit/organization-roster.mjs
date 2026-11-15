#!/usr/bin/env node
// PRO-128: production roster/profile/share components, account and cache stores,
// and app CSS in WebKit. Only native service/clipboard replies are fixtures;
// no live account, organization mutation or external image request is needed.
// Set ROSTER_SHOTS to save the light/dark evidence alongside the assertions.
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer, transformWithEsbuild } from "vite";
import { launch } from "./harness.mjs";

const shots = process.env.ROSTER_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { OrganizationMembers } from '/src/components/settings/OrganizationMembers.tsx';
import { CloudShareDialog } from '/src/components/cloud/CloudShareDialog.tsx';
import { ParticipantsBar, PresenceAvatars } from '/src/components/cloud/CloudCollab.tsx';
import { TooltipProvider } from '/src/components/ui/tooltip.tsx';
import { Button } from '/src/components/ui/button.tsx';
import { bootAccount } from '/src/lib/account.ts';
import { refreshDataPrivacy, setDataPrivacy } from '/src/lib/dataPrivacy.ts';
import { startCollab } from '/src/lib/cloudCollab.ts';
import { cachedOrganizationRosters } from '/src/lib/organizationRoster.ts';
import { setMode, setTheme } from '/src/lib/theme.ts';
import '/src/styles/app.css';

const stub = window.__PW_STUB__;
const orgId = 'org-a';
const me = { userId: 'owner-1', displayName: 'Morgan Chen', email: 'morgan@example.test', role: 'owner', createdAt: Date.UTC(2025, 0, 6) };
const ada = { userId: 'member-1', displayName: 'Ada Lovelace', email: 'ada@example.test', role: 'admin', photoUrl: 'https://avatars.example.test/ada.svg', createdAt: Date.UTC(2025, 1, 3) };
const grace = { userId: 'member-2', displayName: 'Grace Hopper', email: 'grace@example.test', role: 'member', createdAt: Date.UTC(2025, 2, 12) };
let members = [me, ada, grace];
let reads = 0;
const status = { state: 'signed-in', identity: { name: me.displayName, email: me.email, organization: 'Analytical Engines', organizationId: orgId }, expiresAt: null, lastError: null,
  context: { scope: 'roster-fixture', account: 'owner-1', revision: 'roster-fixture:1' },
  organizations: [{ id: orgId, name: 'Analytical Engines', role: 'owner', isPersonal: false, cloud: { enabled: true, flags: { 'team.roster.v1': true } } }] };
const roster = () => { reads++; return structuredClone({ members, pendingInvites: [], viewerRole: 'owner', canManageMembers: true, canInvite: true, contextRevision: status.context.revision }); };
Object.assign(stub.answers, {
  account_status: () => structuredClone(status),
  account_refresh_roles: () => ({ status: structuredClone(status), fresh: true }),
  organization_members: roster,
  organization_members_in: roster,
  data_privacy_status: { enabled: false, managed: false },
  data_privacy_set: ({ enabled }) => { const policy = { enabled, managed: false }; stub.answers.data_privacy_status = policy; return policy; },
  cloud_workspace_shares: { shares: [{ userId: ada.userId, email: ada.email, name: ada.displayName, role: 'viewer', canApprove: false }], you: { role: 'manager', canApprove: true, canManageShares: true } },
  cloud_mirror_list: [],
  cloud_agent_cache_save: null,
});
window.__ROSTER__ = {
  reads: () => reads,
  cached: () => cachedOrganizationRosters(),
  copied: [],
  setFlag: (enabled) => { status.organizations[0].cloud.flags = enabled ? { 'team.roster.v1': true } : {}; stub.emit('account_status', structuredClone(status)); },
  setPrivacy: setDataPrivacy,
  removeGrace: () => { members = members.filter(member => member.userId !== grace.userId); },
};
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__ROSTER__.copied.push(text); } } });
await refreshDataPrivacy();
await bootAccount();
const you = { userId: me.userId, role: 'manager', canApprove: true };
const participants = [ada, grace].map(member => ({ userId: member.userId, role: 'driver', canApprove: false, surfaces: 1, tabId: 'tab-1', activity: 'viewing', since: Date.now() }));
startCollab('cloud:org-a:workspace', {
  connection: { state: 'connected', runtimeGeneration: 1, runtimeEpoch: 'e1', runtimeVersion: '0.3.0', capabilities: ['collab/1'], authority: 'manage', you },
  call: async method => method === 'collab.state' ? { you, participants, leases: [] } : {},
  onNotification: () => () => {},
});
setTheme('slate');
setMode(window.__ROSTER_MODE__);

function App() {
  const [surface, setSurface] = useState('share');
  const [sharing, setSharing] = useState(false);
  window.__ROSTER__.show = setSurface;
  return <TooltipProvider><main className="h-full overflow-auto bg-background p-8 text-foreground">
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-1 text-base font-semibold">Analytical Engines</h1>
      {surface === 'members' && <OrganizationMembers organizationId={orgId} accountEmail={me.email} contextRevision={status.context.revision}/>}
      {surface === 'participants' && <div className="mt-4 flex border-y border-hairline py-2"><ParticipantsBar collabKey="cloud:org-a:workspace" you={you} tabLabel={() => 'Editor'}/></div>}
      {surface === 'header' && <header className="mt-4 flex h-10 items-center gap-3 border-y border-hairline px-3"><span className="mr-auto text-sm">Team workspace</span><PresenceAvatars collabKey="cloud:org-a:workspace" you={you}/></header>}
      <Button className="mt-5" variant="outline" onClick={() => setSharing(true)}>Share workspace</Button>
      {sharing && <CloudShareDialog orgId={orgId} workspaceId="workspace" name="Team workspace" onClose={() => setSharing(false)}/>}
    </div>
  </main></TooltipProvider>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;

const server = await createServer({
  server: { port: 0, host: "127.0.0.1" },
  plugins: [{
    name: "organization-roster-regression",
    resolveId(id) { if (id === "/roster-regression.tsx") return "\0roster-regression.tsx"; },
    async load(id) {
      if (id === "\0roster-regression.tsx") return (await transformWithEsbuild(entry, "roster-regression.tsx", { loader: "tsx", jsx: "automatic" })).code;
    },
    configureServer(server) {
      server.middlewares.use("/roster-test", async (_request, response) => {
        response.setHeader("Content-Type", "text/html");
        response.end(await server.transformIndexHtml("/roster-test", '<div id="root"></div><script type="module" src="/roster-regression.tsx"></script>'));
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await launch();
  for (const mode of ["dark", "light"]) {
    const page = await browser.newPage({ viewport: { width: 960, height: 720 }, locale: "en-US", colorScheme: mode });
    page.setDefaultTimeout(20_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("https://avatars.example.test/ada.svg", (route) => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#667799"/><circle cx="32" cy="23" r="12" fill="#edcbb0"/><path d="M8 64a24 30 0 0148 0" fill="#202e49"/></svg>' }));
    await page.addInitScript(`window.__ROSTER_MODE__ = ${JSON.stringify(mode)};\n${await readFile(new URL("./tauri-stub.js", import.meta.url), "utf8")}`);
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/roster-test`);
    const shot = async (name) => {
      if (!shots) return;
      await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
      await page.screenshot({ path: join(shots, `${name}-${mode}.png`) });
    };
    const openProfile = async (container = page) => {
      const avatar = container.getByRole("button", { name: "View profile: Ada Lovelace" });
      await avatar.focus();
      await page.keyboard.press("Enter");
      const profile = page.getByRole("dialog", { name: "Profile of Ada Lovelace" });
      await profile.waitFor();
      assert.equal(await profile.getByText("ada@example.test", { exact: true }).count(), 1);
      assert.equal(await profile.getByText("Admin", { exact: true }).count(), 1);
      assert.equal(await profile.getByText("Joined February 3, 2025", { exact: true }).count(), 1);
      const box = await profile.boundingBox();
      assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 960 && box.y + box.height <= 720, "profile fits WebKit viewport");
      assert.ok(await profile.evaluate(node => node.scrollWidth <= node.clientWidth + 1), "profile text does not overflow");
      assert.notEqual(await profile.getByTestId("profile-presence").evaluate(node => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)", "presence slot has a visible theme color");
      return { profile, avatar };
    };
    const closeProfile = async ({ profile, avatar }) => {
      await page.keyboard.press("Escape");
      await profile.waitFor({ state: "detached" });
      assert.ok(await avatar.evaluate(node => node === document.activeElement), "Escape restores avatar focus");
    };

    // Start with Share so no other consumer can hide a duplicate read.
    for (let n = 0; n < 2; n++) {
      await page.getByRole("button", { name: "Share workspace", exact: true }).click();
      const share = page.getByRole("dialog", { name: "Share Team workspace", exact: true });
      await share.waitFor();
      const opened = await openProfile(share);
      if (n === 0) await shot("share-profile");
      await closeProfile(opened);
      await page.keyboard.press("Escape");
      await share.waitFor({ state: "detached" });
    }
    assert.equal(await page.evaluate(() => window.__ROSTER__.reads()), 1, "two Share opens make one roster request");

    for (const surface of ["members", "participants", "header"]) {
      await page.evaluate(surface => window.__ROSTER__.show(surface), surface);
      const opened = await openProfile();
      await shot(`${surface}-profile`);
      await closeProfile(opened);
    }
    assert.equal(await page.evaluate(() => window.__ROSTER__.reads()), 1, "every avatar surface reuses the same roster");

    await page.evaluate(() => window.__ROSTER__.show("members"));
    await page.getByRole("button", { name: "Actions for Ada Lovelace" }).click();
    await page.getByRole("menuitem", { name: "View profile", exact: true }).click();
    await page.getByRole("dialog", { name: "Profile of Ada Lovelace" }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Actions for Ada Lovelace" }).click();
    await page.getByRole("menuitem", { name: "Copy user info", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "User info copied." }).waitFor();
    assert.equal(await page.evaluate(() => window.__ROSTER__.copied.at(-1)), "Name: Ada Lovelace\nEmail: ada@example.test\nUser ID: member-1");
    await shot("members-copy");
    await page.evaluate(() => window.__ROSTER__.removeGrace());
    await page.getByRole("button", { name: "Refresh members" }).click();
    await page.getByRole("listitem", { name: "grace@example.test" }).waitFor({ state: "detached" });
    assert.ok(!(await page.evaluate(() => window.__ROSTER__.cached())).some(roster => roster.members.some(member => member.userId === "member-2")), "refresh removes departed member from cache");

    await openProfile();
    await page.evaluate(() => window.__ROSTER__.setFlag(false));
    await page.getByRole("dialog", { name: "Profile of Ada Lovelace" }).waitFor({ state: "detached" });
    assert.equal(await page.getByRole("button", { name: /^View profile:/ }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Actions for Ada Lovelace" }).count(), 0);
    assert.deepEqual(await page.evaluate(() => window.__ROSTER__.cached()), []);
    await page.evaluate(() => window.__ROSTER__.setFlag(true));
    await openProfile();
    await page.evaluate(() => window.__ROSTER__.setPrivacy(true));
    await page.getByRole("dialog", { name: "Profile of Ada Lovelace" }).waitFor({ state: "detached" });
    assert.equal(await page.locator('img[src^="https://avatars.example.test/"]').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.__ROSTER__.cached()), []);
    await page.evaluate(() => window.__ROSTER__.setPrivacy(false));
    await openProfile();
    assert.deepEqual(errors, [], "no browser errors");
    console.log(`ok ${mode}: all four avatar surfaces, keyboard/focus, copy toast, cache reuse/removal, rollout and privacy kills`);
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
