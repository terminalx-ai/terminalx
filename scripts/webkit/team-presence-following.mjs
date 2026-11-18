#!/usr/bin/env node
// SOURCE AUTHORED / UNRUN: needs the root's CURRENT 27-file PRO-133/137 UI
// prerequisite in dist/. Never enables native production transport.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { launch, serve, sidebar } from "./harness.mjs";

const fixture = (await Promise.all(["tauri-stub.js", "cloud-runtime-stub.js", "local-sharing-stub.js", "dashboard-stub.js"].map((file) => readFile(new URL(file, import.meta.url), "utf8")))).join("\n");
const server = await serve();
const browser = await launch();
const names = ["Local task", "Owned task", "Shared task", "Organization task"];
const rows = (page) => page.getByRole("table", { name: "Sessions" }).locator("tbody tr[data-session]");
const titles = (page) => rows(page).locator("[data-session-title]").allTextContents();

// Measure every clipping ancestor after animations finish. scrollIntoView may
// expose a table header horizontally; it must never make a clipped menu pass.
async function reachable(locator, why) {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {}))));
  const measured = await locator.evaluate((el) => {
    const box = el.getBoundingClientRect();
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p), r = p.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(s.overflowX)) { left = Math.max(left, r.left); right = Math.min(right, r.right); }
      if (/auto|scroll|hidden|clip/.test(s.overflowY)) { top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom); }
    }
    const x = Math.max(left, box.left) + Math.min(box.width, right - Math.max(left, box.left)) / 2;
    const y = Math.max(top, box.top) + Math.min(box.height, bottom - Math.max(top, box.top)) / 2;
    const hit = document.elementFromPoint(x, y);
    return { fits: box.width > 0 && box.height > 0 && box.left >= left - 1 && box.right <= right + 1 && box.top >= top - 1 && box.bottom <= bottom + 1,
      hit: !!hit && (hit === el || el.contains(hit)), box: { x: box.x, y: box.y, width: box.width, height: box.height }, clip: { left, right, top, bottom } };
  });
  assert.ok(measured.fits && measured.hit, `${why}: ${JSON.stringify(measured)}`);
}
async function menu(page, trigger) {
  await reachable(trigger, "menu trigger");
  await trigger.click();
  const panel = page.getByRole("menu");
  await panel.waitFor();
  await reachable(panel, "open menu fits viewport and clipping ancestors");
  return panel;
}
async function sameRows(page, expected, ordered = false) {
  await page.waitForFunction(({ expected, ordered }) => {
    const actual = [...document.querySelectorAll('table[aria-label="Sessions"] tbody tr[data-session] [data-session-title]')].map((el) => el.textContent);
    return JSON.stringify(ordered ? actual : actual.sort()) === JSON.stringify(ordered ? expected : [...expected].sort());
  }, { expected, ordered });
  const actual = await titles(page);
  assert.deepEqual(ordered ? actual : actual.sort(), ordered ? expected : [...expected].sort());
}
async function viewCounts(page, counts) {
  const views = page.getByRole("navigation", { name: "Views", exact: true });
  for (const [name, count] of Object.entries(counts)) {
    const button = views.getByRole("button", { name: new RegExp(`^${name}\\s*${count}$`) });
    try { await button.waitFor(); }
    catch (error) {
      console.error("Views diagnostic", { expected: `${name} ${count}`, actual: await views.innerText(), aria: await views.ariaSnapshot(),
        fixture: await page.evaluate(() => ({ viewer: window.__PW_TEAM__?.viewer, calls: window.__PW_TEAM__?.calls })) });
      throw error;
    }
    assert.equal(await button.isEnabled(), true, `${name}: supported authorized projection`);
    await reachable(button, `${name}: view is usable`);
  }
}
async function chooseView(page, name, expected) {
  const button = page.getByRole("navigation", { name: "Views", exact: true }).getByRole("button", { name: new RegExp(`^${name}\\s*\\d+$`) });
  await button.click();
  assert.equal(await button.getAttribute("aria-pressed"), "true");
  await sameRows(page, expected);
}
async function fresh(width, options = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  if (process.env.WEBKIT_TIMEOUT_MS) page.setDefaultTimeout(Number(process.env.WEBKIT_TIMEOUT_MS));
  // Block before navigation, so startup and avatar requests are also local only.
  await page.route("**/*", (route) => new URL(route.request().url()).origin === new URL(server.url).origin ? route.continue() : route.abort());
  await page.addInitScript(`window.__PW_FIXTURE__ = ${JSON.stringify({ cloud: true, localProjects: 1, dashboardCount: 0, teamOverview: true, ...options })};\n${fixture}`);
  await page.goto(server.url);
  await sidebar(page);
  await page.getByRole("button", { name: /^Dashboard/ }).click();
  await page.getByRole("heading", { name: "Agents", exact: true }).waitFor();
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await sameRows(page, names);
  await viewCounts(page, { Everyone: 4, Mine: 2, "Shared with me": 1, Following: 1, "Active now": 1 });
  return page;
}
async function reassign(page) {
  const trigger = page.getByRole("button", { name: "Actions for Owned workspace", exact: true });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.locator("..").hover();
  const panel = await menu(page, trigger);
  await panel.getByRole("menuitem", { name: "Reassign to…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Reassign Owned workspace", exact: true });
  await dialog.waitFor();
  await reachable(dialog, "reassign dialog");
  return dialog;
}

