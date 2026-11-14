#!/usr/bin/env node
// pnpm build && node scripts/webkit/attention-approvals.mjs
// Real app notices and command approvals; native OS banners are recorded by the bridge.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launch, open, openConversation, serve, sidebar, tab } from "./harness.mjs";

const title = "TerminalX — Codex needs attention";
const extra = `
  const stub = window.__PW_STUB__;
  stub.answers.list_sessions.slice(1).forEach(s => s.tabs[0].harness = "codex");
  stub.answers.list_harnesses.push({ id: "codex", name: "Codex", available: true });
  window.__APPROVAL_ANSWERS__ = [];
  window.__NATIVE_NOTICES__ = [];
  stub.answers["plugin:notification|notify"] = args => window.__NATIVE_NOTICES__.push(args);
  stub.answers.respond_permission = args => {
    window.__APPROVAL_ANSWERS__.push(args);
    stub.emit("tab_status", { sessionId: args.sessionId, tabId: args.tabId, status: "completed" });
  };
`;
const painted = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const notices = page => page.getByText(title, { exact: true });
async function raise(page) {
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    for (let i = 0; i < 4; i++) {
      const tab = { sessionId: `many-s${i}`, tabId: `many-s${i}-t` };
      window.__PW_STUB__.emit("tab_status", { ...tab, status: "in_progress" });
      window.__PW_STUB__.emit("tab_status", { ...tab, status: "waiting" });
    }
  });
  await painted(page);
}
async function unobscured(locator, name) {
  const hits = await locator.evaluate(el => {
    const r = el.getBoundingClientRect();
    const points = [0.15, 0.5, 0.85].flatMap(x => [0.15, 0.5, 0.85].map(y => [r.left + r.width * x, r.top + r.height * y]));
    return {
      contained: r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
      clear: points.every(([x, y]) => el.contains(document.elementFromPoint(x, y))),
    };
  });
  assert.ok(hits.contained && hits.clear, `${name}: ${JSON.stringify(hits)}`);
}

