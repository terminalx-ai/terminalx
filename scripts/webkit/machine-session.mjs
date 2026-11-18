#!/usr/bin/env node
// PRO-347: a session on a paired machine opens in the same session view as a
// local or cloud one (screens 21.08 and 21.09), in the desktop's WebKit.
//
// "Mac mini" (Direct) is paired, with one project and two sessions; its
// runtime is stubbed as scripts/webkit/machine-sidebar.mjs does (PRO-346) and
// also answers session.subscribe, session.send, session.decide, pty.create and
// pty.attach, recording every frame.
//
// Checked, in the light and the dark theme:
// - clicking the session's row opens it: the header names the machine (its
//   chip, "Direct") and the session; the agent tab strip under it has the tab
//   and the terminal view switch; "Runs on Mac mini" sits under the strip;
//   the transcript replays and the composer is there;
// - the "+" menu offers "Terminal on Mac mini" and says, once, that browser
//   and computer use aren't available on another machine; nothing in it is a
//   browser page, computer or Local VM;
// - a new terminal is created on the machine in the session
//   (`pty.create` with its sessionId) and the side panel names it
//   "Mac mini terminal 1";
// - a sent message draws within 100 ms and goes to the machine as a live
//   `session.send` with a clientRequestId; answering an approval sends
//   `session.decide` with the request's id;
// - every fs.* and git.* call names the project, and no frame carries a path
//   of this computer;
// - Mac mini reconnecting: "Reconnecting to Mac mini" under the strips, and
//   the composer can't send until it is back;
// - nothing scrolls sideways; with no machine paired the session is not shown.
//
// Pictures of each state go to MACHINE_SESSION_SHOTS when it is set (the PR
// evidence puts them beside 21.08 and 21.09), named after the state.
//
//   pnpm build && npx playwright install webkit && node scripts/webkit/machine-session.mjs
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const shots = process.env.MACHINE_SESSION_SHOTS || null;
if (shots) await mkdir(shots, { recursive: true });
const shoot = async (page, name) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
};

const TITLE = "Add read markers to the catalog feed";
const SEND_BUDGET_MS = 100;

