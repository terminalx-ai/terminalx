#!/usr/bin/env node
// #686: this Mac's name in Settings → Account, in the desktop's WebKit. It is
// there with Relay off; since PRO-375 it is an inline text field on the right
// of its row, a long name stays inside the field, and renaming saves on Enter.
// In the light and the dark theme, at a wide and a narrow window.
//
// Set MACHINE_NAME_SHOTS to a directory to also save a picture of each case.
//
//   pnpm build && npx playwright install webkit && node scripts/webkit/machine-name.mjs
import { join } from "node:path";
import { launch, open, report, serve } from "./harness.mjs";

const shots = process.env.MACHINE_NAME_SHOTS;
// 80 characters, the most a name may have.
const LONG = "Bartholomew’s exceedingly long-named Mac Studio in the upstairs office by a door";
const cases = [
  { name: "follows the computer", machine: { name: "Paresh’s Mac mini", chosen: false, computerName: "Paresh’s Mac mini" } },
  { name: "long chosen name", machine: { name: LONG, chosen: true, computerName: "Paresh’s Mac mini" } },
];

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const mode of ["light", "dark"]) {
    for (const width of [960, 720]) {
      for (const { name, machine } of cases) {
        const page = await open(
          browser,
          server.url,
          { cloud: true, localProjects: 1 },
          { width, height: 900 },
          {
            extra: `localStorage.setItem("raccoon.mode", ${JSON.stringify(mode)});
              (() => {
                const answers = window.__PW_STUB__.answers;
                window.__RENAMES__ = [];
                let machine = ${JSON.stringify(machine)};
                answers.machine_name = () => machine;
                answers.set_machine_name = ({ name }) => {
                  window.__RENAMES__.push(name);
                  machine = { ...machine, name: name ?? machine.computerName, chosen: name !== null };
                  return machine;
                };
                // Relay off: no host is bound, so "What this Mac shares" is not shown.
                answers.pairing_status = { relay: { phase: "off", message: null, attempt: 0 }, host: null, devices: [], activePairing: null, lastError: null };
                answers.work_status_settings = { shareWithTeam: true };
              })();`,
          },
        );
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Account", exact: true }).click(); // Settings opens on General (PRO-374).
        const section = page.getByTestId("machine-name-settings");
        await page.waitForFunction((name) => document.querySelector("[data-testid=machine-name]")?.value === name, machine.name);
        // Settings opens with a fade: measure once it has settled.
        await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
        const measure = () =>
          section.evaluate((root) => {
            const main = root.closest('[role="main"]') ?? document.body;
            const rect = (element) => {
              const box = element.getBoundingClientRect();
              return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width };
            };
            const bounds = rect(root);
            const visible = [...root.querySelectorAll("button, input, [data-testid=machine-name]")].filter((element) => element.getBoundingClientRect().width > 0);
            const overlaps = [];
            for (let a = 0; a < visible.length; a++)
              for (let b = a + 1; b < visible.length; b++) {
                const one = visible[a].getBoundingClientRect();
                const two = visible[b].getBoundingClientRect();
                if (one.left < two.right - 1 && two.left < one.right - 1 && one.top < two.bottom - 1 && two.top < one.bottom - 1) overlaps.push([visible[a].textContent, visible[b].textContent]);
              }
            const field = root.querySelector("[data-testid=machine-name]");
            const label = root.querySelector("#machine-name-label");
            return {
              sectionRight: bounds.right,
              noPageOverflow: main.scrollWidth <= main.clientWidth + 1,
              outside: visible.filter((element) => {
                const box = element.getBoundingClientRect();
                return box.left < bounds.left - 1 || box.right > bounds.right + 1;
              }).map((element) => element.tagName + ":" + (element.textContent ?? "").slice(0, 30)),
              overlaps,
              field: field ? { ...rect(field), opacity: Number(getComputedStyle(field).opacity) } : null,
              label: label ? rect(label) : null,
              shares: document.body.textContent.includes("What this Mac shares"),
              text: root.textContent,
            };
          });
        const before = await measure();
        if (shots) await section.screenshot({ path: join(shots, `machine-name-${mode}-${width}-${name.replace(/ /g, "-")}.png`) });
        const checks = {
          "the section is shown with Relay off": !before.shares && /You · on /.test(before.text),
          "the name is an inline text field on the right of its label": !!before.field && !!before.label && before.field.opacity > 0.99 && before.field.left >= before.label.right && before.field.right >= before.sectionRight - 1,
          "everything stays inside the section, unoverlapped": before.outside.length === 0 && before.overlaps.length === 0,
          "the section does not widen the Settings column": before.noPageOverflow,
        };
        if (machine.chosen) checks["the computer's own name is offered back"] = (await section.getByRole("button", { name: `Use “${machine.computerName}”` }).count()) === 1;

        const input = section.getByRole("textbox", { name: "This Mac’s name" });
        await input.fill("  Desk Mac ");
        const editing = await measure();
        if (shots) await section.screenshot({ path: join(shots, `machine-name-${mode}-${width}-${name.replace(/ /g, "-")}-editing.png`) });
        checks["while renaming, the field stays inside, unoverlapped"] = editing.outside.length === 0 && editing.overlaps.length === 0 && editing.noPageOverflow;
        await input.press("Enter");
        await page.waitForFunction(() => document.querySelector("[data-testid=machine-name-settings]")?.textContent.includes("You · on Desk Mac"));
        checks["Enter sends the trimmed name and shows it"] = JSON.stringify(await page.evaluate(() => window.__RENAMES__)) === JSON.stringify(["Desk Mac"]) && (await input.inputValue()) === "Desk Mac";
        failed += report(`${mode}, ${width}px, ${name}`, checks, { before, editing });
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