try {
  for (const width of [1360, 390, 320]) {
    const page = await fresh(width);
    try {
      await chooseView(page, "Mine", ["Local task", "Owned task"]);
      await chooseView(page, "Shared with me", ["Shared task"]);
      await chooseView(page, "Following", ["Shared task"]);
      await chooseView(page, "Active now", ["Shared task"]);
      await chooseView(page, "Everyone", names);
      let panel = await menu(page, page.getByRole("button", { name: "By Anyone", exact: true }));
      await panel.getByRole("textbox", { name: "Filter people", exact: true }).fill("Bob");
      assert.equal(await panel.getByRole("menuitemcheckbox").count(), 1, "By search narrows real people");
      await panel.getByRole("menuitemcheckbox", { name: "Bob", exact: true }).click();
      await panel.getByRole("textbox", { name: "Filter people", exact: true }).fill("");
      await panel.getByRole("menuitemcheckbox", { name: "You", exact: true }).click();
      assert.equal(await panel.getByRole("menuitemcheckbox", { name: "Bob", exact: true }).getAttribute("aria-checked"), "true");
      assert.equal(await panel.getByRole("menuitemcheckbox", { name: "You", exact: true }).getAttribute("aria-checked"), "true");
      await page.keyboard.press("Escape");
      await sameRows(page, ["Local task", "Owned task", "Shared task"]);
      await viewCounts(page, { Everyone: 3, Mine: 2, "Shared with me": 1, Following: 1, "Active now": 1 });
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("terminalx.overview.by.v1:account-a:org-a"))), ["u-bob", "u-me"]);
      panel = await menu(page, page.getByRole("button", { name: "By 2 people", exact: true }));
      await panel.getByRole("menuitem", { name: "Anyone", exact: true }).click();
      await sameRows(page, names);
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("terminalx.overview.by.v1:account-a:org-a"))), []);
      await page.getByRole("textbox", { name: "Search sessions" }).fill("Shared task");
      await viewCounts(page, { Everyone: 1, Mine: 0, "Shared with me": 1, Following: 1, "Active now": 1 });
      await sameRows(page, ["Shared task"]);
      await page.getByRole("button", { name: "Clear search", exact: true }).click();

      panel = await menu(page, page.getByRole("button", { name: /^Filter(?:\s*\d+)?$/ }));
      await panel.getByRole("menuitemcheckbox", { name: "Working", exact: true }).click();
      await page.keyboard.press("Escape");
      await sameRows(page, ["Organization task"]);
      await viewCounts(page, { Everyone: 1, Mine: 0, "Shared with me": 0, Following: 0, "Active now": 0 });
      panel = await menu(page, page.getByRole("button", { name: /^Filter(?:\s*\d+)?$/ }));
      await panel.getByRole("menuitem", { name: /Clear filters/ }).click();
      await sameRows(page, names);

      for (const [label, order] of [
        ["Owner", ["Shared task", "Organization task", "Owned task", "Local task"]],
        ["Status", ["Owned task", "Organization task", "Shared task", "Local task"]],
        ["Last active", ["Shared task", "Local task", "Owned task", "Organization task"]],
      ]) {
        panel = await menu(page, page.getByRole("button", { name: /^Sort: / }));
        await panel.getByRole("menuitem", { name: label, exact: true }).click();
        await sameRows(page, order, true);
        const header = page.getByRole("columnheader", { name: label, exact: true });
        assert.equal(await header.getAttribute("aria-sort"), label === "Last active" ? "descending" : "ascending");
        await reachable(header.getByRole("button"), `${label}: horizontal scroll reaches sort header`);
        await header.getByRole("button").focus();
        await page.keyboard.press("Enter");
        assert.equal(await header.getAttribute("aria-sort"), label === "Last active" ? "ascending" : "descending");
        // Unknown activity stays last in both directions, and gets no invented time.
        if (label === "Last active") {
          await sameRows(page, ["Owned task", "Local task", "Shared task", "Organization task"], true);
          assert.equal(await rows(page).filter({ hasText: "Organization task" }).locator("time").count(), 1, "only genuine created time, no last-active time");
        }
      }
      panel = await menu(page, page.getByRole("button", { name: "Display", exact: true }));
      await panel.getByRole("menuitemcheckbox", { name: "Owner", exact: true }).click();
      await page.keyboard.press("Escape");
      assert.equal(await page.getByRole("columnheader", { name: "Owner", exact: true }).count(), 0);
      panel = await menu(page, page.getByRole("button", { name: "Display", exact: true }));
      assert.equal(await panel.getByRole("menuitemcheckbox", { name: "Owner", exact: true }).getAttribute("aria-checked"), "false");
      await panel.getByRole("menuitemcheckbox", { name: "Owner", exact: true }).click();
      await page.keyboard.press("Escape");
      await page.getByRole("columnheader", { name: "Owner", exact: true }).waitFor();

      const faces = page.locator('main header [aria-label="Active now"]');
      assert.equal(await faces.getByRole("button", { name: "View profile: Bob", exact: true }).count(), 1, "deduplicated aggregate avatar");
      await reachable(faces, "active avatars remain in header");
      await faces.getByRole("button", { name: "View profile: Bob", exact: true }).click();
      const profile = page.getByRole("dialog", { name: "Profile of Bob", exact: true });
      await profile.waitFor();
      await reachable(profile, "profile popover");
      assert.equal(await profile.getByTestId("profile-presence").getAttribute("aria-label"), "Online");
      assert.doesNotMatch(await profile.textContent(), /last seen|\d+\s*(seconds?|minutes?|hours?) ago/i);
      await page.keyboard.press("Escape");
      const following = page.getByRole("region", { name: "Following", exact: true });
      await reachable(following, "Following sidebar section");
      assert.equal(await following.getByRole("button", { name: "Organization workspace", exact: true }).count(), 0);
      assert.match(await page.getByTestId("cloud-org-list").textContent(), /cloud · 1 online/, "org count deduplicates people, not devices or local sessions");

      // Successful empty reads mean expired/offline. Failed reads are unavailable.
      for (const mode of ["expired", "unavailable"]) {
        await page.evaluate((mode) => { window.__PW_TEAM__.presence = mode; window.__PW_TEAM__.event("workspace.presence-changed"); }, mode);
        if (mode === "expired") {
          await viewCounts(page, { Everyone: 4, Mine: 2, "Shared with me": 1, Following: 1, "Active now": 0 });
          await page.getByText("No one online", { exact: true }).first().waitFor();
        } else {
          const active = page.getByRole("navigation", { name: "Views", exact: true }).getByRole("button", { name: /^Active now\s*—$/ });
          await active.waitFor();
          assert.equal(await active.isDisabled(), true);
          await page.getByText("Presence unavailable", { exact: true }).first().waitFor();
        }
        const owner = rows(page).filter({ hasText: "Shared task" }).getByRole("button", { name: "View profile: Bob", exact: true });
        await owner.scrollIntoViewIfNeeded();
        await owner.click();
        await profile.waitFor();
        assert.equal(await profile.getByTestId("profile-presence").getAttribute("aria-label"), mode === "expired" ? "Offline" : "Presence unavailable");
        assert.doesNotMatch(await profile.textContent(), /last seen|\d+\s*(seconds?|minutes?|hours?) ago/i);
        await page.keyboard.press("Escape");
      }
      console.log(`ok team overview ${width}px: authorized rows/counts, By, sort/Display, avatars and presence states`);
    } finally { await page.close(); }
  }

  for (const width of [1360, 390, 320]) {
    const page = await fresh(width);
    try {
      const following = page.getByRole("region", { name: "Following", exact: true });
      await following.getByRole("button", { name: "Shared workspace", exact: true }).click();
      const unfollow = page.getByRole("button", { name: "Following", exact: true });
      await reachable(unfollow, "Following header control");
      assert.equal(await unfollow.getAttribute("aria-pressed"), "true");
      await unfollow.click();
      const follow = page.getByRole("button", { name: "Follow", exact: true });
      await follow.waitFor();
      assert.equal(await following.count(), 0, "unfollow removed authorized sidebar row");
      await follow.click();
      await page.waitForFunction(() => !!window.__PW_TEAM__.followPending);
      assert.equal(await follow.isDisabled(), true);
      assert.equal(await following.count(), 0, "pending preference is not optimistic access");
      await page.evaluate(() => window.__PW_TEAM__.followPending());
      await unfollow.waitFor();
      await following.getByRole("button", { name: "Shared workspace", exact: true }).waitFor();

      const dialog = await reassign(page);
      const search = dialog.getByRole("textbox", { name: "Find a teammate", exact: true });
      await search.fill("nobody matches");
      assert.equal(await dialog.getByRole("radio").count(), 0);
      assert.equal(await dialog.getByRole("button", { name: "Reassign", exact: true }).isDisabled(), true);
      await search.fill("Bob");
      await dialog.getByRole("radio").waitFor();
      assert.equal(await dialog.getByRole("radio").count(), 1);
      await dialog.getByRole("radio").check();
      await dialog.getByRole("textbox", { name: "Note to the new owner", exact: true }).fill("Private handover note & plain text");
      await reachable(dialog.getByRole("button", { name: "Reassign", exact: true }), "reassign submit");
      await dialog.getByRole("button", { name: "Reassign", exact: true }).click();
      await dialog.getByRole("alert").filter({ hasText: "Work is running." }).waitFor();
      const attempts = () => page.evaluate(() => window.__PW_TEAM__.calls.filter((c) => c.command === "cloud_workspace_reassign"));
      assert.equal((await attempts()).length, 1, "no automatic refusal retry");
      await dialog.getByRole("button", { name: "Retry same attempt", exact: true }).click();
      await dialog.getByRole("alert").waitFor();
      const calls = await attempts();
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0], calls[1], "explicit retry retains exact UUID/CAS/target/note");
      assert.match(calls[0].input.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.deepEqual({ ...calls[0].input, requestId: undefined }, { targetUserId: "u-bob", expectedOwnerId: "u-me", note: "Private handover note & plain text", requestId: undefined });
      await page.evaluate(() => window.__PW_TEAM__.switchAccount());
      await dialog.getByText("The account changed. Close and reopen this dialog.", { exact: true }).waitFor();
      assert.equal(await dialog.getByRole("textbox").count(), 0);
      assert.doesNotMatch(await dialog.textContent(), /Private handover note|Owned workspace|Bob/);
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      console.log(`ok team following/reassign ${width}px: header/sidebar, pending preference, search, refusal, retry and account fence`);
    } finally { await page.close(); }
  }

  const empty = await fresh(390, { emptyTeam: true });
  try {
    const dialog = await reassign(empty);
    await dialog.getByText(/No other teammates in Demo/).waitFor();
    await reachable(dialog.getByRole("button", { name: "Invite people", exact: true }), "empty-team invitation");
    assert.equal(await dialog.getByRole("radio").count(), 0);
    assert.equal(await dialog.getByRole("button", { name: "Reassign", exact: true }).isDisabled(), true);
  } finally { await empty.close(); }

  const success = await fresh(1360);
  try {
    const dialog = await reassign(success);
    await dialog.getByRole("textbox", { name: "Find a teammate", exact: true }).fill("Bob");
    await dialog.getByRole("radio").check();
    await dialog.getByRole("textbox", { name: "Note to the new owner", exact: true }).fill("Away until Monday");
    await success.evaluate(() => { window.__PW_TEAM__.refusal = null; });
    await dialog.getByRole("button", { name: "Reassign", exact: true }).click();
    await dialog.getByRole("status").filter({ hasText: "Reassignment recorded." }).waitFor();
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    const following = success.getByRole("region", { name: "Following", exact: true });
    await following.getByRole("button", { name: "Owned workspace", exact: true }).waitFor();
    await success.getByRole("button", { name: /^Dashboard/ }).click();
    await success.getByRole("button", { name: "Table", exact: true }).click();
    await rows(success).filter({ hasText: "Owned task" }).getByRole("button", { name: "View profile: Bob", exact: true }).waitFor();
    assert.equal(await success.getByRole("button", { name: "Dismiss reassignment", exact: true }).count(), 0, "previous owner receives no target notice");
  } finally { await success.close(); }

  const privatePage = await fresh(390, { privateWorkspace: true });
  try {
    const dialog = await reassign(privatePage);
    await dialog.getByRole("textbox", { name: "Find a teammate", exact: true }).fill("Bob");
    await dialog.getByRole("radio").check();
    await dialog.getByText("Private cross-owner handover is unavailable. Confirmation cannot grant a teammate access.", { exact: true }).waitFor();
    assert.equal(await dialog.getByRole("button", { name: "Reassign", exact: true }).isDisabled(), true);
    assert.equal(await privatePage.evaluate(() => window.__PW_TEAM__.calls.filter((c) => c.command === "cloud_workspace_reassign").length), 0);
  } finally { await privatePage.close(); }

  for (const recipient of ["other", "target-account", "target-privacy"]) {
    const target = recipient !== "other";
    const page = await fresh(390);
    try {
      await page.waitForFunction(() => !!window.__PW_TEAM__.inboxPending);
      await page.evaluate((target) => {
        const f = window.__PW_TEAM__;
        if (target) { f.rows[1].workspace.createdBy = "u-me"; f.rows[1].workspace.creator = f.roster[0]; }
        f.event("workspace.reassigned", { actorId: "u-cara", previousOwnerId: "u-bob", note: "Target-only note <b>literal</b>" });
      }, target);
      // Durable cursor proves the subscriber consumed the event, independent of notice rendering.
      await page.waitForFunction(() => Number(JSON.parse(localStorage.getItem("terminalx.inbox.v1:account-a") ?? "null")?.cursor) > 0);
      await page.waitForFunction(() => !!window.__PW_TEAM__.inboxPending);
      if (target) {
        const notice = page.getByRole("status").filter({ hasText: "reassigned to you Shared workspace" });
        await notice.waitFor();
        await reachable(notice, "target-only notice");
        assert.match(await notice.textContent(), /Target-only note <b>literal<\/b>/);
        assert.equal(await notice.locator("b").count(), 0, "note is text, never markup");
        if (recipient === "target-account") await page.evaluate(() => window.__PW_TEAM__.switchAccount());
        else await page.evaluate(() => {
          window.__PW_STUB__.answers.data_privacy_status = { enabled: true, managed: false };
          window.dispatchEvent(new Event("focus"));
        });
        await notice.waitFor({ state: "detached" });
        assert.equal(await page.getByText("Target-only note <b>literal</b>", { exact: true }).count(), 0);
      } else {
        assert.equal(await page.getByRole("button", { name: "Dismiss reassignment", exact: true }).count(), 0, "non-target cannot see private note");
        assert.equal(await page.getByText("Target-only note <b>literal</b>", { exact: true }).count(), 0);
      }
    } finally { await page.close(); }
  }
} finally {
  await browser.close();
  server.close();
}
