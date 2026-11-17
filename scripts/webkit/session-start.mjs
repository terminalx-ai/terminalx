// PRO-397: drive the real Create dialog and hold the native send at the bridge.
import assert from "node:assert/strict";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createServer, searchForWorkspaceRoot } from "vite";
import { launch, open } from "./harness.mjs";

function fixture() {
  const at = "2026-11-16T00:00:00Z";
  const projectPath = "/repos/p0";
  const cwd = projectPath + "/.raccoon/worktrees/first";
  const setup = { sessionId: "first", paneId: "setup", command: "pnpm install", status: "running", exitCode: null, error: null, hasPane: true };
  let started = false;
  const files = [{ name: "notes.md", path: "/fixtures/attachments/first/send/notes.md" }];
  const stub = window.__PW_STUB__;
  Object.assign(stub.answers, {
    list_harnesses: [{ id: "claude", name: "Claude Code", available: true }],
    list_models: [{ harness: "claude", id: "opus", label: "Opus", efforts: ["high"], defaultEffort: "high", isDefault: true, acceptsImages: true }],
    check_agent_readiness: { state: "ready", checkedAt: null, version: "1" },
    list_projects: { projects: [{ name: "Demo", path: projectPath, kind: "git" }], lastSelected: projectPath },
    list_workspaces: [{ path: projectPath, branch: "main", name: "Demo", isMain: true, managed: false, head: "abc" }],
    work_status: { isRepo: true, branch: "main", defaultBranch: "main", head: "abc" },
    preview_workspace_name: "first",
    load_tab_events: [],
    pty_shells: [],
    tab_pane: null,
    workspace_setup: ({ operation }) => operation === "list" && started ? [setup] : [],
    create_session: ({ req }) => {
      started = true;
      window.__createRequest = req;
      setTimeout(() => stub.emit("workspace_setup_changed", setup), 0);
      return {
        id: "first", title: req.title, projectPath, cwd, worktreeName: "first", branch: "raccoon/first",
        worktreeBase: { commit: "abc", from: "main", fetched: false, warning: null, fileCopy: { copiedCount: 1, firstCopied: ".env.local", copiedBytes: 10, skippedCount: 0, skipped: [], warnings: [], error: null } },
        created: at, modified: at, archived: false, pinned: false, worktreeRemoved: false, activeTab: "tab",
        tabs: [{ id: "tab", ...req.tab, status: "idle", created: at, modified: at }],
      };
    },
    store_attachments: (args) => { window.__storedAttachments = args; return files; },
    send_message: (args) => new Promise((resolve, reject) => {
      window.__firstSend = args;
      const event = { id: "prompt", seq: 1, sessionId: "first", tabId: "tab", ts: at, harness: "claude", promptRequestId: args.promptRequestId,
        payload: { type: "user_message", text: args.text, queued: false, files: args.files } };
      const otherMessage = (id, seq, text) => ({ ...event, id, seq, promptRequestId: undefined, payload: { type: "user_message", text, queued: false } });
      window.__finishSetup = () => stub.emit("workspace_setup_changed", { ...setup, status: "succeeded", exitCode: 0 });
      window.__publishFirstPrompt = () => stub.emit("agent_event", event);
      window.__publishOtherPrompt = () => stub.emit("agent_event", otherMessage("live", 2, "Another live prompt"));
      window.__otherHistory = [otherMessage("history", 3, "Another prompt from history")];
      window.__firstHistory = [event];
      window.__completeFirstSend = () => resolve({ queued: false, events: [event] });
      window.__failFirstSend = () => reject(new Error("Agent could not start"));
    }),
  });
}

