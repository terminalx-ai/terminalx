#!/usr/bin/env node
// PRO-175: an organization invitation in the desktop's WebKit engine. The
// combined invite-and-welcome card shown before joining (12.21, with a login
// still needed and the computer building), Decide later and its notice, the
// Invitations list in Settings → Organizations with the menu's "1 invite"
// (12.20), and Accept with "You joined" (01.08). Each state must fit with no
// two buttons overlapping; pictures go to $INVITES_SHOTS (default /tmp).
import { launch, open, report, serve } from "./harness.mjs";

const shots = process.env.INVITES_SHOTS ?? "/tmp";
const DAY = 86_400_000;
const backend = `(() => {
  const answers = window.__PW_STUB__.answers;
  const now = Date.now();
  const personal = { id: "personal-1", name: "Personal", role: "owner", isPersonal: true };
  const status = (orgs) => ({ state: "signed-in", identity: { name: "Robin Vale", email: "robin@example.test", organization: "Personal", organizationId: "personal-1" },
    context: { scope: "invites-fixture", account: "robin", revision: "invites:1" }, expiresAt: null, lastError: null, organizations: orgs,
    phase2Readiness: Object.fromEntries(orgs.map((org) => [org.id, ["organization.invites-welcome.v1"]])) });
  const state = window.__INVITES__ = { orgs: [personal], calls: [] };
  const invites = window.__INVITES__.invites = [
    { id: "inv-1", organizationName: "Orbit Labs", role: "member", expiresAt: now + 6 * ${DAY}, createdAt: now - 2 * ${DAY}, invitedBy: "Ada Park", expired: false, teamsPlan: true },
    { id: "inv-2", organizationName: "Acme Labs", role: "member", expiresAt: now - ${DAY}, createdAt: now - 25 * ${DAY}, invitedBy: "Alex Rivera", expired: true, teamsPlan: false },
  ];
  answers.account_status = () => status(state.orgs);
  answers.account_refresh_roles = () => ({ status: status(state.orgs), fresh: true });
  answers.my_invites = () => ({ invites: structuredClone(invites) });
  answers.my_invite_welcome = ({ inviteId }) => ({
    id: inviteId, organizationName: "Orbit Labs", role: "member", expiresAt: now + 6 * ${DAY}, createdAt: now - 2 * ${DAY}, invitedBy: "Ada Park",
    seatCovered: true, checkedAt: now,
    github: { state: "ready", repositories: ["orbit/terminal-app", "orbit/terminal-server", "orbit/review-lab"] },
    agents: [{ provider: "claude", state: "ready", authKind: "subscription" }, { provider: "codex", state: "needs_login" }],
    computer: { state: "building", name: "orbit-cloud", version: 2 },
    admins: [{ name: "Ada Park", owner: true }, { name: "Sam Rivera", owner: false }],
  });
  answers.my_invite_accept = ({ inviteId }) => {
    state.calls.push(["accept", inviteId]);
    invites.splice(invites.findIndex((invite) => invite.id === inviteId), 1);
    state.orgs = [personal, { id: "org-orbit", name: "Orbit Labs", role: "member", isPersonal: false }];
    return { organizationId: "org-orbit", organizationName: "Orbit Labs", role: "member" };
  };
  answers.my_invite_decline = ({ inviteId }) => { state.calls.push(["decline", inviteId]); return { declined: true }; };
})();`;

