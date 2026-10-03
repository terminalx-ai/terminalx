#!/usr/bin/env node
// WebKit layout check (PRO-49): the sidebar's footer is one row, the account
// entry (avatar or name, relay status) and then the Settings gear at the far
// right. A long name gets an ellipsis and never pushes the gear out, wraps
// the row or runs under it; signed out, the gear sits next to "Sign in". In
// the light and the dark theme.
//
// Set ACCOUNT_ROW_SHOTS to a directory to also save a picture of each row.
//
//   pnpm build && npx playwright install webkit && pnpm test:webkit-layout
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, report, serve } from "./harness.mjs";

const stub = `${await readFile(new URL("./tauri-stub.js", import.meta.url), "utf8")}`;
const shots = process.env.ACCOUNT_ROW_SHOTS;
const LONG = "Bartholomew Maximilian Featherstonehaugh-Cholmondeley the Third";
const cases = [
  { name: "short name", fixture: { cloud: true, localProjects: 3, accountName: "Ada" }, account: "Ada" },
  { name: "long name", fixture: { cloud: true, localProjects: 3, accountName: LONG }, account: LONG },
  { name: "signed out", fixture: { cloud: false, localProjects: 3 }, account: "Sign in" },
];

const server = await serve();
const browser = await launch();
let failed = 0;
for (const mode of ["light", "dark"]) {
  for (const { name, fixture, account } of cases) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 600 } });
    await page.addInitScript(`localStorage.setItem("raccoon.mode", ${JSON.stringify(mode)});\nwindow.__PW_FIXTURE__ = ${JSON.stringify(fixture)};\n${stub}`);
    await page.goto(server.url);
    const row = page.locator('[data-testid="sidebar-account-row"]');
    await row.waitFor();
    await row.getByText(account, { exact: true }).first().waitFor();
    const layout = await row.evaluate((element, label) => {
      const rect = (node) => {
        const box = node.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      };
      const buttons = [...element.querySelectorAll("button")];
      const gear = buttons.find((button) => button.getAttribute("aria-label") === "Settings");
      const entry = buttons.find((button) => button !== gear);
      const text = [...element.querySelectorAll("span")].find((span) => span.textContent === label && !span.children.length);
      return {
        buttons: buttons.length,
        row: rect(element),
        gear: gear ? rect(gear) : null,
        gearText: gear?.textContent ?? null,
        entry: entry ? rect(entry) : null,
        name: text ? { ...rect(text), clipped: text.scrollWidth > text.clientWidth } : null,
        scrolls: element.scrollWidth > element.clientWidth,
        dark: getComputedStyle(document.documentElement).colorScheme,
      };
    }, account);
    const { gear, entry, row: box } = layout;
    const SLACK = 0.5;
    const checks = {
      "the account entry and the gear are the row's only two buttons": layout.buttons === 2 && !!gear && !!entry,
      "the gear is icon-only": layout.gearText === "",
      "they share one row (the gear sits within the entry's height)": !!gear && !!entry && gear.top >= entry.top - SLACK && gear.bottom <= entry.bottom + SLACK,
      "the gear is at the right end, inside the sidebar": !!gear && gear.right <= box.right + SLACK && box.right - gear.right < 12,
      "the entry ends before the gear starts": !!gear && !!entry && entry.right <= gear.left + SLACK,
      "the row does not scroll sideways": !layout.scrolls,
    };
    if (name === "long name") {
      checks["the long name is cut with an ellipsis, short of the gear"] = !!layout.name && layout.name.clipped && layout.name.right <= gear.left + SLACK;
    }
    if (shots) await row.screenshot({ path: join(shots, `account-row-${mode}-${name.replace(/ /g, "-")}.png`) });
    // The tooltip names the action and its shortcut.
    await row.getByRole("button", { name: "Settings" }).hover();
    const tooltip = page.getByRole("tooltip");
    await tooltip.waitFor({ timeout: 3000 }).catch(() => undefined);
    const tip = (await tooltip.count()) ? await tooltip.first().textContent() : "";
    checks["hovering the gear says Settings and its shortcut"] = /Settings/.test(tip ?? "") && /,/.test(tip ?? "");
    failed += report(`${mode}, ${name}`, checks, layout);
    await page.close();
  }
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
