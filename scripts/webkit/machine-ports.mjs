#!/usr/bin/env node
// PRO-355: a paired machine's ports forwarded to this Mac, in the desktop's
// WebKit, as screens 14.10, 14.11 and 21.08
// draw them with the machine's name where they say workspace.
//
// "Mac mini" (Direct) is paired with one project and one session; its runtime
// is stubbed as scripts/webkit/machine-session.mjs does, grants `ports/1`, and
// answers `ports.list` with the programs that listen (vite in console, bun in
// api, redis-server, an inspector). The desktop's forwarder is stubbed too:
// `cloud_port_forward`, `cloud_port_unforward`, `cloud_port_forwards`, the two
// switches, and `cloud_port_forwards_changed` for every change.
//
// Checked, in the light and the dark theme, with a picture of each state:
// - 21.08: the header has the forward chip with the count of open forwards,
//   left of the panel's actions; the side panel's tab reads "Ports 1";
// - 14.10: the chip opens "Forward ports to this Mac" with the Forwarding and
//   "Forward new ports automatically" switches, PORTS DETECTED with each
//   program named ("vite · console"), Open / Copy / Stop on forwarded rows,
//   Forward on the rest, "+ Forward a port", and the footnote naming Mac mini;
//   turning on automatic forwarding reaches the desktop;
// - the toast: a forward opened unasked says "Port 8787 forwarded to
//   127.0.0.1:8787" with Open and Copy; Open opens TerminalX's built-in
//   browser (browser_open_tab), never the system browser;
// - 14.11: the Ports tab, "Ports and previews" with Forwarding, FORWARDED
//   (open and expired, the expired address struck through with Start again)
//   and NOT FORWARDED, the port field with "Same port number on this Mac";
//   no signed-in preview link card (PRO-135);
// - Mac mini reconnecting: the Ports tab stays, its forwards waiting
//   ("returns when Mac mini is back"), and they open again when it is back;
// - a Mac mini without ports/1 (TerminalX 0.2.27): no chip and no Ports tab;
//   the "Runs on" strip's update line says to update it to forward ports.
// - nothing scrolls sideways.
//
// Pictures go to the directory named by MACHINE_PORTS_SHOTS, or the first
// argument, named after the state and theme.
//
//   pnpm build && npx playwright install webkit && node scripts/webkit/machine-ports.mjs [shots-dir]
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const shots = process.env.MACHINE_PORTS_SHOTS || process.argv[2] || null;
if (shots) await mkdir(shots, { recursive: true });
const shoot = async (page, name) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
};

const TITLE = "Add read markers to the catalog feed";

