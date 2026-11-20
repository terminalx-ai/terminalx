#!/usr/bin/env node
// PRO-354: versions and updates in the desktop's WebKit, at the screens' width (1440×900) and the window's smallest size
// (760×520), in the light and the dark theme.
//
// Three paired machines: "Mac mini" (0.2.33, everything granted), "dev-server"
// (0.2.29, connected through the relay without ports/1, pipeline/2 and
// session-status/1, updatable by its installer) and "ci-box" (0.2.27, refused
// as needing an update). Shown in turn:
//   - Settings → Machines (21.02): ci-box and dev-server say Needs update with
//     Update; the Mac mini says Connected.
//   - dev-server's page (21.10): the version banner "TerminalX 0.2.29 there,
//     0.2.33 here", what is hidden, and Update dev-server.
//   - Update with another computer connected and an agent a handover cannot
//     carry: the confirmation lists both before machine.update is sent.
//   - The chip (21.09) for ci-box (Needs update) and for dev-server while it
//     hands over (Updating · Back in under a minute).
//   - dev-server's Ports panel: the one-line message naming the machine.
//   - A machine newer than this Mac: the page offers this Mac's update.
// In each: no text is under 12 px and nothing scrolls sideways.
//
// Pictures go to MACHINES_SHOTS, by default
// scripts/webkit/output/machine-update; that default folder ignores itself.
//
//   pnpm build && npx playwright install webkit && node scripts/webkit/machine-update.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const output = fileURLToPath(new URL("./output/", import.meta.url));
const shots = process.env.MACHINES_SHOTS ?? join(output, "machine-update");
await mkdir(shots, { recursive: true });
if (!process.env.MACHINES_SHOTS) await writeFile(join(output, ".gitignore"), "*\n");

const ALL = ["pty/1", "pty/2", "fs/1", "git/1", "session/1", "session/2", "session/3", "session-status/1", "session-repository/1", "lifecycle/1", "agents/1", "agent-pty/1",
  "composer/1", "composer/2", "composer/3", "composer/4", "ports/1", "cleanup/1", "workspace/1", "workspace/2", "pipeline/1", "pipeline/2", "agent-commands/1", "machine/1", "machine/2", "machine/3", "machine/4", "machine/6", "machine/7", "machine/8"];
const OLDER = ALL.filter((capability) => !["ports/1", "pipeline/2", "session-status/1"].includes(capability));