const server = await serve();
const screenshots = process.env.WEBKIT_LAYOUT_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });
let browser;
try {
  browser = await launch();
  for (const [width, height, zoom] of [[1100, 800, 1], [760, 600, 1], [640, 480, 1], [760, 600, 1.5]]) {
    for (const order of ["approval-first", "notification-first"]) {
      const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true, localSessions: 4 }, { width, height }, { extra });
      page.setDefaultTimeout(10_000);
      await sidebar(page);
      await page.evaluate(zoom => {
        document.documentElement.style.zoom = String(zoom);
        document.documentElement.style.setProperty("--fs-base", "14.5px");
        document.documentElement.style.setProperty("--sidebar-w", "200px");
      }, zoom);
      if (order === "notification-first") {
        await raise(page);
        assert.equal(await notices(page).count(), 4);
      }
      await openConversation(page, "Local long session");
      await tab(page, "gemini tab").click();
      const allow = page.getByRole("button", { name: /^Allow/ }).filter({ visible: true });
      const deny = page.getByRole("button", { name: "Deny", exact: true }).filter({ visible: true });
      const detail = page.getByTestId("permission-detail").filter({ visible: true });
      await allow.waitFor();
      await allow.focus();
      await raise(page);
      await raise(page); // Repeated attention replaces each tab's notice.
      assert.equal(await notices(page).count(), 0, "notices defer while an approval is visible");
      assert.ok(await allow.evaluate(el => el === document.activeElement), "arrival keeps approval focus");
      await detail.scrollIntoViewIfNeeded();
      await unobscured(detail, "command text");
      await allow.scrollIntoViewIfNeeded();
      await unobscured(allow, "Allow button");
      await unobscured(deny, "Deny button");
      await page.keyboard.press(process.platform === "darwin" ? "Alt+Tab" : "Tab");
      assert.ok(await deny.evaluate(el => el === document.activeElement), `Tab reaches Deny: ${await page.evaluate(() => document.activeElement?.outerHTML)}`);
      await page.keyboard.press(process.platform === "darwin" ? "Alt+Shift+Tab" : "Shift+Tab");
      assert.ok(await allow.evaluate(el => el === document.activeElement), "Shift+Tab reaches Allow");
      const label = `${width}x${height}-${zoom}-${order}`;
      if (screenshots) await page.screenshot({ path: `${screenshots}/attention-${label}.png` });
      if (order === "approval-first") await allow.click({ position: { x: 8, y: 3 } });
      else await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.__APPROVAL_ANSWERS__.length === 1);
      await notices(page).first().waitFor();
      assert.equal(await notices(page).count(), 4, "retained notices appear after answering, with no duplicates");
      assert.equal(await page.evaluate(() => window.__APPROVAL_ANSWERS__[0].optionId), "allow");
      assert.deepEqual(await page.evaluate(() => window.__NATIVE_NOTICES__), [], "the focused app used in-app toasts");
      // The other, hidden tab still has a pending approval. It must not defer these.
      await notices(page).first().click();
      await tab(page, "Chat 0").waitFor();
      console.log(`ok ${label}: command and actions clear, focus and pointer/keyboard answers work, notices retained`);
      await page.close();
    }
  }

  // Shared guests render approvals through Chat, outside TabView and modal dialogs.
  const guestExtra = extra + `
    const guestEvents = [];
    const guestEvent = payload => ({ id: "guest-" + (guestEvents.length + 1), seq: guestEvents.length + 1,
      sessionId: "invited-session", tabId: "tab", harness: "claude", ts: new Date().toISOString(), payload });
    guestEvents.push(guestEvent({ type: "user_message", text: "Check the guest approval", queued: false }));
    const guestPush = payload => {
      const event = guestEvent(payload);
      guestEvents.push(event);
      stub.emit("session_guest_message", { connectionId: "connection", message: { method: "session.event", params: { event } } });
    };
    window.__PW_GUEST_ASK__ = () => guestPush({ type: "permission_requested", requestId: "guest-ask", toolName: "Bash",
      input: { command: "touch /tmp/guest-asked" }, options: [{ id: "allow", label: "Allow", kind: "allow_once" }, { id: "deny", label: "Deny", kind: "deny" }] });
    const originalGuestSend = stub.answers.session_guest_send;
    stub.answers.session_guest_send = args => {
      const { request } = args;
      const respond = result => {
        window.__PW_SHARE_CALLS__.push(request);
        queueMicrotask(() => stub.emit("session_guest_message", { connectionId: "connection", message: { id: request.id, ok: true, result } }));
      };
      if (request.method === "session.status") return respond({ admitted: true, you: { person: { userId: "guest" }, role: "driver", canApprove: true }, state: { active: true, people: [], leases: [], notes: [], queue: [], activity: [], links: [] } });
      if (request.method === "session.tail") return respond({ events: guestEvents, hasMore: false });
      if (request.method === "permission.respond") {
        respond({ accepted: true });
        guestPush({ type: "permission_decided", requestId: "guest-ask", allowed: true, label: "Allowed", automatic: false });
        return;
      }
      return originalGuestSend(args);
    };
  `;
  for (const [width, height, zoom] of [[760, 600, 1], [640, 480, 1], [760, 600, 1.5]]) {
    for (const order of ["approval-first", "notification-first"]) {
      const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true, localSessions: 4, localSharing: "guest" }, { width, height }, { extra: guestExtra });
      page.setDefaultTimeout(10_000);
      await page.getByText("Check the guest approval", { exact: true }).waitFor();
      await page.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); }, zoom);
      if (order === "notification-first") {
        await raise(page);
        assert.equal(await notices(page).count(), 4);
      }
      await page.evaluate(() => window.__PW_GUEST_ASK__());
      const allow = page.getByRole("button", { name: /^Allow/ }).filter({ visible: true });
      const deny = page.getByRole("button", { name: "Deny", exact: true }).filter({ visible: true });
      await allow.waitFor();
      await allow.focus();
      await raise(page);
      await raise(page);
      await allow.scrollIntoViewIfNeeded();
      await unobscured(allow, "guest Allow");
      await unobscured(deny, "guest Deny");
      assert.equal(await notices(page).count(), 0);
      assert.ok(await allow.evaluate(el => el === document.activeElement));
      await page.keyboard.press(process.platform === "darwin" ? "Alt+Tab" : "Tab");
      assert.ok(await deny.evaluate(el => el === document.activeElement));
      await page.keyboard.press(process.platform === "darwin" ? "Alt+Shift+Tab" : "Shift+Tab");
      if (order === "approval-first") await allow.click({ position: { x: 8, y: 3 } });
      else await page.keyboard.press("Enter");
      await notices(page).first().waitFor();
      assert.equal(await notices(page).count(), 4);
      assert.equal(await page.evaluate(() => window.__PW_SHARE_CALLS__.filter(call => call.method === "permission.respond").length), 1);
      console.log(`ok guest ${width}x${height}-${zoom}-${order}: controls clear, focus and answering work, notices resume`);
      await page.close();
    }
  }

  // Joining a guest session covers, but does not unmount, the selected local tab.
  // Its pending approval must only defer notices again once the guest leaves.
  {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true, localSessions: 4, localSharing: "guest" }, { width: 760, height: 600 }, { extra: guestExtra + `
      stub.answers.session_join_pending = null;
      window.__PW_JOIN_GUEST__ = () => {
        stub.answers.session_join_pending = "https://terminalx.ai/join#fixture";
        stub.emit("session_join_requested", null);
      };
    ` });
    page.setDefaultTimeout(10_000);
    await openConversation(page, "Local long session");
    await tab(page, "gemini tab").click();
    const localApproval = page.locator("main").getByRole("button", { name: /^Allow/ }).filter({ visible: true });
    await localApproval.waitFor();
    await raise(page);
    assert.equal(await notices(page).count(), 0);
    await page.evaluate(() => window.__PW_JOIN_GUEST__());
    const guest = page.getByRole("region", { name: "Shared session", exact: true });
    await guest.getByText("Check the guest approval", { exact: true }).waitFor();
    await painted(page);
    assert.equal(await notices(page).count(), 4, "the covered local approval must release its retained notices");
    await raise(page);
    assert.equal(await notices(page).count(), 4, "new attention remains visible in the foreground guest session");
    await page.evaluate(() => window.__PW_GUEST_ASK__());
    const guestAllow = guest.getByRole("button", { name: /^Allow/ });
    await guestAllow.waitFor();
    assert.equal(await notices(page).count(), 0, "the foreground guest approval defers notices");
    await unobscured(guestAllow, "foreground guest Allow");
    await guestAllow.click();
    await notices(page).first().waitFor();
    assert.equal(await notices(page).count(), 4);
    await guest.getByRole("button", { name: "Leave session" }).click();
    await guest.waitFor({ state: "detached" });
    assert.equal(await notices(page).count(), 0, "leaving restores protection for the still-pending local approval");
    await unobscured(localApproval, "restored local Allow");
    await localApproval.click();
    await notices(page).first().waitFor();
    assert.equal(await notices(page).count(), 4);
    console.log("ok guest foreground: covered local approval releases notices; guest decisions and restored local decisions defer them");
    await page.close();
  }

  // A real permission-mode confirmation exercises the shared modal surface separately.
  for (const order of ["approval-first", "notification-first"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true, localSessions: 4 }, { width: 760, height: 600 }, { extra: extra + `
      const load = stub.answers.load_tab_events;
      stub.answers.load_tab_events = args => load(args).filter(e => e.payload.type !== "permission_requested");
      stub.answers.list_sessions[0].tabs.forEach(t => t.status = "idle");
    ` });
    page.setDefaultTimeout(10_000);
    await openConversation(page, "Local long session");
    await tab(page, "gemini tab").click();
    if (order === "notification-first") {
      await raise(page);
      assert.equal(await notices(page).count(), 4);
    }
    await page.locator("main [data-composer-toolbar]").getByRole("button", { name: "More options" }).focus();
    await page.keyboard.press("Enter");
    await page.getByTestId("permission-mode").focus();
    await page.keyboard.press("ArrowRight");
    await page.getByRole("menuitemradio", { name: /Bypass permissions/ }).focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await page.evaluate(() => { document.documentElement.style.zoom = "1.5"; });
    const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
    await cancel.focus();
    await raise(page);
    assert.equal(await notices(page).count(), 0);
    assert.ok(await cancel.evaluate(el => el === document.activeElement));
    await cancel.scrollIntoViewIfNeeded();
    await unobscured(cancel, "confirmation Cancel");
    await unobscured(dialog.getByRole("button", { name: "Bypass permissions", exact: true }), "confirmation action");
    await page.keyboard.press(process.platform === "darwin" ? "Alt+Tab" : "Tab");
    assert.ok(await dialog.evaluate(el => el.contains(document.activeElement)), "focus stays inside the modal");
    await cancel.click();
    await notices(page).first().waitFor();
    assert.equal(await notices(page).count(), 4);
    console.log(`ok modal ${order}: confirmation controls clear, focus retained, notices resume`);
    await page.close();
  }
} finally {
  await browser?.close();
  server.close();
}
