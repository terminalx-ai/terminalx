#!/usr/bin/env node
// PRO-133/137: team presence, Following and reassign over the built app
// (`pnpm build` first). Never enables native production transport.
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
// The minimum window is 760px and zoom is capped at 2, so 380 CSS px is the narrowest real width.
const WIDTHS = [1360, 390, 380];
// At 390 and 380 the open sidebar (268px) leaves the main view about 120px: narrower than any single
// control, in the authored layout as much as today's. The narrow passes therefore
// measure the main view with the sidebar hidden, as a narrow window is used, and
// show it again for every step that reads or drives the sidebar.
const narrow = (page) => page.viewportSize().width < 760;
async function sidebarShown(page, shown) {
  if (!narrow(page)) return;
  const rail = page.locator('[data-testid="sidebar-rail"]');
  const show = page.locator("main header").getByRole("button", { name: "Show sidebar", exact: true });
  if (shown) {
    if (await rail.count() === 0) await show.click();
    await rail.waitFor();
  } else {
    if (await rail.count()) await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
    await show.waitFor();
    // The toggle changes before the closing animation gives the sidebar's width back.
    await page.locator('[data-testid="panel-presence"][data-side="left"]').waitFor({ state: "detached" });
  }
}
// PRO-385: Table/Board moved from the header into the Display menu (02.15).
// The choice is saved, so a second visit may already show the table.
async function showTable(page) {
  await page.getByRole("button", { name: "Display", exact: true }).click();
  await page.getByRole("menu").getByRole("button", { name: "Table", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("table", { name: "Sessions" }).waitFor();
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
  }, { expected, ordered }).catch(async (error) => {
    console.error("Rows diagnostic", { expected, ordered, actual: await titles(page) });
    throw error;
  });
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
  await page.getByRole("button", { name: /^Overview/ }).click();
  await sidebarShown(page, false);
  // PRO-385: a toolbar row replaced the "Agents" heading; its search field marks the Overview.
  await page.getByRole("textbox", { name: "Search sessions" }).waitFor();
  await showTable(page);
  await sameRows(page, names);
  await viewCounts(page, { Everyone: 4, Mine: 2, "Shared with me": 1, Following: 1, "Active now": 1 });
  return page;
}
async function reassign(page) {
  await sidebarShown(page, true);
  const trigger = page.getByRole("button", { name: "Actions for Owned workspace", exact: true });
  await trigger.scrollIntoViewIfNeeded();
  // A row's actions (RowActions) stay visually hidden until the row itself is hovered.
  await trigger.locator('xpath=ancestor::*[contains(concat(" ", @class, " "), " group/row ")][1]').hover();
  const panel = await menu(page, trigger);
  await panel.getByRole("menuitem", { name: "Reassign to…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Reassign Owned workspace", exact: true });
  await dialog.waitFor();
  await reachable(dialog, "reassign dialog");
  return dialog;
}

