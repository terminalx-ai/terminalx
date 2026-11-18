#!/usr/bin/env node
// PRO-346: each paired machine's sidebar section lists its projects and,
// under each, its sessions (screen 21.01), in the desktop's WebKit.
//
// Two machines are paired: "Mac mini" (macOS, Direct) with two projects, one
// of them named as a project on the other machine, and "dev-server" (Linux,
// Relay). Their runtimes are stubbed as scripts/webkit/machine-connection.mjs
// does (PRO-345), and answer machine.projects, session.list and session.tabs.
//
// Checked, in the light and the dark theme:
// - each section: monitor or server, name, state dot, route label, + and fold;
//   then its projects in the machine's order, then each project's sessions,
//   each with a status mark and a time or PR number and no status label;
// - the header's + lists the machine's projects; choosing one opens the
//   machine's view with the new-agent form on that project, and Start agent
//   sends `session.create` with its projectId and selects the new session;
// - Mac mini going offline keeps its section and its sessions, dimmed, with
//   the "Mac mini isn't reachable" card under them (PRO-352, 21.09): when it
//   was last seen, Try again and Machine settings, inside the sidebar, no
//   text under 12 px; Try again asks the native side to reconnect;
// - Mac mini revoking this Mac shows "no longer allows this Mac" with Pair
//   again; coming back removes the card;
// - the sidebar never scrolls sideways; with no machine paired nothing shows.
//
// Pictures of each state go to MACHINE_SIDEBAR_SHOTS when it is set (the
// PR evidence uses ~/.raccoon/pr-evidence/pro-346/), named after the state.
//
//   pnpm build && npx playwright install webkit && node scripts/webkit/machine-sidebar.mjs
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const shots = process.env.MACHINE_SIDEBAR_SHOTS || null;
if (shots) await mkdir(shots, { recursive: true });
const shoot = async (page, name) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
};

// Yesterday at 14:02 local time, whatever day the check runs: a fixed date read "at 14:02" on that day only.
const LAST_SEEN = (() => {
  const day = new Date();
  day.setDate(day.getDate() - 1);
  return day.setHours(14, 2, 0, 0);
})();