// Runs in the page, after the stub.
const fixture = (newer) => `(() => {
  const answers = window.__PW_STUB__.answers;
  const emit = window.__PW_STUB__.emit;
  answers.experimental_settings = { nativeCodex: false, sessionCost: false, orchestratorRuns: false, localVmTasks: false };
  answers["plugin:app|version"] = "0.2.33";
  const machine = (patch) => ({ os: { family: "linux", version: "24.04" }, publicKeyB64: "a2V5", directEndpoints: [], route: "relayAndNearby",
    pairedAt: Date.parse("2026-11-12T09:00:00Z"), lastSeenAt: Date.now(), lastRoute: null, relay: null, ...patch });
  answers.machines_list = [
    machine({ machineId: "m-mini", name: "Mac mini", os: { family: "macos", version: "26.1" }, version: "0.2.33" }),
    machine({ machineId: "m-dev", name: "dev-server", os: { family: "linux", version: "24.04" }, version: ${newer ? '"0.2.35"' : '"0.2.29"'} }),
    machine({ machineId: "m-ci", name: "ci-box", version: "0.2.27" }),
  ];
  const connected = (kind, rttMs) => ({ state: kind === "relay" ? "relay" : "direct", route: { kind, endpoint: kind === "relay" ? null : "ws://100.64.0.2:6768/machine/1" }, since: Date.now(), rttMs });
  const views = { "m-mini": connected("tailscale", 9), "m-dev": connected("relay", 41), "m-ci": { state: "needsUpdate", version: "0.2.27", side: "machine" } };
  const caps = { "m-mini": ${JSON.stringify(ALL)}, "m-dev": ${newer ? JSON.stringify(ALL) : JSON.stringify(OLDER)}, "m-ci": [] };
  const versions = { "m-mini": "0.2.33", "m-dev": ${newer ? '"0.2.35"' : '"0.2.29"'}, "m-ci": "0.2.27" };
  answers.machines_connections = () => Object.entries(views).map(([machineId, state]) => ({ machineId, state }));
  const links = {};
  const transport = (machineId, view) => {
    switch (view.state) {
      case "direct":
      case "relay":
        links[machineId] = (links[machineId] ?? 0) + 1;
        return { state: "connected", runtimeGeneration: 1, runtimeEpoch: "e1", runtimeVersion: versions[machineId], authority: "manage", link: links[machineId], capabilities: caps[machineId] };
      case "updating":
      case "reconnecting":
        return { state: "reconnecting", attempt: 1, reason: "link lost", retryInMs: 1000 };
      case "needsUpdate":
        return { state: "updateRequired" };
      default:
        return { state: "connecting", attempt: 1 };
    }
  };
  const sendState = (machineId) =>
    setTimeout(() => emit("cloud_remote_event", { kind: "state", connectionId: "conn-" + machineId, state: transport(machineId, views[machineId]) }), 0);
  answers.machine_remote_attach = ({ machineId }) => { sendState(machineId); return "conn-" + machineId; };
  const status = {
    method: "installer", current: "0.2.29", available: { version: "0.2.33" }, checkedAt: Date.now(),
    blockers: [{ id: "tab-1", kind: "agent", title: "Codex (stdio) in Bisect the flaky relay e2e" }],
    otherComputers: [{ id: "c-air", label: "Paresh’s MacBook Air" }],
    kept: ["0.2.29", "0.2.28"], progress: { phase: "idle" },
  };
  window.__PW_UPDATE_SENT__ = [];
  const reply = (connectionId, id, result) => setTimeout(() => emit("cloud_remote_event", { kind: "message", connectionId, message: { id, ok: true, result } }), 0);
  const notify = (connectionId, event, params) => setTimeout(() => emit("cloud_remote_event", { kind: "message", connectionId, message: { event, params } }), 0);
  const empty = { "pty.list": { epoch: "e1", terminals: [] }, "git.repositories": { repositories: [] }, "fs.list": { path: "", entries: [] },
    "runtime.agents": { agents: [] }, "session.list": { sessions: [] }, "ports.list": { ports: [] }, "machine.projects": { projects: [] } };
  answers.cloud_remote_send = ({ connectionId, frame }) => {
    if (frame.method === "machine.updateStatus") reply(connectionId, frame.id, status);
    else if (frame.method === "machine.update") {
      window.__PW_UPDATE_SENT__.push(frame.params);
      const started = { ...status, progress: { phase: "handingOver", version: "0.2.33", since: Date.now() } };
      reply(connectionId, frame.id, started);
      notify(connectionId, "machine.updateChanged", { status: started });
    } else if (frame.method in empty) reply(connectionId, frame.id, empty[frame.method]);
    return true;
  };
  answers.machines_reconnect = null;
  answers.cloud_remote_detach = null;
  window.__PW_MACHINE__ = (machineId, state) => {
    views[machineId] = state;
    emit("machines_connection_changed", { machineId, state });
    sendState(machineId);
  };
})();`;

/** Text under 12 px, and whether `root` scrolls sideways. */
const measure = (page, selector) =>
  page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) return null;
    const small = [...root.querySelectorAll("*")]
      .filter((node) => node.getClientRects().length && [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim()))
      .filter((node) => !node.closest(".sr-only") && parseFloat(getComputedStyle(node).fontSize) < 12)
      .map((node) => node.textContent.trim());
    return { text: root.textContent, small, sideways: root.scrollWidth > root.clientWidth + 1 };
  }, selector);

const server = await serve();
const browser = await launch();
let failed = 0;

async function settings(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const main = page.getByRole("main", { name: "Settings", exact: true });
  await main.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Machines", exact: true }).click();
  await main.getByTestId("machines-settings").waitFor();
  return main;
}

