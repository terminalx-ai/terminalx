#!/usr/bin/env node
// The Machines screens 21.01 (sidebar and overview), 21.08 (a session on
// another machine) and 21.02 (Settings → Machines) in the desktop's WebKit at
// the screens' own size (1440×900), in the light and the dark theme, drawn
// from one world that matches the screens.
//
// The world:
//   - this Mac (Local): project terminalx; sessions "Show the diff inside edit
//     approvals" (needs approval) and "Notarize release builds" (PR #779).
//   - Mac mini (macOS, Direct over Tailscale): projects terminalx and
//     terminalx-server; sessions "Add read markers to the catalog feed"
//     (working, two agent tabs, a changed-files list, a branch), "Bisect the
//     flaky relay e2e" (needs approval) and "Seat-based Teams billing" (PR #212).
//   - dev-server (headless Linux, Relay): project tx-review-lab; sessions
//     "Nightly soak run" (working) and "Cache the Linux runtime build" (PR #790).
//   Settings → Machines lists those two and, besides them, ci-box (Linux, runs
//   TerminalX 0.2.27: Needs update) and Studio (macOS, Offline), and one
//   computer that can operate this Mac. Those two are paired only in the
//   Settings page's world, so the sidebar and session shots show the screens'
//   three machines.
// The runtimes are stubbed as machine-sidebar.mjs and machine-session.mjs do.
//
// Pictures, per theme:
//   21.01-sidebar-overview-<theme>.png    sidebar sections and the overview (Table), all machines
//   21.08-session-<theme>.png             a Mac mini session: header chip, "Runs on Mac mini" strip, transcript, changes panel, "Mac mini terminal 1"
//   21.02-settings-machines-<theme>.png   Settings → Machines
//   21.02-first-run-<theme>.png           Settings → Machines with no machine paired (PRO-360)
//   21.07-new-session-where-<theme>.png   the new-session form's Where it runs menu
// go to MACHINES_SCREENS_SHOTS, by default scripts/webkit/output/machines-screens
// (a folder that ignores itself). When MACHINES_DESIGNS names a folder holding
// 21.01.png, 21.02.png, 21.07.png and 21.08.png each shot also gets a
// <shot>-vs-design.png beside it, the design on the left.
//
// Checked per screen and theme: each machine the screen names appears, nothing
// scrolls sideways, no text is under 12 px. A failed check exits 1.
//
//   pnpm build && npx playwright install webkit && node scripts/webkit/machines-screens.mjs
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const output = fileURLToPath(new URL("./output/", import.meta.url));
const shots = process.env.MACHINES_SCREENS_SHOTS ?? join(output, "machines-screens");
const designs = process.env.MACHINES_DESIGNS || null;
await mkdir(shots, { recursive: true });
if (!process.env.MACHINES_SCREENS_SHOTS) await writeFile(join(shots, ".gitignore"), "*\n");

const VIEWPORT = { width: 1440, height: 900 };
const TITLE = "Add read markers to the catalog feed";
// Every feature this desktop uses, so no connected machine is shown as needing an update (PRO-354).
const CAPABILITIES = ["pty/1", "pty/2", "fs/1", "git/1", "session/1", "session/2", "session/3", "session-status/1", "session-repository/1", "lifecycle/1", "agents/1", "agent-pty/1",
  "composer/1", "composer/2", "composer/3", "composer/4", "ports/1", "cleanup/1", "workspace/1", "workspace/2", "pipeline/1", "pipeline/2", "agent-commands/1",
  "machine/1", "machine/2", "machine/3", "machine/4"];

