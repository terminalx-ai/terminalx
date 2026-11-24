// PRO-397: drive the real Create dialog and hold the native send at the bridge.
//
// Runs against the built app (`pnpm build`), like the other layout checks. It
// used to start a Vite dev server so the page could import
// /src/lib/agentEvents.ts and call mergeTabEvents itself; the first load of
// the whole unbundled app then had to finish inside page.goto's 30 s, which a
// busy runner did not always manage. Saved history now reaches the page the
// way it does in the app: the bridge answers load_tab_events and the runtime
// says it reattached, so the app reads the tab's history again and merges it.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, serve } from "./harness.mjs";

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
      const session = {
        id: "first", title: req.title, projectPath, cwd, worktreeName: "first", branch: "raccoon/first",
        worktreeBase: { commit: "abc", from: "main", fetched: false, warning: null, fileCopy: { copiedCount: 1, firstCopied: ".env.local", copiedBytes: 10, skippedCount: 0, skipped: [], warnings: [], error: null } },
        created: at, modified: at, archived: false, pinned: false, worktreeRemoved: false, activeTab: "tab",
        tabs: [{ id: "tab", ...req.tab, status: "idle", created: at, modified: at }],
      };
      // The runtime lists what it created: the app reads the list again when the runtime reattaches.
      stub.answers.list_sessions = [...stub.answers.list_sessions, session];
      return session;
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
      // A reattached runtime makes the app read every open tab's saved history again.
      const readHistory = (events) => () => {
        stub.answers.load_tab_events = events;
        stub.emit("local_runtime_reattached", null);
      };
      window.__readOtherHistory = readHistory([otherMessage("history", 3, "Another prompt from history")]);
      window.__readFirstHistory = readHistory([event]);
      window.__completeFirstSend = () => resolve({ queued: false, events: [event] });
      window.__failFirstSend = () => reject(new Error("Agent could not start"));
    }),
  });
}

function placementFixture(ready) {
  const { answers } = window.__PW_STUB__;
  const org = "org-a";
  const fullName = "procyon-labs/long-repository-for-session-placement";
  answers.account_status.organizations = [{
    ...answers.account_status.organizations[0], name: "Procyon Labs Engineering",
  }];
  if (ready) answers.account_status.phase2Readiness = { [org]: ["cloud.workspaces.session-placement.v1"] };
  const provider = "compute";
  const defaults = { sourceId: "image", locationId: "fra", machineClassId: "small", idleSuspendMinutes: 30, retentionDays: 7, networkPolicy: "open" };
  const machine = { id: "small", label: "General Purpose Shared CPU", vcpu: 2, memoryMiB: 4096, diskGiB: 20, activeHourlyMicros: 120_000 };
  const check = (kind, status = "verified", extra = {}) => ({ kind, status, errorCode: null, retryable: false, cloneUrl: null, ...extra });
  window.__placementCalls = [];
  let environmentReady = false;
  window.__publishEnvironment = () => { environmentReady = true; };
  Object.assign(answers, {
    cloud_workspace_repositories: { configured: true, repositories: [{ fullName, cloneUrl: `https://github.com/${fullName}.git`, defaultBranch: "main", private: true, state: "accessible", reason: null }] },
    cloud_workspaces: { workspaces: [], quota: { used: 0, limit: 3, running: { used: 0, limit: 3 } } },
    github_identity: { repo: fullName, remoteHost: "github", login: null, email: null, source: null },
    cloud_providers: () => {
      window.__placementCalls.push("offers");
      return { providers: [{ id: provider, displayName: "Regional Compute Provider", availability: "available", descriptor: null, connection: null }] };
    },
    cloud_workspace_setup: () => {
      window.__placementCalls.push("setup");
      return { provider, defaults, locations: [{ id: "fra", label: "Frankfurt", placement: "selected" }], machineClasses: [machine], allowedIdleSuspendMinutes: [30, 60], currency: "USD", pricing: "provider-rate" };
    },
    cloud_workspace_quote: () => {
      window.__placementCalls.push("quote");
      return { id: "q", provider, expiresAt: Date.now() + 60000, currency: "USD", pricing: "provider-rate", activeHourlyMicros: machine.activeHourlyMicros,
        configuration: { ...defaults, machineClassLabel: machine.label, vcpu: machine.vcpu, memoryMiB: machine.memoryMiB, locationLabel: "Frankfurt" } };
    },
    cloud_workspace_preflight: ({ agent }) => {
      window.__placementCalls.push("preflight");
      return { ready: environmentReady, checks: [check("agent-credential", "verified", { agent }),
        check("repository", environmentReady ? "verified" : "failed", { errorCode: environmentReady ? null : "cloud_environment_version_missing" })] };
    },
    cloud_workspace_create: () => {
      window.__placementCalls.push("create");
      throw new Error("The layout check must never create a workspace");
    },
    list_models: [{ harness: "claude", id: "opus", label: "Opus", efforts: [], isDefault: true }],
  });
}

