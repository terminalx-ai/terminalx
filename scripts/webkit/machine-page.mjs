#!/usr/bin/env node
// PRO-350: a machine's page (screen 21.10) in the desktop's WebKit, with
// Experimental → Machines on, at the screen's width (1440×900) in the dark
// theme.
//
// Two paired machines over the relay:
//   - "dev-server" (headless Linux, 0.2.33, every namespace incl. machine/4):
//     Claude Code signed in, Codex installed and not signed in, Gemini CLI not
//     installed and installable; 8 cores, CPU, memory and disk.
//   - "old-box" (0.2.29, no machine/4): runtime.agents without sign-in states
//     or missing agents, lifecycle.resources without cpu.
// Shown in turn, each captured:
//   - dev-server's page: header with fingerprint and Rename, Agents, Resources
//     and Remove this machine (machine-page).
//   - Sign in to Codex: machine.agentSetup names only the agent and the step,
//     and its terminal shows under Codex's row (setup-running).
//   - The sign-in exits 74: "Sign-in did not finish", output kept (setup-failed).
//   - Install Gemini CLI, refused as setup_busy from the machine's own window:
//     the refusal's message (setup-busy).
//   - old-box's page: agents with no state, no Install or Sign in, no CPU bar
//     (machine-page-older).
//   - Remove: the confirmation (remove-confirm).
// In each: no text is under 12 px and nothing scrolls sideways.
//
// Pictures go to MACHINES_SHOTS, by default
// scripts/webkit/output/machine-page; that default folder ignores itself.
//
//   pnpm build && npx playwright install webkit && node scripts/webkit/machine-page.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const output = fileURLToPath(new URL("./output/", import.meta.url));
const shots = process.env.MACHINES_SHOTS ?? join(output, "machine-page");
await mkdir(shots, { recursive: true });
if (!process.env.MACHINES_SHOTS) await writeFile(join(output, ".gitignore"), "*\n");

const ALL = ["pty/1", "pty/2", "fs/1", "git/1", "session/1", "session/2", "session/3", "session-status/1", "session-repository/1", "lifecycle/1", "agents/1", "agent-pty/1",
  "composer/1", "composer/2", "composer/3", "ports/1", "cleanup/1", "workspace/1", "workspace/2", "pipeline/1", "pipeline/2", "agent-commands/1",
  "machine/1", "machine/2", "machine/3", "machine/4"];
const OLDER = ALL.filter((capability) => capability !== "machine/4");

