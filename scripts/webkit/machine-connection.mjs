#!/usr/bin/env node
// PRO-345: a paired machine's connection in the desktop's WebKit, with
// Experimental → Machines on. The sidebar lists each paired machine as its
// own section (screen 21.01): a monitor for a Mac, a server for Linux, its
// name, and its live state. Choosing one opens its view (21.08) with the
// header chip and the "Runs on …" strip; the chip's hover text says what the
// state means (21.09).
//
// Every state is shown in turn (connecting, direct on this network, direct
// over Tailscale, relay, reconnecting, offline, needs update, updating (PRO-354),
// access removed),
// at the window's smallest size (760×520, tauri.conf.json) and a roomy one, in
// the light and the dark theme. In each: the label and the hover text are the
// ones the screens name, the section and the chip stay inside the sidebar and
// the header, the sidebar does not scroll sideways, no text is under 12 px and
// no UI text is mono. With Machines off, the section is not there at all.
//
// Pictures of every case go to MACHINES_SHOTS, by default
// scripts/webkit/output/machine-connection; that default folder ignores itself.
//
//   pnpm build && npx playwright install webkit && node scripts/webkit/machine-connection.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const output = fileURLToPath(new URL("./output/", import.meta.url));
const shots = process.env.MACHINES_SHOTS ?? join(output, "machine-connection");
await mkdir(shots, { recursive: true });
if (!process.env.MACHINES_SHOTS) await writeFile(join(output, ".gitignore"), "*\n");

const SLACK = 1;
const LAST_SEEN = Date.parse("2026-11-15T14:02:00");

