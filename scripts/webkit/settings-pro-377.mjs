#!/usr/bin/env node
// PRO-377: Settings → Appearance, Shortcuts and Agents against designs 09.08,
// 09.13 and 10.19–10.21, in the desktop's WebKit engine at 1440 wide, in dark
// and in light:
//
// - no text on any of the three pages is drawn below 12px;
// - Appearance has the design's rows only (Theme, Mode, Colored sidebar diffs),
//   Mode is a select with its keys beneath, Ember says "dark only", and the
//   Theme row has no "…" menu; the rows that left are on General;
// - Shortcuts groups are a sentence-case title above a bordered card, one
//   keycap per chord, a pencil on bound rows and "Not set" with + on others;
// - Agents shows "· up to date" beside the version.
//
// A picture of each page is written to $PRO_377_SHOTS (default /tmp).
//
//   pnpm build && node scripts/webkit/settings-pro-377.mjs
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const shots = process.env.PRO_377_SHOTS ?? "/tmp";
const caps = { images: true, steer: false, permissionModes: true, effort: true, slashCommands: true, atMentions: true, fork: true, resume: true };
const harnesses = [
  { id: "claude", name: "Claude Code", binary: "claude", available: true, installable: true, path: "/Users/ada/.local/bin/claude", installHint: "", installUrl: "https://docs.claude.com/claude-code", caps },
  { id: "codex", name: "Codex", binary: "codex", available: true, installable: true, path: "/opt/homebrew/bin/codex", installHint: "", installUrl: "https://developers.openai.com/codex/cli", caps },
];
const backend = `(() => {
  const answers = window.__PW_STUB__.answers;
  const now = () => new Date().toISOString();
  answers.list_harnesses = ${JSON.stringify(harnesses)};
  answers.check_agent_readiness = ({ harness }) => ({ state: "ready", checkedAt: now(), version: harness === "claude" ? "2.3.41" : "0.166.0", loginMethod: "Claude account", plan: "max", account: "ada@example.com", organization: harness === "claude" ? "Acme" : null });
  answers.agent_latest_version = ({ harness }) => harness === "claude" ? "2.3.41" : "0.166.0";
  answers.agent_setup_running = null;
  answers.agent_login_status = ({ harness }) => ({ harness, variable: harness === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY", mode: "api_key",
    saved: { masked: "sk-ant-api03-" + "•".repeat(24) + "4f2a", savedAt: now(), ...(harness === "codex" ? { fromShell: { file: "~/.zshrc" } } : {}) },
    verified: { ok: true, checkedAt: now() }, ...(harness === "codex" ? { config: "~/.codex/config.toml" } : {}) });
  answers.agent_login_shell_offer = null;
  answers.agent_login_verify = () => ({ ok: true, checkedAt: now() });
  answers.agent_login_tabs = [];
  answers.agent_accounts_list = ({ harness }) => ({ agent: harness, defaultAccount: "api-key", projectDefaults: {}, accounts: [] });
})();`;