// Runs in the page, after the stub.
const fixture = `(() => {
  const answers = window.__PW_STUB__.answers;
  const emit = window.__PW_STUB__.emit;
  answers.experimental_settings = { nativeCodex: false, sessionCost: false, orchestratorRuns: false, localVmTasks: false, machines: true };
  answers["plugin:app|version"] = "0.2.33";
  const machine = (patch) => ({ os: { family: "linux", version: "24.04" }, publicKeyB64: "a2V5", directEndpoints: [], route: "relayAndNearby", hasWindow: false,
    pairedAt: Date.parse("2026-11-12T09:00:00Z"), lastSeenAt: Date.now(), lastRoute: null, relay: null, ...patch });
  answers.machines_list = [
    machine({ machineId: "PB4eLHf3wXc1qD9z", name: "dev-server", version: "0.2.33" }),
    machine({ machineId: "Zk2mN8sQ4rT6vW1y", name: "old-box", version: "0.2.29" }),
  ];
  const ids = { dev: "PB4eLHf3wXc1qD9z", old: "Zk2mN8sQ4rT6vW1y" };
  const connected = { state: "relay", route: { kind: "relay", endpoint: null }, since: Date.now(), rttMs: 41 };
  answers.machines_connections = () => Object.values(ids).map((machineId) => ({ machineId, state: connected }));
  const caps = { [ids.dev]: ${JSON.stringify(ALL)}, [ids.old]: ${JSON.stringify(OLDER)} };
  const versions = { [ids.dev]: "0.2.33", [ids.old]: "0.2.29" };
  answers.machine_remote_attach = ({ machineId }) => {
    setTimeout(() => emit("cloud_remote_event", { kind: "state", connectionId: "conn-" + machineId,
      state: { state: "connected", runtimeGeneration: 1, runtimeEpoch: "e1", runtimeVersion: versions[machineId], authority: "manage", link: 1, capabilities: caps[machineId] } }), 0);
    return "conn-" + machineId;
  };
  const GB = 1e9;
  const agents = {
    ["conn-" + ids.dev]: {
      agents: [
        { id: "claude", name: "Claude Code", caps: {}, models: [], modes: [], defaultMode: "", version: "2.4.1", signIn: "signedIn", signInCheckedAt: Date.now() },
        { id: "codex", name: "Codex", caps: {}, models: [], modes: [], defaultMode: "", version: "0.62.0", signIn: "signedOut", signInCheckedAt: Date.now() },
      ],
      missing: [{ id: "gemini", name: "Gemini CLI", installable: true }],
    },
    ["conn-" + ids.old]: { agents: [
      { id: "claude", name: "Claude Code", caps: {}, models: [], modes: [], defaultMode: "" },
      { id: "codex", name: "Codex", caps: {}, models: [], modes: [], defaultMode: "" },
    ] },
  };
  let usage = 0.31;
  const resources = (connectionId) => ({
    v: 1, observedAt: Date.now(),
    memory: { totalBytes: 16 * GB, availableBytes: 6.8 * GB },
    storage: { totalBytes: 500 * GB, availableBytes: 212 * GB, totalInodes: 0, availableInodes: 0 },
    ...(connectionId === "conn-" + ids.dev ? { cpu: { cores: 8, usage: (usage = Math.min(0.9, usage + 0.07)) } } : {}),
  });
  const status = { method: "installer", current: "0.2.33", available: null, checkedAt: Date.now(), blockers: [], otherComputers: [], kept: ["0.2.33"], progress: { phase: "idle" } };
  window.__PW_SETUP_SENT__ = [];
  window.__PW_SETUP_BUSY__ = false;
  const reply = (connectionId, id, result) => setTimeout(() => emit("cloud_remote_event", { kind: "message", connectionId, message: { id, ok: true, result } }), 0);
  const refuse = (connectionId, id, code, message, data) => setTimeout(() => emit("cloud_remote_event", { kind: "message", connectionId, message: { id, ok: false, error: { code, message, ...(data ? { data } : {}) } } }), 0);
  const notify = (connectionId, event, params) => setTimeout(() => emit("cloud_remote_event", { kind: "message", connectionId, message: { event, params } }), 0);
  const b64 = (text) => btoa(unescape(encodeURIComponent(text)));
  const empty = { "pty.list": { epoch: "e1", terminals: [] }, "git.repositories": { repositories: [] }, "fs.list": { path: "", entries: [] },
    "session.list": { sessions: [] }, "ports.list": { ports: [] }, "machine.projects": { projects: [] }, "machine.agentSetupRunning": { run: null } };
  let subscriptions = 0;
  window.__PW_SETUP_EXIT__ = (code) => {
    const sub = window.__PW_SETUP_SUB__;
    if (!sub) return;
    notify(sub.connectionId, "pty.output", { subscriptionId: sub.id, data: b64("\\r\\nError: the device code expired before it was used.\\r\\n"), offset: sub.offset });
    notify(sub.connectionId, "pty.exit", { subscriptionId: sub.id, code });
  };
  answers.cloud_remote_send = ({ connectionId, frame }) => {
    const { method, id, params } = frame;
    if (method === "runtime.agents") reply(connectionId, id, agents[connectionId]);
    else if (method === "lifecycle.resources") reply(connectionId, id, resources(connectionId));
    else if (method === "machine.updateStatus") reply(connectionId, id, status);
    else if (method === "machine.agentSetup") {
      window.__PW_SETUP_SENT__.push(params);
      if (window.__PW_SETUP_BUSY__) refuse(connectionId, id, "setup_busy", "Gemini CLI is being installed from dev-server's own window. Try again when it finishes.");
      else reply(connectionId, id, { ptyId: "setup-1", number: 0, epoch: "e1", pid: 4242, cwd: "/home/paresh", cols: params.cols, rows: params.rows, createdAt: Date.now(),
        offset: 0, exited: false, exitCode: null, control: "you", setup: { harness: params.harness, step: params.step } });
    } else if (method === "pty.attach") {
      const text = "$ codex login --device-auth\\r\\n\\r\\nWelcome to Codex.\\r\\nOpen this link on any device and sign in:\\r\\n  https://auth.openai.com/codex/device\\r\\n\\r\\nThen enter this one-time code:  ABCD-1234\\r\\n\\r\\nWaiting for sign-in…";
      const sub = { id: "sub-" + ++subscriptions, connectionId, offset: text.length };
      window.__PW_SETUP_SUB__ = sub;
      reply(connectionId, id, { subscriptionId: sub.id, ptyId: params.ptyId, epoch: "e1", data: b64(text), offset: 0, end: text.length, control: "you", cols: 100, rows: 14, exited: false });
    } else if (method in empty) reply(connectionId, id, empty[method]);
    else reply(connectionId, id, {});
    return true;
  };
  answers.machines_remove = true;
  answers.machines_reconnect = null;
  answers.cloud_remote_detach = null;
})();`;