// Runs in the page, after the stub: Mac mini, its project and sessions, and its runtime.
const fixture = (paired) => `(() => {
  const answers = window.__PW_STUB__.answers;
  const emit = window.__PW_STUB__.emit;
  answers.experimental_settings = { nativeCodex: false, sessionCost: false, orchestratorRuns: false, localVmTasks: false };
  // This desktop's version, which the header compares with the machine's since PRO-352; the stub's generic plugin answer is not a string.
  answers["plugin:app|version"] = "0.2.33";
  answers.machines_list = [{ machineId: "m-mini", name: "Mac mini", os: { family: "macos", version: "26.1" }, version: "0.2.33", publicKeyB64: "a2V5",
    directEndpoints: ["ws://192.168.1.20:6768/machine/1"], route: "relayAndNearby", pairedAt: Date.parse("2026-11-10T09:00:00Z"), lastSeenAt: Date.now(), lastRoute: null, relay: null }];
  let view = { state: "direct", route: { kind: "tailscale", endpoint: "ws://100.64.0.7:6768/machine/1" }, since: Date.now(), rttMs: 9 };
  answers.machines_connections = () => [{ machineId: "m-mini", state: view }];
  // No machine paired (PRO-360): the app is as it was before Machines.
  if (!${paired}) { answers.machines_list = []; answers.machines_connections = () => []; }

  const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const project = { projectId: "p-tx", name: "terminalx", path: "/Users/paresh/code/terminalx", kind: "git", defaultBranch: "main", archived: false };
  const tab = (id, status, title) => ({ id, harness: "claude", title, status, created: ago(90), lastMessageAt: null });
  const session = (id, title, minutes, tabs, cwd) => ({ id, projectId: "p-tx", projectPath: project.path, cwd, title, branch: "read-markers",
    created: ago(minutes + 60), modified: ago(minutes), lastMessageAt: ago(minutes), hasMessages: true, archived: false, pinned: false, tabs, activeTab: tabs[0].id });
  const sessions = [
    session("s-read", "${TITLE}", 3, [tab("t-read", "completed", "Read markers")], project.path + "/.raccoon/worktrees/read-markers"),
    session("s-flaky", "Bisect the flaky relay e2e", 11, [tab("t-flaky", "waiting", "Bisect")], project.path),
  ];
  const ASK = { requestId: "r-flaky", toolName: "Bash", input: { command: "git bisect run pnpm e2e:relay" },
    options: [{ id: "allow", label: "Allow", kind: "allow_once" }, { id: "deny", label: "Deny", kind: "deny" }] };
  const agentTab = (s, t) => ({ sessionId: s.id, tabId: t.id, title: t.title, harness: "claude", model: "", effort: null, permissionMode: "default",
    status: t.status, process: "idle", pendingPermissions: t.id === "t-flaky" ? [ASK] : [], followUps: [], lastSeq: 0, created: t.created,
    lastMessageAt: s.lastMessageAt, sessionCreated: s.created, sessionLastMessageAt: s.lastMessageAt, sessionHasMessages: true });
  const tabs = () => sessions.flatMap((s) => s.tabs.map((t) => agentTab(s, t)));

  let seq = 0;
  const events = [];
  const event = (sessionId, tabId, payload) => ({ id: "e" + ++seq, seq, sessionId, tabId, harness: "claude", ts: new Date(Date.now() - 600_000 + seq * 1000).toISOString(), payload });
  events.push(
    event("s-read", "t-read", { type: "user_message", text: "Add read markers to the catalog feed so reading a session on one Mac clears it on every device.", queued: false }),
    event("s-read", "t-read", { type: "turn_started" }),
    event("s-read", "t-read", { type: "assistant_text", text: "The feed now carries a readAt marker per session." }),
    event("s-read", "t-read", { type: "turn_completed", status: "ok", authFailed: false, durationMs: 228000 }),
    event("s-flaky", "t-flaky", { type: "user_message", text: "Bisect the flaky relay e2e", queued: false }),
    event("s-flaky", "t-flaky", { type: "turn_started" }),
    event("s-flaky", "t-flaky", { type: "permission_requested", ...ASK }),
  );

  const frames = (window.__PW_FRAMES__ = []);
  const subscriptions = new Map();
  let sub = 0;
  const terminals = [];
  const CONNECTION = "conn-m-mini";
  let link = 0;
  const transport = () => {
    if (view.state === "direct" || view.state === "relay") {
      link++;
      return { state: "connected", runtimeGeneration: 1, runtimeEpoch: "e1", runtimeVersion: "0.2.33", authority: "manage", link,
        capabilities: ["pty/1", "pty/2", "fs/1", "git/1", "session/1", "session/2", "keys/1", "agents/1", "composer/2", "machine/1", "machine/2", "agent-commands/1",
          // Every feature in machineFeatures.ts, so the machine reads as up to date and nothing is hidden.
          "ports/1", "session/3", "session-status/1", "agent-pty/1", "composer/1", "composer/3", "composer/4", "workspace/1", "workspace/2",
          "cleanup/1", "pipeline/1", "pipeline/2", "machine/3", "machine/4", "machine/6", "machine/7", "machine/8"] };
    }
    return view.state === "reconnecting" ? { state: "reconnecting", attempt: 1, reason: "network", retryInMs: 2000 } : { state: "connecting", attempt: 1 };
  };
  const sendState = () => setTimeout(() => emit("cloud_remote_event", { kind: "state", connectionId: CONNECTION, state: transport() }), 0);
  const deliver = (message) => setTimeout(() => emit("cloud_remote_event", { kind: "message", connectionId: CONNECTION, message }), 0);
  const reply = (id, result) => deliver({ id, ok: true, result });
  const refuse = (id, code) => deliver({ id, ok: false, error: { code, message: code } });
  const push = (sessionId, tabId, payload) => {
    const next = event(sessionId, tabId, payload);
    events.push(next);
    for (const [id, scope] of subscriptions) if (scope.sessionId === sessionId) deliver({ event: "session.event", params: { subscriptionId: id, cursor: "1:" + next.seq, event: next } });
  };
  answers.machine_remote_attach = () => (sendState(), CONNECTION);
  answers.cloud_remote_send = ({ frame }) => {
    const params = frame.params ?? {};
    frames.push({ method: frame.method, params });
    switch (frame.method) {
      case "machine.projects": reply(frame.id, { projects: [project] }); break;
      case "session.list": reply(frame.id, { sessions }); break;
      case "session.tabs": reply(frame.id, { tabs: tabs() }); break;
      case "session.subscribe": {
        const id = "sub-" + ++sub;
        subscriptions.set(id, { sessionId: params.sessionId });
        const own = events.filter((e) => e.sessionId === params.sessionId && (!params.tabId || e.tabId === params.tabId));
        reply(frame.id, { subscriptionId: id, events: own.map((e) => ({ cursor: "1:" + e.seq, event: e })), cursor: "1:" + seq });
        break;
      }
      case "session.send":
        reply(frame.id, { accepted: true });
        push(params.sessionId, params.tabId, { type: "user_message", text: params.text, queued: false });
        break;
      case "session.decide": reply(frame.id, { accepted: true }); break;
      case "pty.list": reply(frame.id, { epoch: "e1", terminals }); break;
      case "pty.create": {
        const created = { ptyId: "p" + (terminals.length + 1), number: terminals.length + 1, epoch: "e1", pid: 200, cwd: sessions[0].cwd, cols: 80, rows: 24,
          createdAt: Date.now(), offset: 0, exited: false, exitCode: null, control: "you", controllerId: null, ...(params.sessionId ? { sessionId: params.sessionId } : {}) };
        terminals.push(created);
        reply(frame.id, created);
        break;
      }
      case "pty.attach": {
        const found = terminals.find((t) => t.ptyId === params.ptyId);
        if (found) reply(frame.id, { subscriptionId: "sub-" + ++sub, ...found, data: "paresh@mac-mini read-markers $ ", truncated: false });
        else refuse(frame.id, "not_found");
        break;
      }
      case "fs.watch": reply(frame.id, { subscriptionId: "sub-" + ++sub }); break;
      case "git.repositories": reply(frame.id, { repositories: [] }); break;
      case "fs.list": reply(frame.id, { path: params.path ?? "", entries: [] }); break;
      case "runtime.agents": reply(frame.id, { agents: [] }); break;
      // machine/8: this session has no usage kept on the machine yet.
      case "session.usage": reply(frame.id, { usage: { sessionId: params.sessionId, title: "", tabs: [], models: [], estimate: true }, loginMethods: {}, windows: [] }); break;
      case "session.unsubscribe": case "pty.detach": case "fs.unwatch": case "session.markRead": case "session.nudge": reply(frame.id, {}); break;
      default: refuse(frame.id, "method_not_found");
    }
    return true;
  };
  answers.machines_reconnect = null;
  answers.cloud_remote_detach = null;
  window.__PW_MACHINE__ = (state) => {
    view = state;
    emit("machines_connection_changed", { machineId: "m-mini", state });
    sendState();
  };
})();`;

const scrollsSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

const server = await serve();
const browser = await launch();
let failed = 0;

for (const colorScheme of ["light", "dark"]) {
  const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1440, height: 900 }, { extra: fixture(true), colorScheme });
  await sidebar(page);
  const row = page.locator(`[data-testid="machine-session-row"][title$="${TITLE}"]`);
  await row.waitFor();
  await row.click();
  const strip = page.locator('main [data-testid="machine-tab-strip"]');
  await strip.waitFor();
  await page.locator("main [data-chat-scroller]").getByText("The feed now carries a readAt marker").waitFor();
  if (!(await page.locator("main aside").count())) await page.getByRole("button", { name: "Toggle panel" }).click();
  await page.waitForTimeout(250);
  await shoot(page, `21.08-session-${colorScheme}`);

  // ---- 21.08: the session, as a local one is laid out.
  {
    const m = await page.evaluate(() => {
      const header = document.querySelector("main header");
      const chip = header?.querySelector('[data-testid="machine-chip"]');
      const title = header?.querySelector('[data-testid="session-title"]');
      const location = document.querySelector('main [data-testid="machine-location"]');
      const stripBox = document.querySelector('main [data-testid="machine-tab-strip"]')?.getBoundingClientRect();
      return {
        chip: chip?.textContent ?? null,
        chipBeforeTitle: !!chip && !!title && chip.getBoundingClientRect().right <= title.getBoundingClientRect().left + 1,
        title: title?.textContent ?? null,
        tabs: [...document.querySelectorAll('main [data-testid="machine-tab-strip"] [role="tab"]')].map((t) => t.textContent),
        terminalView: !!document.querySelector('main [data-testid="machine-terminal-view"]'),
        location: location?.textContent ?? null,
        locationUnderStrip: !!location && !!stripBox && location.getBoundingClientRect().top >= stripBox.bottom - 1,
        composer: !!document.querySelector("main textarea[placeholder]"),
        cloudLocation: !!document.querySelector('main header [data-testid="session-location"]'),
        dock: !!document.querySelector('main [data-testid="machine-terminal-dock"]'),
        panelTabs: [...document.querySelectorAll('main aside [role="tab"]')].map((t) => t.textContent?.trim()),
      };
    });
    failed += report(`machine session (${colorScheme})`, {
      "the header's chip names the machine and its route": /Mac mini/.test(m.chip ?? "") && /Direct/.test(m.chip ?? ""),
      "the chip comes before the title": m.chipBeforeTitle,
      "the title is the session's": m.title?.includes(TITLE) ?? false,
      "the agent tab strip has the session's tab": m.tabs.some((t) => t?.includes("Read markers")),
      "no cloud location chip": !m.cloudLocation,
      "Runs on Mac mini sits under the strip": /Runs on Mac mini/.test(m.location ?? "") && m.locationUnderStrip,
      "the composer is there": m.composer,
      "the side panel docks the machine's terminals": m.dock,
      "the side panel has no Browser or Computer tab": !m.panelTabs.some((t) => /Browser|Computer/.test(t ?? "")),
      "nothing scrolls sideways": !(await scrollsSideways(page)),
    }, m);
  }

  // ---- The "+" menu: a terminal on the machine, and what stays on this Mac.
  {
    await strip.getByRole("button", { name: "New tab" }).click();
    const menu = page.getByRole("menu");
    await menu.waitFor();
    const items = await menu.getByRole("menuitem").allTextContents();
    const note = await menu.locator('[data-testid="machine-local-only"]').allTextContents();
    await shoot(page, `21.08-new-tab-menu-${colorScheme}`);
    failed += report(`new tab menu (${colorScheme})`, {
      "it offers a terminal on Mac mini": items.some((t) => /Terminal/.test(t) && /on Mac mini/.test(t)),
      "it says once that browser and computer use stay on this Mac": note.length === 1 && note[0] === "Browser and computer use aren't available on another machine.",
      "no browser page, computer or Local VM": !items.some((t) => /Browser page|Computer|Local VM/i.test(t)),
    }, { items, note });
    await menu.getByRole("menuitem").filter({ hasText: "on Mac mini" }).click();
    const named = await page.locator('main [data-testid="machine-terminal-dock"] [role="tab"]').filter({ hasText: "Mac mini terminal 1" }).waitFor({ timeout: 5_000 }).then(() => true, () => false);
    const created = await page.evaluate(() => window.__PW_FRAMES__.filter((f) => f.method === "pty.create"));
    await page.waitForTimeout(150);
    await shoot(page, `21.08-terminal-${colorScheme}`);
    failed += report(`machine terminal (${colorScheme})`, {
      "it is created in the session on the machine": created.length === 1 && created[0].params.sessionId === "s-read",
      "the side panel names it Mac mini terminal 1": named,
    }, created);
  }

  // ---- Send: drawn within the budget, and a live session.send to the machine.
  {
    const composer = page.locator("main textarea[placeholder]");
    await composer.click();
    await composer.fill("Keep the cursor behaviour.");
    await page.evaluate(() => {
      window.__PW_SENT__ = null;
      window.__PW_DRAWN__ = null;
      document.addEventListener("keydown", (e) => { if (e.key === "Enter" && window.__PW_SENT__ === null) window.__PW_SENT__ = performance.now(); }, { capture: true, once: true });
      const scroller = document.querySelector("main [data-chat-scroller]");
      const seen = () => scroller?.textContent?.includes("Keep the cursor behaviour.");
      const observer = new MutationObserver(() => {
        if (window.__PW_DRAWN__ === null && seen()) {
          window.__PW_DRAWN__ = performance.now();
          observer.disconnect();
        }
      });
      if (scroller) observer.observe(scroller, { subtree: true, childList: true, characterData: true });
    });
    await composer.press("Enter");
    await page.waitForFunction(() => window.__PW_DRAWN__ !== null, null, { timeout: 5_000 }).catch(() => undefined);
    const timing = await page.evaluate(() => ({ sent: window.__PW_SENT__, drawn: window.__PW_DRAWN__ }));
    const sends = await page.evaluate(() => window.__PW_FRAMES__.filter((f) => f.method === "session.send"));
    const drawnIn = timing.sent !== null && timing.drawn !== null ? timing.drawn - timing.sent : null;
    failed += report(`send (${colorScheme})`, {
      [`the message draws within ${SEND_BUDGET_MS} ms`]: drawnIn !== null && drawnIn <= SEND_BUDGET_MS,
      "it goes live to the machine with a request id": sends.length === 1 && sends[0].params.sessionId === "s-read" && sends[0].params.tabId === "t-read" && typeof sends[0].params.clientRequestId === "string",
    }, { drawnIn, sends });
  }

  // ---- An approval on the other session: session.decide with its request.
  {
    await page.locator('[data-testid="machine-session-row"][title$="Bisect the flaky relay e2e"]').click();
    const allow = page.locator("main").getByRole("button", { name: /^Allow/ }).first();
    await allow.waitFor();
    await shoot(page, `21.08-approval-${colorScheme}`);
    await allow.click();
    await page.waitForFunction(() => window.__PW_FRAMES__.some((f) => f.method === "session.decide"), null, { timeout: 5_000 }).catch(() => undefined);
    const decides = await page.evaluate(() => window.__PW_FRAMES__.filter((f) => f.method === "session.decide"));
    failed += report(`approval (${colorScheme})`, {
      "the answer goes live to the machine": decides.length === 1 && decides[0].params.requestId === "r-flaky" && decides[0].params.sessionId === "s-flaky" && typeof decides[0].params.clientRequestId === "string",
    }, decides);
  }

  // ---- Files and Git name the project; nothing of this computer's paths is sent.
  {
    const frames = await page.evaluate(() => window.__PW_FRAMES__);
    const scoped = frames.filter((f) => /^(fs|git)\./.test(f.method));
    // fs.cancel and fs.unwatch name a subscription the runtime resolves, not a project (needs_project in remote/machine.rs).
    const unscoped = scoped.filter((f) => f.method !== "fs.cancel" && f.method !== "fs.unwatch" && f.params.projectId !== "p-tx");
    const local = frames.filter((f) => /\/(private\/)?(tmp|var\/folders)\/|\.raccoon-dev|Application Support/.test(JSON.stringify(f.params)));
    failed += report(`project scope (${colorScheme})`, {
      "files and git were asked for": scoped.length > 0,
      "every fs and git call names the project": unscoped.length === 0,
      "no frame carries a path of this computer": local.length === 0,
    }, { unscoped, local });
  }

  // ---- 21.09: reconnecting.
  {
    await page.locator(`[data-testid="machine-session-row"][title$="${TITLE}"]`).click();
    await strip.waitFor();
    await page.evaluate(() => window.__PW_MACHINE__({ state: "reconnecting", lostAt: Date.now() - 12_000, attempt: 1, retryInMs: 2000, trying: ["lan", "relay"] }));
    const notice = page.locator('main [data-testid="machine-session-reconnecting"]');
    await notice.waitFor({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(200);
    await shoot(page, `21.09-reconnecting-${colorScheme}`);
    const m = await page.evaluate(() => ({
      notice: document.querySelector('main [data-testid="machine-session-reconnecting"]')?.textContent ?? null,
      chip: document.querySelector('main header [data-testid="machine-chip"]')?.textContent ?? null,
      // The composer says so as its placeholder, which textContent does not include.
      blocked: (() => {
        const main = document.querySelector("main");
        const reason = "Can't send until Mac mini is back";
        if (main?.textContent?.includes(reason)) return true;
        return [...(main?.querySelectorAll("[placeholder], [data-placeholder], [aria-placeholder]") ?? [])].some((element) =>
          ["placeholder", "data-placeholder", "aria-placeholder"].some((name) => element.getAttribute(name)?.includes(reason)));
      })(),
    }));
    failed += report(`reconnecting (${colorScheme})`, {
      "the session says it is reconnecting and the agent keeps working": /Reconnecting to Mac mini/.test(m.notice ?? "") && /The agent keeps working there/.test(m.notice ?? ""),
      "the chip says Reconnecting": /Reconnecting/.test(m.chip ?? ""),
      "the composer can't send until it is back": m.blocked,
    }, m);
  }
  await page.close();
}

// ---- No machine paired: no machine session (PRO-360).
{
  const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1280, height: 820 }, { extra: fixture(false) });
  await sidebar(page);
  await page.waitForTimeout(400);
  failed += report("no machine paired", {
    "no machine session or strip": (await page.locator('[data-testid="machine-session-row"], [data-testid="machine-tab-strip"]').count()) === 0,
  });
  await page.close();
}

await browser.close();
server.close();
if (shots) console.log(`screenshots: ${shots}`);
process.exit(failed ? 1 : 0);