/** A machine's page (21.10), from its card's menu: choosing the card itself opens the machine's view and leaves Settings. */
async function openMachinePage(page, main, name) {
  await main.getByRole("button", { name: `More for ${name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Version and updates…" }).click();
}

for (const [viewportName, viewport] of [["design", { width: 1440, height: 900 }], ["small", { width: 760, height: 520 }]]) {
  for (const colorScheme of ["dark", "light"]) {
    const name = `${viewportName}, ${colorScheme}`;
    const shot = (id) => page.screenshot({ path: join(shots, `${id}-${viewportName}-${colorScheme}.png`) });
    const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, viewport, { extra: fixture(false), colorScheme });
    await sidebar(page);

    // 21.02: the cards.
    const main = await settings(page);
    const cards = main.getByRole("list", { name: "Your machines" });
    await cards.getByTestId("paired-machine").nth(2).waitFor();
    await cards.locator('[data-testid="paired-machine"][data-needs-update]').nth(1).waitFor();
    await page.waitForTimeout(300);
    let m = await measure(page, '[data-testid="machines-settings"]');
    failed += report(`${name}: Settings → Machines`, {
      "ci-box and dev-server say Needs update": (await cards.locator('[data-testid="paired-machine"][data-needs-update]').count()) === 2,
      "ci-box's line names its version": m.text.includes("TerminalX 0.2.27"),
      "dev-server's line says features are hidden": m.text.includes("TerminalX 0.2.29 · some features are hidden until it is updated"),
      "dev-server, which serves machine/3, has Update": (await cards.locator('[data-testid="paired-machine"]', { hasText: "dev-server" }).getByTestId("machine-update-button").count()) === 1,
      "ci-box, too old to be updated from here, says where to update it": m.text.includes("Update it on ci-box."),
      "the Mac mini is connected": m.text.includes("Connected"),
      "no text is under 12 px": m.small.length === 0,
      "nothing scrolls sideways": !m.sideways,
    }, m.small);
    await shot("settings-machines");

    // 21.10: dev-server's page.
    await openMachinePage(page, main, "dev-server");
    const banner = main.getByTestId("machine-version-banner");
    await banner.waitFor();
    await page.waitForTimeout(300);
    m = await measure(page, '[data-testid="machine-page"]');
    const hidden = await main.getByTestId("machine-hidden-features").textContent();
    failed += report(`${name}: dev-server's page`, {
      "the page says Connected": (await main.getByTestId("machine-page-state").textContent()).includes("Connected"),
      "the banner names both versions": m.text.includes("TerminalX 0.2.29 there, 0.2.33 here"),
      "the banner says running sessions keep going": m.text.includes("Running sessions keep going through the update."),
      "the page lists port forwarding as hidden": hidden.includes("Port forwarding"),
      "Update names the machine": (await banner.getByTestId("machine-update-button").textContent()).includes("dev-server"),
      "no text is under 12 px": m.small.length === 0,
      "nothing scrolls sideways": !m.sideways,
    }, m.small);
    await shot("machine-page");

    // Update: told about the other computer and the agent first.
    await banner.getByTestId("machine-update-button").click();
    const confirm = page.getByTestId("machine-update-confirm");
    await confirm.waitFor();
    await page.waitForTimeout(200);
    const confirmText = await confirm.textContent();
    failed += report(`${name}: the update confirmation`, {
      "it names the agent that would stop": confirmText.includes("Codex (stdio) in Bisect the flaky relay e2e"),
      "it names the other computer": confirmText.includes("Paresh’s MacBook Air"),
      "nothing was sent yet": (await page.evaluate(() => window.__PW_UPDATE_SENT__.length)) === 0,
    });
    await shot("update-confirm");
    await confirm.getByRole("button", { name: "Stop it and update" }).click();
    await page.waitForFunction(() => window.__PW_UPDATE_SENT__.length === 1);
    const sent = await page.evaluate(() => window.__PW_UPDATE_SENT__[0]);
    failed += report(`${name}: machine.update`, {
      "it asks for 0.2.33": sent.version === "0.2.33",
      "it stops only the agent named": JSON.stringify(sent.stop) === JSON.stringify(["tab-1"]),
      "it says the person was told about the other computer": JSON.stringify(sent.confirmedOthers) === JSON.stringify(["c-air"]),
    }, sent);
    await page.waitForTimeout(300);
    await shot("update-started");
    await page.close();
  }
}