/** Text under 12 px, and whether `root` scrolls sideways. */
const measure = (page, selector) =>
  page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) return null;
    const small = [...root.querySelectorAll("*")]
      .filter((node) => node.getClientRects().length && [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim()))
      .filter((node) => !node.closest(".sr-only") && !node.closest(".xterm") && parseFloat(getComputedStyle(node).fontSize) < 12)
      .map((node) => node.textContent.trim());
    return { text: root.textContent, small, sideways: root.scrollWidth > root.clientWidth + 1 };
  }, selector);

const server = await serve();
const browser = await launch();
let failed = 0;
const viewport = { width: 1440, height: 900 };
const shot = (page, id) => page.screenshot({ path: join(shots, `${id}-design-dark.png`) });

async function openPage(page, name) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const main = page.getByRole("main", { name: "Settings", exact: true });
  await main.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Machines", exact: true }).click();
  await main.getByTestId("machines-settings").waitFor();
  const card = main.locator('[data-testid="paired-machine"]', { hasText: name });
  await card.hover();
  await card.getByRole("button", { name: `More for ${name}` }).click();
  await page.getByRole("menuitem", { name: /Version and updates/ }).click();
  await main.getByTestId("machine-page").waitFor();
  return main;
}

const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, viewport, { extra: fixture, colorScheme: "dark" });
await sidebar(page);

// 21.10: dev-server's page.
let main = await openPage(page, "dev-server");
const row = (id) => main.locator(`[data-testid="machine-agent"][data-agent="${id}"]`);
await row("gemini").waitFor();
await main.getByTestId("machine-resources-summary").waitFor();
await page.waitForTimeout(300);
let m = await measure(page, '[data-testid="machine-page"]');
failed += report("dev-server's page", {
  "the meta line names its fingerprint": /fingerprint [0-9A-F]{4}·[0-9A-F]{4}/.test(await main.getByTestId("machine-page-meta").textContent()),
  "it has Rename": (await main.getByRole("button", { name: "Rename" }).count()) === 1,
  "Claude Code is signed in": (await row("claude").textContent()).includes("2.4.1 · sessions here use this server’s sign-in") && (await row("claude").textContent()).includes("Signed in"),
  "Codex offers Sign in": (await row("codex").textContent()).includes("Installed · not signed in") && (await row("codex").getByRole("button", { name: /Sign in/ }).count()) === 1,
  "Gemini CLI offers Install": (await row("gemini").textContent()).includes("Not installed") && (await row("gemini").getByRole("button", { name: /Install/ }).count()) === 1,
  "Resources says 8 cores": (await main.getByTestId("machine-resources-summary").textContent()).startsWith("8 cores · updated"),
  "Resources shows CPU, Memory and Disk": (await main.getByTestId("machine-resource").count()) === 3,
  "memory reads used of total": m.text.includes("9.2 of 16 GB"),
  "disk reads free": m.text.includes("212 GB free"),
  "it has Remove this machine": m.text.includes("Remove this machine"),
  "no text is under 12 px": m.small.length === 0,
  "nothing scrolls sideways": !m.sideways,
}, m.small);
await shot(page, "machine-page");

