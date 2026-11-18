#!/usr/bin/env node
// PRO-342, PRO-353: Settings → Machines, the Add a machine dialog (screen 21.04,
// and its Headless server tab, screen 21.06) and the approval dialog (screen
// 21.05) in the desktop's WebKit, at the window's smallest size (760×520,
// tauri.conf.json), a roomy one and the screens' own width (1440×900), in the
// light and the dark theme.
//
// The approval dialog shows over the app while a computer waits, then goes
// when the request ends. Add a machine shows: empty, an invalid code, waiting
// for approval, paired, not allowed, the code inactive, the code expired,
// pairing paused, another computer waiting, and the machine unreachable. Its
// Headless server tab shows: empty (placeholders for the server's values and
// this Mac's name in the asking line), an invalid code, a code pasted (the
// server's values filled from it, Continue on), waiting after Continue, and
// paired. In each: the dialog stays inside the window and dims the page behind it, it
// does not scroll sideways, controls do not overlap, no text is under 12 px,
// mono is used only for commands, codes, IDs and fingerprints, and a
// fingerprint box shows two lines of two groups that fit it.
//
// Pictures of every case go to MACHINES_SHOTS, by default
// scripts/webkit/output/machines-pairing; that default folder ignores itself.
// When the design renders are found (MACHINES_DESIGNS, a folder holding any of
// 21.04.png, 21.05.png and 21.06.png) each matching shot also gets a
// <shot>-vs-design.png beside it.
//
//   pnpm build && npx playwright install webkit && node scripts/webkit/machines-pairing.mjs
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, open, report, serve } from "./harness.mjs";

const output = fileURLToPath(new URL("./output/", import.meta.url));
const shots = process.env.MACHINES_SHOTS ?? join(output, "machines-pairing");
const designs = process.env.MACHINES_DESIGNS ?? null;
await mkdir(shots, { recursive: true });
if (!process.env.MACHINES_SHOTS) await writeFile(join(output, ".gitignore"), "*\n");

// A headless server's code: the stub names a Linux server for it.
const SERVER_CODE = "txm2.eyJ2IjoyLCJraW5kIjoibWFjaGluZSIsInNjb3BlIjoicnVudGltZSIsIm1hY2hpbmUiOnsibWFjaGluZUlkIjoiUW05dmRITjBjbUZ3WDJsayIsIm5hbWUiOiJidWlsZC1ib3gifX0";
const INSTALL_COMMAND = "curl -fsSL https://terminalx.ai/install.sh | sh";
const CODE = "txm2.eyJ2IjoyLCJraW5kIjoibWFjaGluZSIsInNjb3BlIjoicnVudGltZSIsImlkZW50aXR5TW9kZSI6ImF1dGhlbnRpY2F0ZSIsIm1hY2hpbmUiOnsibWFjaGluZUlkIjoiY3MxdWhDTEVCX3R0Q1lhUSIsIm5hbWUiOiJNYWMgbWluaSJ9fQ";