// Runs in the page, after the stub. `settings` adds ci-box and Studio to the paired machines; `none` pairs none (PRO-360).
const fixture = (settings, none = false) => `(() => {
  const answers = window.__PW_STUB__.answers;
  const emit = window.__PW_STUB__.emit;
  const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  answers.experimental_settings = { nativeCodex: false, sessionCost: false, orchestratorRuns: false, localVmTasks: false };
  answers["plugin:app|version"] = "0.2.33";
  answers.machine_name = { name: "Paresh’s MacBook Pro", chosen: false, computerName: "Paresh’s MacBook Pro" };
  answers.machines_account_list = { signedIn: false };

  // ---- This Mac.
  const LOCAL = "/Users/me/code/terminalx";
  answers.list_projects = { projects: [{ path: LOCAL, name: "terminalx" }], lastSelected: LOCAL };
  const localRows = [
    { title: "Show the diff inside edit approvals", minutes: 6, tab: "waiting", lines: [48, 6], facts: { tabs: [{ status: "waiting" }], branch: "edit-diff", started: true, work: "uncommitted", branchStatus: null } },
    { title: "Notarize release builds", minutes: 300, tab: "idle", lines: [0, 0], facts: { tabs: [{ status: "idle" }], branch: "notarize", started: true, work: "none",
      branchStatus: { branch: "notarize", checked: true, headMatches: true, pr: { number: 779, state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", checks: "SUCCESS", inMergeQueue: false } } } },
  ];
  const localFacts = {};
  answers.list_sessions = localRows.map((row, index) => {
    const id = "local-" + index;
    const branch = row.facts.branch;
    const at = ago(row.minutes);
    localFacts[id] = row.facts;
    return { id, projectPath: LOCAL, cwd: LOCAL + "/.raccoon/worktrees/" + branch, branch, title: row.title, worktreeName: branch, worktreeRemoved: false,
      created: at, modified: at, lastMessageAt: at, hasMessages: true, archived: false, pinned: false,
      tabs: [{ id: id + "-tab", title: row.title, harness: "codex", model: "", permissionMode: "manual", status: row.tab, created: at, modified: at, lastMessageAt: at }], activeTab: id + "-tab" };
  });
  answers.list_workspaces = () => localRows.map((row) => ({ path: LOCAL + "/.raccoon/worktrees/" + row.facts.branch, name: row.facts.branch, branch: row.facts.branch, placeholder: true, head: null, isMain: false, managed: true,
    uncommitted: row.lines[0] ? 1 : 0, additions: row.lines[0], deletions: row.lines[1], branchAdditions: row.lines[0], branchDeletions: row.lines[1], unpushed: 0, ahead: 0, behind: 0 }));
  answers.session_row_statuses = ({ ids }) => Object.fromEntries(ids.map((id) => [id, localFacts[id]]));
  answers.session_summaries = [];
  answers.project_overview = { defaultBranch: "main", branches: [], contributors: [], latest: [], recentCommits: 0, pullRequests: null };

  // ---- The paired machines.
  const machine = (patch) => ({ os: { family: "macos", version: "26.1" }, version: "0.2.33", publicKeyB64: "a2V5", directEndpoints: ["ws://192.168.1.20:6768/machine/1"], hasWindow: true,
    route: "relayAndNearby", pairedAt: Date.parse("2026-11-10T09:00:00Z"), lastSeenAt: Date.now(), lastRoute: null, relay: null, ...patch });
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(18, 40, 0, 0);
  const paired = [
    machine({ machineId: "m-mini", name: "Mac mini" }),
    machine({ machineId: "m-server", name: "dev-server", os: { family: "linux", version: "24.04" }, hasWindow: false }),
    ${settings ? `machine({ machineId: "m-ci", name: "ci-box", os: { family: "linux", version: "24.04" }, version: "0.2.27", hasWindow: false }),
    machine({ machineId: "m-studio", name: "Studio", lastSeenAt: yesterday.getTime() }),` : ""}
  ];
  answers.machines_list = paired;
  const views = {
    "m-mini": { state: "direct", route: { kind: "tailscale", endpoint: "ws://100.64.0.7:6768/machine/1" }, since: Date.now(), rttMs: 9 },
    "m-server": { state: "relay", route: { kind: "relay", endpoint: null }, since: Date.now(), rttMs: 41 },
    "m-ci": { state: "needsUpdate", version: "0.2.27", side: "machine" },
    "m-studio": { state: "offline", lastSeenAt: yesterday.getTime(), retryInMs: 10_000 },
  };
  answers.machines_connections = () => paired.map((m) => ({ machineId: m.machineId, state: views[m.machineId] }));
  ${none ? "paired.length = 0;" : ""}

  // Computers that can operate this Mac (Settings → Machines).
  answers.machines_host_status = { allowOperating: true, keepAwake: true, status: { enabled: true, hostKey: "ready", machineId: "host-1", listening: "0.0.0.0:6768", takesPort: true, phoneRoute: false,
    computers: [{ id: "computer-1", label: "Paresh’s MacBook Air", platform: "macos", approvedAt: Date.parse("2026-11-03T09:00:00Z"), lastSeenAt: Date.now(), connected: true }],
    error: null, pending: null, code: null, pausedUntil: null } };

  // ---- Their runtimes.
  const project = (projectId, name, path) => ({ projectId, name, path, kind: "git", defaultBranch: "main", archived: false });
  const tab = (id, status, title = null) => ({ id, harness: "claude", title, status, created: ago(90), lastMessageAt: null });
  const pr = (number) => ({ tabs: [{ status: "idle" }], branch: "feature", started: true, work: "none",
    branchStatus: { branch: "feature", checked: true, headMatches: true, pr: { number, state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", checks: "SUCCESS", inMergeQueue: false } } });
  const MINI = "/Users/me/code/terminalx";
  const session = (id, projectId, path, title, minutes, tabs, patch = {}) => ({ id, projectId, projectPath: path, cwd: path, title,
    created: ago(minutes + 60), modified: ago(minutes), lastMessageAt: ago(minutes), hasMessages: true, archived: false, pinned: false, tabs, activeTab: tabs[0]?.id ?? null, ...patch });
  const runtimes = {
    "m-mini": {
      projects: [project("p-tx", "terminalx", MINI), project("p-txs", "terminalx-server", "/Users/me/code/terminalx-server")],
      sessions: [
        session("s-read", "p-tx", MINI, ${JSON.stringify(TITLE)}, 3, [tab("t-read", "completed", "Read markers"), tab("t-cursor", "in_progress", "Review the cursor change")],
          { branch: "read-markers", cwd: MINI + "/.raccoon/worktrees/read-markers" }),
        session("s-flaky", "p-tx", MINI, "Bisect the flaky relay e2e", 11, [tab("t-flaky", "waiting", "Bisect")], { branch: "flaky-e2e" }),
        session("s-seats", "p-txs", "/Users/me/code/terminalx-server", "Seat-based Teams billing", 120, [tab("t-seats", "idle")], { branch: "feature", rowStatus: pr(212) }),
      ],
    },
    "m-server": {
      projects: [project("p-lab", "tx-review-lab", "/home/me/repos/tx-review-lab")],
      sessions: [
        session("s-soak", "p-lab", "/home/me/repos/tx-review-lab", "Nightly soak run", 42, [tab("t-soak", "in_progress")]),
        session("s-cache", "p-lab", "/home/me/repos/tx-review-lab", "Cache the Linux runtime build", 480, [tab("t-cache", "idle")], { branch: "feature", rowStatus: pr(790) }),
      ],
    },
  };
  const ASK = { requestId: "r-flaky", toolName: "Bash", input: { command: "git bisect run pnpm e2e:relay" },
    options: [{ id: "allow", label: "Allow", kind: "allow_once" }, { id: "deny", label: "Deny", kind: "deny" }] };
  const agentTab = (s, t) => ({ sessionId: s.id, tabId: t.id, title: t.title, harness: t.harness, model: "", effort: null, permissionMode: "default",
    status: t.status, process: t.status === "in_progress" ? "running" : "idle", pendingPermissions: t.id === "t-flaky" ? [ASK] : [],
    followUps: [], lastSeq: 0, created: t.created, lastMessageAt: s.lastMessageAt, sessionCreated: s.created, sessionLastMessageAt: s.lastMessageAt, sessionHasMessages: true });
  const tabsOf = (machineId) => runtimes[machineId].sessions.flatMap((s) => s.tabs.map((t) => agentTab(s, t)));

  // Mac mini's transcript for the session the screen opens.
  let seq = 0;
  const events = [];
  const event = (sessionId, tabId, payload) => ({ id: "e" + ++seq, seq, sessionId, tabId, harness: "claude", ts: new Date(Date.now() - 600_000 + seq * 1000).toISOString(), payload });
  events.push(
    event("s-read", "t-read", { type: "user_message", text: "Add read markers to the catalog feed so reading a session on one Mac clears it on every device. Keep the cursor behaviour.", queued: false }),
    event("s-read", "t-read", { type: "turn_started" }),
    event("s-read", "t-read", { type: "assistant_text", text: "The feed now carries a readAt marker per session. Opening a session posts the marker, and every other device clears its unread dot on the next feed page.\\n\\nThe cursor is unchanged: a marker moves a session to a new page only when its unread state flips. \`pnpm vitest run src/lib/cloudCatalog.test.ts\` passes 38 tests." }),
    event("s-read", "t-read", { type: "turn_completed", status: "ok", authFailed: false, durationMs: 228000 }),
    event("s-flaky", "t-flaky", { type: "user_message", text: "Bisect the flaky relay e2e", queued: false }),
    event("s-flaky", "t-flaky", { type: "turn_started" }),
    event("s-flaky", "t-flaky", { type: "permission_requested", ...ASK }),
  );
  const CHANGED = [
    { path: "src/lib/cloudCatalog.ts", status: "modified", additions: 96, deletions: 7 },
    { path: "src/lib/readMarkers.ts", status: "added", additions: 31, deletions: 0 },
    { path: "src/lib/cloudCatalog.test.ts", status: "modified", additions: 12, deletions: 2 },
    { path: "docs/CLOUD-SHARING.md", status: "modified", additions: 3, deletions: 0 },
  ];
  const WORKTREE = ".raccoon/worktrees/read-markers";

  const links = {};
  const transport = (machineId, view) => {
    switch (view.state) {
      case "direct":
      case "relay":
        links[machineId] = (links[machineId] ?? 0) + 1;
        return { state: "connected", runtimeGeneration: 1, runtimeEpoch: "e1", runtimeVersion: "0.2.33", authority: "manage", link: links[machineId], capabilities: ${JSON.stringify(CAPABILITIES)} };
      case "offline":
        return { state: "reconnecting", attempt: 0, reason: "offline", retryInMs: view.retryInMs };
      case "needsUpdate":
        return { state: "updateRequired" };
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
  const deliver = (connectionId, message) => setTimeout(() => emit("cloud_remote_event", { kind: "message", connectionId, message }), 0);
  const reply = (connectionId, id, result) => deliver(connectionId, { id, ok: true, result });
  const refuse = (connectionId, id, code) => deliver(connectionId, { id, ok: false, error: { code, message: code } });
  const terminals = [];
  let sub = 0;
  answers.cloud_remote_send = ({ connectionId, frame }) => {
    const machineId = connectionId.replace(/^conn-/, "");
    const runtime = runtimes[machineId];
    if (!runtime) return true;
    const params = frame.params ?? {};
    switch (frame.method) {
      case "machine.projects": reply(connectionId, frame.id, { projects: runtime.projects }); break;
      case "session.list": reply(connectionId, frame.id, { sessions: runtime.sessions }); break;
      case "session.tabs": reply(connectionId, frame.id, { tabs: tabsOf(machineId) }); break;
      case "session.subscribe": {
        const own = events.filter((e) => machineId === "m-mini" && e.sessionId === params.sessionId && (!params.tabId || e.tabId === params.tabId));
        reply(connectionId, frame.id, { subscriptionId: "sub-" + ++sub, events: own.map((e) => ({ cursor: "1:" + e.seq, event: e })), cursor: "1:" + seq });
        break;
      }
      case "pty.list": reply(connectionId, frame.id, { epoch: "e1", terminals: machineId === "m-mini" ? terminals : [] }); break;
      case "pty.create": {
        const created = { ptyId: "p" + (terminals.length + 1), number: terminals.length + 1, epoch: "e1", pid: 200, cwd: MINI + "/" + WORKTREE, cols: 80, rows: 24,
          createdAt: Date.now(), offset: 0, exited: false, exitCode: null, control: "you", controllerId: null, ...(params.sessionId ? { sessionId: params.sessionId } : {}) };
        terminals.push(created);
        reply(connectionId, frame.id, created);
        break;
      }
      case "pty.attach": {
        const found = terminals.find((t) => t.ptyId === params.ptyId);
        const screen = ["paresh@mac-mini read-markers $ pnpm vitest run src/lib", "✓ cloudCatalog.test.ts (38 tests) 412ms", "✓ readMarkers.test.ts (6 tests) 21ms",
          " Test Files  2 passed (2)", "      Tests  44 passed (44)", "paresh@mac-mini read-markers $ "].join("\\r\\n");
        if (found) reply(connectionId, frame.id, { subscriptionId: "sub-" + ++sub, ...found, data: screen, truncated: false });
        else refuse(connectionId, frame.id, "not_found");
        break;
      }
      case "git.repositories": reply(connectionId, frame.id, { repositories: machineId === "m-mini" ? [{ repo: WORKTREE, branch: "read-markers", head: "abc", remote: "origin", defaultBranch: "main" }] : [] }); break;
      case "git.status":
        reply(connectionId, frame.id, { repository: true, repo: params.repo, branch: "read-markers", head: "abc", upstream: null, ahead: 0, behind: 0, defaultBranch: "main", aheadOfBase: 1, dirty: true, operation: null, conflicted: [], files: [] });
        break;
      case "git.branchBase": reply(connectionId, frame.id, { aheadOfBase: 1, head: "abc" }); break;
      case "git.branchDiffSize":
        reply(connectionId, frame.id, { additions: 142, deletions: 9, aheadOfBase: 1, head: "abc" });
        break;
      case "git.reviewRange": reply(connectionId, frame.id, { target: "main", base: "base-tree", head: "live-tree" }); break;
      case "git.changesBetween":
      case "git.workingChanges": reply(connectionId, frame.id, { head: "abc", files: CHANGED, truncated: false }); break;
      case "git.log": reply(connectionId, frame.id, { commits: [] }); break;
      case "git.branches": reply(connectionId, frame.id, { branches: [], current: "read-markers", defaultBranch: "main" }); break;
      case "git.prs": reply(connectionId, frame.id, { branch: "read-markers", prs: [] }); break;
      case "ports.list": reply(connectionId, frame.id, { detected: true, ports: [{ port: 5173, process: { name: "vite", pid: 4100, cwd: MINI } }], streams: [] }); break;
      case "fs.watch": reply(connectionId, frame.id, { subscriptionId: "sub-" + ++sub }); break;
      case "fs.list": reply(connectionId, frame.id, { path: params.path ?? "", entries: [] }); break;
      case "runtime.agents": reply(connectionId, frame.id, { agents: [] }); break;
      case "session.unsubscribe": case "pty.detach": case "fs.unwatch": case "session.markRead": case "session.nudge": reply(connectionId, frame.id, {}); break;
      default: refuse(connectionId, frame.id, "method_not_found");
    }
    return true;
  };
  answers.machines_reconnect = null;
  answers.cloud_remote_detach = null;
})();`;

