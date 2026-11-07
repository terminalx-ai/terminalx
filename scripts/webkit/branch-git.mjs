#!/usr/bin/env node
// PRO-199: header layout, live state events, named-account confirmation and
// keyboard actions in the built frontend. Native Git/GitHub calls are stubbed.
import { launch, open, openConversation, report, serve } from "./harness.mjs";

const server = await serve();
const browser = await launch();
let failed = 0;
const extra = `
localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: false }));
(() => {
  const { answers, emit } = window.__PW_STUB__;
  const session = answers.list_sessions[0];
  session.branch = "feature";
  session.tabs = session.tabs.map(tab => ({ ...tab, title: "", status: "completed" }));
  session.activeTab = "lt-chat";
  answers.load_tab_events = () => [];
  answers.github_identity = { login: "alice", source: "ssh", remoteHost: "github", repo: "example/repo" };
  window.__gitCalls = [];
  window.__branch = { revision: 1, sessionId: session.id, cwd: session.cwd, branch: "feature", head: "abc", base: "develop", mergeMethod: "squash", state: "uncommitted", actions: ["commitPush"], pr: null, behindUpstream: false };
  answers.branch_step_refresh = () => window.__branch;
  let approved = false;
  answers.branch_step_account = () => ({ login: "alice", destination: "git@github.com:example/repo.git", approved });
  answers.branch_step_action = ({ request }) => {
    window.__gitCalls.push(request.action);
    approved = true;
    if (window.__failGit) throw new Error("Remote rejected this push");
    return "Git action completed.";
  };
  window.__setBranch = (state, action) => {
    window.__branch = { ...window.__branch, revision: window.__branch.revision + 1, state, actions: action ? [action] : [] };
    emit("branch_step_changed", window.__branch);
  };
})();`;
try {
  for (const mode of (process.env.BRANCH_GIT_MODES?.split(",") ?? ["light", "dark"])) for (const width of (process.env.BRANCH_GIT_WIDTHS?.split(",").map(Number) ?? [1280, 960, 720])) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, { width, height: 780 }, { waitUntil: "domcontentloaded", extra: `localStorage.setItem("raccoon.mode", ${JSON.stringify(mode)});\n${extra}` });
    await openConversation(page, "Local long session");
    const button = page.getByTestId("branch-git-button");
    const primary = button.getByRole("button", { name: "Commit and push", exact: true });
    await primary.waitFor();
    const bounds = await button.evaluate(root => {
      const header = root.closest("header").getBoundingClientRect();
      const controls = [...root.querySelectorAll("button")].map(e => e.getBoundingClientRect());
      return { fits: controls.every(r => r.left >= header.left && r.right <= header.right), separated: controls[0].right <= controls[1].left + 1, scroll: document.scrollingElement.scrollWidth - innerWidth };
    });
    failed += report(`header at ${width}px`, { "buttons stay in the header": bounds.fits, "split buttons do not overlap": bounds.separated, "no horizontal document scroll": bounds.scroll <= 0 }, bounds);
    if (process.env.BRANCH_GIT_SHOTS) await page.screenshot({ path: `${process.env.BRANCH_GIT_SHOTS}/header-${mode}-${width}.png` });
    await primary.hover();
    const tooltip = page.getByRole("tooltip");
    await tooltip.waitFor();
    const tip = await tooltip.textContent();
    failed += report("tooltip", { "names the base and method": tip.includes("develop") && tip.includes("squash") }, tip);
    await primary.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    failed += report("confirmation", { "names the pushing account": (await dialog.textContent()).includes("alice"), "does not publish before confirmation": await page.evaluate(() => window.__gitCalls.length === 0) });
    await dialog.getByLabel("Commit message").fill("Add feature");
    if (process.env.BRANCH_GIT_SHOTS && width === 960) await page.screenshot({ path: `${process.env.BRANCH_GIT_SHOTS}/confirmation-${mode}.png` });
    await dialog.getByRole("button", { name: "Commit and push", exact: true }).click();
    await page.waitForFunction(() => window.__gitCalls.length === 1);
    await page.evaluate(() => window.__setBranch("ready", "merge"));
    await button.getByRole("button", { name: "Merge", exact: true }).waitFor();
    await page.keyboard.press("Meta+Shift+M");
    await page.waitForFunction(() => window.__gitCalls.includes("merge"));
    failed += report("merge shortcut", { "uses the same session authorization": await page.getByRole("dialog").count() === 0 });
    await page.evaluate(() => window.__setBranch("diverged", "resolveConflicts"));
    await button.getByRole("button", { name: "Reconcile with upstream", exact: true }).waitFor();
    await page.evaluate(() => window.__setBranch("hidden", null));
    await button.waitFor({ state: "hidden" });
    failed += report("inapplicable branch", { "no Git button or background alert": await button.count() === 0 });
    await page.evaluate(() => { window.__failGit = true; window.__setBranch("ahead", "push"); });
    await button.getByRole("button", { name: "Push", exact: true }).click();
    await button.getByRole("alert").waitFor();
    failed += report("failure", { "shows the failure inline": (await button.getByRole("alert").textContent()).includes("rejected") });
    if (process.env.BRANCH_GIT_SHOTS) await page.screenshot({ path: `${process.env.BRANCH_GIT_SHOTS}/failure-${mode}-${width}.png` });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.exitCode = failed ? 1 : 0;
