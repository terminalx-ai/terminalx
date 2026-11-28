#!/usr/bin/env node
// PRO-375: Settings → Account and General in the desktop's WebKit, light and
// dark, 1440 wide. Account has an identity header with no box, flat rows with
// hairline dividers (the Mac's name an inline field), a Sign out row with an
// outlined button and no organization setup. Data privacy mode is on Account,
// not General; once an organisation manages it, it is a card whose switch
// reads as on and locked, not greyed out.
//
// Set ACCOUNT_SETTINGS_SHOTS to a directory to also save a picture of each case.
//
//   pnpm build && npx playwright install webkit && node scripts/webkit/account-settings.mjs
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve } from "./harness.mjs";

const shots = process.env.ACCOUNT_SETTINGS_SHOTS;
if (shots) await mkdir(shots, { recursive: true });
const cases = [
  { name: "account", section: "Account", privacy: { enabled: false, managed: false } },
  { name: "account-managed-privacy", section: "Account", privacy: { enabled: true, managed: true } },
  { name: "general", section: "General", privacy: { enabled: false, managed: false } },
];

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const mode of ["light", "dark"]) {
    for (const { name, section, privacy } of cases) {
      const page = await open(browser, server.url, { cloud: true, localProjects: 1, accountName: "Alex Kim" }, { width: 1440, height: 1000 }, {
        extra: `localStorage.setItem("raccoon.mode", ${JSON.stringify(mode)});
          (() => {
            const answers = window.__PW_STUB__.answers;
            answers.data_privacy_status = ${JSON.stringify(privacy)};
            answers.machine_name = { name: "Alex’s MacBook Pro", chosen: false, computerName: "Alex’s MacBook Pro" };
            answers.pairing_status = { relay: { phase: "off", message: null, attempt: 0 }, host: null, devices: [], activePairing: null, pendingApproval: null, keepAwake: true, lastError: null, accountListing: { state: "off" } };
            answers.work_status_settings = { shareWithTeam: true };
          })();`,
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const settings = page.getByRole("main", { name: "Settings", exact: true });
      await settings.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: section, exact: true }).click();
      await settings.getByRole("heading", { name: section, exact: true }).waitFor();
      if (section === "Account") {
        await settings.getByRole("switch", { name: "Data privacy mode" }).waitFor();
        if (!privacy.enabled) await page.waitForFunction(() => document.querySelector("[data-testid=machine-name]")?.value === "Alex’s MacBook Pro");
      }
      // Settings opens with a fade; spinners (infinite animations) never settle and are not waited for.
      await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running" || animation.effect?.getComputedTiming().iterations === Infinity));
      const layout = await settings.evaluate((root) => {
        const column = root.querySelector("section[aria-labelledby]");
        const controls = [...column.querySelectorAll("button, input, [role=switch]")].filter((element) => element.getBoundingClientRect().width > 0);
        const overlaps = [];
        for (let a = 0; a < controls.length; a++)
          for (let b = a + 1; b < controls.length; b++) {
            if (controls[a].contains(controls[b]) || controls[b].contains(controls[a])) continue;
            const one = controls[a].getBoundingClientRect();
            const two = controls[b].getBoundingClientRect();
            if (one.left < two.right - 1 && two.left < one.right - 1 && one.top < two.bottom - 1 && two.top < one.bottom - 1) overlaps.push([controls[a].textContent, controls[b].textContent]);
          }
        const opacity = (element) => {
          let value = 1;
          for (let node = element; node; node = node.parentElement) value *= Number(getComputedStyle(node).opacity);
          return value;
        };
        const privacySwitch = column.querySelector('[role=switch][aria-label="Data privacy mode"]');
        const identity = column.querySelector("[data-testid=account-identity]");
        const avatar = identity?.querySelector("span[aria-hidden]");
        const signOut = [...column.querySelectorAll("[data-testid=account-sign-out] button")].find((button) => button.textContent.trim() === "Sign out");
        const transparent = (color) => color === "rgba(0, 0, 0, 0)" || color === "transparent";
        const firstRow = column.querySelector("[data-setting-id]");
        return {
          overflow: root.scrollWidth > root.clientWidth + 1 || column.scrollWidth > column.clientWidth + 1,
          overlaps,
          text: column.textContent,
          firstRow: firstRow?.getAttribute("data-setting-id") ?? null,
          privacySwitch: privacySwitch ? { checked: privacySwitch.getAttribute("aria-checked"), disabled: privacySwitch.disabled, opacity: opacity(privacySwitch) } : null,
          identity: identity ? { background: getComputedStyle(identity).backgroundColor, avatar: avatar?.getBoundingClientRect().width, initials: avatar?.textContent } : null,
          signOut: signOut ? { background: getComputedStyle(signOut).backgroundColor, border: getComputedStyle(signOut).borderTopWidth, icon: !!signOut.querySelector("svg") } : null,
          bordered: [...column.querySelectorAll("[data-testid=machine-name-settings], [data-testid=work-status-settings]")].map((element) => getComputedStyle(element).borderTopWidth),
          transparentIdentity: identity ? transparent(getComputedStyle(identity).backgroundColor) : null,
          transparentSignOut: signOut ? transparent(getComputedStyle(signOut).backgroundColor) : null,
        };
      });
      if (shots) await page.screenshot({ path: join(shots, `${name}-${mode}-1440.png`) });
      const checks = {
        "nothing scrolls sideways": !layout.overflow,
        "no controls overlap": layout.overlaps.length === 0,
        "no browser errors": errors.length === 0,
      };
      if (name === "general") {
        checks["General does not start with, or contain, data privacy mode"] = layout.firstRow !== "account.dataPrivacy" && !layout.privacySwitch && !layout.text.includes("Data privacy mode");
      } else if (privacy.managed) {
        checks["the managed card has its badge and list"] = /Managed by your organisation/.test(layout.text) && /Turned off while it’s on/i.test(layout.text) && /configuration profile/.test(layout.text);
        checks["the managed switch reads as on and locked, not greyed out"] = layout.privacySwitch?.checked === "true" && layout.privacySwitch.disabled && layout.privacySwitch.opacity > 0.99;
      } else {
        checks["identity header: 48px initials, no box"] = layout.identity?.avatar === 48 && layout.identity.initials === "AK" && layout.transparentIdentity;
        checks["Mac name and work status are rows, not bordered cards"] = layout.bordered.length === 2 && layout.bordered.every((width) => width === "0px");
        checks["Sign out is an outlined button with an icon"] = !!layout.signOut && layout.transparentSignOut && layout.signOut.border !== "0px" && layout.signOut.icon;
        checks["no organization setup on Account"] = !layout.text.includes("Organization setup") && !layout.text.includes("Create or switch organization");
        checks["data privacy mode is an Account row"] = layout.privacySwitch?.checked === "false" && !layout.privacySwitch.disabled;
      }
      failed += report(`${mode}, 1440px, ${name}`, checks, layout);
      if (name === "account") {
        // PRO-400 (17.01): Sign out asks in the app's own dialog: what happens, then Cancel on the left and a red Sign out on the right.
        await settings.locator("[data-testid=account-sign-out]").getByRole("button", { name: "Sign out", exact: true }).click();
        const dialog = page.getByRole("alertdialog", { name: "Sign out of TerminalX?" });
        await dialog.waitFor();
        await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
        if (shots) await page.screenshot({ path: join(shots, `sign-out-${mode}-1440.png`) });
        const asked = await dialog.evaluate((node) => {
          const probe = document.createElement("i");
          probe.style.background = "var(--destructive)";
          document.body.append(probe);
          const red = getComputedStyle(probe).backgroundColor;
          probe.remove();
          const buttons = [...node.querySelectorAll("button")];
          const box = node.getBoundingClientRect();
          return {
            text: node.textContent,
            buttons: buttons.map((button) => button.textContent.trim()),
            cancelFirst: buttons.length === 2 && buttons[0].getBoundingClientRect().right <= buttons[1].getBoundingClientRect().left,
            red: buttons.length === 2 && getComputedStyle(buttons[1]).backgroundColor === red,
            inWindow: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
            row: document.querySelector("[data-testid=account-sign-out]").textContent,
          };
        });
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        failed += report(`${mode}, 1440px, sign out dialog`, {
          "says what happens": /Phones paired through your account disconnect\. QR and code pairings keep working, and running agents are untouched\./.test(asked.text),
          "Cancel on the left, a red Sign out on the right": JSON.stringify(asked.buttons) === JSON.stringify(["Cancel", "Sign out"]) && asked.cancelFirst && asked.red,
          "the dialog is inside the window": asked.inWindow,
          "the row has no inline confirmation": !/Confirm sign out/.test(asked.row),
          "Cancel closes it and stays signed in": (await page.getByRole("alertdialog").count()) === 0 && (await settings.locator("[data-testid=account-identity]").count()) === 1,
        }, asked);
      }
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