const shots = process.env.WEBKIT_LAYOUT_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const server = await serve();
let browser;
try {
  browser = await launch();
  for (const [colorScheme, outcome] of [["dark", "reply"], ["light", "broadcast"], ["light", "recorded-failure"], ["light", "failure"]]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1440, height: 900 }, { colorScheme, extra: `(${fixture.toString()})();` });
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
      await page.evaluate(() => window.__readOtherHistory());
      await chat.getByTestId("reader-message").getByText("Another prompt from history").waitFor();
      await first.getByRole("alert").filter({ hasText: "Agent could not start" }).waitFor();
      await first.getByText("Check the attached notes.").waitFor();
      await first.getByText("notes.md", { exact: true }).waitFor();
      await first.getByRole("button", { name: "View pixel.png" }).waitFor();
      assert.equal(await first.getByText("Sending…").count(), 0);
      await page.evaluate(() => window.__readFirstHistory());
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
  for (const ready of [false, true]) {
    const page = await open(browser, server.url, { cloud: true, localProjects: 1 }, { width: 760, height: 680 }, {
      extra: `(${placementFixture.toString()})(${ready});`,
    });
    page.setDefaultTimeout(12_000);
    await page.getByTestId("sidebar-rail").waitFor();
    await page.keyboard.press("Meta+n");
    const prompt = page.locator("[data-new-session-prompt]");
    await prompt.fill("Keep this draft while choosing where it runs.");
    if (!ready) {
      assert.equal(await page.getByTestId("where-it-runs").count(), 0);
      assert.deepEqual(await page.evaluate(() => window.__placementCalls), []);
    } else {
      const where = page.getByTestId("where-it-runs");
      await where.click();
      const provider = page.getByTestId("where-cloud-org-a-compute");
      await provider.getByText("No environment version is ready for this organization.").waitFor();
      assert.equal(await provider.getAttribute("aria-disabled"), "true");
      await page.evaluate(() => window.__publishEnvironment());
      await page.getByRole("menuitem", { name: "Recheck cloud placement" }).click();
      await where.click();
      await provider.click();
      await page.getByTestId("cloud-placement-readiness").getByText(/Cloud preflight passed. Environment version unavailable/).waitFor();
      assert.equal(await prompt.inputValue(), "Keep this draft while choosing where it runs.");
      await page.getByRole("button", { name: "Visible to Only me" }).click();
      await page.getByRole("menuitemradio", { name: "Everyone at Procyon Labs Engineering" }).click();
      const header = page.getByTestId("new-session-header");
      await header.getByRole("button", { name: "Visible to Procyon Labs Engineering" }).waitFor();
      await header.getByTestId("cloud-placement-machine").getByText("General Purpose Shared CPU · $0.12 an hour").waitFor();
      await page.getByRole("button", { name: "Create in cloud" }).waitFor();
      assert.deepEqual(await header.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return [...element.children].filter((child) => {
          const bounds = child.getBoundingClientRect();
          return bounds.width && (bounds.left < box.left - 1 || bounds.right > box.right + 1 || bounds.bottom > box.bottom + 1);
        }).map((child) => child.textContent);
      }), [], "placement chips stay inside the narrow header");
      if (shots) await page.screenshot({ path: join(shots, "session-placement-narrow.png"), animations: "disabled" });
      assert.ok(!(await page.evaluate(() => window.__placementCalls)).includes("create"));
    }
    console.log(`ok Session placement at 760px (${ready ? "ready" : "held"})`);
    await page.close();
  }
} finally {
  await browser?.close();
  server.close();
}