try {
  for (const width of WIDTHS) {
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

      panel = await menu(page, page.getByRole("button", { name: /^Filter(?:, \d+ on)?$/ }));
      await panel.getByRole("menuitemcheckbox", { name: "Working", exact: true }).click();
      await page.keyboard.press("Escape");
      await sameRows(page, ["Organization task"]);
      await viewCounts(page, { Everyone: 1, Mine: 0, "Shared with me": 0, Following: 0, "Active now": 0 });
      panel = await menu(page, page.getByRole("button", { name: /^Filter(?:, \d+ on)?$/ }));
      await panel.getByRole("menuitem", { name: /Clear filters/ }).click();
      await sameRows(page, names);

      for (const [label, order] of [
        ["Owner", ["Shared task", "Organization task", "Owned task", "Local task"]],
        ["Status", ["Owned task", "Organization task", "Shared task", "Local task"]],
        ["Last active", ["Shared task", "Local task", "Owned task", "Organization task"]],
      ]) {
        // PRO-385: the sort chip picks the column and the direction apart, and the
        // Last active column is headed "Active".
        panel = await menu(page, page.getByRole("button", { name: /^Sort: / }));
        await panel.getByRole("menuitemradio", { name: label, exact: true }).click();
        panel = await menu(page, page.getByRole("button", { name: `Sort: ${label}`, exact: true }));
        await panel.getByRole("menuitemradio", { name: label === "Last active" ? "Descending" : "Ascending", exact: true }).click();
        await sameRows(page, order, true);
        const header = page.getByRole("columnheader", { name: label === "Last active" ? "Active" : label, exact: true });
        assert.equal(await header.getAttribute("aria-sort"), label === "Last active" ? "descending" : "ascending");
        await reachable(header.getByRole("button"), `${label}: horizontal scroll reaches sort header`);
        await header.getByRole("button").focus();
        await page.keyboard.press("Enter");
        assert.equal(await header.getAttribute("aria-sort"), label === "Last active" ? "ascending" : "descending");
        // Unknown activity stays last in both directions, and gets no invented time.
        if (label === "Last active") {
          await sameRows(page, ["Owned task", "Local task", "Shared task", "Organization task"], true);
          // PRO-385 hides Created by default: show it to count the row's times, then put it back.
          for (const shown of [true, false]) {
            panel = await menu(page, page.getByRole("button", { name: "Display", exact: true }));
            await panel.getByRole("menuitemcheckbox", { name: "Created", exact: true }).click();
            await page.keyboard.press("Escape");
            await page.getByRole("columnheader", { name: "Created", exact: true }).waitFor({ state: shown ? "attached" : "detached" });
            if (shown) assert.equal(await rows(page).filter({ hasText: "Organization task" }).locator("time").count(), 1, "only genuine created time, no last-active time");
          }
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
      await sidebarShown(page, true);
      const following = page.getByRole("region", { name: "Following", exact: true });
      await reachable(following, "Following sidebar section");
      assert.equal(await following.getByRole("button", { name: "Organization workspace", exact: true }).count(), 0);
      assert.match(await page.getByTestId("cloud-org-list").textContent(), /cloud · 1 online/, "org count deduplicates people, not devices or local sessions");
      await sidebarShown(page, false);

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

  for (const width of WIDTHS) {
    const page = await fresh(width);
    try {
      await sidebarShown(page, true);
      const following = page.getByRole("region", { name: "Following", exact: true });
      await following.getByRole("button", { name: "Shared workspace", exact: true }).click();
      await sidebarShown(page, false);
      const unfollow = page.getByRole("button", { name: "Following", exact: true });
      await reachable(unfollow, "Following header control");
      assert.equal(await unfollow.getAttribute("aria-pressed"), "true");
      await unfollow.click();
      const follow = page.getByRole("button", { name: "Follow", exact: true });
      await follow.waitFor();
      // The sidebar is on screen whenever its Following section is counted.
      await sidebarShown(page, true);
      await sidebar(page);
      assert.equal(await following.count(), 0, "unfollow removed authorized sidebar row");
      await sidebarShown(page, false);
      await follow.click();
      await page.waitForFunction(() => !!window.__PW_TEAM__.followPending);
      assert.equal(await follow.isDisabled(), true);
      await sidebarShown(page, true);
      await sidebar(page);
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
      // The fenced dialog drops the workspace's name from its title too, so it is no longer "Reassign Owned workspace".
      const fenced = page.getByRole("dialog", { name: "Reassign workspace", exact: true });
      await fenced.getByText("The account changed. Close and reopen this dialog.", { exact: true }).waitFor();
      assert.equal(await dialog.count(), 0, "the named dialog is gone");
      assert.equal(await page.getByRole("dialog").count(), 1, "the same dialog, fenced");
      assert.equal(await fenced.getByRole("textbox").count(), 0);
      assert.doesNotMatch(await fenced.textContent(), /Private handover note|Owned workspace|Bob/);
      // The footer's Close, not the dialog's corner button of the same name.
      await fenced.getByRole("button", { name: "Close", exact: true }).filter({ hasText: "Close" }).click();
      await fenced.waitFor({ state: "detached" });
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
    await success.evaluate(() => {
      const fixture = window.__PW_TEAM__;
      fixture.refusal = null;
      const answers = window.__PW_STUB__.answers;
      const reassign = answers.cloud_workspace_reassign;
      answers.cloud_workspace_reassign = (args) => new Promise((resolve) => {
        fixture.finishReassignment = () => resolve(reassign(args));
      });
    });
    const confirmation = success.getByRole("status").filter({ hasText: "Reassigned Owned workspace to Bob" });
    await dialog.getByRole("button", { name: "Reassign", exact: true }).click();
    await success.waitForFunction(() => !!window.__PW_TEAM__.finishReassignment);
    assert.equal(await dialog.getByRole("button", { name: "Reassigning…", exact: true }).isDisabled(), true);
    assert.equal(await confirmation.count(), 0, "no sender feedback before the server confirms");
    await success.evaluate(() => window.__PW_TEAM__.finishReassignment());
    await dialog.waitFor({ state: "detached" });
    await confirmation.waitFor();
    await reachable(confirmation, "confirmed sender feedback");
    await success.getByRole("button", { name: "Dismiss reassignment confirmation", exact: true }).click();
    await confirmation.waitFor({ state: "detached" });
    const following = success.getByRole("region", { name: "Following", exact: true });
    await following.getByRole("button", { name: "Owned workspace", exact: true }).waitFor();
    await success.getByRole("button", { name: /^Overview/ }).click();
    await sidebarShown(success, false);
    await showTable(success);
    await rows(success).filter({ hasText: "Owned task" }).getByRole("button", { name: "View profile: Bob", exact: true }).waitFor();
    assert.equal(await success.getByRole("button", { name: "Dismiss reassignment", exact: true }).count(), 0, "previous owner receives no target notice");
  } finally { await success.close(); }

  const privatePage = await fresh(390, { privateWorkspace: true });
  try {
    const dialog = await reassign(privatePage);
    assert.equal(await dialog.getByRole("radio").count(), 0);
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