// Runs in the page, after the stub: the two machines, their projects and sessions, and their runtimes.
const fixture = (paired) => `(() => {
  const answers = window.__PW_STUB__.answers;
  const emit = window.__PW_STUB__.emit;
  answers.experimental_settings = { nativeCodex: false, sessionCost: false, orchestratorRuns: false, localVmTasks: false };
  // This desktop's version, which a machine's view compares with the machine's (PRO-354).
  answers["plugin:app|version"] = "0.2.33";
  const machine = (patch) => ({ os: { family: "macos", version: "26.1" }, version: "0.2.33", publicKeyB64: "a2V5", directEndpoints: ["ws://192.168.1.20:6768/machine/1"],
    route: "relayAndNearby", pairedAt: Date.parse("2026-11-10T09:00:00Z"), lastSeenAt: ${LAST_SEEN}, lastRoute: null, relay: null, ...patch });
  answers.machines_list = [
    machine({ machineId: "m-mini", name: "Mac mini" }),
    machine({ machineId: "m-server", name: "dev-server", os: { family: "linux", version: null } }),
  ];
  const views = {
    "m-mini": { state: "direct", route: { kind: "lan", endpoint: "ws://192.168.1.20:6768/machine/1" }, since: Date.now(), rttMs: 3 },
    "m-server": { state: "relay", route: { kind: "relay", endpoint: null }, since: Date.now(), rttMs: 41 },
  };
  answers.machines_connections = () => Object.entries(views).map(([machineId, state]) => ({ machineId, state }));
  // No machine paired (PRO-360): the app is as it was before Machines.
  if (!${paired}) { answers.machines_list = []; answers.machines_connections = () => []; }

  const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const project = (projectId, name, path) => ({ projectId, name, path, kind: "git", defaultBranch: "main", archived: false });
  const tab = (id, status, title = null) => ({ id, harness: "claude", title, status, created: ago(90), lastMessageAt: null });
  const pr = (number) => ({ tabs: [{ status: "idle" }], branch: "feature", started: true, work: "none",
    branchStatus: { branch: "feature", checked: true, headMatches: true, pr: { number, state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", checks: "SUCCESS", inMergeQueue: false } } });
  const session = (id, projectId, title, minutes, tabs, patch = {}) => ({ id, projectId, projectPath: "/srv/" + projectId, cwd: "/srv/" + projectId, title,
    created: ago(minutes + 60), modified: ago(minutes), lastMessageAt: ago(minutes), hasMessages: true, archived: false, pinned: false, tabs, activeTab: tabs[0]?.id ?? null, ...patch });
  const runtimes = {
    "m-mini": {
      projects: [project("p-tx", "terminalx", "/Users/me/code/terminalx"), project("p-txs", "terminalx-server", "/Users/me/code/terminalx-server")],
      sessions: [
        session("s-read", "p-tx", "Add read markers to the catalog", 3, [tab("t-read", "in_progress")]),
        session("s-flaky", "p-tx", "Bisect the flaky relay e2e", 11, [tab("t-flaky", "waiting")]),
        session("s-seats", "p-txs", "Seat-based Teams billing", 120, [tab("t-seats", "idle")], { branch: "feature", rowStatus: pr(212) }),
        session("s-old", "p-tx", "An archived session", 3000, [tab("t-old", "idle")], { archived: true }),
      ],
    },
    "m-server": {
      projects: [project("p-lab", "tx-review-lab", "/home/me/repos/tx-review-lab"), project("p-tx2", "terminalx", "/home/me/repos/terminalx")],
      sessions: [
        session("s-soak", "p-lab", "Nightly soak run", 42, [tab("t-soak", "in_progress")]),
        session("s-cache", "p-tx2", "Cache the Linux runtime build", 480, [tab("t-cache", "idle")], { branch: "feature", rowStatus: pr(790) }),
      ],
    },
  };
  const agentTab = (session, t) => ({ sessionId: session.id, tabId: t.id, title: t.title, harness: t.harness, model: "", effort: null, permissionMode: "bypassPermissions",
    status: t.status, process: t.status === "in_progress" ? "running" : "idle", pendingPermissions: t.status === "waiting" ? [{ requestId: "r-" + t.id, toolName: "Bash", input: {}, options: [] }] : [],
    followUps: [], lastSeq: 0, created: t.created, lastMessageAt: session.lastMessageAt, sessionCreated: session.created, sessionLastMessageAt: session.lastMessageAt, sessionHasMessages: true });
  const tabsOf = (machineId) => runtimes[machineId].sessions.flatMap((session) => session.tabs.map((t) => agentTab(session, t)));
  window.__PW_CREATES__ = [];

  const links = {};
  const transport = (machineId, view) => {
    switch (view.state) {
      case "direct":
      case "relay":
        links[machineId] = (links[machineId] ?? 0) + 1;
        return { state: "connected", runtimeGeneration: 1, runtimeEpoch: "e1", runtimeVersion: "0.2.33", authority: "manage", link: links[machineId],
          capabilities: ["pty/1", "pty/2", "fs/1", "git/1", "session/1", "session/2", "keys/1", "agents/1", "machine/1", "machine/2"] };
      case "offline":
        return { state: "reconnecting", attempt: 0, reason: "offline", retryInMs: view.retryInMs };
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
  const reply = (connectionId, id, result) => setTimeout(() => emit("cloud_remote_event", { kind: "message", connectionId, message: { id, ok: true, result } }), 0);
  const notify = (connectionId, event, params) => setTimeout(() => emit("cloud_remote_event", { kind: "message", connectionId, message: { event, params } }), 0);
  answers.cloud_remote_send = ({ connectionId, frame }) => {
    const machineId = connectionId.replace(/^conn-/, "");
    const runtime = runtimes[machineId];
    const params = frame.params ?? {};
    switch (frame.method) {
      case "machine.projects": reply(connectionId, frame.id, { projects: runtime.projects }); break;
      case "session.list": reply(connectionId, frame.id, { sessions: runtime.sessions }); break;
      case "session.tabs": reply(connectionId, frame.id, { tabs: tabsOf(machineId) }); break;
      case "pty.list": reply(connectionId, frame.id, { epoch: "e1", terminals: [] }); break;
      case "git.repositories": reply(connectionId, frame.id, { repositories: [] }); break;
      case "fs.list": reply(connectionId, frame.id, { path: "", entries: [] }); break;
      case "runtime.agents": reply(connectionId, frame.id, { agents: [] }); break;
      case "session.create": {
        window.__PW_CREATES__.push({ machineId, params });
        const created = session("s-new", params.projectId, "New session", 0, [tab("t-new", "idle")]);
        runtime.sessions = [created, ...runtime.sessions];
        reply(connectionId, frame.id, { sessionId: created.id, tabId: "t-new", tab: agentTab(created, created.tabs[0]), session: created });
        notify(connectionId, "session.sessions", { sessions: runtime.sessions });
        break;
      }
      default: break;
    }
    return true;
  };
  // Try again (PRO-352): counted, so the check sees it asked the native side.
  window.__PW_RECONNECTS__ = 0;
  answers.machines_reconnect = () => { window.__PW_RECONNECTS__++; return null; };
  answers.cloud_remote_detach = null;
  window.__PW_MACHINE__ = (machineId, state) => {
    views[machineId] = state;
    emit("machines_connection_changed", { machineId, state });
    sendState(machineId);
  };
})();`;