// Runs in the page, after the stub: this Mac as a machine and as the operating computer, and ways to move them on.
const fixture = `(() => {
  const answers = window.__PW_STUB__.answers;
  const emit = window.__PW_STUB__.emit;
  window.__PW_CALLS__ = [];
  const note = (name, args) => window.__PW_CALLS__.push([name, args ?? null]);
  answers.machine_name = { name: "Paresh’s MacBook Pro", chosen: false, computerName: "Paresh’s MacBook Pro" };
  answers.copy_text = (args) => { note("copy_text", args); return null; };
  answers.experimental_settings = { nativeCodex: false, sessionCost: false, orchestratorRuns: false, localVmTasks: false };
  const computers = [
    { id: "computer-1", label: "Paresh’s MacBook Air", platform: "macos", approvedAt: Date.parse("2026-11-03T09:00:00Z"), lastSeenAt: Date.now(), connected: true },
    { id: "computer-2", label: "build-box", platform: "linux", approvedAt: Date.parse("2026-11-10T09:00:00Z"), lastSeenAt: Date.parse("2026-11-14T18:40:00Z"), connected: false },
  ];
  const status = (patch) => ({ enabled: true, hostKey: "ready", machineId: "host-1", listening: "0.0.0.0:6768", takesPort: true, phoneRoute: false,
    computers, error: null, pending: null, code: null, pausedUntil: null, ...patch });
  let view = { allowOperating: true, keepAwake: true, status: status({}) };
  const machine = (patch) => ({ machineId: "cs1uhCLEB_ttCYaQ", name: "Mac mini", os: { family: "macos", version: "26.1" }, version: "0.2.33",
    publicKeyB64: "a2V5", directEndpoints: ["ws://192.168.1.20:6768/machine/1"], route: "relayAndNearby", pairedAt: Date.now(), lastSeenAt: null, ...patch });
  let machines = [];
  let inspectExpiresIn = 252000;
  let settlePair = null;
  answers.machines_host_status = () => view;
  answers.machines_set_allow_operating = ({ enabled }) => (view = { ...view, allowOperating: enabled });
  answers.machines_create_code = () => {
    const code = { code: ${JSON.stringify(CODE)}, expiresAt: Date.now() + 300000 };
    view = { ...view, status: { ...view.status, code: { expiresAt: code.expiresAt } } };
    return code;
  };
  answers.machines_approve = (args) => { note("machines_approve", args); return { approved: true }; };
  answers.machines_decline = (args) => { note("machines_decline", args); return { declined: true }; };
  answers.machines_revoke = (args) => { note("machines_revoke", args); return null; };
  answers.machines_list = () => machines;
  // The dialog opens on On your account (PRO-349); nobody is signed in here.
  answers.machines_account_list = { signedIn: false };
  // Settings lists Your machines from the connections store (PRO-349), which reads their states too.
  answers.machines_connections = [];
  answers.machines_inspect_code = ({ code }) => {
    note("machines_inspect_code", { code });
    if (!code.startsWith("txm2.")) return Promise.reject("not a machine code");
    if (code === ${JSON.stringify(SERVER_CODE)})
      return { machine: { machineId: "Qm9vdHN0cmFwX2lk", name: "build-box", os: { family: "linux", version: "24.04" }, version: "0.2.34" },
        fingerprint: "3C1E·77A0·5B2D·E914", expiresAt: Date.now() + inspectExpiresIn, directEndpoints: [], hasRelay: true, alreadyPaired: false };
    return { machine: { machineId: "cs1uhCLEB_ttCYaQ", name: "Mac mini", os: { family: "macos", version: "26.1" }, version: "0.2.33" },
      fingerprint: "CEF4·2468·FE26·9E4B", expiresAt: Date.now() + inspectExpiresIn, directEndpoints: ["ws://192.168.1.20:6768/machine/1"], hasRelay: false, alreadyPaired: false };
  };
  answers.machines_pair = (args) => { note("machines_pair", args); return new Promise((resolve) => (settlePair = resolve)); };
  answers.machines_cancel_pairing = () => { note("machines_cancel_pairing"); settlePair?.({ paired: false, reason: "cancelled", message: "cancelled" }); return null; };
  answers.machines_set_route = (args) => { note("machines_set_route", args); return null; };
  answers.pairing_set_keep_awake = ({ enabled }) => { note("pairing_set_keep_awake", { enabled }); view = { ...view, keepAwake: enabled }; return { keepAwake: enabled }; };
  window.__MACHINES__ = {
    host(patch) {
      view = { ...view, status: status(patch) };
      emit("machines_host_changed", view);
    },
    pair(result) {
      if (result.paired) machines = [machine(result.machine ?? {})];
      settlePair?.(result.paired ? { paired: true, machine: machine(result.machine ?? {}) } : result);
      settlePair = null;
    },
    expiresIn(ms) { inspectExpiresIn = ms; },
  };
})();`;