/** Whether `root` fits the window with no two of its buttons on top of each other. */
async function layout(page, selector) {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) return { found: false, overlaps: [], outside: [], text: "" };
    const bounds = root.getBoundingClientRect();
    const buttons = [...root.querySelectorAll("button"), ...document.querySelectorAll('[role="status"][aria-label] button')]
      .map((button) => ({ label: button.getAttribute("aria-label") ?? button.textContent.trim(), box: button.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0);
    const overlaps = [];
    for (let a = 0; a < buttons.length; a++)
      for (let b = a + 1; b < buttons.length; b++) {
        const one = buttons[a].box, two = buttons[b].box;
        if (one.left < two.right - 1 && two.left < one.right - 1 && one.top < two.bottom - 1 && two.top < one.bottom - 1) overlaps.push([buttons[a].label, buttons[b].label]);
      }
    const outside = [...root.querySelectorAll("button, li, h1, h2")].filter((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && (box.left < bounds.left - 1 || box.right > bounds.right + 1 || box.right > window.innerWidth + 1);
    }).map((element) => element.getAttribute("aria-label") ?? element.textContent.trim().slice(0, 30));
    const truncated = [...root.querySelectorAll("li")].filter((li) => li.scrollWidth > li.clientWidth + 1).map((li) => li.textContent.slice(0, 30));
    return { found: true, overlaps, outside, truncated, text: root.textContent };
  }, selector);
}

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 720 }]) {
    const tag = `${viewport.width}`;
    const page = await open(browser, server.url, { cloud: true, localProjects: 1 }, viewport, { extra: backend, colorScheme: "dark", locale: "en-US" });
    const card = page.getByTestId("invite-welcome");
    await card.getByText("Ready for you").first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${shots}/pro-175-welcome-${tag}.png` });
    const found = await layout(page, '[data-testid="invite-welcome"]');
    failed += report(`welcome card ${tag} (12.21)`, {
      "it fits the window": found.found && found.outside.length === 0,
      "no two buttons overlap": found.overlaps.length === 0,
      "the title and inviter": found.text.includes("Welcome to Orbit Labs") && found.text.includes("Ada Park invited you as a member"),
      "a line per agent, GitHub and the computer, with its state": /GitHub.*Ready.*Claude Code.*Ready.*Codex.*Needs a login.*Cloud computer.*Building/.test(found.text),
      "2 of 4 ready": found.text.includes("2 of 4"),
      "admins and the seat": found.text.includes("Sam Rivera") && found.text.includes("Your seat is covered by Orbit Labs’ Teams plan."),
      "Accept and join, Decline, Decide later": (await page.getByRole("button", { name: /Accept and join/ }).count()) === 1 && (await card.getByRole("button", { name: "Decline" }).count()) === 1 && (await page.getByRole("button", { name: "Decide later" }).count()) === 1,
    }, found);

    // Decide later: the card closes and the invitation waits in Settings.
    await page.getByRole("button", { name: "Decide later" }).click();
    const kept = page.getByRole("status", { name: "Invitation kept for later" });
    await kept.waitFor();
    failed += report(`decide later ${tag}`, { "the card closed": (await card.count()) === 0, "the notice says where it waits": /It waits in Settings › Organizations until/.test(await kept.textContent()) });

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("main", { name: "Settings", exact: true });
    const nav = settings.getByRole("navigation", { name: "Settings sections" });
    await nav.getByText("1 invite").first().waitFor();
    const all = nav.getByRole("button", { name: /All organizations/ });
    if (!(await all.count())) await nav.getByRole("button", { name: /^Organizations/ }).click();
    await nav.getByRole("button", { name: /All organizations/ }).click();
    const list = page.getByRole("heading", { name: "Invitations" });
    await list.waitFor();
    await page.getByText(/are ready for you · Codex needs a login · The cloud computer is building/).waitFor();
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${shots}/pro-175-invitations-${tag}.png` });
    const listed = await layout(page, '[aria-labelledby="organization-invitations-title"]');
    failed += report(`invitations list ${tag} (12.20)`, {
      "it fits the column": listed.found && listed.outside.length === 0,
      "no two buttons overlap": listed.overlaps.length === 0,
      "no row runs over": listed.truncated.length === 0,
      "the open one: Teams, Decide later, actions": listed.text.includes("Teams") && listed.text.includes("You chose Decide later") && /Decline.*Review.*Accept and join/.test(listed.text),
      "the expired one: Expired and Remove": listed.text.includes("Expired") && listed.text.includes("Ask Alex for a new invitation.") && listed.text.includes("Remove"),
    }, listed);

    // Accept from the list: the organization appears, and the switch is offered.
    await page.getByRole("listitem", { name: "Orbit Labs invitation" }).getByRole("button", { name: "Accept and join" }).click();
    const joined = page.getByRole("status", { name: "You joined Orbit Labs" });
    await joined.waitFor();
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${shots}/pro-175-joined-${tag}.png` });
    failed += report(`joined ${tag} (01.08)`, {
      "the invitation left the list": (await page.getByRole("listitem", { name: "Orbit Labs invitation" }).count()) === 0,
      "the menu no longer counts it": (await nav.getByText("1 invite").count()) === 0,
      "accept was sent once": JSON.stringify(await page.evaluate(() => window.__INVITES__.calls)) === JSON.stringify([["accept", "inv-1"]]),
    });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