/** What the page draws: which names it says, whether it scrolls sideways, and the smallest text. */
const measure = (page) =>
  page.evaluate(() => {
    const shown = (element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden";
    };
    const texts = [...document.querySelectorAll("body *")].filter(
      (element) => shown(element) && !element.closest(".xterm, [data-terminal], script, style") && [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim()),
    );
    // The 12 px floor does not cover the small labels the designs use on purpose (PRO-384, PRO-385, PRO-346,
    // PRO-349), none under 10 px: keycaps; uppercase section, column and menu headings; a sidebar row's age and
    // PR tag; a machine's state badge and the header's chips; a changed file's status letter; the status bar.
    // A label only a screen reader gets is not drawn at all. Everything else is 12 px or larger.
    const DESIGNED_SMALL = [
      "kbd",
      '[data-testid="new-session-create"] span.border',
      '[data-testid="machine-session-row"] span.tabular-nums',
      '[data-testid="paired-machine"] span.rounded.h-5',
      '[data-testid="session-branch"]',
      '[data-testid="session-location"]',
      "[data-status]",
      "[data-status-bar]",
    ].join(", ");
    const designedSmall = (element) => parseFloat(getComputedStyle(element).fontSize) >= 10 && (getComputedStyle(element).textTransform === "uppercase" || !!element.closest(DESIGNED_SMALL));
    const small = texts.filter((element) => parseFloat(getComputedStyle(element).fontSize) < 12 && !element.closest(".sr-only") && !designedSmall(element)).map((element) => `${element.tagName.toLowerCase()}: ${element.textContent.trim().slice(0, 30)} (${getComputedStyle(element).fontSize})`);
    const list = document.querySelector('[data-testid="conversation-list"]');
    return {
      text: document.body.innerText,
      small,
      page: document.documentElement.scrollWidth > window.innerWidth + 1,
      sidebar: list ? list.scrollWidth > list.clientWidth + 1 : false,
    };
  });