/** Each machine's section as drawn: header, projects, rows, and whether it is dimmed. */
const measure = (page) =>
  page.evaluate(() => {
    const rect = (element) => {
      const box = element?.getBoundingClientRect();
      return box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom } : null;
    };
    const list = document.querySelector('[data-testid="conversation-list"]');
    const sections = [...document.querySelectorAll('[data-testid="machine-section"]')].map((section) => {
      const header = section.querySelector("button");
      const actions = document.querySelector(`[data-testid="machine-header-actions"][data-machine="${section.getAttribute("data-machine")}"]`);
      const projectsBox = section.querySelector('[data-testid="machine-projects"]');
      return {
        machine: section.getAttribute("data-machine"),
        name: section.getAttribute("aria-label"),
        reachable: section.getAttribute("data-reachable"),
        opacity: projectsBox ? parseFloat(getComputedStyle(projectsBox).opacity) : null,
        icon: header?.querySelector("[data-icon]")?.getAttribute("data-icon") ?? null,
        mark: !!header?.querySelector('[data-testid="machine-state-mark"]'),
        label: header?.querySelector('[data-testid="machine-state-label"]')?.textContent ?? null,
        plus: !!actions?.querySelector('[data-testid="machine-new-session"]'),
        fold: !!actions?.querySelector('[data-testid="machine-fold"]'),
        header: rect(section.firstElementChild),
        actions: rect(actions),
        projects: [...section.querySelectorAll('[data-testid="machine-project"]')].map((project) => ({
          name: project.getAttribute("aria-label"),
          rows: [...project.querySelectorAll('[data-testid="machine-session-row"]')].map((row) => ({
            title: row.getAttribute("title"),
            key: row.getAttribute("data-session"),
            mark: !!row.querySelector("svg, [data-status-mark]"),
            meta: row.querySelector("[data-row-meta]")?.getAttribute("data-row-meta") ?? null,
            metaText: row.querySelector("[data-row-meta]")?.textContent ?? null,
            box: rect(row),
          })),
        })),
      };
    });
    return { list: rect(list), scrollsSideways: list ? list.scrollWidth > list.clientWidth + 1 : null, sections };
  });

const inside = (inner, outer) => !!inner && !!outer && inner.left >= outer.left - 1 && inner.right <= outer.right + 1;

const server = await serve();
const browser = await launch();
let failed = 0;