/** Layout facts about the open dialog. */
function measure(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const out = { viewport: { width: innerWidth, height: innerHeight } };
    if (!dialog) return out;
    const shown = (element) => {
      const r = element.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(element).visibility !== "hidden";
    };
    const r = dialog.getBoundingClientRect();
    out.dialog = { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth };
    const overlay = document.querySelector("[data-dialog-overlay]");
    out.dimmed = !!overlay && getComputedStyle(overlay).backgroundColor !== "rgba(0, 0, 0, 0)";
    const texts = [...dialog.querySelectorAll("*")].filter((el) => shown(el) && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
    out.smallText = texts.filter((el) => parseFloat(getComputedStyle(el).fontSize) < 12).map((el) => `${el.tagName}:${el.textContent.trim().slice(0, 30)}:${getComputedStyle(el).fontSize}`);
    out.clipped = texts
      .filter((el) => !el.classList.contains("truncate") && el.tagName !== "TEXTAREA" && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== "visible")
      .map((el) => el.textContent.trim().slice(0, 40));
    const probe = document.createElement("span");
    probe.className = "font-mono";
    document.body.append(probe);
    const mono = getComputedStyle(probe).fontFamily;
    probe.remove();
    // Mono only for commands, codes, IDs and fingerprints: the code fields, a command box, the server's transcript.
    out.monoElsewhere = texts
      .filter((el) => getComputedStyle(el).fontFamily === mono)
      .filter((el) => !el.closest('[aria-label^="Fingerprint "], code, [data-command], [data-terminal]') && el.tagName !== "TEXTAREA")
      .map((el) => el.textContent.trim().slice(0, 30));
    out.fingerprints = [...dialog.querySelectorAll('[aria-label^="Fingerprint "]')].map((el) => ({
      text: el.getAttribute("aria-label").slice("Fingerprint ".length),
      lines: [...el.children].map((line) => line.textContent),
      mono: getComputedStyle(el).fontFamily === mono,
      fits: el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= el.parentElement.getBoundingClientRect().right + 0.5,
    }));
    const controls = [...dialog.querySelectorAll("button, [role=switch], [role=radio], textarea")].filter(shown);
    out.overlaps = [];
    for (let a = 0; a < controls.length; a++)
      for (let b = a + 1; b < controls.length; b++) {
        if (controls[a].contains(controls[b]) || controls[b].contains(controls[a])) continue;
        const one = controls[a].getBoundingClientRect();
        const two = controls[b].getBoundingClientRect();
        if (one.left < two.right - 1 && two.left < one.right - 1 && one.top < two.bottom - 1 && two.top < one.bottom - 1) out.overlaps.push([controls[a].textContent, controls[b].textContent]);
      }
    out.outside = controls
      .filter((el) => {
        const c = el.getBoundingClientRect();
        return c.left < r.left - 0.5 || c.right > r.right + 0.5;
      })
      .map((el) => el.textContent.trim().slice(0, 30));
    out.title = dialog.querySelector("h2")?.textContent ?? null;
    out.tabs = [...dialog.querySelectorAll('[role="tab"]')].map((tab) => [tab.textContent, tab.getAttribute("aria-selected")]);
    out.wrappedButtons = [...dialog.querySelectorAll("button")].filter(shown).filter((button) => getComputedStyle(button).whiteSpace !== "nowrap" && button.textContent.trim()).map((button) => button.textContent.trim());
    const transcript = dialog.querySelector('[data-testid="server-transcript"]');
    // PRO-398: the code field shows the whole code and has no focus ring while locked; the waiting spinner is the arc; the footer's commands are mono.
    const code = dialog.querySelector("textarea#machine-code");
    out.code = code ? { whole: code.scrollHeight <= code.clientHeight + 1, readOnly: code.readOnly, focused: document.activeElement === code, ring: getComputedStyle(code).boxShadow } : null;
    out.waitingMark = [...dialog.querySelectorAll('[role="status"]')].find((el) => el.textContent.includes("Waiting for approval"))?.querySelector("[data-icon]")?.getAttribute("data-icon") ?? null;
    out.noteCommands = [...dialog.querySelectorAll('[data-testid="headless-agents-note"] code')].map((el) => [el.textContent, getComputedStyle(el).fontFamily === mono]);
    out.transcript = transcript ? [...transcript.children].map((line) => line.textContent.replace(/\u00a0/g, " ").trimEnd()) : null;
    const panel = dialog.querySelector("[data-terminal]");
    out.panelInside = panel ? panel.getBoundingClientRect().right <= r.right + 0.5 && panel.scrollWidth <= panel.clientWidth + 1 : null;
    out.steps = [...dialog.querySelectorAll('[data-testid="headless-server"] ol > li')].map((li) => li.lastElementChild.textContent);
    out.stepNumbers = [...dialog.querySelectorAll('[data-testid="headless-server"] ol > li')].map((li) => li.firstElementChild.textContent);
    out.text = dialog.textContent;
    return out;
  });
}