/** Every visible text node's computed size on the Settings page, below 12px listed. */
const smallText = (page) => page.evaluate(() => {
  const main = document.querySelector('main[aria-label="Settings"]') ?? document.body;
  const small = [];
  const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.trim();
    const element = node.parentElement;
    if (!text || !element) continue;
    const rect = element.getBoundingClientRect();
    // The pages only: the menu's group titles are 11px by its own design (09.02, PRO-374).
    if (!rect.width || !rect.height || getComputedStyle(element).visibility === "hidden" || element.closest('[aria-hidden=true], .sr-only, option, nav[aria-label="Settings sections"]')) continue;
    const size = parseFloat(getComputedStyle(element).fontSize);
    if (size < 12) small.push(`${size}px "${text.slice(0, 40)}"`);
  }
  return small;
});

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const scheme of ["dark", "light"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1440, height: 900 }, { extra: backend, colorScheme: scheme, locale: "en-US" });
    // The mode follows the system: the scheme the page sees.
    await (await sidebar(page)).getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("main", { name: "Settings", exact: true });
    const nav = settings.getByRole("navigation", { name: "Settings sections" });
    const go = async (name) => { await nav.getByRole("button", { name, exact: true }).click(); await page.waitForTimeout(300); };

    await go("Appearance");
    await settings.getByLabel("Mode", { exact: true }).waitFor();
    await page.screenshot({ path: `${shots}/pro-377-appearance-${scheme}.png` });
    const appearance = await page.evaluate(() => {
      const ids = [...document.querySelectorAll("[data-setting-id]")].map((row) => row.dataset.settingId);
      const theme = document.querySelector('[data-setting-id="appearance.theme"]');
      const mode = document.querySelector('[data-setting-id="appearance.mode"]');
      return { ids, themeButtons: theme ? [...theme.querySelectorAll("button")].filter((b) => !b.getAttribute("role")).length : -1, modeText: mode?.textContent ?? "", select: mode?.querySelector("select")?.value ?? null, text: document.querySelector('main[aria-label="Settings"]').textContent };
    });
    failed += report(`Appearance (${scheme})`, {
      "the design's rows only": JSON.stringify(appearance.ids) === JSON.stringify(["appearance.theme", "appearance.mode", "appearance.colourLineCounts"]),
      "Mode is a select": appearance.select === "system",
      "Mode says its keys": /switches light and dark/.test(appearance.modeText),
      "the Theme row has no menu": appearance.themeButtons === 0,
      "Ember is dark only": appearance.text.includes("Emberdark only"),
      "Colored sidebar diffs": appearance.text.includes("Colored sidebar diffs"),
    }, appearance);
    // PRO-400 (17.07): each theme card is a 200 by 124 drawing of the window in that theme, with its name and a caption.
    const themes = await page.evaluate(() => {
      const column = document.querySelector('[data-setting-id="appearance.theme"]').getBoundingClientRect();
      return [...document.querySelectorAll("[data-theme-card]")].map((card) => {
        const preview = card.querySelector("[data-theme-preview]");
        const box = preview.getBoundingClientRect();
        const [sidebar, chat] = preview.children;
        return {
          id: card.dataset.themeCard, width: box.width, height: box.height, labels: [...card.children].slice(1).map((label) => label.textContent),
          sidebar: sidebar.getBoundingClientRect().width, sidebarRows: sidebar.children.length - 1, chatParts: chat.children.length,
          accent: getComputedStyle(preview.querySelector("[data-theme-accent]")).backgroundColor, page: getComputedStyle(preview).backgroundColor,
          inColumn: card.getBoundingClientRect().right <= column.right + 1, checked: card.getAttribute("aria-checked"),
        };
      });
    });
    failed += report(`Appearance theme cards (${scheme})`, {
      "four cards, each 200 by 124": themes.length === 4 && themes.every((card) => card.width === 200 && card.height === 124),
      "each draws a window: a sidebar with rows, then the chat": themes.every((card) => card.sidebar === 54 && card.sidebarRows === 5 && card.chatParts === 5),
      "each has an accent button in its own accent": themes.every((card) => card.accent !== card.page) && new Set(themes.map((card) => card.accent)).size > 1,
      "each has its name and a caption": JSON.stringify(themes.map((card) => card.labels)) === JSON.stringify([["Den", "default"], ["Slate", "cool neutral grey"], ["Moss", "green-tinted"], ["Ember", "dark only"]]),
      "the cards stay inside the column, and Den is the one chosen": themes.every((card) => card.inColumn) && themes.map((card) => card.checked).join() === "true,false,false,false",
    }, themes);
    failed += report(`Appearance text (${scheme})`, { "nothing below 12px": (await smallText(page)).length === 0 }, await smallText(page));

    await go("General");
    const general = await page.evaluate(() => [...document.querySelectorAll("[data-setting-id]")].map((row) => row.dataset.settingId));
    failed += report(`General (${scheme})`, { "has the rows Appearance gave up": ["general.textSize", "general.transcriptLayout", "general.customOrder", "general.tabBar", "general.statusBar", "general.usageRefresh"].every((id) => general.includes(id)) }, general);

    await go("Keyboard shortcuts");
    await page.locator('[data-testid="shortcuts-tab"]').waitFor();
    await page.screenshot({ path: `${shots}/pro-377-shortcuts-${scheme}.png` });
    const shortcuts = await page.evaluate(() => {
      const session = document.querySelector('section[aria-label="Session shortcuts"]');
      const title = session.firstElementChild;
      const card = title.nextElementSibling;
      const style = getComputedStyle(card);
      const rows = [...card.children];
      const next = card.querySelector('[data-shortcut="session.nextTab"]');
      const unset = card.querySelector('[data-shortcut="session.stop"]');
      return {
        title: title.textContent, titleSize: getComputedStyle(title).fontSize, titleCase: getComputedStyle(title).textTransform,
        bordered: parseFloat(style.borderTopWidth) > 0 && parseFloat(style.borderTopLeftRadius) > 0,
        dividers: rows.slice(1).every((row) => parseFloat(getComputedStyle(row).borderTopWidth) > 0),
        // The row itself; the hairline above it is the card's divider.
        rowHeight: Math.round(next.firstElementChild.getBoundingClientRect().height),
        nextKeys: [...next.querySelectorAll("kbd")].map((kbd) => kbd.textContent),
        pencil: !!next.querySelector('button[aria-label^="Change the shortcut for"] svg'),
        unset: unset?.textContent ?? "", unsetPlus: !!unset?.querySelector("button svg"),
      };
    });
    failed += report(`Shortcuts (${scheme})`, {
      "the group title is sentence case at 13px": shortcuts.title === "Session" && shortcuts.titleSize === "13px" && shortcuts.titleCase === "none",
      "rows sit in a bordered card with hairlines between": shortcuts.bordered && shortcuts.dividers,
      "rows are 35px": shortcuts.rowHeight === 35,
      "one keycap per chord": shortcuts.nextKeys.length === 1 && shortcuts.nextKeys[0] === "⇧⌘]",
      "a pencil edits": shortcuts.pencil,
      "an unbound action says Not set with +": shortcuts.unset.includes("Not set") && shortcuts.unsetPlus,
    }, shortcuts);
    failed += report(`Shortcuts text (${scheme})`, { "nothing below 12px": (await smallText(page)).length === 0 }, await smallText(page));

    await go("Agents");
    await page.getByText("2.3.41 · up to date").waitFor();
    await page.screenshot({ path: `${shots}/pro-377-agents-claude-${scheme}.png` });
    const claudeText = await settings.textContent();
    failed += report(`Agents · Claude Code (${scheme})`, { "Organization with a key": claudeText.includes("OrganizationAcme"), "up to date": claudeText.includes("Version2.3.41 · up to date") });
    failed += report(`Agents text (${scheme})`, { "nothing below 12px": (await smallText(page)).length === 0 }, await smallText(page));
    await page.getByRole("tab", { name: /Codex/ }).click();
    await page.getByText("From your shell").waitFor();
    await page.screenshot({ path: `${shots}/pro-377-agents-codex-${scheme}.png` });
    const codexText = await settings.textContent();
    failed += report(`Agents · Codex imported (${scheme})`, { "no second Keychain note": !codexText.includes("Kept in the Keychain") });
    failed += report(`Agents · Codex text (${scheme})`, { "nothing below 12px": (await smallText(page)).length === 0 }, await smallText(page));
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
