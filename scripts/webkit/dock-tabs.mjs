#!/usr/bin/env node
// PRO-402 (design 06.01): the right panel's terminal dock always has the tabs
// Setup, Run (with a status dot), Terminal and Device, with and without a setup run.
// Setup shows the "After setup" label, the script in a mono block and the
// last outcome with its duration and exit code, keeps Rerun, and keeps the
// run's output reachable below; a docked shell has its own header row with
// one Move to tab and the dock's row has none. Checked at 1440 wide in dark
// and light; a capture per theme and state goes to DOCK_TABS_SHOTS (default:
// a terminalx-webkit-dock folder in the system temp directory).
// pnpm build && node scripts/webkit/dock-tabs.mjs
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, open, openConversation, report, serve } from "./harness.mjs";

const shots = process.env.DOCK_TABS_SHOTS || join(tmpdir(), "terminalx-webkit-dock");
mkdirSync(shots, { recursive: true });

function setup({ withRun }) {
  localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: true, panelTerminalOpen: true, panelTerminalHeight: 420, tabStrip: true }));
  const { answers } = window.__PW_STUB__;
  const session = answers.list_sessions[0];
  const project = answers.list_projects.projects[0];
  session.tabs.forEach((tab) => { tab.status = "idle"; });
  const checks = window.__DOCK_CHECKS__ = { reruns: 0 };
  const runs = [];
  window.__SETUP_RUNS__ = runs;
  let shells = [];
  if (withRun) {
    project.scripts = { setup: "bun install\ncp \"$TERMINALX_ROOT/.env.local\" .env.local", archive: "" };
    project.actions = [{ id: "dev", name: "Dev server", icon: "play", command: "bun install && bun run dev", runAfterSetup: true, concurrent: false, hidden: false }];
    shells = [{ id: `${session.id}:dock-shell`, sessionId: session.id, title: "zsh", cwd: session.cwd, exited: false, docked: true, created: new Date().toISOString() }];
  }
  Object.assign(answers, {
    load_tab_events: [], tab_pane: null, ensure_tab_started: null, browser_pages: [], set_active_tab: null,
    pty_shells: shells, pane_agents: [], pty_detach_all: null, pty_detach: null, pty_ack: null, pty_resize: null, pty_write: null,
    pty_attach_sized: () => null,
    workspace_ports: [1420],
    action_states: () => withRun ? [{ sessionId: session.id, actionId: "dev", name: "Dev server", paneId: `${session.id}:action-dev`, state: "running", exitCode: null, started: new Date().toISOString(), ended: null }] : [],
    workspace_setup: ({ operation }) => {
      if (operation === "list") return structuredClone(runs);
      if (operation === "log") return "bun install v1.3.1\n812 packages installed [2.41s]\nCopied .env.local\n";
      if (operation === "rerun") { checks.reruns++; return null; }
      return null;
    },
  });
}

/** The dock's fixed tabs, by their own text (the dot has no text). */
const tabs = (dock) => dock.getByRole("tablist", { name: "Terminals" }).getByRole("tab").allTextContents();

/** Dock content that spills sideways, and visible pieces of the Setup pane that overlap each other. */
function layout(dock) {
  const pane = dock.querySelector('[data-testid="setup-pane"], [data-testid="setup-empty"], [data-testid="run-pane"], [data-testid="run-empty"]');
  const parts = pane ? [...pane.children].filter((el) => el.getBoundingClientRect().height > 0) : [];
  const overlaps = [];
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
    const a = parts[i].getBoundingClientRect();
    const b = parts[j].getBoundingClientRect();
    if (a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5 && a.left < b.right && b.left < a.right) overlaps.push(`${parts[i].tagName}/${parts[j].tagName}`);
  }
  const row = dock.querySelector('[role="tablist"]').getBoundingClientRect();
  const box = dock.getBoundingClientRect();
  return {
    overflow: dock.scrollWidth > dock.clientWidth + 1 || (pane ? pane.scrollWidth > pane.clientWidth + 1 : false),
    overlaps,
    rowInside: row.left >= box.left - 0.5 && row.right <= box.right + 0.5,
  };
}