for (const colorScheme of ["light", "dark"]) {
  const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1280, height: 820 }, { extra: fixture(true), colorScheme });
  await sidebar(page);
  await page.locator('[data-testid="machine-section"][data-machine="m-mini"][data-reachable="true"]').waitFor();
  await page.locator('[data-testid="machine-section"][data-machine="m-server"][data-reachable="true"]').waitFor();
  await page.locator('[data-testid="machine-session-row"]').nth(4).waitFor();
  await page.waitForTimeout(200);

  // Two machines, live.
  {
    const m = await measure(page);
    const [mini, dev] = m.sections;
    const rowsOf = (section, name) => section?.projects.find((project) => project.name === name)?.rows ?? [];
    const everyRow = m.sections.flatMap((section) => section.projects.flatMap((project) => project.rows));
    failed += report(`two machines (${colorScheme})`, {
      "one section per machine, in pairing order": m.sections.map((section) => section.name).join(",") === "Mac mini,dev-server",
      "a Mac has a monitor and Linux a server": mini?.icon === "monitor" && dev?.icon === "server",
      "each header has its state dot and route label": mini?.mark && dev?.mark && mini?.label === "Direct" && dev?.label === "Relay",
      "each header has a + and a fold": m.sections.every((section) => section.plus && section.fold),
      "the + and fold sit on the header's row": m.sections.every((section) => section.actions && section.header && section.actions.top >= section.header.top - 1 && section.actions.bottom <= section.header.bottom + 1),
      "Mac mini's projects in its order": mini?.projects.map((project) => project.name).join(",") === "terminalx,terminalx-server",
      "dev-server's projects, one named as Mac mini's": dev?.projects.map((project) => project.name).join(",") === "tx-review-lab,terminalx",
      "a project lists its sessions, most recent first; archived ones are hidden": rowsOf(mini, "terminalx").map((row) => row.title).join("|") === "Add read markers to the catalog|Bisect the flaky relay e2e",
      "same-named projects keep their own sessions": rowsOf(dev, "terminalx").map((row) => row.key).join() === "machine:m-server:p-tx2:s-cache",
      "every row has a status mark and metadata": everyRow.length === 5 && everyRow.every((row) => row.mark && row.meta),
      "a session with an open PR shows its number": rowsOf(mini, "terminalx-server")[0]?.metaText === "PR #212" && rowsOf(dev, "terminalx")[0]?.metaText === "PR #790",
      "rows stay inside the sidebar": everyRow.every((row) => inside(row.box, m.list)) && m.sections.every((section) => inside(section.actions, m.list)),
      "the sidebar does not scroll sideways": m.scrollsSideways === false,
      "both machines are drawn reachable": m.sections.every((section) => section.reachable === "true" && section.opacity === 1),
    }, m);
    await shoot(page, `two-machines-${colorScheme}`);
  }

  // The overview: machine sessions in the table, a Where column naming each machine, and the All machines menu with a count per machine.
  {
    // The sidebar destination is "Overview" since PRO-384 (#1046).
    await page.getByRole("button", { name: /^Overview/ }).first().click();
    await page.getByRole("button", { name: "Table", exact: true }).click();
    const table = page.getByRole("table", { name: "Sessions", exact: true });
    await table.locator("tbody tr[data-session]").first().waitFor();
    const headers = (await table.locator("thead th").allTextContents()).map((text) => text.trim());
    const whereIndex = headers.indexOf("Where");
    const rows = await table.locator("tbody tr[data-session]").evaluateAll((trs, index) => trs.map((tr) => ({ key: tr.dataset.session, where: tr.children[index]?.textContent?.trim() ?? "" })), whereIndex);
    const whereOf = (key) => rows.find((row) => row.key === key)?.where;
    await shoot(page, `overview-table-${colorScheme}`);
    await page.getByRole("button", { name: /All machines/ }).click();
    const items = page.getByRole("menuitem");
    await items.first().waitFor();
    const entries = (await items.allTextContents()).map((text) => text.replace(/\s+/g, " ").trim());
    // Past the menu's open animation, so the shot shows it as it rests.
    await page.waitForTimeout(400);
    await shoot(page, `overview-machines-menu-${colorScheme}`);
    await page.keyboard.press("Escape");
    const count = (name) => Number(entries.find((entry) => entry.startsWith(name))?.slice(name.length).trim());
    failed += report(`overview (${colorScheme})`, {
      "the table has a Where column": whereIndex >= 0,
      "machine sessions are listed with their machine's name": whereOf("machine:m-mini:p-tx:s-flaky") === "Mac mini" && whereOf("machine:m-server:p-tx2:s-cache") === "dev-server",
      "the menu offers every machine and this Mac": ["All machines", "This Mac", "Mac mini", "dev-server"].every((name) => entries.some((entry) => entry.startsWith(name))),
      "each machine has its session count": count("Mac mini") === rows.filter((row) => row.where === "Mac mini").length && count("dev-server") === rows.filter((row) => row.where === "dev-server").length && count("Mac mini") > 0,
    }, { headers, rows, entries });
  }

  // A session row opens that session (PRO-347), not the machine's own page.
  {
    const row = '[data-testid="machine-session-row"][data-session="machine:m-mini:p-tx:s-flaky"]';
    await page.locator(`${row} button`).first().click();
    await page.waitForFunction((row) => /\bbg-selected\b/.test(document.querySelector(row)?.className ?? "") && !!document.querySelector("main"), row);
    const opened = await page.evaluate(() => ({ session: !!document.querySelector("main") && !document.querySelector('[data-testid="machine-main"]'), main: document.querySelector("main")?.textContent?.slice(0, 200) ?? null }));
    failed += report(`select a machine session (${colorScheme})`, {
      "the session opens in the session view, not the machine's page": opened.session,
      "the row is selected": true,
    }, opened);
    await shoot(page, `session-selected-${colorScheme}`);
  }

  // + on Mac mini: a menu of its projects; terminalx-server opens the form there, and Start agent creates the session in it.
  {
    await page.locator('[data-testid="machine-header-actions"][data-machine="m-mini"] [data-testid="machine-new-session"]').click();
    const items = page.getByRole("menuitem");
    await items.first().waitFor();
    const names = (await items.allTextContents()).map((text) => text.trim());
    await shoot(page, `new-session-menu-${colorScheme}`);
    await page.getByRole("menuitem", { name: "terminalx-server" }).click();
    const form = page.locator('[data-testid="cloud-agent-new"]');
    await form.waitFor();
    const formProject = await form.getAttribute("data-project");
    await shoot(page, `new-session-form-${colorScheme}`);
    await form.getByRole("button", { name: "Start agent" }).click();
    await page.waitForFunction(() => window.__PW_CREATES__.length > 0);
    const creates = await page.evaluate(() => window.__PW_CREATES__);
    const created = page.locator('[data-testid="machine-session-row"][data-session="machine:m-mini:p-txs:s-new"]');
    await created.waitFor();
    await page.waitForFunction(() => /\bbg-selected\b/.test(document.querySelector('[data-testid="machine-session-row"][data-session="machine:m-mini:p-txs:s-new"]')?.className ?? ""));
    failed += report(`new session from + (${colorScheme})`, {
      "the menu lists Mac mini's projects": names.join(",") === "terminalx,terminalx-server",
      "the form opens on the chosen project": formProject === "p-txs",
      "session.create carries the projectId": creates.length === 1 && creates[0].machineId === "m-mini" && creates[0].params.projectId === "p-txs",
      "the new session's row is listed under its project and selected": true,
    }, { names, formProject, creates });
    await shoot(page, `new-session-created-${colorScheme}`);
  }

  // Mac mini goes offline: its section stays, dimmed, with its last known sessions.
  {
    await page.evaluate(() => window.__PW_MACHINE__("m-mini", { state: "offline", lastSeenAt: Date.parse("2026-11-15T14:02:00"), retryInMs: 10_000 }));
    await page.locator('[data-testid="machine-section"][data-machine="m-mini"][data-reachable="false"]').waitFor();
    await page.waitForTimeout(300);
    const m = await measure(page);
    const mini = m.sections.find((section) => section.machine === "m-mini");
    failed += report(`offline machine (${colorScheme})`, {
      "the header says Offline": /^Offline · seen/.test(mini?.label ?? ""),
      "its sessions are still listed": (mini?.projects.flatMap((project) => project.rows).length ?? 0) === 4,
      "its section is dimmed": mini?.opacity !== null && mini.opacity < 1,
      "dev-server stays as it was": m.sections.find((section) => section.machine === "m-server")?.reachable === "true",
    }, m);
    await shoot(page, `offline-${colorScheme}`);
  }

  // PRO-352 (21.09): the offline section's card, and Try again.
  {
    const card = page.locator('[data-testid="machine-section"][data-machine="m-mini"] [data-testid="machine-away-card"]');
    await card.waitFor();
    const c = await card.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const aside = node.closest("aside, nav, [data-testid='sidebar']")?.getBoundingClientRect() ?? null;
      const texts = [...node.querySelectorAll("*")].filter((el) => el.childElementCount === 0 && el.textContent.trim()).map((el) => parseFloat(getComputedStyle(el).fontSize));
      return {
        state: node.getAttribute("data-state"),
        text: node.textContent.replace(/\s+/g, " ").trim(),
        buttons: [...node.querySelectorAll("button")].map((button) => button.textContent.trim()),
        inside: !aside || (box.left >= aside.left - 1 && box.right <= aside.right + 1),
        smallest: Math.min(...texts),
      };
    });
    const before = await page.evaluate(() => window.__PW_RECONNECTS__);
    await card.getByRole("button", { name: "Try again" }).click();
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => window.__PW_RECONNECTS__);
    failed += report(`offline card (${colorScheme})`, {
      "the card is for the offline state": c.state === "offline",
      "it says Mac mini isn't reachable": c.text.includes("Mac mini isn’t reachable"),
      "it says when it was last seen": /Last seen yesterday at 14:02\./.test(c.text),
      "it says sessions keep running and the list catches up": c.text.includes("Sessions there keep running, and this list catches up when it reconnects."),
      "it offers Try again and Machine settings": c.buttons.join(",") === "Try again,Machine settings",
      "it stays inside the sidebar": c.inside,
      "no text under 12 px": c.smallest >= 12,
      "Try again asks to reconnect": after > before,
    }, { ...c, before, after });
    await shoot(page, `offline-card-${colorScheme}`);

    await page.evaluate(() => window.__PW_MACHINE__("m-mini", { state: "accessRemoved" }));
    await page.locator('[data-testid="machine-away-card"][data-state="accessRemoved"]').waitFor();
    const removed = await page.locator('[data-testid="machine-away-card"][data-state="accessRemoved"]').evaluate((node) => ({
      text: node.textContent.replace(/\s+/g, " ").trim(),
      buttons: [...node.querySelectorAll("button")].map((button) => button.textContent.trim()),
    }));
    failed += report(`access removed card (${colorScheme})`, {
      "it says Mac mini no longer allows this Mac": removed.text.includes("Mac mini no longer allows this Mac"),
      "it offers Pair again and Machine settings": removed.buttons.join(",") === "Pair again,Machine settings",
    }, removed);
    await shoot(page, `access-removed-card-${colorScheme}`);

    await page.evaluate(() => window.__PW_MACHINE__("m-mini", { state: "direct", route: { kind: "lan", endpoint: "ws://192.168.1.20:6768/machine/1" }, since: Date.now(), rttMs: 3 }));
    await page.waitForTimeout(300);
    failed += report(`back (${colorScheme})`, {
      "the card is gone": (await page.locator('[data-testid="machine-away-card"]').count()) === 0,
    });
  }
  await page.close();
}

// No machine paired: nothing of the machines shows (PRO-360).
{
  const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1000, height: 620 }, { extra: fixture(false) });
  await sidebar(page);
  await page.waitForTimeout(500);
  failed += report("no machine paired", {
    "there is no Machines section": (await page.locator('[data-testid="machines-section"]').count()) === 0,
    "there are no machine rows": (await page.locator('[data-testid="machine-session-row"], [data-testid="machine-project"]').count()) === 0,
  });
  await shoot(page, "no-machine-paired");
  await page.close();
}

await browser.close();
server.close();
if (shots) console.log(`screenshots: ${shots}`);
process.exit(failed ? 1 : 0);
