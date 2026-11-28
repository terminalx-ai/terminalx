#!/usr/bin/env node
// PRO-200 (design 17.13): a cloud tab whose agent runs on its organization's
// login has hit the provider's usage limit. The recovery card then speaks of
// that login: whose it is (for an owner or admin), until when, Copy request
// and "Switch to Codex", over the card's usual recovery (another model, Stop,
// Continue in new session). At 960x600 and 1280x760:
//
// - the card is inside the window and the composer's column, above the
//   composer, and no part of it runs out of the card;
// - its title and body say what the design says, naming the login's owner;
// - no two of its buttons overlap, and each is inside the card;
// - Switch opens the runtime's handoff to Codex (#1327), inside the window,
//   with no control overlapping another.
//
//   pnpm build && npx playwright install webkit && node scripts/webkit/org-usage-limit.mjs [screenshot-dir]
import { launch, open, openCloudSession, report, serve } from "./harness.mjs";

const shots = process.argv[2];
const resetsAt = Date.now() + 2 * 3600_000;
const session = {
  role: "manager",
  lines: 6,
  login: "organization",
  handoff: true,
  usageLimit: { resetsAt },
  readiness: ["cloud.agent-logins.usage-limit-card.v1"],
  agentLogins: [{ provider: "claude", authKind: "oauth-credentials-json", displayIdentity: "Ada Lovelace · until 18:00", state: "connected" }],
};

// Every visible control or text block in `root`: where it is, and whether it fits.
const measure = (root) => {
  const box = (element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
  };
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
  };
  const overlaps = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
  const outer = box(root);
  const controls = [...root.querySelectorAll("button, select, [role=combobox]")].filter(visible);
  const boxes = controls.map((control) => ({ name: (control.getAttribute("aria-label") || control.textContent || "").trim().slice(0, 40), ...box(control) }));
  const pairs = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    if (controls[i].contains(controls[j]) || controls[j].contains(controls[i])) continue;
    if (overlaps(boxes[i], boxes[j])) pairs.push(`${boxes[i].name} × ${boxes[j].name}`);
  }
  const texts = [...root.querySelectorAll("p, span, div")].filter((element) => visible(element) && element.children.length === 0 && element.textContent.trim());
  return {
    outer,
    inWindow: outer.left >= 0 && outer.top >= 0 && outer.right <= innerWidth + 0.5 && outer.bottom <= innerHeight + 0.5,
    controls: boxes.map((control) => control.name),
    outside: boxes.filter((control) => control.left < outer.left - 1 || control.right > outer.right + 1 || control.top < outer.top - 1 || control.bottom > outer.bottom + 1).map((control) => control.name),
    overlapping: pairs,
    clipped: texts.filter((element) => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflow !== "visible").map((element) => element.textContent.slice(0, 40)),
    runsOut: texts.filter((element) => element.getBoundingClientRect().right > outer.right + 1).map((element) => element.textContent.slice(0, 40)),
  };
};

// This computer's agents, which name the runtime's in the handoff dialog.
const caps = { images: true, steer: false, permissionModes: true, effort: true, slashCommands: true, atMentions: true, fork: true, resume: true };
const harnesses = [
  { id: "claude", name: "Claude Code", binary: "claude", available: true, caps },
  { id: "codex", name: "Codex", binary: "codex", available: true, caps },
];
const extra = `window.__PW_STUB__.answers.list_harnesses = ${JSON.stringify(harnesses)};`;

const server = await serve();
const browser = await launch();
let failed = 0;
for (const [width, height] of [[960, 600], [1280, 760]]) {
  const name = `organization usage-limit card at ${width}x${height}`;
  const page = await open(browser, server.url, { cloud: true, localProjects: 0, session }, { width, height }, { extra });
  await openCloudSession(page, await page.evaluate(() => window.__PW_RUNTIME__.sessionTitle));
  // A manager reads the tab until they drive it: the card's actions are for the one driving.
  await page.getByRole("button", { name: "Take the wheel" }).click();
  const body = page.getByTestId("org-usage-limit");
  await body.waitFor();
  await page.getByText("Ada Lovelace", { exact: false }).first().waitFor();
  await page.waitForTimeout(300);
  const card = await page.evaluate((measureSource) => {
    const measure = eval(`(${measureSource})`);
    const body = document.querySelector('[data-testid="org-usage-limit"]');
    // The card is the banner that holds the body: the nearest ancestor that also holds its buttons.
    let root = body.parentElement;
    while (root && !root.querySelector('[data-testid="usage-limit-copy"]')) root = root.parentElement;
    const composer = document.querySelector("[data-composer], form textarea")?.getBoundingClientRect();
    const result = measure(root);
    return {
      ...result,
      title: root.textContent.includes("Claude Code usage limit reached"),
      body: body.textContent,
      hint: root.textContent.includes("Switch opens a Codex tab that continues from this conversation."),
      aboveComposer: !composer || result.outer.bottom <= composer.top + 1,
    };
  }, measure.toString());
  failed += report(name, {
    "the card is inside the window": card.inWindow,
    "it is above the composer": card.aboveComposer,
    "its title names the agent's usage limit": card.title,
    "its body names whose login it is and the organization": card.body.startsWith("Ada Lovelace’s login is out of Claude Code usage until ") && card.body.includes("the Claude Code login Local E2E set for cloud workspaces"),
    "Switch to Codex and Copy request lead its actions": card.controls[0]?.startsWith("Switch to Codex") && card.controls[1] === "Copy request",
    "its usual recovery stays": card.controls.includes("Stop session") && card.controls.includes("Continue in new session"),
    "the hint says what Switch does": card.hint,
    "no two of its controls overlap": card.overlapping.length === 0,
    "every control is inside the card": card.outside.length === 0,
    "no text runs out of the card or is cut off": card.runsOut.length === 0 && card.clipped.length === 0,
  }, card);
  if (shots) await page.screenshot({ path: `${shots}/org-usage-limit-${width}.png` });

  await page.getByTestId("usage-limit-switch").click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await page.waitForTimeout(300);
  const opened = await page.evaluate((measureSource) => {
    const measure = eval(`(${measureSource})`);
    const root = document.querySelector('[role="dialog"]');
    return { ...measure(root), text: root.textContent.slice(0, 400) };
  }, measure.toString());
  failed += report(`${name}, Switch's dialog`, {
    "Switch opens the handoff to Codex": opened.text.startsWith("This sessionNew sessionHand off to Codex") && opened.text.includes("Opens a new Codex tab in this session on the workspace"),
    "the dialog is inside the window": opened.inWindow,
    "no two of its controls overlap": opened.overlapping.length === 0,
    "every control is inside the dialog": opened.outside.length === 0,
    "no text runs out of the dialog or is cut off": opened.runsOut.length === 0 && opened.clipped.length === 0,
  }, opened);
  if (shots) await page.screenshot({ path: `${shots}/org-usage-limit-dialog-${width}.png` });
  await page.close();
}
await browser.close();
server.close();
process.exitCode = failed ? 1 : 0;