async function check(browser, url, colorScheme) {
  let failed = 0;

  // Without a setup run: no script, no actions, no shell.
  let page = await open(browser, url, { cloud: false, localProjects: 1, localSession: true }, { width: 1440, height: 900 }, { extra: `(${setup})(${JSON.stringify({ withRun: false })})`, colorScheme });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openConversation(page, "Local long session");
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-mode")), colorScheme, `the app follows the ${colorScheme} appearance`);
  let dock = page.getByTestId("panel-terminal");
  await dock.getByTestId("setup-empty").waitFor();
  await page.waitForTimeout(250);
  failed += report(`${colorScheme} without a setup run`, {
    "tabs are Setup, Run, Terminal, Device": JSON.stringify(await tabs(dock)) === JSON.stringify(["Setup", "Run", "Terminal", "Device"]),
    "Setup is shown": (await dock.getByRole("tab", { name: /^Setup/ }).getAttribute("aria-selected")) === "true",
    "Run has a status dot": (await dock.getByRole("tab", { name: /^Run/ }).getByRole("img", { name: "Not running" }).count()) === 1,
    "Setup says where to add the script": (await dock.getByTestId("setup-empty").innerText()).includes("Settings → Projects → Scripts"),
    "After setup label is upper case": (await dock.getByTestId("setup-empty").innerText()).includes("AFTER SETUP"),
    "nothing spills or overlaps": await dock.evaluate((node, fn) => { const r = new Function(`return ${fn}`)()(node); return !r.overflow && !r.overlaps.length && r.rowInside; }, layout.toString()),
  });
  await dock.screenshot({ path: join(shots, `dock-no-setup-run-${colorScheme}.png`) });
  await dock.getByRole("tab", { name: /^Run/ }).click();
  await dock.getByTestId("run-empty").waitFor();
  failed += report(`${colorScheme} Run without actions`, {
    "Run says where to add the script": (await dock.getByTestId("run-empty").innerText()).includes("Settings → Projects → Actions"),
    "tabs stay Setup, Run, Terminal, Device": JSON.stringify(await tabs(dock)) === JSON.stringify(["Setup", "Run", "Terminal", "Device"]),
  });
  assert.deepEqual(errors, [], "no page errors");
  await page.close();

  // With a setup run seen from its start, an action running and a docked shell.
  page = await open(browser, url, { cloud: false, localProjects: 1, localSession: true }, { width: 1440, height: 900 }, { extra: `(${setup})(${JSON.stringify({ withRun: true })})`, colorScheme });
  page.on("pageerror", (error) => errors.push(error.message));
  await openConversation(page, "Local long session");
  dock = page.getByTestId("panel-terminal");
  await dock.getByTestId("terminal-header").waitFor();
  const sessionId = await page.evaluate(() => window.__PW_STUB__.answers.list_sessions[0].id);
  const run = { sessionId, paneId: `${sessionId}:workspace-setup-1`, command: "bun install\ncp \"$TERMINALX_ROOT/.env.local\" .env.local", status: "pending", exitCode: null, error: null, hasPane: false };
  await page.evaluate((run) => { window.__SETUP_RUNS__.push(run); window.__PW_STUB__.emit("workspace_setup_changed", run); }, run);
  await page.evaluate((run) => window.__PW_STUB__.emit("workspace_setup_changed", { ...run, status: "running" }), run);
  await page.waitForTimeout(1600);
  await page.evaluate((run) => { const done = { ...run, status: "succeeded", exitCode: 0 }; window.__SETUP_RUNS__.splice(0, 1, done); window.__PW_STUB__.emit("workspace_setup_changed", done); }, run);

  // The docked shell first: its own header row with one Move to tab, none on the dock's row.
  failed += report(`${colorScheme} docked shell`, {
    "tabs are Setup, Run, Terminal, Device": JSON.stringify(await tabs(dock)) === JSON.stringify(["Setup", "Run", "Terminal", "Device"]),
    "the shell has its header row": (await dock.getByTestId("terminal-header").count()) === 1,
    "one Move to tab, in the header": (await dock.getByRole("button", { name: "Move to tab" }).count()) === 1 && (await dock.getByTestId("terminal-header").getByRole("button", { name: "Move to tab" }).count()) === 1,
  });

  await dock.getByRole("tab", { name: /^Setup/ }).click();
  const pane = dock.getByTestId("setup-pane");
  await pane.waitFor();
  await pane.getByText("812 packages installed").waitFor();
  await page.waitForTimeout(250);
  const outcome = await pane.getByTestId("setup-outcome").innerText();
  const font = await pane.getByTestId("setup-script").evaluate((el) => getComputedStyle(el).fontFamily);
  failed += report(`${colorScheme} with a setup run`, {
    "tabs are Setup, Run, Terminal, Device": JSON.stringify(await tabs(dock)) === JSON.stringify(["Setup", "Run", "Terminal", "Device"]),
    "Setup has its outcome dot": (await dock.getByRole("tab", { name: /^Setup/ }).getByRole("img", { name: "Setup succeeded" }).count()) === 1,
    "Run's dot says running": (await dock.getByRole("tab", { name: /^Run/ }).getByRole("img", { name: "Running" }).count()) === 1,
    "AFTER SETUP label": (await pane.innerText()).includes("AFTER SETUP"),
    "script in a mono block": (await pane.getByTestId("setup-script").innerText()).startsWith("bun install") && /mono|menlo|courier|consolas/i.test(font),
    "outcome with duration and exit code": /^✓ Last setup finished in \d+s · exit 0$/.test(outcome),
    "Rerun is kept": (await pane.getByRole("button", { name: "Rerun" }).count()) === 1,
    "the setup output stays reachable": (await pane.getByTestId("setup-output").innerText()).includes("812 packages installed"),
    "nothing spills or overlaps": await dock.evaluate((node, fn) => { const r = new Function(`return ${fn}`)()(node); return !r.overflow && !r.overlaps.length && r.rowInside; }, layout.toString()),
  }, { outcome, font });
  await dock.screenshot({ path: join(shots, `dock-setup-run-${colorScheme}.png`) });

  await dock.getByRole("tab", { name: /^Run/ }).click();
  const runPane = dock.getByTestId("run-pane");
  await runPane.waitFor();
  failed += report(`${colorScheme} Run with an action`, {
    "lists the action and its command": (await runPane.innerText()).includes("Dev server") && (await runPane.innerText()).includes("bun install && bun run dev"),
    "shows it running with Restart": (await runPane.innerText()).includes("Running") && (await runPane.getByRole("button", { name: "Restart" }).count()) === 1,
  });
  await dock.screenshot({ path: join(shots, `dock-run-${colorScheme}.png`) });
  assert.deepEqual(errors, [], "no page errors");
  await page.close();
  return failed;
}

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const mode of ["dark", "light"]) failed += await check(browser, server.url, mode);
} finally {
  await browser.close();
  server.close();
}
console.log(`captures in ${shots}`);
assert.equal(failed, 0, `${failed} check(s) failed`);