// Runs in the page, after the stub: Mac mini, its project and session, its runtime and this Mac's forwarder.
// `ports`: the machine grants ports/1 (a current TerminalX); without it, it runs 0.2.27.
const fixture = (ports) => `(() => {
  const answers = window.__PW_STUB__.answers;
  const emit = window.__PW_STUB__.emit;
  const VERSION = ${ports ? '"0.2.33"' : '"0.2.27"'};
  answers.experimental_settings = { nativeCodex: false, sessionCost: false, orchestratorRuns: false, localVmTasks: false };
  // This desktop's version, which the header compares with the machine's since PRO-352; the stub's generic plugin answer is not a string.
  answers["plugin:app|version"] = "0.2.33";
  answers.machines_list = [{ machineId: "m-mini", name: "Mac mini", os: { family: "macos", version: "26.1" }, version: VERSION, publicKeyB64: "a2V5",
    directEndpoints: ["ws://192.168.1.20:6768/machine/1"], route: "relayAndNearby", pairedAt: Date.parse("2026-11-10T09:00:00Z"), lastSeenAt: Date.now(), lastRoute: null, relay: null }];
  let view = { state: "direct", route: { kind: "tailscale", endpoint: "ws://100.64.0.7:6768/machine/1" }, since: Date.now(), rttMs: 9 };
  answers.machines_connections = () => [{ machineId: "m-mini", state: view }];

  const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const project = { projectId: "p-tx", name: "terminalx", path: "/Users/paresh/code/terminalx", kind: "git", defaultBranch: "main", archived: false };
  const cwd = project.path + "/.raccoon/worktrees/read-markers";
  const sessions = [{ id: "s-read", projectId: "p-tx", projectPath: project.path, cwd, title: "${TITLE}", branch: "read-markers",
    created: ago(63), modified: ago(3), lastMessageAt: ago(3), hasMessages: true, archived: false, pinned: false,
    tabs: [{ id: "t-read", harness: "claude", title: "Read markers", status: "completed", created: ago(90), lastMessageAt: null }], activeTab: "t-read" }];
  const tabs = () => [{ sessionId: "s-read", tabId: "t-read", title: "Read markers", harness: "claude", model: "", effort: null, permissionMode: "default",
    status: "completed", process: "idle", pendingPermissions: [], followUps: [], lastSeq: 0, created: ago(90), lastMessageAt: ago(3),
    sessionCreated: ago(63), sessionLastMessageAt: ago(3), sessionHasMessages: true }];
  let seq = 0;
  const event = (payload) => ({ id: "e" + ++seq, seq, sessionId: "s-read", tabId: "t-read", harness: "claude", ts: new Date(Date.now() - 600_000 + seq * 1000).toISOString(), payload });
  const events = [
    event({ type: "user_message", text: "Start the console and the API so I can check the read markers.", queued: false }),
    event({ type: "turn_started" }),
    event({ type: "assistant_text", text: "Started bun run dev: the API on 8787 and the console on 5173. Redis is on 6379." }),
    event({ type: "turn_completed", status: "ok", authFailed: false, durationMs: 228000 }),
  ];

  // What listens on Mac mini, as ports.list names it (PRO-355).
  const listed = [
    { port: 5173, process: { name: "vite", pid: 4100, cwd: project.path + "/console" } },
    { port: 6379, process: { name: "redis-server", pid: 312, cwd: "/" } },
    { port: 8787, process: { name: "bun", pid: 4101, cwd: project.path + "/api" } },
    { port: 9229, process: { name: "bun", pid: 4102, cwd: project.path + "/inspector" } },
  ];

  const frames = (window.__PW_FRAMES__ = []);
  let sub = 0;
  const CONNECTION = "conn-m-mini";
  let link = 0;
  const capabilities = ["pty/1", "pty/2", "fs/1", "git/1", "session/1", "session/2", "keys/1", "agents/1", "composer/2", "machine/1", "machine/2", "agent-commands/1"]
    .concat(${ports ? '["ports/1"]' : "[]"});
  const transport = () => {
    if (view.state === "direct" || view.state === "relay") {
      link++;
      return { state: "connected", runtimeGeneration: 1, runtimeEpoch: "e1", runtimeVersion: VERSION, authority: "manage", link, capabilities };
    }
    return view.state === "reconnecting" ? { state: "reconnecting", attempt: 1, reason: "network", retryInMs: 2000 } : { state: "connecting", attempt: 1 };
  };
  const sendState = () => setTimeout(() => emit("cloud_remote_event", { kind: "state", connectionId: CONNECTION, state: transport() }), 0);
  const deliver = (message) => setTimeout(() => emit("cloud_remote_event", { kind: "message", connectionId: CONNECTION, message }), 0);
  const reply = (id, result) => deliver({ id, ok: true, result });
  const refuse = (id, code) => deliver({ id, ok: false, error: { code, message: code } });
  answers.machine_remote_attach = () => (sendState(), CONNECTION);
  answers.cloud_remote_send = ({ frame }) => {
    const params = frame.params ?? {};
    frames.push({ method: frame.method, params });
    switch (frame.method) {
      case "machine.projects": reply(frame.id, { projects: [project] }); break;
      case "session.list": reply(frame.id, { sessions }); break;
      case "session.tabs": reply(frame.id, { tabs: tabs() }); break;
      case "session.subscribe": reply(frame.id, { subscriptionId: "sub-" + ++sub, events: events.map((e) => ({ cursor: "1:" + e.seq, event: e })), cursor: "1:" + seq }); break;
      case "pty.list": reply(frame.id, { epoch: "e1", terminals: [] }); break;
      case "fs.watch": reply(frame.id, { subscriptionId: "sub-" + ++sub }); break;
      case "git.repositories": reply(frame.id, { repositories: [] }); break;
      case "fs.list": reply(frame.id, { path: params.path ?? "", entries: [] }); break;
      case "runtime.agents": reply(frame.id, { agents: [] }); break;
      case "ports.list": reply(frame.id, { detected: true, ports: listed, streams: [] }); break;
      case "session.unsubscribe": case "fs.unwatch": case "session.markRead": case "session.nudge": reply(frame.id, {}); break;
      default: refuse(frame.id, "method_not_found");
    }
    return true;
  };
  answers.machines_reconnect = null;
  answers.cloud_remote_detach = null;

  // ---- this Mac's forwarder (src-tauri), as the contract in src/lib/api.ts has it.
  const forwarder = (window.__PW_PORTS__ = { forwards: [], settings: { enabled: true, auto: false }, calls: [], opened: [] });
  const announce = (opened = []) => emit("cloud_port_forwards_changed", { connectionId: CONNECTION, forwards: forwarder.forwards, settings: forwarder.settings, opened });
  const away = () => !(view.state === "direct" || view.state === "relay");
  answers.cloud_port_forwards = () => forwarder.forwards;
  answers.cloud_port_settings = () => forwarder.settings;
  answers.cloud_port_set_settings = ({ enabled, auto }) => {
    forwarder.calls.push({ command: "cloud_port_set_settings", enabled, auto });
    forwarder.settings = { enabled: enabled ?? forwarder.settings.enabled, auto: auto ?? forwarder.settings.auto };
    forwarder.forwards = forwarder.forwards.map((f) => ({ ...f, state: forwarder.settings.enabled && !away() ? "open" : "waiting" }));
    announce();
    return forwarder.settings;
  };
  answers.cloud_port_forward = ({ port, localPort, exact }) => {
    forwarder.calls.push({ command: "cloud_port_forward", port, localPort, exact });
    const forward = { port, localPort: localPort ?? port, reassigned: false, state: "open", auto: false };
    forwarder.forwards = [...forwarder.forwards.filter((f) => f.port !== port), forward].sort((a, b) => a.port - b.port);
    announce();
    return forward;
  };
  answers.cloud_port_unforward = ({ port }) => {
    forwarder.calls.push({ command: "cloud_port_unforward", port });
    forwarder.forwards = forwarder.forwards.filter((f) => f.port !== port);
    announce();
    return true;
  };
  // A forward that opened without a click here (automatic forwarding): the toast's.
  forwarder.autoForward = (port) => {
    const forward = { port, localPort: port, reassigned: false, state: "open", auto: true };
    forwarder.forwards = [...forwarder.forwards.filter((f) => f.port !== port), forward].sort((a, b) => a.port - b.port);
    announce([forward]);
  };
  // A listener that closed here without a Stop: its address expires.
  forwarder.close = (port) => {
    forwarder.forwards = forwarder.forwards.filter((f) => f.port !== port);
    announce();
  };

  // ---- TerminalX's built-in browser.
  const pages = [];
  answers.chats_dir = "/Users/paresh/.raccoon/Chats";
  answers.browser_pages = () => pages;
  answers.browser_open_tab = ({ workspace, url }) => {
    forwarder.opened.push({ workspace, url });
    const page = { id: "page-" + pages.length, browserPageId: "page-" + pages.length, profileId: "default", tabId: "browser-tab", url, title: "console", workspacePath: workspace, created: new Date().toISOString(), active: true, index: pages.length };
    pages.push(page);
    emit("browser_pages_changed", { pages });
    return page;
  };
  answers.browser_activate_page = null;
  answers.copy_text = null;
  const system = (window.__PW_SYSTEM_OPENS__ = []);
  answers["plugin:opener|open_url"] = ({ url }) => { system.push(url); };

  window.__PW_MACHINE__ = (state) => {
    view = state;
    emit("machines_connection_changed", { machineId: "m-mini", state });
    sendState();
    // The forwarder follows the link: waiting while it is away, open again when it is back.
    const back = !away() && forwarder.settings.enabled;
    const before = forwarder.forwards;
    forwarder.forwards = before.map((f) => ({ ...f, state: back ? "open" : "waiting" }));
    announce(back ? forwarder.forwards.filter((f, i) => before[i].state === "waiting") : []);
  };
})();`;

const scrollsSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
const portsTab = (page) => page.locator("main aside button").filter({ hasText: /^Ports/ });
const rowStates = (scope) =>
  scope.locator('[data-testid="cloud-port"]').evaluateAll((rows) =>
    rows.map((row) => ({
      port: row.getAttribute("data-port"),
      state: row.getAttribute("data-state"),
      label: row.querySelector('[data-testid="cloud-port-process"]')?.textContent ?? "",
      text: row.textContent,
    })),
  );

async function openSession(page) {
  await sidebar(page);
  const row = page.locator(`[data-testid="machine-session-row"][title="read-markers · ${TITLE}"]`);
  await row.waitFor();
  await row.click();
  await page.locator('main [data-testid="machine-tab-strip"]').waitFor();
  await page.locator("main [data-chat-scroller]").getByText("Started bun run dev").waitFor();
  if (!(await page.locator("main aside").count())) await page.getByRole("button", { name: "Toggle panel" }).click();
  await page.waitForTimeout(250);
}

const server = await serve();
const browser = await launch();
let failed = 0;

for (const colorScheme of ["light", "dark"]) {
  const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1440, height: 900 }, { extra: fixture(true), colorScheme });
  await openSession(page);
  const chip = page.locator('main header [data-testid="port-forward-chip"]');
  await chip.waitFor();

  // ---- 14.10: the popover, from the header's chip.
  {
    await chip.click();
    const popover = page.locator('[data-testid="ports-popover"]');
    await popover.waitFor();
    await popover.locator('[data-testid="cloud-port"]').first().waitFor();
    await popover.locator('[data-port="5173"]').getByRole("button", { name: "Forward" }).click();
    await popover.locator('[data-port="5173"][data-state="open"]').waitFor();
    await popover.getByRole("switch", { name: "Forward new ports automatically" }).click();
    await page.waitForFunction(() => window.__PW_PORTS__.settings.auto === true, null, { timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(200);
    await shoot(page, `14.10-popover-${colorScheme}`);
    const rows = await rowStates(popover);
    const words = await popover.textContent();
    const actions = await popover.locator('[data-port="5173"] button').evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label")));
    const count = await chip.textContent();
    failed += report(`popover (${colorScheme})`, {
      "it is Forward ports to this Mac": /Forward ports/.test(words) && /to this Mac/.test(words),
      "it has the Forwarding and automatic switches": (await popover.getByRole("switch").count()) === 2,
      "turning on automatic forwarding reaches the desktop": await page.evaluate(() => window.__PW_PORTS__.calls.some((c) => c.command === "cloud_port_set_settings" && c.auto === true)),
      "PORTS DETECTED lists every listener, forwarded first": rows.length === 4 && rows[0].port === "5173" && rows[0].state === "open",
      "each row names its program and folder": rows.find((r) => r.port === "5173")?.label === "vite · console" && rows.find((r) => r.port === "6379")?.label === "redis-server",
      "a forwarded row has Open, Copy and Stop": actions.includes("Open in the built-in browser") && actions.some((a) => a?.startsWith("Copy")) && actions.includes("Stop forwarding 5173"),
      "the others have Forward": rows.filter((r) => r.state === "listening").length === 3,
      "it has + Forward a port": (await popover.getByRole("button", { name: "Forward a port" }).count()) === 1,
      "the footnote names Mac mini and the skipped range": /encrypted connection to Mac mini/.test(words) && /32768–60999/.test(words),
      "no preview link": !/preview link/i.test(words),
      "the chip counts the open forward": /1/.test(count ?? ""),
    }, { rows, words, actions, count });
    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
  }

  // ---- 21.08: the header's chip and the panel's "Ports 1".
  {
    await page.waitForTimeout(150);
    await shoot(page, `21.08-header-${colorScheme}`);
    const m = await page.evaluate(() => {
      const header = document.querySelector("main header");
      const chip = header?.querySelector('[data-testid="port-forward-chip"]');
      const toggle = header?.querySelector('button[aria-label="Toggle panel"]');
      const tab = [...document.querySelectorAll("main aside button")].find((b) => /^Ports/.test(b.textContent ?? ""));
      return {
        chip: chip?.textContent ?? null,
        chipBeforeToggle: !!chip && !!toggle && chip.getBoundingClientRect().right <= toggle.getBoundingClientRect().left + 1,
        tab: tab?.textContent ?? null,
      };
    });
    failed += report(`header (${colorScheme})`, {
      "the chip shows one forward": m.chip === "1",
      "the chip sits with the header's actions": m.chipBeforeToggle,
      "the panel's tab reads Ports 1": m.tab === "Ports1" || m.tab === "Ports 1",
      "nothing scrolls sideways": !(await scrollsSideways(page)),
    }, m);
  }

  // ---- The toast: a port forwarded automatically, opened in the built-in browser.
  {
    await page.evaluate(() => window.__PW_PORTS__.autoForward(8787));
    const toast = page.locator('main [data-testid="port-toast"]');
    await toast.waitFor({ timeout: 5_000 });
    await page.waitForTimeout(150);
    await shoot(page, `14.10-toast-${colorScheme}`);
    const words = await toast.textContent();
    await toast.getByRole("button", { name: "Open" }).click();
    await page.waitForFunction(() => window.__PW_PORTS__.opened.length > 0, null, { timeout: 5_000 }).catch(() => undefined);
    const opened = await page.evaluate(() => ({ terminalx: window.__PW_PORTS__.opened, system: window.__PW_SYSTEM_OPENS__ }));
    failed += report(`toast (${colorScheme})`, {
      "it says the port and its address": /Port 8787 forwarded to 127\.0\.0\.1:8787/.test(words ?? ""),
      "it names the program on Mac mini": /bun · api on Mac mini/.test(words ?? ""),
      "Open opens TerminalX's browser at the address": opened.terminalx.length === 1 && opened.terminalx[0].url === "http://127.0.0.1:8787" && !opened.terminalx[0].workspace.startsWith("machine"),
      "never the system browser": opened.system.length === 0,
      "the chip counts both forwards": (await chip.textContent()) === "2",
    }, { words, opened });
  }

  // ---- 14.11: the Ports tab, with an expired forward.
  {
    await page.evaluate(() => window.__PW_PORTS__.close(8787));
    await portsTab(page).click();
    const tab = page.locator('main [data-testid="panel-ports"]');
    await tab.locator('[data-testid="cloud-port"]').first().waitFor();
    await tab.locator('[data-port="8787"][data-state="expired"]').waitFor({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(200);
    await shoot(page, `14.11-ports-tab-${colorScheme}`);
    const words = await tab.textContent();
    const rows = await rowStates(tab);
    const struck = await tab.locator('[data-port="8787"] .line-through').textContent().catch(() => null);
    failed += report(`ports tab (${colorScheme})`, {
      "its header is Ports and previews with Forwarding": /Ports and previews/.test(words) && (await tab.getByRole("switch", { name: "Forwarding" }).count()) === 1,
      "FORWARDED has the open and the expired forward": (await tab.getByRole("region", { name: "Forwarded", exact: true }).locator('[data-testid="cloud-port"]').count()) === 2,
      "NOT FORWARDED has the rest": (await tab.getByRole("region", { name: "Not forwarded", exact: true }).locator('[data-testid="cloud-port"]').count()) === 2,
      "the expired address is struck through, with Start again": struck === "127.0.0.1:8787" && (await tab.locator('[data-port="8787"]').getByRole("button", { name: "Start again" }).count()) === 1,
      "the port field names Mac mini and keeps the number": (await tab.getByRole("textbox", { name: "Port on Mac mini" }).count()) === 1 && /Same port number on this Mac/.test(words),
      "no signed-in preview link": !/preview link|Signed-in/i.test(words),
      "nothing scrolls sideways": !(await scrollsSideways(page)),
    }, { rows, words, struck });
  }

  // ---- Mac mini reconnecting: the tab stays, its forwards wait, and return.
  {
    await page.evaluate(() => window.__PW_MACHINE__({ state: "reconnecting", lostAt: Date.now() - 12_000, attempt: 1, retryInMs: 2000, trying: ["lan", "relay"] }));
    const ports = page.locator('main [data-testid="cloud-panel-offline-ports"]');
    await ports.locator('[data-state="waiting"]').first().waitFor({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(200);
    await shoot(page, `21.09-reconnecting-ports-${colorScheme}`);
    const waiting = await rowStates(ports);
    const chipAway = await chip.count();
    await page.evaluate(() => window.__PW_MACHINE__({ state: "direct", route: { kind: "tailscale", endpoint: "ws://100.64.0.7:6768/machine/1" }, since: Date.now(), rttMs: 9 }));
    const tab = page.locator('main [data-testid="panel-ports"]');
    await tab.locator('[data-port="5173"][data-state="open"]').waitFor({ timeout: 5_000 }).catch(() => undefined);
    const back = await rowStates(tab);
    failed += report(`reconnecting (${colorScheme})`, {
      "the Ports tab stays while Mac mini reconnects": waiting.length > 0,
      "its forward waits, named as returning": waiting.some((r) => r.port === "5173" && r.state === "waiting" && /returns when Mac mini is back/.test(r.text)),
      "the chip stays": chipAway === 1,
      "it opens again when Mac mini is back": back.some((r) => r.port === "5173" && r.state === "open"),
    }, { waiting, back });
  }
  await page.close();
}

// ---- A Mac mini without ports/1: no chip, no Ports tab; the update line says so.
for (const colorScheme of ["light", "dark"]) {
  const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1440, height: 900 }, { extra: fixture(false), colorScheme });
  await openSession(page);
  const line = page.locator('main [data-testid="machine-hidden-features-line"]');
  await line.waitFor({ timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(200);
  await shoot(page, `21.09-update-line-${colorScheme}`);
  const words = (await line.textContent().catch(() => null)) ?? "";
  failed += report(`no ports/1 (${colorScheme})`, {
    "the update line says to update Mac mini to forward ports": /Mac mini runs TerminalX 0\.2\.27/.test(words) && /forward ports/.test(words),
    "no forward chip": (await page.locator('main header [data-testid="port-forward-chip"]').count()) === 0,
    "no Ports tab": (await portsTab(page).count()) === 0,
    "nothing asked the forwarder": await page.evaluate(() => window.__PW_PORTS__.calls.length === 0),
  }, { words });
  await page.close();
}

await browser.close();
server.close();
if (shots) console.log(`screenshots: ${shots}`);
process.exit(failed ? 1 : 0);
