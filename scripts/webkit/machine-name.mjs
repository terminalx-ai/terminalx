#!/usr/bin/env node
// #686: this Mac's name in Settings → Account, in the desktop's WebKit. It is
// there with Relay off, its Rename control shows without hovering, a long
// name is cut short of the control, and renaming stays inside the section.
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
        const section = page.getByTestId("machine-name-settings");
        await section.getByTestId("machine-name").getByText(machine.name, { exact: true }).waitFor();
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
            const rename = [...root.querySelectorAll("button")].find((button) => button.textContent.trim() === "Rename");
            const shown = root.querySelector("[data-testid=machine-name]");
            // Within the section: the control and its icon, which once showed only on hover.
            const opacity = (element) => {
              let value = 1;
              for (let node = element; node && node !== root.parentElement; node = node.parentElement) value *= Number(getComputedStyle(node).opacity);
              for (const icon of element.querySelectorAll("svg")) value = Math.min(value, Number(getComputedStyle(icon).opacity));
              return value;
            };
            return {
              noPageOverflow: main.scrollWidth <= main.clientWidth + 1,
              outside: visible.filter((element) => {
                const box = element.getBoundingClientRect();
                return box.left < bounds.left - 1 || box.right > bounds.right + 1;
              }).map((element) => element.tagName + ":" + (element.textContent ?? "").slice(0, 30)),
              overlaps,
              rename: rename ? { ...rect(rename), opacity: opacity(rename) } : null,
              shown: shown ? { ...rect(shown), clipped: shown.scrollWidth > shown.clientWidth, height: shown.getBoundingClientRect().height } : null,
              shares: document.body.textContent.includes("What this Mac shares"),
              text: root.textContent,
            };
          });
        const before = await measure();
        if (shots) await section.screenshot({ path: join(shots, `machine-name-${mode}-${width}-${name.replace(/ /g, "-")}.png`) });
        const checks = {
          "the section is shown with Relay off": !before.shares && /You · on /.test(before.text),
          "Rename is a visible button, not a pencil that appears on hover": !!before.rename && before.rename.width > 0 && before.rename.opacity > 0.99,
          "the name is one line that ends before Rename starts": !!before.rename && !!before.shown && before.shown.right <= before.rename.left + 0.5 && before.shown.height < 24,
          "everything stays inside the section, unoverlapped": before.outside.length === 0 && before.overlaps.length === 0,
          "the section does not widen the Settings column": before.noPageOverflow,
        };
        // At 720px it no longer fits beside Rename.
        if (machine.name === LONG && width === 720) checks["the long name is cut with an ellipsis"] = !!before.shown?.clipped;
        if (machine.chosen) checks["the computer's own name is offered back"] = (await section.getByRole("button", { name: `Use “${machine.computerName}”` }).count()) === 1;

        await section.getByRole("button", { name: "Rename", exact: true }).click();
        const input = section.getByRole("textbox", { name: "This Mac’s name" });
        await input.fill("  Desk Mac ");
        const editing = await measure();
        if (shots) await section.screenshot({ path: join(shots, `machine-name-${mode}-${width}-${name.replace(/ /g, "-")}-editing.png`) });
        checks["while renaming, the field and its buttons stay inside, unoverlapped"] = editing.outside.length === 0 && editing.overlaps.length === 0 && editing.noPageOverflow;
        await section.getByRole("button", { name: "Save", exact: true }).click();
        await section.getByTestId("machine-name").getByText("Desk Mac", { exact: true }).waitFor();
        checks["saving sends the trimmed name and shows it"] = JSON.stringify(await page.evaluate(() => window.__RENAMES__)) === JSON.stringify(["Desk Mac"]);
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
