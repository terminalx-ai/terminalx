#!/usr/bin/env node
// Run after pnpm build. Covers a secret host dialog and a scoped guest screen.
// The host opens the session from its conversation row (the chat-first sidebar,
// #484); the Share button is in the session's header.
import { launch, open, openConversation, report, serve } from "./harness.mjs";

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  const host = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true, localSharing: "host" }, { width: 1280, height: 760 });
  await openConversation(host, "Local long session");
  await host.getByRole("button", { name: "Share session…" }).click();
  // A first-time host sees the introduction before the link settings (#852).
  await host.getByTestId("share-intro").waitFor();
  failed += report("sharing introduction", {
    "the risk notice is visible": await host.getByTestId("share-terms").getByText("A driver can act", { exact: true }).isVisible()
      && await host.getByTestId("share-terms").getByText(/can have the agent change files and run commands on this computer/).isVisible(),
  });
  await host.getByRole("button", { name: "Continue", exact: true }).click();
  // PRO-390: every setting is in view, none folded under More settings.
  failed += report("host sharing settings", {
    "approval is an explicit unchecked grant": await host.getByRole("switch", { name: "Guests may approve permissions" }).getAttribute("aria-checked") === "false",
    "nothing is folded away": await host.getByRole("button", { name: "More settings" }).count() === 0,
  });
  await host.getByRole("button", { name: "Create share link" }).click();
  await host.getByLabel("Secret share link").waitFor();
  await host.getByAltText("Secret share link QR code").waitFor();
  failed += report("host sharing", {
    "the QR code is shown with the link": await host.getByAltText("Secret share link QR code").isVisible(),
    "the link offers Copy link and Revoke only": await host.getByTestId("share-link").getByRole("button").allTextContents().then((names) => names.join("|") === "Copy link|Revoke"),
  });
  await host.screenshot({ path: "/tmp/terminalx-sharing-host.png" });
  await host.close();

  // PRO-390: the designed two-column dialog at 1440×900, dark and light, with someone waiting and someone let in.
  for (const mode of ["dark", "light"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true, localSharing: "host" }, { width: 1440, height: 900 }, {
      extra: `localStorage.setItem("raccoon.mode", ${JSON.stringify(mode)}); localStorage.setItem("raccoon.prefs", JSON.stringify({ shareOnboarded: true }));`,
    });
    await openConversation(page, "Local long session");
    await page.getByRole("button", { name: "Share session…" }).click();
    const intro = page.getByRole("button", { name: "Continue", exact: true });
    if (await intro.isVisible().catch(() => false)) await intro.click();
    await page.getByRole("radio", { name: "4 hours", exact: true }).click();
    await page.getByLabel("Maximum people").fill("5");
    await page.getByRole("button", { name: "Create share link" }).click();
    await page.getByAltText("Secret share link QR code").waitFor();
    await page.evaluate(() => window.__PW_SHARE_HOST_PEOPLE__());
    await page.getByRole("button", { name: "Let in" }).waitFor();
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
    const m = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const r = (el) => el.getBoundingClientRect();
      const qr = document.querySelector('img[alt="Secret share link QR code"]').parentElement;
      const settings = document.querySelector('[data-testid="share-settings"]');
      const link = document.querySelector('[data-testid="share-link"]');
      const buttons = [...dialog.querySelectorAll("button, select, input, [role=switch]")].filter((el) => r(el).width > 0);
      const overlaps = [];
      for (let a = 0; a < buttons.length; a++) for (let b = a + 1; b < buttons.length; b++) {
        const one = r(buttons[a]), two = r(buttons[b]);
        if (buttons[a].contains(buttons[b]) || buttons[b].contains(buttons[a])) continue;
        if (one.left < two.right - 1 && two.left < one.right - 1 && one.top < two.bottom - 1 && two.top < one.bottom - 1) overlaps.push([buttons[a].textContent, buttons[b].textContent]);
      }
      return {
        dialog: { width: r(dialog).width, top: r(dialog).top, bottom: r(dialog).bottom, scrolls: dialog.scrollHeight > dialog.clientHeight + 1 || dialog.scrollWidth > dialog.clientWidth + 1 },
        qr: r(qr).width,
        beside: r(link).left >= r(settings).right && Math.abs(r(link).top - r(settings).top) < 60,
        header: dialog.querySelector("h2")?.textContent,
        people: [...dialog.querySelectorAll('[data-testid="share-person"]')].map((row) => row.textContent),
        footer: dialog.querySelector("footer")?.textContent,
        button: document.querySelector('[aria-label="Share session…"]').textContent,
        checked: document.querySelector('[role=radiogroup][aria-label="Link expires"] [aria-checked=true]')?.textContent,
        overlaps,
      };
    });
    await page.screenshot({ path: `/tmp/terminalx-sharing-dialog-${mode}.png` });
    failed += report(`share dialog, ${mode}, 1440×900`, {
      "about 760 px wide, two columns, the link beside the settings": Math.abs(m.dialog.width - 760) < 1 && m.beside,
      "it does not scroll and fits the window": !m.dialog.scrolls && m.dialog.top >= 0 && m.dialog.bottom <= 900,
      "a 180 px QR code": Math.abs(m.qr - 180) < 1,
      "titled Share session": m.header === "Share session",
      "the made link shows its 4 hours": m.checked === "4 hours",
      "people rows: the waiting one asks for access, the other shows devices": m.people.length === 2 && m.people[0].includes("Waiting for approval · asked for") && m.people[1].includes("2 devices"),
      "one footer bar with the notes hint and Stop sharing": /Notes to people stay separate from the agent.*Stop sharing/.test(m.footer ?? ""),
      "the header button reads Share with the waiting count": m.button === "Share· 1 waiting",
      "no control overlaps another": m.overlaps.length === 0,
    }, m);
    await page.close();
  }

  const guest = await open(browser, server.url, { cloud: false, localProjects: 0, localSharing: "guest" }, { width: 1280, height: 760 });
  await guest.getByRole("heading", { name: "Shared local session" }).waitFor();
  await guest.waitForFunction(() => window.__PW_SHARE_CALLS__.some((request) => request.method === "session.tail"));
  await guest.screenshot({ path: "/tmp/terminalx-sharing-guest-debug.png" });
  await guest.getByText("Run the tests", { exact: false }).waitFor();
  await guest.getByLabel("Prompt to agent").fill("Check the build");
  await guest.getByRole("button", { name: "Send", exact: true }).click();
  await guest.waitForFunction(() => window.__PW_SHARE_CALLS__.some((request) => request.method === "session.send"));
  failed += report("guest sharing", {
    "the transcript names the verified sender": await guest.locator('[data-user-id="guest"]').isVisible(),
    "all RPCs stay bound to the invitation": await guest.evaluate(() => window.__PW_SHARE_CALLS__.every((request) => request.params.sessionId === "invited-session")),
  });
  await guest.evaluate(() => window.__PW_SHARE_VIEWER__());
  await guest.waitForFunction(() => document.querySelector('[aria-label="Prompt to agent"]').disabled);
  failed += report("live demotion", {
    "the agent composer is disabled": await guest.getByLabel("Prompt to agent").isDisabled(),
    "notes remain available": await guest.getByLabel("Note to people").isEnabled(),
  });
  await guest.screenshot({ path: "/tmp/terminalx-sharing-guest.png" });
  await guest.close();
} finally {
  await browser.close();
  server.close();
}
process.exitCode = failed ? 1 : 0;