/** The checks every screen has: its machines are named, nothing scrolls sideways, no text under 12 px but the designed small labels (`measure`). */
const common = (m, names) => ({
  ...Object.fromEntries(names.map((name) => [`${name} appears`, (name instanceof RegExp ? name : new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).test(m.text)])),
  "nothing scrolls sideways": !m.page && !m.sidebar,
  "no text under 12 px": m.small.length === 0,
});

// Entrances finish; a spinner turns for as long as it waits, so it does not count.
const settle = (page) =>
  page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running" || animation.effect?.getComputedTiming().iterations === Infinity));

async function besideDesign(browser, ours, design) {
  if (!designs || !existsSync(join(designs, design))) return;
  const side = await browser.newPage({ viewport: { width: 2896, height: 960 } });
  const data = async (path) => `data:image/png;base64,${(await readFile(path)).toString("base64")}`;
  await side.setContent(`<body style="margin:0;display:flex;gap:16px;padding:16px;background:#777;font:12px sans-serif;color:#fff">
    <figure style="margin:0"><figcaption>Design ${design}</figcaption><img style="width:1420px" src="${await data(join(designs, design))}"></figure>
    <figure style="margin:0"><figcaption>Built UI</figcaption><img style="width:1420px" src="${await data(ours)}"></figure></body>`);
  await side.screenshot({ path: ours.replace(/\.png$/, "-vs-design.png"), fullPage: true });
  await side.close();
}

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const mode of ["light", "dark"]) {
    const take = async (page, name, design) => {
      await settle(page);
      const path = join(shots, `${name}-${mode}.png`);
      await page.screenshot({ path });
      await besideDesign(browser, path, design);
    };
    const world = (settings, none = false) => open(browser, server.url, { cloud: false, localProjects: 1 }, VIEWPORT, {
      extra: `localStorage.setItem("raccoon.mode", ${JSON.stringify(mode)});\n${fixture(settings, none)}`,
      colorScheme: mode,
    });

    // ---- 21.01 and 21.08: three machines.
    {
      const page = await world(false);
      await sidebar(page);
      for (const machine of ["m-mini", "m-server"]) await page.locator(`[data-testid="machine-section"][data-machine="${machine}"][data-reachable="true"]`).waitFor();
      await page.locator('[data-testid="machine-session-row"]').nth(4).waitFor();

      // 21.01: the sidebar's sections and the overview with every machine.
      await page.getByRole("button", { name: /^(Overview|Dashboard)/ }).first().click();
      // The overview's view is chosen in its Display menu since PRO-385 (02.15).
      await page.getByRole("button", { name: "Display", exact: true }).click();
      await page.getByRole("button", { name: "Table", exact: true }).click();
      await page.keyboard.press("Escape");
      await page.locator("tbody tr[data-session]").nth(6).waitFor();
      await page.waitForTimeout(300);
      await take(page, "21.01-sidebar-overview", "21.01.png");
      let m = await measure(page);
      failed += report(`21.01 sidebar and overview (${mode})`, common(m, [/this mac/i, "Mac mini", "dev-server", "tx-review-lab", "terminalx-server", "PR #212", "PR #790"]), { small: m.small });

      // 21.08: the Mac mini session, its changes and a terminal on the machine.
      await page.locator(`[data-testid="machine-session-row"][title="read-markers · ${TITLE}"]`).click();
      const strip = page.locator('main [data-testid="machine-tab-strip"]');
      await strip.waitFor();
      await page.locator("main [data-chat-scroller]").getByText("The feed now carries a readAt marker").waitFor();
      if (!(await page.locator("main aside").count())) await page.getByRole("button", { name: "Toggle panel" }).click();
      const changes = page.locator("main aside").getByRole("tab", { name: /^Changes/ });
      if (await changes.count()) await changes.first().click();
      await strip.getByRole("button", { name: "New tab" }).click();
      const menu = page.getByRole("menu");
      await menu.waitFor();
      await menu.getByRole("menuitem").filter({ hasText: "on Mac mini" }).click();
      await page.locator('main [data-testid="machine-terminal-dock"] [role="tab"]').filter({ hasText: "Mac mini terminal 1" }).waitFor();
      await page.locator("main aside").getByText("cloudCatalog.ts").first().waitFor({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(400);
      await take(page, "21.08-session", "21.08.png");
      m = await measure(page);
      failed += report(`21.08 session on Mac mini (${mode})`, {
        ...common(m, ["Mac mini", "Runs on Mac mini", "Mac mini terminal 1", TITLE]),
        "the Changes panel lists the session's files": /cloudCatalog\.ts/.test(m.text) && /readMarkers\.ts/.test(m.text),
      }, { small: m.small });
      await page.close();
    }

    // ---- 21.07: the new-session form's Where it runs, listing this Mac and each machine.
    {
      const page = await world(false);
      await sidebar(page);
      for (const machine of ["m-mini", "m-server"]) await page.locator(`[data-testid="machine-section"][data-machine="${machine}"][data-reachable="true"]`).waitFor();
      await page.locator("main").getByRole("button", { name: "New session", exact: true }).click();
      await page.getByTestId("where-it-runs").first().click();
      const where = page.getByTestId("where-menu");
      await where.waitFor();
      await where.getByText("dev-server").first().waitFor();
      await page.waitForTimeout(300);
      await take(page, "21.07-new-session-where", "21.07.png");
      const m = await measure(page);
      failed += report(`21.07 new session, Where it runs (${mode})`, {
        ...common(m, [/this mac/i, "Mac mini", "dev-server", /Add a machine/]),
      }, { small: m.small });
      await page.close();
    }

    // ---- 21.02 with no machine paired (PRO-360): the first-run card and the guide,
    // no machine section in the sidebar, and no Machines switch under Experimental.
    {
      const page = await world(false, true);
      await sidebar(page);
      await page.waitForTimeout(500);
      const sections = await page.locator('[data-testid="machines-section"]').count();
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const settings = page.getByRole("main", { name: "Settings", exact: true });
      const nav = settings.getByRole("navigation", { name: "Settings sections" });
      await nav.getByRole("button", { name: "Machines", exact: true }).click();
      await settings.getByTestId("machines-first-run").waitFor();
      await page.waitForTimeout(300);
      await take(page, "21.02-first-run", "21.02.png");
      const m = await measure(page);
      await nav.getByRole("button", { name: "Experimental", exact: true }).click();
      await settings.getByTestId("experimental-settings").waitFor();
      const experimentalSwitch = await settings.getByRole("switch", { name: "Machines", exact: true }).count();
      failed += report(`21.02 Settings → Machines, nothing paired (${mode})`, {
        ...common(m, ["No machines yet", "Get the other computer ready", "Add it here", "Start a session there", "Machines guide"]),
        "the sidebar has no machine section": sections === 0,
        "Experimental has no Machines switch": experimentalSwitch === 0,
      }, { small: m.small });
      await page.close();
    }

    // ---- 21.02: Settings → Machines, with ci-box and Studio paired as well.
    {
      const page = await world(true);
      await sidebar(page);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const settings = page.getByRole("main", { name: "Settings", exact: true });
      await settings.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Machines", exact: true }).click();
      await settings.getByTestId("machines-settings").waitFor();
      // The card says its state itself since the designed page (PRO-349, #1029): ci-box's reads Needs update.
      await settings.locator('[data-testid="paired-machine"][data-machine="m-ci"][data-state="needsUpdate"]').getByText("Needs update", { exact: true }).waitFor();
      await settings.getByTestId("machines-settings").getByText("Offline").first().waitFor();
      await page.waitForTimeout(300);
      await take(page, "21.02-settings-machines", "21.02.png");
      const m = await measure(page);
      failed += report(`21.02 Settings → Machines (${mode})`, {
        ...common(m, ["Mac mini", "dev-server", "ci-box", "Studio", "Needs update", "Offline", "Computers that can operate this Mac", "Paresh’s MacBook Air"]),
      }, { small: m.small });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`screenshots: ${shots}`);
process.exit(failed ? 1 : 0);
