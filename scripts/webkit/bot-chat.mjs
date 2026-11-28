#!/usr/bin/env node
// PRO-468: a bot's view (designs 23.01 and 23.04) in real WebKit, at 1440×900 and at the scaled 1280×800, dark and
// light: the header (avatar, name, role, status line, chips, Pause) on one band; the five tabs; on Chat, the chat
// list beside the transcript and composer; a paused bot's banner with Resume. Nothing overlaps, nothing leaves the
// window, and the bot's chats are not in the sidebar's lists. PRO-478: the header's menu after Pause, and the
// Settings tab with the bot's five settings sections inside the view.
// Run after pnpm build: node scripts/webkit/bot-chat.mjs
// BOT_CHAT_SHOTS=<dir> saves a screenshot of each case.
import { launch, open, openSession, report, serve, sidebar } from "./harness.mjs";

const shots = process.env.BOT_CHAT_SHOTS;
const server = await serve();
const browser = await launch();
let failed = 0;

const fixture = (paused) => `
  const backend = window.__PW_STUB__;
  const at = new Date().toISOString();
  const tab = (id) => ({ id, harness: "claude", model: "", permissionMode: "bypassPermissions", status: "idle", created: at, modified: at });
  const chat = (id, title, bot, extra = {}) => ({ id, kind: "quick", projectPath: "/scratch/" + id, cwd: "/home/.raccoon/bots/b1", title, created: at, modified: at,
    archived: false, pinned: false, worktreeRemoved: false, tabs: [tab(id + "-t")], activeTab: id + "-t", bot, ...extra });
  backend.answers.list_sessions = [
    chat("bot-home", "Home chat", { id: "b1", home: true }),
    chat("bot-other", "Chat with Kestrel", { id: "b1" }),
    chat("bot-started", "Move the macOS jobs to our own runner", null, { kind: undefined, projectPath: "/repos/p0", cwd: "/repos/p0", parent: { sessionId: "bot-home" } }),
  ];
  backend.answers.load_tab_events = () => [];
  backend.answers.experimental_settings = { nativeCodex: false, bots: true };
  const bot = { id: "b1", slug: "kestrel", name: "Kestrel", roleTitle: "CTO", roleTemplateId: "cto", harness: "claude", model: "", access: "full", runsOn: "thisMac",
    reportsTo: "owner", worksIn: ["personal"], created: at, modified: at${paused ? ', paused: { at, by: "owner" }' : ""} };
  backend.answers.bot_list = { revision: 1, bots: [bot], unreadable: 0 };
  backend.answers.bot_home_chat = () => backend.answers.list_sessions[0];
`;

const box = (locator) => locator.evaluate((element) => {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
});
const overlaps = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
const inside = (inner, outer) => inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;

const chatCases = shots
  ? [{ width: 1440, height: 900 }, { width: 1280, height: 800 }].flatMap((viewport) => ["dark", "light"].map((colorScheme) => ({ viewport, colorScheme })))
  : [{ viewport: { width: 1440, height: 900 }, colorScheme: "dark" }, { viewport: { width: 1280, height: 800 }, colorScheme: "light" }];
