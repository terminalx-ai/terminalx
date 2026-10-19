#!/usr/bin/env node
// #555: "Link to a project" opens a dialog before anything moves: the
// destination, and the launch settings New Session uses, starting from the
// chat's own. The move starts exactly what was chosen (another provider, and
// Bypass permissions once its own confirmation is agreed to over the dialog),
// and archives the chat only once the new session has started.
//
// pnpm build && pnpm exec playwright install webkit && pnpm test:webkit-link-chat
import assert from "node:assert/strict";
import { launch, open, serve, sidebar } from "./harness.mjs";

const extra = `(() => {
  const answers = window.__PW_STUB__.answers;
  const calls = window.__PW_CALLS__ = [];
  const record = (cmd, args) => calls.push({ cmd, args });
  const at = new Date().toISOString();
  const chatTab = { id: "chat-tab", harness: "claude", title: "Plan the login page", model: "sonnet", effort: "low", permissionMode: "plan", status: "idle", created: at, modified: at };
  const chat = { id: "chat-1", projectPath: "/store/Chats", cwd: "/store/Chats", worktreeRemoved: false, title: "Plan the login page", created: at, modified: at, archived: false, pinned: false, tabs: [chatTab], activeTab: chatTab.id };
  const model = (harness, id, label, efforts, isDefault = false) => ({ id, label, harness, efforts, defaultEffort: efforts[1] ?? null, acceptsImages: true, isDefault, upgrade: null, description: null });
  answers.chats_dir = "/store/Chats";
  answers.list_sessions = [chat];
  answers.list_harnesses = [{ id: "claude", name: "Claude Code", available: true }, { id: "codex", name: "Codex", available: true }];
  answers.list_models = [
    model("claude", "opus", "Opus", ["low", "medium", "high", "max"], true), model("claude", "sonnet", "Sonnet", ["low", "medium", "high"]),
    model("codex", "gpt-6", "GPT-6", ["low", "medium", "high"], true), model("codex", "gpt-6-mini", "GPT-6 Mini", ["low", "medium"]),
  ];
  answers.prepare_continuation = { sessionId: "chat-1", tabId: "chat-tab", title: "Plan the login page", provider: "claude", providerSessionId: "p1", cwd: "/store/Chats", sourceActive: false, transcriptPath: "/t/p1.jsonl", fullUnavailableReason: null, lastPrompt: "Make the login page", lastUpdate: "Drafted the form", partialCapture: null };
  answers.create_session = ({ req }) => {
    record("create_session", req);
    return { ...chat, id: "work-1", projectPath: req.projectPath, cwd: req.projectPath + "/.raccoon/worktrees/plan", title: req.title, tabs: [{ ...chatTab, id: "work-tab", ...req.tab }], activeTab: "work-tab" };
  };
  answers.ensure_tab_started = (args) => { record("ensure_tab_started", args); return null; };
  answers.set_session_archived = (args) => { record("set_session_archived", args); return null; };
  answers.send_message = (args) => { record("send_message", args); return { queued: false, events: [] }; };
})();`;