function commonChecks(m) {
  const { width, height } = m.viewport;
  return {
    "the dialog is inside the window": !!m.dialog && m.dialog.left >= 0 && m.dialog.right <= width + 0.5 && m.dialog.top >= 0 && m.dialog.bottom <= height + 0.5,
    "the page behind is dimmed": !!m.dimmed,
    "the dialog does not scroll sideways": !!m.dialog && m.dialog.scrollWidth <= m.dialog.clientWidth + 1,
    "no control leaves the dialog": !!m.dialog && m.outside.length === 0,
    "no control overlaps another": !!m.dialog && m.overlaps.length === 0,
    "no text is under 12 px": !!m.dialog && m.smallText.length === 0,
    "no text is cut short": !!m.dialog && m.clipped.length === 0,
    "mono only for commands, codes, IDs and fingerprints": !!m.dialog && m.monoElsewhere.length === 0,
    "buttons do not wrap": !!m.dialog && m.wrappedButtons.length === 0,
    "fingerprints are mono, two lines of two groups, inside their box": !!m.dialog && m.fingerprints.every((f) => f.mono && f.fits && f.lines.length === 2 && f.lines.every((line) => line.split("·").length === 2)),
  };
}

// Entrances finish; a spinner turns for as long as it waits, so it does not count.
const settle = (page) =>
  page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running" || animation.effect?.getComputedTiming().iterations === Infinity));