// Resources are asked again while the page is open.
const before = await main.getByTestId("machine-resource").first().textContent();
await page.waitForTimeout(5_500);
failed += report("dev-server's resources", { "CPU is read again within 5 s": (await main.getByTestId("machine-resource").first().textContent()) !== before });

// Sign in to Codex: a terminal on the machine under its row.
await row("codex").getByRole("button", { name: /Sign in/ }).click();
await row("codex").getByTestId("machine-agent-setup-terminal").waitFor();
await page.waitForTimeout(500);
const sent = await page.evaluate(() => window.__PW_SETUP_SENT__[0]);
m = await measure(page, '[data-testid="machine-page"]');
failed += report("Sign in to Codex", {
  "only the agent and the step are sent": JSON.stringify(Object.keys(sent).sort()) === JSON.stringify(["cols", "harness", "rows", "step"]) && sent.harness === "codex" && sent.step === "login",
  "it says it is signing in": (await row("codex").getByTestId("machine-agent-setup").getAttribute("data-phase")) === "running",
  "its terminal shows the device code": (await row("codex").getByTestId("machine-agent-setup-terminal").textContent()).includes("ABCD-1234"),
  "no text is under 12 px": m.small.length === 0,
  "nothing scrolls sideways": !m.sideways,
}, { sent, small: m.small });
await shot(page, "setup-running");

// It exits 74: the sign-in did not finish.
await page.evaluate(() => window.__PW_SETUP_EXIT__(74));
await row("codex").getByRole("alert").waitFor();
await page.waitForTimeout(300);
failed += report("the sign-in fails", {
  "it says the sign-in did not finish": (await row("codex").getByRole("alert").textContent()).includes("Sign-in did not finish."),
  "its output stays": (await row("codex").getByTestId("machine-agent-setup-terminal").count()) === 1,
});
await shot(page, "setup-failed");

// Install, refused: the machine's own window runs it.
await page.evaluate(() => (window.__PW_SETUP_BUSY__ = true));
await row("gemini").getByRole("button", { name: /Install/ }).click();
await row("gemini").getByRole("alert").waitFor();
failed += report("Install while the machine's own window installs", {
  "it shows the refusal's message": (await row("gemini").getByRole("alert").textContent()).includes("being installed from dev-server's own window"),
});
await shot(page, "setup-busy");

// Remove: asked first.
await main.getByTestId("machine-remove").getByRole("button", { name: "Remove" }).click();
await page.getByTestId("remove-machine").waitFor();
await page.waitForTimeout(200);
await shot(page, "remove-confirm");
await page.getByTestId("remove-machine").getByRole("button", { name: "Cancel" }).click();
await page.close();

// An older runtime: agents without a state, nothing offered, no CPU.
{
  const older = await open(browser, server.url, { cloud: false, localProjects: 1 }, viewport, { extra: fixture, colorScheme: "dark" });
  await sidebar(older);
  main = await openPage(older, "old-box");
  const rows = main.getByTestId("machine-agent");
  await rows.nth(1).waitFor();
  await main.getByTestId("machine-resources-summary").waitFor();
  await older.waitForTimeout(300);
  m = await measure(older, '[data-testid="machine-page"]');
  failed += report("old-box's page", {
    "its agents show without a state": (await rows.nth(0).getByTestId("machine-agent-line").textContent()) === "Installed",
    "nothing offers Install or Sign in": (await main.getByTestId("machine-agents").getByRole("button").count()) === 0,
    "no error is shown for the agents": (await main.getByTestId("machine-agents").getByRole("alert").count()) === 0,
    "no CPU bar": (await main.locator('[data-testid="machine-resource"][data-resource="cpu"]').count()) === 0,
    "no text is under 12 px": m.small.length === 0,
    "nothing scrolls sideways": !m.sideways,
  }, m.small);
  await older.screenshot({ path: join(shots, "machine-page-older-design-dark.png") });
  await older.close();
}

await browser.close();
server.close();
console.log(`screenshots: ${shots}`);
process.exit(failed ? 1 : 0);