const shots = process.env.WEBKIT_LAYOUT_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const server = await createServer({
  server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { allow: [searchForWorkspaceRoot(process.cwd()), await realpath("node_modules")] } },
});
let browser;
try {
  await server.listen();
  browser = await launch();
  for (const [colorScheme, outcome] of [["dark", "reply"], ["light", "broadcast"], ["light", "recorded-failure"], ["light", "failure"]]) {
    const page = await open(browser, server.resolvedUrls.local[0], { cloud: false, localProjects: 1 }, { width: 1440, height: 900 }, { colorScheme, extra: `(${fixture.toString()})();` });
    page.setDefaultTimeout(12_000);
    page.on("pageerror", (error) => console.error(error));
    await page.getByTestId("sidebar-rail").waitFor();
    await page.keyboard.press("Meta+n");
    const dialog = page.getByTestId("new-session-dialog");
    const prompt = "First line\n\nCheck the attached notes.";
    await dialog.locator("[data-new-session-prompt]").fill(prompt);
    const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jT1sAAAAASUVORK5CYII=", "base64");
    await dialog.locator('input[type="file"]').setInputFiles([
      { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Notes") },
      { name: "pixel.png", mimeType: "image/png", buffer: pixel },
    ]);
    await dialog.getByText("notes.md", { exact: true }).waitFor();
    await dialog.getByText("pixel.png", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await page.waitForFunction(() => !!window.__firstSend);
    assert.equal(await page.evaluate(() => window.__createRequest.useWorktree), true);
    assert.deepEqual(await page.evaluate(() => window.__storedAttachments.files.map(({ name }) => name)), ["notes.md"]);
    assert.deepEqual(await page.evaluate(() => [window.__firstSend.text, window.__firstSend.files[0].name]), [prompt, "notes.md"]);

    assert.equal(await page.evaluate(() => window.__firstSend.images[0].name), "pixel.png");
    assert.match(await page.evaluate(() => window.__firstSend.promptRequestId), /^[a-f0-9-]{36}$/);

    const chat = page.locator("[data-chat-scroller]:visible");
    const first = chat.getByTestId("first-message");
    await first.getByText("Check the attached notes.").waitFor();
    await first.getByText("notes.md", { exact: true }).waitFor();
    await first.getByRole("button", { name: "View pixel.png" }).waitFor();
    await first.getByText("Created worktree raccoon/first from main").waitFor();
    await first.getByText("Copied .env.local").waitFor();
    await first.getByText("Running the setup script · pnpm install").waitFor();
    await first.getByText("Your first message is held and sent as soon as Claude Code is ready.").waitFor();
    assert.equal(await chat.getByText(/Nothing here yet|Loading the conversation/).count(), 0);
    await dialog.waitFor({ state: "detached" });
    if (shots && outcome !== "failure") await page.screenshot({ path: join(shots, `session-start-${colorScheme}.png`), animations: "disabled" });

    await page.evaluate(() => window.__finishSetup());
    await first.getByText("Ran the setup script · pnpm install").waitFor();

    if (outcome === "failure") {
      await page.evaluate(() => window.__publishOtherPrompt());
      await chat.getByTestId("reader-message").getByText("Another live prompt").waitFor();
      await first.getByText("Check the attached notes.").waitFor();
      await page.evaluate(() => window.__failFirstSend());
      await first.getByRole("alert").filter({ hasText: "Agent could not start" }).waitFor();
      await page.evaluate(async () => {
        const { mergeTabEvents } = await import("/src/lib/agentEvents.ts");
        mergeTabEvents("first", "tab", window.__otherHistory);
      });
      await chat.getByTestId("reader-message").getByText("Another prompt from history").waitFor();
      await first.getByRole("alert").filter({ hasText: "Agent could not start" }).waitFor();
      await first.getByText("Check the attached notes.").waitFor();
      await first.getByText("notes.md", { exact: true }).waitFor();
      await first.getByRole("button", { name: "View pixel.png" }).waitFor();
      assert.equal(await first.getByText("Sending…").count(), 0);
      await page.evaluate(async () => {
        const { mergeTabEvents } = await import("/src/lib/agentEvents.ts");
        mergeTabEvents("first", "tab", window.__firstHistory);
      });
      await first.waitFor({ state: "detached" });
      assert.equal(await chat.getByText("Check the attached notes.").count(), 1);
    } else {
      if (outcome !== "reply") {
        await page.evaluate(() => window.__publishFirstPrompt());
        await first.waitFor({ state: "detached" });
        assert.equal(await chat.getByText("Check the attached notes.").count(), 1);
      }
      if (outcome === "recorded-failure") {
        const rejected = page.waitForEvent("console", { predicate: (message) => message.text().includes("first send failed") });
        await page.evaluate(() => window.__failFirstSend());
        await rejected;
        assert.equal(await first.count(), 0);
      } else {
        await page.evaluate(() => window.__completeFirstSend());
        await first.waitFor({ state: "detached" });
      }
      const message = chat.getByTestId("reader-message");
      await message.getByText("Check the attached notes.").waitFor();
      await message.getByText("notes.md", { exact: true }).waitFor();
      assert.equal(await message.count(), 1);
    }
    console.log(`ok Create with delayed first send (${colorScheme}, ${outcome})`);
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