async function besideDesign(browser, ours, design) {
  if (!designs || !existsSync(join(designs, design))) return;
  const side = await browser.newPage({ viewport: { width: 2896, height: 960 } });
  const data = async (path) => `data:image/png;base64,${(await readFile(path)).toString("base64")}`;
  await side.setContent(`<body style="margin:0;display:flex;gap:16px;padding:16px;background:#777;font:12px sans-serif;color:#fff">
    <figure style="margin:0"><figcaption>Design ${design}</figcaption><img style="width:1420px" src="${await data(join(designs, design))}"></figure>
    <figure style="margin:0"><figcaption>Built UI</figcaption><img style="width:1420px" src="${await data(ours)}"></figure></body>`);
  await side.screenshot({ path: ours.replace(/\.png$/, "-vs-design.png"), fullPage: true });
  await side.close();
}

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const mode of ["light", "dark"]) {
    for (const viewport of [{ width: 760, height: 520 }, { width: 1280, height: 800 }, { width: 1440, height: 900 }]) {
      const name = `${mode}, ${viewport.width}×${viewport.height}`;
      const shot = (state) => join(shots, `machines-${mode}-${viewport.width}x${viewport.height}-${state}.png`);
      const take = async (state, design) => {
        await settle(page);
        await page.screenshot({ path: shot(state) });
        // Each screen is compared at the width it was drawn at.
        if (design && viewport.width === (design === "21.06.png" ? 1440 : 1280)) await besideDesign(browser, shot(state), design);
      };
      const calls = () => page.evaluate(() => window.__PW_CALLS__);
      const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, viewport, {
        extra: `localStorage.setItem("raccoon.mode", ${JSON.stringify(mode)});\n${fixture}`,
      });
      await page.locator('[data-testid="sidebar-rail"]').waitFor();

      // 21.05: a computer asks to operate this Mac; the dialog opens over the app.
      await page.evaluate(() => window.__MACHINES__.host({ pending: { requestId: "req-7", label: "Paresh’s MacBook Pro", platform: "macos", fingerprint: "CEF4·2468·FE26·9E4B", transport: "direct", requestedAt: Date.now(), expiresAt: Date.now() + 118000 } }));
      const approval = page.getByRole("dialog", { name: "Let Paresh’s MacBook Pro operate this Mac?" });
      await approval.waitFor();
      await take("approval", "21.05.png");
      let m = await measure(page);
      failed += report(`${name}, approval`, {
        ...commonChecks(m),
        "names the computer and how it asked": m.title === "Let Paresh’s MacBook Pro operate this Mac?" && m.text.includes("It asked to pair a moment ago, over this network."),
        "the fingerprint is CEF4·2468 over FE26·9E4B": m.fingerprints.length === 1 && m.fingerprints[0].lines.join("|") === "CEF4·2468|FE26·9E4B",
        "the won't list and the shell line follow owner decision 2":
          m.text.includes("TerminalX won’t let it") && m.text.includes("Use this Mac’s built-in browser, computer use or dictation") && m.text.includes("Pair other computers or change who may operate this Mac") && m.text.includes("Its terminals and agents run as you, so they can reach anything your account can."),
        "keep awake, revoke later, Don't allow and Allow": m.text.includes("Keep this Mac awake while it is connected") && m.text.includes("You can revoke it later in Settings → Machines.") && m.text.includes("Don’t allow") && m.text.includes("Allow"),
      }, m);
      await page.evaluate(() => window.__MACHINES__.host({ pending: { requestId: "req-8", label: "dev-laptop", platform: "linux", fingerprint: "7F3A·91C2·4E08·B6D1", transport: "relay", requestedAt: Date.now(), expiresAt: Date.now() + 118000 } }));
      const relayed = page.getByRole("dialog", { name: "Let dev-laptop operate this Mac?" });
      await relayed.waitFor();
      await take("approval-relay");
      m = await measure(page);
      failed += report(`${name}, approval through the relay`, { ...commonChecks(m), "says through TerminalX Relay": m.text.includes("through TerminalX Relay") }, m);
      await relayed.getByRole("button", { name: "Allow", exact: true }).click();
      await page.evaluate(() => window.__MACHINES__.host({ pending: null }));
      await relayed.waitFor({ state: "detached" });
      failed += report(`${name}, approval answered`, {
        "Allow approves the request by its id": (await calls()).some(([command, args]) => command === "machines_approve" && args?.requestId === "req-8"),
        "the dialog goes when the request ends": (await page.getByRole("dialog").count()) === 0,
      });

      // Settings → Machines, with a code made.
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const settings = page.getByRole("main", { name: "Settings", exact: true });
      await settings.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Machines", exact: true }).click();
      await settings.getByTestId("machines-settings").waitFor();
      await settings.getByRole("button", { name: "Create pairing code" }).click();
      await settings.getByTestId("machine-pairing-code").waitFor();
      await take("settings");
      const section = await settings.getByTestId("machines-settings").evaluate((el) => {
        const style = (node) => (node ? { size: parseFloat(getComputedStyle(node).fontSize), weight: Number(getComputedStyle(node).fontWeight), height: node.getBoundingClientRect().height } : null);
        const button = (label) => [...el.querySelectorAll("button")].find((node) => node.textContent.trim() === label) ?? null;
        const leaf = (label) => [...el.querySelectorAll("h3, div")].find((node) => node.children.length === 0 && node.textContent === label) ?? null;
        const add = button("Add a machine");
        const create = button("Create a new code");
        const yours = leaf("Your machines");
        const after = (first, second) => !!first && !!second && !!(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
        return {
          text: el.textContent,
          scroll: el.scrollWidth <= el.clientWidth + 1,
          // What reaches past the section's right edge, when something does.
          wide: [...el.querySelectorAll("*")]
            .filter((node) => node.getBoundingClientRect().right > el.getBoundingClientRect().right + 1)
            .map((node) => `${node.tagName.toLowerCase()}${node.dataset.testid ? `[${node.dataset.testid}]` : ""}: ${node.textContent.trim().slice(0, 40)}`)
            .slice(0, 6),
          headings: ["Your machines", "Computers that can operate this Mac"].map((label) => style(leaf(label))),
          add: add ? { ...style(add), primary: add.classList.contains("bg-primary"), plus: !!add.querySelector('[data-icon="plus"]'), besideHeading: !!yours && Math.abs(add.getBoundingClientRect().bottom - yours.parentElement.getBoundingClientRect().bottom) <= 1 } : null,
          codeAfterYours: after(el.querySelector('[aria-label="Your machines"]') ?? yours, create),
          revoke: style(button("Revoke")),
          macIcons: [...el.querySelectorAll('[data-testid="paired-machine"], [data-testid="operating-computer"]')]
            .filter((row) => !/build-box/.test(row.textContent))
            .map((row) => row.querySelector("[data-icon]")?.getAttribute("data-icon") ?? ""),
          small: [...el.querySelectorAll("*")]
            .filter((node) => node.closest('[data-setting-id="machines.yours"], [data-setting-id="machines.computers"]'))
            .filter((node) => [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim()) && parseFloat(getComputedStyle(node).fontSize) < 12)
            .map((node) => node.textContent.trim().slice(0, 30)),
        };
      });
      failed += report(`${name}, Settings → Machines`, {
        "operate switch, code, Add a machine and the computers show": ["Let other computers operate this Mac", "works once", "Add a machine", "Computers that can operate this Mac", "Paresh’s MacBook Air", "build-box"].every((said) => section.text.includes(said)),
        "the section does not scroll sideways": section.scroll,
        "revoking does not claim to remove all access": !/removes all access|all of its access/.test(section.text),
        // PRO-398, screen 21.02.
        "the intro and the Your machines line are the screen's": section.text.includes("Operate TerminalX on your other computers from this Mac. Sessions, terminals and files stay on the machine that runs them.")
          && section.text.includes("Computers this Mac can operate. Each one appears as a section in the sidebar."),
        "section headings are 14 px semibold": section.headings.every((heading) => heading?.size === 14 && heading.weight === 600),
        // The screen draws it h-8: 32 px, the app's default button.
        "Add a machine is the primary button with +, 32 px tall, beside Your machines": !!section.add && section.add.primary && section.add.plus && section.add.besideHeading && Math.abs(section.add.height - 32) <= 0.5,
        "no pairing code sits between the switch and Your machines": section.codeAfterYours,
        "a Mac has the monitor icon": section.macIcons.length > 0 && section.macIcons.every((icon) => icon === "monitor"),
        "Revoke is 13 px": section.revoke?.size === 13,
        "no text in the two lists is under 12 px": section.small.length === 0,
        "last-seen times are on the 24-hour clock": !/\d [AP]M\b/.test(section.text),
      }, section);

      // 21.04, each state.
      const openAdd = async () => {
        await settings.getByRole("button", { name: "Add a machine" }).click();
        const dialog = page.getByRole("dialog", { name: "Add a machine" });
        await dialog.waitFor();
        // It opens on On your account (PRO-349); these states are the Pairing code tab's.
        await dialog.getByRole("tab", { name: "Pairing code" }).click();
        return dialog;
      };
      const closeAdd = async (dialog) => {
        await dialog.getByRole("button", { name: "Close" }).click();
        await dialog.waitFor({ state: "detached" });
      };
      let dialog = await openAdd();
      await take("add-empty");
      m = await measure(page);
      failed += report(`${name}, add: empty`, { ...commonChecks(m), "tabs: On your account, Pairing code (chosen) and Headless server": JSON.stringify(m.tabs) === JSON.stringify([["On your account", "false"], ["Pairing code", "true"], ["Headless server", "false"]]) }, m);

      await dialog.getByLabel("Pairing code").fill("hello");
      await dialog.getByText("This is not a machine pairing code").waitFor();
      await take("add-invalid");
      m = await measure(page);
      failed += report(`${name}, add: invalid code`, commonChecks(m), m);

      await dialog.getByLabel("Pairing code").fill(CODE);
      await dialog.getByText("Waiting for approval on Mac mini…").waitFor();
      await take("add-waiting", "21.04.png");
      m = await measure(page);
      failed += report(`${name}, add: waiting`, {
        ...commonChecks(m),
        "the machine card, fingerprint, steps and expiry show": ["Mac mini", "macOS 26.1 · TerminalX 0.2.33", "Mac mini shows the same one", "Compare this fingerprint with the one on Mac mini.", "Choose Allow there."].every((said) => m.text.includes(said)) && /The code expires in \d:\d\d and works once\./.test(m.text),
        "the relay hint follows owner decision 4": m.text.includes("TerminalX Relay is used once this Mac and Mac mini are signed in to the same account"),
        "the code field shows the whole code": m.code?.whole === true,
        "the locked code field is read-only with no focus ring": m.code?.readOnly === true && m.code.ring === "none",
        "the waiting spinner is the arc": m.waitingMark === "loader-circle",
      }, m);
      await dialog.getByRole("radio", { name: "Only this network" }).click();
      await page.evaluate(() => window.__MACHINES__.pair({ paired: true }));
      await dialog.getByText("Paired with Mac mini").waitFor();
      await take("add-paired");
      m = await measure(page);
      failed += report(`${name}, add: paired`, {
        ...commonChecks(m),
        "the route chosen while waiting is saved": (await calls()).some(([command, args]) => command === "machines_set_route" && args?.route === "thisNetwork"),
      }, m);
      await dialog.getByRole("button", { name: "Done" }).click();
      await dialog.waitFor({ state: "detached" });
      await take("settings-paired");
      await settings.getByRole("list", { name: "Your machines" }).getByText("Mac mini").waitFor();

      for (const [reason, said] of [
        ["not-approved", "Mac mini did not allow this Mac"],
        ["code-inactive", "This code no longer works"],
        ["pairing-paused", "Pairing is paused on Mac mini"],
        ["another-computer", "Another computer is waiting on Mac mini"],
        ["unreachable", "This Mac could not reach Mac mini"],
      ]) {
        dialog = await openAdd();
        await dialog.getByLabel("Pairing code").fill(CODE);
        await dialog.getByText("Waiting for approval on Mac mini…").waitFor();
        await page.evaluate((reason) => window.__MACHINES__.pair({ paired: false, reason, message: reason }), reason);
        await dialog.getByText(said).waitFor();
        await take(`add-${reason}`);
        m = await measure(page);
        failed += report(`${name}, add: ${reason}`, commonChecks(m), m);
        await closeAdd(dialog);
      }

      await page.evaluate(() => window.__MACHINES__.expiresIn(-1000));
      dialog = await openAdd();
      await dialog.getByLabel("Pairing code").fill(CODE);
      await dialog.getByText("The code has expired.").waitFor();
      await page.evaluate(() => window.__MACHINES__.pair({ paired: false, reason: "code-inactive", message: "expired" }));
      await dialog.getByText("This code no longer works").waitFor();
      await take("add-expired");
      m = await measure(page);
      failed += report(`${name}, add: expired`, commonChecks(m), m);
      await page.evaluate(() => window.__MACHINES__.expiresIn(252000));
      await closeAdd(dialog);

      // Cancel while waiting cancels the pairing.
      dialog = await openAdd();
      await dialog.getByLabel("Pairing code").fill(CODE);
      await dialog.getByText("Waiting for approval on Mac mini…").waitFor();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await dialog.waitFor({ state: "detached" });
      failed += report(`${name}, add: cancel`, { "Cancel calls machines_cancel_pairing": (await calls()).some(([command]) => command === "machines_cancel_pairing") });

      // 21.06, the Headless server tab, each state.
      dialog = await openAdd();
      await dialog.getByRole("tab", { name: "Headless server" }).click();
      await dialog.getByTestId("headless-server").waitFor();
      await dialog.getByText("Paresh’s MacBook Pro asks to operate this server", { exact: false }).waitFor();
      await take("headless-empty", "21.06.png");
      m = await measure(page);
      failed += report(`${name}, headless: empty`, {
        ...commonChecks(m),
        "tabs: On your account, Pairing code and Headless server (chosen)": JSON.stringify(m.tabs) === JSON.stringify([["On your account", "false"], ["Pairing code", "false"], ["Headless server", "true"]]),
        "the intro and three numbered steps": m.text.includes("A server runs TerminalX without a window. This Mac connects to it directly, on this network or over Tailscale, so its TCP port 6768 must be reachable from here.")
          && m.steps.length === 3 && m.stepNumbers.join() === "1,2,3" && m.steps[0].startsWith("Install TerminalX on the server") && m.steps[1].startsWith("Create a pairing code there") && m.steps[2].startsWith("Paste the code here"),
        "the install command and what it supports": m.steps[0]?.includes(INSTALL_COMMAND) && m.steps[0]?.includes("Linux x64 and arm64, and macOS. Installs a user service that starts at boot."),
        "the On the server panel: placeholders for the server, this Mac by name": JSON.stringify(m.transcript) === JSON.stringify([
          "you@server ~ $ terminalx-serve pair", "TerminalX <version> · <OS> <arch>", "Name        <server name>", "Machine ID  <machine ID>", "", "Pairing code, valid for 5:00, works once:", "txm2.…", "",
          "Waiting for a computer to pair…", "✓Paresh’s MacBook Pro asks to operate this server. Fingerprint <fingerprint>.", "Allow? [y/N]"]),
        "the panel fits the dialog": m.panelInside === true,
        "the footer's agent commands are mono": JSON.stringify(m.noteCommands) === JSON.stringify([["claude", true], ["codex login --device-auth", true]]),
        "the footer note, Cancel, and Continue off": m.text.includes("Sign in the agents in a terminal on the server: run claude, or codex login --device-auth.") && (await dialog.getByRole("button", { name: "Continue" }).isDisabled()),
      }, m);
      await dialog.getByRole("button", { name: "Copy install command" }).click();
      await dialog.getByRole("button", { name: "install command copied" }).waitFor();
      failed += report(`${name}, headless: copy`, { "copies the install command": (await calls()).some(([command, args]) => command === "copy_text" && args?.text === INSTALL_COMMAND) });

      await dialog.getByLabel("Paste the code here").fill("hello");
      await dialog.getByText("This is not a machine pairing code").waitFor();
      await take("headless-invalid");
      m = await measure(page);
      failed += report(`${name}, headless: invalid code`, { ...commonChecks(m), "Continue stays off": await dialog.getByRole("button", { name: "Continue" }).isDisabled() }, m);

      const pairsBefore = (await calls()).filter(([command]) => command === "machines_pair").length;
      await dialog.getByLabel("Paste the code here").fill(SERVER_CODE);
      await dialog.getByText("From build-box.", { exact: false }).waitFor();
      await take("headless-pasted", "21.06.png");
      m = await measure(page);
      failed += report(`${name}, headless: code pasted`, {
        ...commonChecks(m),
        "the server's values come from the code": m.transcript?.[1] === "TerminalX 0.2.34 · Linux 24.04" && m.transcript?.[2] === "Name        build-box" && m.transcript?.[3] === "Machine ID  Qm9vdHN0cmFwX2lk" && m.transcript?.[6] === SERVER_CODE,
        "the asking line has the four-group fingerprint": m.transcript?.[9] === "✓Paresh’s MacBook Pro asks to operate this server. Fingerprint 3C1E·77A0·5B2D·E914.",
        "nothing is asked before Continue, and Continue is on": (await calls()).filter(([command]) => command === "machines_pair").length === pairsBefore && (await dialog.getByRole("button", { name: "Continue" }).isEnabled()),
        "the panel fits the dialog": m.panelInside === true,
      }, m);

      await dialog.getByRole("button", { name: "Continue" }).click();
      await dialog.getByText("Waiting for approval on build-box…").waitFor();
      await take("headless-waiting");
      m = await measure(page);
      failed += report(`${name}, headless: waiting`, {
        ...commonChecks(m),
        "Continue pairs with the pasted code as the Pairing code tab does": (await calls()).some(([command, args]) => command === "machines_pair" && args?.code === SERVER_CODE && args?.route === "relayAndNearby"),
      }, m);
      await page.evaluate(() => window.__MACHINES__.pair({ paired: true, machine: { machineId: "Qm9vdHN0cmFwX2lk", name: "build-box", os: { family: "linux", version: "24.04" }, version: "0.2.34" } }));
      await dialog.getByText("Paired with build-box").waitFor();
      await take("headless-paired");
      m = await measure(page);
      failed += report(`${name}, headless: paired`, { ...commonChecks(m), "Done replaces Cancel and Continue": m.text.includes("Done") && !(await dialog.getByRole("button", { name: "Continue" }).count()) }, m);
      await dialog.getByRole("button", { name: "Done" }).click();
      await dialog.waitFor({ state: "detached" });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`screenshots: ${shots}`);
process.exit(failed ? 1 : 0);