// 21.09: the chips, and the Ports panel's one line.
for (const colorScheme of ["dark", "light"]) {
  const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1440, height: 900 }, { extra: fixture(false), colorScheme });
  await sidebar(page);
  const chipOf = async (machineId) => {
    await page.locator(`[data-testid="machine-section"][data-machine="${machineId}"] button`).first().click();
    await page.locator(`[data-testid="machine-main"][data-machine="${machineId}"]`).waitFor();
    return page.locator('[data-testid="machine-chip"]');
  };
  let chip = await chipOf("m-ci");
  await page.locator('[data-testid="machine-chip"][data-state="needsUpdate"]').waitFor();
  failed += report(`${colorScheme}: ci-box's chip`, {
    "it says Needs update": (await chip.textContent()).includes("Needs update"),
    "its hover text is Runs an older TerminalX": (await chip.getAttribute("title")) === "Runs an older TerminalX",
  });
  await chip.screenshot({ path: join(shots, `chip-needs-update-${colorScheme}.png`) });

  chip = await chipOf("m-dev");
  await page.locator('[data-testid="machine-chip"][data-state="relay"], [data-testid="machine-chip"][data-needs-update]').first().waitFor().catch(() => undefined);
  // Ports, which dev-server does not serve: one line naming it (21.09).
  await page.getByRole("tab", { name: "Ports", exact: true }).click().catch(() => page.getByRole("button", { name: "Ports", exact: true }).click());
  const notice = page.getByTestId("machine-feature-notice");
  await notice.waitFor();
  failed += report(`${colorScheme}: dev-server's Ports panel`, {
    "it says what to update and why": (await notice.textContent()).includes("dev-server runs TerminalX 0.2.29. Update it to forward ports from here."),
  });
  await notice.screenshot({ path: join(shots, `ports-notice-${colorScheme}.png`) });
  await page.screenshot({ path: join(shots, `main-ports-notice-${colorScheme}.png`) });
  await page.evaluate(() => window.__PW_MACHINE__("m-dev", { state: "updating", version: "0.2.33", since: Date.now() - 5000 }));
  await page.locator('[data-testid="machine-chip"][data-state="updating"]').waitFor();
  failed += report(`${colorScheme}: dev-server's chip while it updates`, {
    "it says Updating": (await chip.textContent()).includes("Updating"),
    "its hover text is Back in under a minute": (await chip.getAttribute("title")) === "Back in under a minute",
  });
  await chip.screenshot({ path: join(shots, `chip-updating-${colorScheme}.png`) });
  await page.screenshot({ path: join(shots, `main-updating-${colorScheme}.png`) });
  await page.close();
}

// A machine newer than this Mac: its page offers this Mac's update.
{
  const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1440, height: 900 }, { extra: fixture(true), colorScheme: "dark" });
  await sidebar(page);
  const main = await settings(page);
  await openMachinePage(page, main, "dev-server");
  const banner = main.getByTestId("machine-version-banner");
  await banner.waitFor();
  await page.waitForTimeout(300);
  const text = await banner.textContent();
  failed += report("dev-server newer than this Mac", {
    "the banner names both versions": text.includes("TerminalX 0.2.35 there, 0.2.33 here"),
    "it is this Mac that updates": (await banner.getAttribute("data-side")) === "thisMac",
    "the button updates this Mac": (await banner.getByTestId("machine-update-button").textContent()).includes("this Mac"),
  }, text);
  await page.screenshot({ path: join(shots, "machine-page-newer-design-dark.png") });
  await page.close();
}

await browser.close();
server.close();
console.log(`screenshots: ${shots}`);
process.exit(failed ? 1 : 0);