// Runs in the page, after the stub: two paired machines, both attachable, and a way to move their states on.
const fixture = (machines) => `(() => {
  const answers = window.__PW_STUB__.answers;
  const emit = window.__PW_STUB__.emit;
  answers.experimental_settings = { nativeCodex: false, sessionCost: false, orchestratorRuns: false, localVmTasks: false, machines: ${machines} };
  const machine = (patch) => ({ os: { family: "macos", version: "26.1" }, version: "0.2.33", publicKeyB64: "a2V5", directEndpoints: ["ws://192.168.1.20:6768/machine/1"],
    route: "relayAndNearby", pairedAt: Date.parse("2026-11-10T09:00:00Z"), lastSeenAt: ${LAST_SEEN}, lastRoute: null, relay: null, ...patch });
  answers.machines_list = [
    machine({ machineId: "m-mini", name: "Mac mini" }),
    machine({ machineId: "m-server", name: "build-server", os: { family: "linux", version: null } }),
  ];
  const views = {
    "m-mini": { state: "connecting", trying: ["lan", "tailscale", "relay"] },
    "m-server": { state: "relay", route: { kind: "relay", endpoint: null }, since: Date.now(), rttMs: 41 },
  };
  answers.machines_connections = () => Object.entries(views).map(([machineId, state]) => ({ machineId, state }));
  // The transport state the native side sends on cloud_remote_event for each
  // machine state (docs/MACHINES.md "As built (PRO-345)"): connected carries
  // the link, offline is reconnecting, needs update and access removed end it.
  const links = {};
  const transport = (machineId, view) => {
    switch (view.state) {
      case "direct":
      case "relay":
        links[machineId] = (links[machineId] ?? 0) + 1;
        return { state: "connected", runtimeGeneration: 1, runtimeEpoch: "e1", runtimeVersion: "0.2.33", authority: "manage", link: links[machineId],
          capabilities: ["pty/1", "pty/2", "fs/1", "git/1", "session/1", "session/2", "keys/1", "agents/1", "machine/1", "machine/2"] };
      case "reconnecting":
        return { state: "reconnecting", attempt: view.attempt, reason: "link lost", retryInMs: view.retryInMs };
      case "offline":
        return { state: "reconnecting", attempt: 0, reason: "offline", retryInMs: view.retryInMs };
      case "needsUpdate":
        return { state: "updateRequired" };
      case "updating":
        return { state: "reconnecting", attempt: 1, reason: "updating", retryInMs: 1_000 };
      case "accessRemoved":
        return { state: "stopped" };
      default:
        return { state: "connecting", attempt: 1 };
    }
  };
  const sendState = (machineId) =>
    setTimeout(() => emit("cloud_remote_event", { kind: "state", connectionId: "conn-" + machineId, state: transport(machineId, views[machineId]) }), 0);
  answers.machine_remote_attach = ({ machineId }) => {
    sendState(machineId);
    return "conn-" + machineId;
  };
  // A machine with no terminals, repositories or files open yet answers the
  // workspace view's first requests; anything else stays unanswered.
  const empty = { "pty.list": { epoch: "e1", terminals: [] }, "git.repositories": { repositories: [] }, "fs.list": { path: "", entries: [] },
    "runtime.agents": { agents: [] }, "session.list": { sessions: [] } };
  answers.cloud_remote_send = ({ connectionId, frame }) => {
    if (frame.method in empty)
      setTimeout(() => emit("cloud_remote_event", { kind: "message", connectionId, message: { id: frame.id, ok: true, result: empty[frame.method] } }), 0);
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

const STATES = [
  { id: "connecting", state: { state: "connecting", trying: ["lan", "tailscale", "relay"] }, label: "Connecting", hint: "Reaching the Mac mini" },
  { id: "direct-lan", state: { state: "direct", route: { kind: "lan", endpoint: "ws://192.168.1.20:6768/machine/1" }, since: 0, rttMs: 3 }, label: "Direct", hint: "On this network or Tailscale", path: "Direct on this network · 3 ms" },
  { id: "direct-tailscale", state: { state: "direct", route: { kind: "tailscale", endpoint: "ws://100.64.0.2:6768/machine/1" }, since: 0, rttMs: 9 }, label: "Direct", hint: "On this network or Tailscale", path: "Direct over Tailscale · 9 ms" },
  { id: "relay", state: { state: "relay", route: { kind: "relay", endpoint: null }, since: 0, rttMs: 41 }, label: "Relay", hint: "Through TerminalX Relay", path: "Through TerminalX Relay · 41 ms" },
  { id: "reconnecting", state: () => ({ state: "reconnecting", lostAt: Date.now() - 12_000, attempt: 2, retryInMs: 500, trying: ["lan", "relay"] }), label: "Reconnecting", hint: /^Lost it 1[2-4] seconds ago$/ },
  { id: "offline", state: { state: "offline", lastSeenAt: LAST_SEEN, retryInMs: 10_000 }, label: "Offline", sidebarLabel: /^Offline · seen \d{1,2}:02/, hint: "Sessions there keep running" },
  { id: "needs-update", state: { state: "needsUpdate", version: "0.2.27", side: "machine" }, label: "Needs update", hint: "Runs an older TerminalX" },
  { id: "updating", state: () => ({ state: "updating", version: "0.2.33", since: Date.now() - 5_000 }), label: "Updating", hint: "Back in under a minute" },
  { id: "access-removed", state: { state: "accessRemoved" }, label: "Access removed", hint: "Revoked on that Mac" },
];

const matches = (expected, actual) => (expected instanceof RegExp ? expected.test(actual ?? "") : expected === actual);

/** Text sizes, mono use and boxes of the machine's section and the main view's header. */
const measure = (page) =>
  page.evaluate(() => {
    const rect = (element) => {
      const box = element?.getBoundingClientRect();
      return box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height } : null;
    };
    const texts = (root) =>
      root
        ? [...root.querySelectorAll("*")]
            .filter((node) => [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim()))
            .map((node) => ({ text: node.textContent.trim(), size: parseFloat(getComputedStyle(node).fontSize), mono: /mono|menlo|monaco|courier/i.test(getComputedStyle(node).fontFamily) }))
        : [];
    const list = document.querySelector('[data-testid="conversation-list"]');
    const section = document.querySelector('[data-testid="machine-section"][data-machine="m-mini"]');
    const header = document.querySelector('[data-testid="machine-main"] header');
    const chip = document.querySelector('[data-testid="machine-chip"]');
    const strip = document.querySelector('[data-testid="machine-location"]');
    return {
      list: rect(list),
      scrollsSideways: list ? list.scrollWidth > list.clientWidth + 1 : null,
      section: rect(section),
      sectionButton: rect(section?.querySelector("button")),
      label: section?.querySelector('[data-testid="machine-state-label"]')?.textContent ?? null,
      sidebarHint: section?.querySelector("button")?.getAttribute("title") ?? null,
      header: rect(header),
      chip: rect(chip),
      chipLabel: chip ? chip.textContent.replace("Mac mini", "") : null,
      chipHint: chip?.getAttribute("title") ?? null,
      strip: rect(strip),
      path: document.querySelector('[data-testid="machine-path"]')?.textContent ?? null,
      icons: [...document.querySelectorAll('[data-testid="machine-section"]')].map((node) => node.querySelector("[data-icon]")?.getAttribute("data-icon") ?? ""),
      texts: [...texts(section), ...texts(header), ...texts(strip)],
    };
  });

const server = await serve();
const browser = await launch();
let failed = 0;

for (const [viewportName, viewport] of [["small", { width: 760, height: 520 }], ["roomy", { width: 1280, height: 800 }]]) {
  for (const colorScheme of ["light", "dark"]) {
    const name = `${viewportName}, ${colorScheme}`;
    const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, viewport, { extra: fixture(true), colorScheme });
    await sidebar(page);
    const section = page.locator('[data-testid="machine-section"][data-machine="m-mini"]');
    await section.waitFor();
    await section.locator("button").click();
    await page.locator('[data-testid="machine-main"]').waitFor();
    await page.locator('[data-testid="machine-chip"]').waitFor();

    for (const expected of STATES) {
      const state = typeof expected.state === "function" ? expected.state() : expected.state;
      await page.evaluate(([id, next]) => window.__PW_MACHINE__(id, next), ["m-mini", state]);
      await page.locator(`[data-testid="machine-chip"][data-state="${state.state}"]`).waitFor();
      await page.waitForTimeout(50);
      const m = await measure(page);
      const inside = (inner, outer) => !!inner && !!outer && inner.left >= outer.left - SLACK && inner.right <= outer.right + SLACK;
      const small = m.texts.filter((entry) => entry.size < 12);
      const mono = m.texts.filter((entry) => entry.mono);
      failed += report(
        `machine ${expected.id} (${name})`,
        {
          [`the sidebar says ${expected.sidebarLabel ?? expected.label}`]: matches(expected.sidebarLabel ?? expected.label, m.label),
          [`the chip says ${expected.label}`]: m.chipLabel === expected.label,
          [`the chip's hover text is ${expected.hint}`]: matches(expected.hint, m.chipHint),
          "the sidebar row's hover text is the same": matches(expected.hint, m.sidebarHint),
          ...(expected.path ? { [`the strip names the route: ${expected.path}`]: m.path === expected.path } : { "the strip names no route while not connected": m.path === null }),
          "the machine's section is inside the sidebar": inside(m.section, m.list) && inside(m.sectionButton, m.list),
          "the sidebar does not scroll sideways": m.scrollsSideways === false,
          "the chip is inside the header": inside(m.chip, m.header) && m.chip.top >= m.header.top - SLACK && m.chip.bottom <= m.header.bottom + SLACK,
          "the strip is under the header": !!m.strip && m.strip.top >= m.header.bottom - SLACK,
          "a Mac has a monitor and Linux a server": m.icons[0] === "monitor" && m.icons[1] === "server",
          "no text is under 12 px": small.length === 0,
          "no UI text is mono": mono.length === 0,
        },
        { ...m, small, mono, texts: undefined },
      );
      await page.screenshot({ path: join(shots, `${expected.id}-${viewportName}-${colorScheme}.png`) });
    }
    await page.close();
  }
}

// Machines off: no section, and the sidebar is as before.
{
  const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1000, height: 620 }, { extra: fixture(false) });
  await sidebar(page);
  await page.waitForTimeout(500);
  const sections = await page.locator('[data-testid="machines-section"]').count();
  failed += report("machines off", { "there is no Machines section": sections === 0, "there is no Development section": (await page.locator('[data-testid="dev-runtime-section"]').count()) === 0 });
  await page.screenshot({ path: join(shots, "machines-off.png") });
  await page.close();
}

await browser.close();
server.close();
console.log(`screenshots: ${shots}`);
process.exit(failed ? 1 : 0);