const server = await serve();
let browser;
try {
  browser = await launch();
  const page = await open(browser, server.url, { cloud: false, localProjects: 2 }, { width: 1100, height: 720 }, { extra });
  const rail = await sidebar(page);
  const chats = rail.getByRole("region", { name: "Chats" });
  // The row's actions show on hover.
  await chats.getByRole("button", { name: /Plan the login page/ }).hover();
  await chats.getByRole("button", { name: "Menu for Plan the login page" }).click();
  await page.getByRole("menuitem", { name: "Link to a project" }).click();
  await page.getByRole("menuitem", { name: "local-0" }).click();
  await page.getByRole("menuitem", { name: "On a new branch (worktree)" }).click();

  const dialog = page.getByRole("dialog", { name: "Link to a Project" });
  const start = dialog.getByRole("button", { name: "Link and Start" });
  await dialog.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent === "Link and Start" && !b.disabled));
  assert.deepEqual(await page.evaluate(() => window.__PW_CALLS__), [], "picking a place moves nothing");
  const pills = () => Promise.all(["Agent", "Model", "Effort", "Permissions"].map((title) => dialog.getByTitle(title).textContent()));
  assert.deepEqual(await pills(), ["Claude Code", "Sonnet", "Low", "Plan"]);
  assert.equal(await dialog.getByRole("switch", { name: "Start on a new branch in a worktree" }).getAttribute("aria-checked"), "true");
  assert.ok(await dialog.getByText("/repos/p0").isVisible());
  const box = await dialog.boundingBox();
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1100 && box.y + box.height <= 720, `dialog inside the window: ${JSON.stringify(box)}`);
  assert.ok(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth), "no sideways scroll in the dialog");
  if (process.env.WEBKIT_LAYOUT_SCREENSHOTS) {
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      await page.waitForFunction((mode) => document.documentElement.dataset.mode === mode, colorScheme);
      await page.screenshot({ path: `${process.env.WEBKIT_LAYOUT_SCREENSHOTS}/link-chat-${colorScheme}.png`, animations: "disabled" });
    }
    await page.emulateMedia({ colorScheme: "light" });
  }
  console.log("ok  picking a project opens the dialog with the destination and the chat's own launch settings; nothing moves yet");

  await dialog.getByTitle("Agent").click();
  await page.getByRole("menuitem", { name: "Codex" }).click();
  assert.deepEqual(await pills(), ["Codex", "GPT-6", "Medium", "Plan"]);
  await dialog.getByTitle("Permissions").click();
  await page.getByRole("menuitemradio", { name: /^Bypass permissions/ }).click();
  const bypass = page.getByRole("dialog", { name: "Let Codex run without asking?" });
  await bypass.waitFor();
  // Under the confirmation the link dialog is still there, hidden from assistive technology by the modal on top.
  assert.equal(await page.getByRole("dialog", { name: "Link to a Project", includeHidden: true }).count(), 1, "the link dialog stays open under the confirmation");
  await bypass.getByRole("button", { name: "Bypass permissions" }).click();
  await bypass.waitFor({ state: "hidden" });
  assert.ok(await dialog.isVisible(), "agreeing to Bypass returns to the link dialog");
  assert.deepEqual(await pills(), ["Codex", "GPT-6", "Medium", "Bypass permissions"]);
  console.log("ok  another provider falls back to its own model and effort; Bypass asks first, over the dialog, and keeps it open");

  await start.click();
  await dialog.waitFor({ state: "hidden" });
  const calls = await page.evaluate(() => window.__PW_CALLS__);
  const commands = calls.map((call) => call.cmd);
  // The opened tab starts its agent too; starting is idempotent, so only the order around it matters.
  assert.deepEqual(commands.filter((cmd) => cmd !== "ensure_tab_started"), ["create_session", "set_session_archived", "send_message"], `one session, one archive, one handoff: ${commands}`);
  assert.ok(commands.indexOf("ensure_tab_started") > 0 && commands.indexOf("ensure_tab_started") < commands.indexOf("set_session_archived"), `archived only once started: ${commands}`);
  const call = (cmd) => calls.find((entry) => entry.cmd === cmd).args;
  assert.deepEqual(call("create_session"), { projectPath: "/repos/p0", title: "Plan the login page", useWorktree: true, onMain: false, tab: { harness: "codex", model: "gpt-6", effort: "medium", permissionMode: "bypassPermissions" } });
  assert.deepEqual(call("set_session_archived"), { sessionId: "chat-1", archived: true });
  assert.match(call("send_message").text, /into the project at \/repos\/p0/);
  // The chat left the Chats list for the project's, where its new session is the open one.
  await rail.getByRole("region", { name: "Chats" }).waitFor({ state: "detached" });
  // Alone on its branch, the row is named "<branch>, <title>".
  assert.match(await rail.getByRole("region", { name: "Projects" }).locator('[aria-current="true"]').getAttribute("aria-label"), /, Plan the login page$/);
  console.log("ok  the new session starts with exactly what was chosen, and the chat is archived after it has started");
} finally {
  await browser?.close();
  server.close();
}