try {
  for (const { viewport, colorScheme } of chatCases) {
      for (const paused of [false, true]) {
        const name = `${viewport.width}×${viewport.height} ${colorScheme}${paused ? " paused" : ""}`;
        const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, viewport, { extra: fixture(paused), colorScheme });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const rail = await sidebar(page);
        // The bot's chats are under the bot, not in the sidebar's lists; a session one started is where it was.
        await rail.getByText("Move the macOS jobs to our own runner").first().waitFor();
        const listed = await rail.getByText("Chat with Kestrel").count();
        // Open the home chat the way a notification does: it opens in its bot's view.
        const view = await openSession(page, "bot-home", "Kestrel, CTO");
        const heading = view.getByRole("heading", { name: "Kestrel", exact: true });
        const chips = view.locator("span", { hasText: "Full access" }).last();
        const pause = view.getByRole("button", { name: paused ? "Resume" : "Pause" }).first();
        const tabs = view.getByRole("tablist", { name: "Kestrel's view" });
        const list = view.getByRole("navigation", { name: "Kestrel's chats" });
        const composer = view.locator("textarea").first();
        await composer.waitFor();
        const banner = view.getByRole("status").filter({ hasText: "Paused." });
        if (shots) await page.screenshot({ path: `${shots}/bot-chat-${viewport.width}-${colorScheme}${paused ? "-paused" : ""}.png` });

        const [viewBox, headingBox, chipBox, pauseBox, tabsBox, listBox, composerBox] = await Promise.all([view, heading, chips, pause, tabs, list, composer].map(box));
        const window_ = { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
        const tabNames = (await tabs.getByRole("tab").allTextContents()).map((text) => text.trim());
        const rows = await list.getByRole("button").allTextContents();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
        const checks = {
          "the view fits the window": inside(viewBox, window_) && !overflow,
          "the name, the chips and Pause share one band above the tabs": headingBox.bottom <= tabsBox.top + 0.5 && chipBox.bottom <= tabsBox.top + 0.5 && pauseBox.bottom <= tabsBox.top + 0.5,
          "the chips stand right of the name and do not cover it": !overlaps(headingBox, chipBox) && chipBox.left > headingBox.right - 0.5,
          "Pause is the last control of the header and inside the view": pauseBox.left >= chipBox.right - 0.5 && inside(pauseBox, viewBox),
          "the five tabs, in order": JSON.stringify(tabNames) === JSON.stringify(["Home", "Chat", "Duties", "Role and memory", "Settings"]),
          "the chat list stands left of the composer, below the tabs": listBox.right <= composerBox.left + 0.5 && listBox.top >= tabsBox.bottom - 0.5,
          "the chat list has the home chat, the other chat and the session it started": rows.some((row) => row.includes("Home chat")) && rows.some((row) => row.includes("Chat with Kestrel")) && rows.some((row) => row.includes("Move the macOS jobs")),
          "the composer is inside the window": inside(composerBox, window_),
          "the bot's chats are not in the sidebar's lists": listed === 0,
          "a paused bot says so above the chat, with Resume": paused ? (await banner.count()) === 1 && (await banner.getByRole("button", { name: "Resume" }).count()) === 1 : (await banner.count()) === 0,
          "no page errors": errors.length === 0,
        };
        if (paused) {
          const bannerBox = await box(banner);
          checks["the banner sits between the tabs and the composer, right of the list"] = bannerBox.top >= tabsBox.bottom - 0.5 && bannerBox.bottom <= composerBox.top + 0.5 && bannerBox.left >= listBox.right - 0.5;
        }
        // PRO-478: the header's menu after Pause, on the same band.
        const menuBox = await box(view.getByTestId("bot-menu"));
        checks["the menu follows Pause on the header's band, inside the view"] = menuBox.left >= pauseBox.right - 0.5 && menuBox.bottom <= tabsBox.top + 0.5 && inside(menuBox, viewBox);
        failed += report(`bot chat ${name}`, checks, { viewBox, headingBox, chipBox, pauseBox, menuBox, tabsBox, listBox, composerBox, tabNames, rows, listed, errors });

        // PRO-478: the Settings tab has the bot's settings, inside the view, scrolling within it.
        await tabs.getByRole("tab", { name: "Settings" }).click();
        const panel = view.getByTestId("bot-view-settings");
        await panel.getByTestId("bot-settings").waitFor();
        if (shots) await page.screenshot({ path: `${shots}/bot-chat-settings-${viewport.width}-${colorScheme}${paused ? "-paused" : ""}.png` });
        const settings = await panel.evaluate((element) => {
          const outer = element.getBoundingClientRect();
          const problems = [];
          const label = (node) => (node.getAttribute("aria-label") || node.textContent || node.tagName).trim().slice(0, 40);
          for (const node of element.querySelectorAll("[data-testid=bot-settings-section], [role=radio], li, button, [role=switch]")) {
            const rect = node.getBoundingClientRect();
            if (rect.width > 0 && (rect.left < outer.left - 0.5 || rect.right > outer.right + 0.5)) problems.push(`${label(node)} leaves the panel sideways`);
          }
          const sections = element.querySelectorAll("[data-testid=bot-settings-section]").length;
          return { problems, sections, scrolls: element.scrollHeight > element.clientHeight, sideways: document.documentElement.scrollWidth > innerWidth + 1, outer: { left: outer.left, top: outer.top, right: outer.right, bottom: outer.bottom } };
        });
        failed += report(`bot settings tab ${name}`, {
          "the five sections": settings.sections === 5,
          "nothing leaves the panel sideways, nor the page": settings.problems.length === 0 && !settings.sideways,
          "the panel sits below the tabs and inside the view": settings.outer.top >= tabsBox.bottom - 0.5 && inside(settings.outer, viewBox),
          "no page errors": errors.length === 0,
        }, settings);
        await page.close();
      }
  }
} finally {
  await browser.close();
  server.close();
}
if (failed) process.exit(1);
