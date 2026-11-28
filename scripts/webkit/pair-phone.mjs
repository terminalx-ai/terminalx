#!/usr/bin/env node
// The Pair a phone dialog and Device dock tab in the desktop's WebKit,
// at the window's smallest size (760×520, tauri.conf.json) and a roomy one, in
// the light and the dark theme. The dialog opens from the command palette; then
// it shows a live code, a phone waiting for approval, an expired code, and Relay
// down with Only this network chosen. In each: the dialog stays inside the
// window and its two columns, nothing overlaps or is cut, no text is under
// 11 px, the fingerprints are mono and device rows are 56 px. The Device tab
// sits beside Terminal and offers access to live connections from the folded
// dock or the lower-right Device button when the right panel is hidden.
//
// Pictures of every case go to PAIR_PHONE_SHOTS, by default scripts/webkit/output/pair-phone;
// that default folder ignores itself, so a run leaves the worktree clean.
//
//   pnpm build && npx playwright install webkit && node scripts/webkit/pair-phone.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const shots = process.env.PAIR_PHONE_SHOTS ?? null;
if (shots) await mkdir(shots, { recursive: true });

const RELAY_DOWN = "TerminalX Relay service is temporarily unavailable. Retrying automatically. You can pair on this network meanwhile.";

// Runs in the page, after the stub: the Mac's pairing status, and a way to change it as the Mac would.
const fixture = `(() => {
  const answers = window.__PW_STUB__.answers;
  const offer = (mode) => ({
    pairingUrl: "terminalx://pair?v=2&code=" + "A1b2C3d4E5".repeat(mode === "automatic" ? 40 : 12),
    expiresAt: Date.now() + 292000,
    connectionMode: mode,
    directAvailable: true,
    transport: mode === "automatic" ? "relay" : "direct",
  });
  const devices = [
    { id: "phone-1", label: "Paresh’s iPhone", platform: "ios", token: "t", scope: "driver", provenance: "explicit", bindingGeneration: 0, publicKey: "k",
      createdAt: "2026-10-01T09:00:00Z", lastSeenAt: "2026-11-12T09:00:00Z", fingerprint: "7F3A·91C2·4E08·B6D1", approvedAt: "2026-10-01T09:00:00Z",
      connection: { transport: "relay", since: "2026-11-12T09:00:00Z" }, lastSeenTransport: "relay" },
    { id: "ipad-1", label: "Studio iPad", platform: "ios", token: "t", scope: "driver", provenance: "explicit", bindingGeneration: 0, publicKey: "k",
      createdAt: "2026-10-01T09:00:00Z", lastSeenAt: "2026-11-03T18:20:00Z", fingerprint: "C04E·5B17·9A2F·13C8", lastSeenTransport: "direct" },
  ];
  let status = {
    relay: { phase: "connected", message: null, attempt: 0 },
    host: null,
    devices,
    activePairing: offer("automatic"),
    pendingApproval: null,
    keepAwake: true,
    lastError: null,
    accountListing: { state: "listed" },
  };
  answers.pairing_status = () => status;
  answers.pairing_generate = ({ connectionMode }) => (status = { ...status, activePairing: offer(connectionMode) });
  answers.pairing_disconnect = ({ deviceId }) => (status = {
    ...status,
    devices: status.devices.map((device) => device.id === deviceId ? { ...device, connection: undefined } : device),
  });
  window.__PAIRING__ = {
    set(patch) {
      status = { ...status, ...patch };
      window.__PW_STUB__.emit("pairing_status", status);
    },
    reconnect() {
      this.set({ devices });
    },
    offer,
  };
})();`;

/** Layout facts about the open dialog. */
function measure(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const box = (element) => {
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const shown = (element) => {
      const r = element.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(element).visibility !== "hidden";
    };
    const out = { viewport: { width: innerWidth, height: innerHeight } };
    if (dialog) {
      const grid = dialog.querySelector(":scope > div.grid");
      const [left, right] = grid ? [...grid.children] : [];
      out.dialog = { ...box(dialog), scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth };
      out.columns = left && right ? { left: box(left), right: box(right) } : null;
      // Every element that holds text of its own, with the smallest size used.
      const texts = [...dialog.querySelectorAll("*")].filter((el) => shown(el) && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
      out.smallText = texts.filter((el) => parseFloat(getComputedStyle(el).fontSize) < 11).map((el) => `${el.tagName}:${el.textContent.trim().slice(0, 30)}:${getComputedStyle(el).fontSize}`);
      // Text cut short inside its own box (truncate is fine only for names).
      out.clipped = texts
        .filter((el) => !el.classList.contains("truncate") && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== "visible")
        .map((el) => el.textContent.trim().slice(0, 40));
      // Each column's content stays inside its column.
      const outside = (column, root) =>
        root
          ? [...root.querySelectorAll("button, [role=radio], [role=switch], p, li, img, [data-testid]")]
              .filter(shown)
              .filter((el) => {
                const r = el.getBoundingClientRect();
                return r.left < column.left - 0.5 || r.right > column.right + 0.5;
              })
              .map((el) => `${el.tagName}:${el.textContent.trim().slice(0, 30)}`)
          : [];
      out.outside = out.columns ? [...outside(out.columns.left, left), ...outside(out.columns.right, right)] : ["no columns"];
      const controls = [...dialog.querySelectorAll("button, [role=switch]")].filter(shown);
      out.overlaps = [];
      for (let a = 0; a < controls.length; a++)
        for (let b = a + 1; b < controls.length; b++) {
          if (controls[a].contains(controls[b]) || controls[b].contains(controls[a])) continue;
          const one = controls[a].getBoundingClientRect();
          const two = controls[b].getBoundingClientRect();
          if (one.left < two.right - 1 && two.left < one.right - 1 && one.top < two.bottom - 1 && two.top < one.bottom - 1) out.overlaps.push([controls[a].textContent, controls[b].textContent]);
        }
      const probe = document.createElement("span");
      probe.className = "font-mono";
      document.body.append(probe);
      const mono = getComputedStyle(probe).fontFamily;
      probe.remove();
      const fingerprints = [...dialog.querySelectorAll('[aria-label^="Fingerprint "]')];
      out.fingerprints = fingerprints.map((el) => ({
        text: el.getAttribute("aria-label").slice("Fingerprint ".length),
        mono: getComputedStyle(el).fontFamily === mono,
        // Every line of it inside its own box: a 64-bit fingerprint must not spill out at the smallest size.
        fits: el.scrollWidth <= el.clientWidth + 1,
      }));
      out.rows = [...dialog.querySelectorAll('[data-testid="paired-device"]')].map((row) => Math.round(row.getBoundingClientRect().height));
      out.headerTitle = dialog.querySelector("h2")?.textContent ?? null;
      out.qr = !!dialog.querySelector('img[alt="TerminalX phone pairing QR code"]');
      out.text = dialog.textContent;
    }
    const code = document.querySelector('[data-testid="pairing-code"]');
    if (code) out.code = box(code);
    const path = document.querySelector('[role="radiogroup"][aria-label="How the phone reaches this Mac"]');
    if (path) out.path = { ...box(path), column: box(path.parentElement) };
    return out;
  });
}

function commonChecks(m) {
  const vw = m.viewport.width;
  return {
    "the dialog is at most 700 px wide and inside the window": !!m.dialog && m.dialog.width <= 700.5 && m.dialog.left >= 0 && m.dialog.right <= vw && m.dialog.top >= 0 && m.dialog.bottom <= m.viewport.height + 0.5,
    "the dialog does not scroll sideways": !!m.dialog && m.dialog.scrollWidth <= m.dialog.clientWidth + 1,
    "a 250 px left column beside the right one": !!m.columns && Math.abs(m.columns.left.width - 250) < 1 && m.columns.right.left >= m.columns.left.right - 0.5,
    "everything stays inside its column": m.outside.length === 0,
    "no control overlaps another": m.overlaps.length === 0,
    "no text is under 11 px": m.smallText.length === 0,
    "no text is cut short": m.clipped.length === 0,
    "paired device rows are 56 px": m.rows.length === 2 && m.rows.every((h) => h === 56),
    "fingerprints are mono": m.fingerprints.length >= 2 && m.fingerprints.every((f) => f.mono),
    "fingerprints fit their boxes": m.fingerprints.every((f) => f.fits),
    "the code is 228 px square": !m.code || (Math.abs(m.code.width - 228) < 1 && Math.abs(m.code.height - 228) < 1),
    "the path picker spans its column": !m.path || Math.abs(m.path.width - (m.path.column.width - 40)) < 1.5,
  };
}

const settle = (page) => page.waitForFunction(() => document.getAnimations().every((animation) =>
  animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity,
));

const server = await serve();
const browser = await launch();
let failed = 0;
const pairCases = shots
  ? ["light", "dark"].flatMap((mode) => [{ width: 760, height: 520 }, { width: 1280, height: 800 }].map((viewport) => ({ mode, viewport })))
  : [
      { mode: "dark", viewport: { width: 1280, height: 800 } },
      { mode: "light", viewport: { width: 760, height: 520 } },
    ];
try {
  for (const { mode, viewport } of pairCases) {
      const name = `${mode}, ${viewport.width}×${viewport.height}`;
      const snap = async (state) => { if (shots) await page.screenshot({ path: join(shots, `pair-phone-${mode}-${viewport.width}x${viewport.height}-${state}.png`) }); };
      const page = await open(browser, server.url, { cloud: true, localProjects: 1, localSession: true }, viewport, {
        colorScheme: mode,
        extra: fixture,
      });
      const rail = await sidebar(page);
      await rail.getByTestId("conversation-list").getByRole("button", { name: /Local long session$/ }).click();
      await page.keyboard.press("Meta+B");
      await settle(page);

      const dock = page.getByTestId("panel-terminal");
      const deviceStatus = page.getByRole("button", { name: "Device · 1 connected phone", exact: true });
      await deviceStatus.waitFor();
      await page.evaluate(() => window.__PW_STUB__.emit("status_bar_settings", { visible: false }));
      await page.locator("[data-status-bar]").waitFor({ state: "hidden" });
      const panelHidden = await dock.count() === 0;
      const statusAtBottomRight = await deviceStatus.evaluate((button) => {
        const box = button.getBoundingClientRect();
        return box.left > innerWidth / 2 && box.bottom > innerHeight - 24;
      });
      await deviceStatus.click();
      const statusDetails = page.getByRole("dialog", { name: "Device", exact: true });
      await statusDetails.getByRole("button", { name: "Disconnect Paresh’s iPhone", exact: true }).click();
      await deviceStatus.waitFor({ state: "hidden" });
      failed += report(`${name}, hidden right panel`, {
        "Device status is in the lower-right corner with no dock": panelHidden && statusAtBottomRight,
        "Disconnect clears the live status and closes its controls": await statusDetails.count() === 0,
      });
      await page.evaluate(() => window.__PAIRING__.reconnect());
      await deviceStatus.waitFor();

      // Live remote access is discoverable and can be ended from the folded dock.
      await page.keyboard.press("Meta+E");
      const deviceTab = dock.getByRole("tab", { name: "Device · 1", exact: true });
      const toggle = dock.getByRole("button", { name: "Show Device tab (1 connected phone)", exact: true });
      await toggle.waitFor();
      await settle(page);
      const dockOnly = await deviceStatus.count() === 0;
      const collapsed = (await toggle.getAttribute("aria-expanded")) === "false";
      const bannerGone = await page.getByTestId("phone-connected-bar").count() === 0;
      const placement = await deviceTab.evaluate((tab) => {
        const terminal = tab.previousElementSibling;
        const row = tab.parentElement.getBoundingClientRect();
        const box = tab.getBoundingClientRect();
        return {
          besideTerminal: terminal?.textContent.trim() === "Terminal" && terminal.getBoundingClientRect().right <= box.left,
          lowerRight: box.left > innerWidth / 2 && box.top > innerHeight / 2,
          fits: box.top >= row.top && box.bottom <= row.bottom && box.right <= Math.min(row.right, innerWidth),
          unselected: tab.getAttribute("aria-selected") === "false",
        };
      });
      await snap("device-collapsed");
      await toggle.click();
      const devicePanel = dock.getByRole("tabpanel", { name: /^Device/ });
      const disconnect = devicePanel.getByRole("button", { name: "Disconnect Paresh’s iPhone" });
      await disconnect.waitFor();
      await snap("device-open");
      const explainsAccess = (await devicePanel.innerText()).includes("see and drive sessions on this Mac");
      await disconnect.click();
      await devicePanel.getByText("No devices connected", { exact: true }).waitFor();
      failed += report(`${name}, Device dock`, {
        "Device is immediately after Terminal in the lower-right dock and fits its tab row": placement.besideTerminal && placement.lowerRight && placement.fits,
        "a connection leaves the tab unselected and the dock collapsed": placement.unselected && collapsed,
        "there is no floating connection banner": bannerGone,
        "the collapsed toggle opens Device and the panel explains remote access": explainsAccess,
        "the Device tab takes over from the lower-right Device button": dockOnly,
        "Disconnect clears the tab count and keeps the phone paired": await dock.getByRole("tab", { name: "Device", exact: true }).count() === 1 &&
          await page.evaluate(async () => (await window.__PW_STUB__.answers.pairing_status()).devices.some((device) => device.id === "phone-1" && !device.connection)),
      }, placement);

      await page.evaluate(() => window.__PAIRING__.reconnect());
      await page.keyboard.press("Meta+K");
      const palette = page.getByRole("dialog");
      await palette.locator("input").fill("Pair a phone");
      await palette.getByRole("option", { name: /^Pair a phone…/ }).click();
      const dialog = page.getByRole("dialog", { name: "Pair a phone" });
      await dialog.getByAltText("TerminalX phone pairing QR code").waitFor();
      const connectedRow = dialog.getByTestId("paired-device").filter({ hasText: "Paresh’s iPhone" });
      await connectedRow.getByRole("button", { name: "Disconnect Paresh’s iPhone", exact: true }).waitFor();
      await connectedRow.getByRole("button", { name: "Revoke Paresh’s iPhone", exact: true }).waitFor();
      await settle(page);

      // 1. A live Relay code.
      let m = await measure(page);
      await snap("code");
      failed += report(`${name}, live code`, {
        ...commonChecks(m),
        "opened from the command palette, titled Pair a phone": m.headerTitle === "Pair a phone",
        "the QR, Expires in m:ss and Generate a new code show": m.qr && /Expires in \d:\d\d/.test(m.text) && m.text.includes("Generate a new code"),
        "Relay is ready": m.text.includes("Relay is ready"),
      }, m);

      // 2. A phone scanned it and waits for approval.
      await page.evaluate(() => window.__PAIRING__.set({ pendingApproval: { requestId: "req-1", deviceId: "phone-9", fingerprint: "CEF4·2468·FE26·9E4B", transport: "relay", requestedAt: Date.now(), expiresAt: Date.now() + 118000 } }));
      await dialog.getByRole("group", { name: "Approve this phone" }).waitFor();
      m = await measure(page);
      await snap("approval");
      failed += report(`${name}, approval`, {
        ...commonChecks(m),
        "the waiting phone's fingerprint is shown, mono, with Approve and Decline": m.fingerprints.some((f) => f.text === "CEF4·2468·FE26·9E4B" && f.mono) && m.text.includes("Approve") && m.text.includes("Decline"),
        "the QR is gone while a phone waits": !m.qr,
      }, m);

      // 3. Declined, then the code ran out: it cannot be scanned.
      await page.evaluate(() => window.__PAIRING__.set({ pendingApproval: null, activePairing: { ...window.__PAIRING__.offer("automatic"), expiresAt: Date.now() - 1000 } }));
      await dialog.getByText("This code has expired").waitFor();
      m = await measure(page);
      await snap("expired");
      failed += report(`${name}, expired`, {
        ...commonChecks(m),
        "no QR for an expired code, and Generate a new code stays": !m.qr && m.text.includes("Generate a new code") && !/Expires in/.test(m.text),
      }, m);

      // 4. Relay down: its problem shows, and Only this network still pairs.
      await page.evaluate((message) => window.__PAIRING__.set({ relay: { phase: "offline", message, attempt: 7 }, activePairing: null }), RELAY_DOWN);
      await dialog.getByText(RELAY_DOWN).waitFor();
      m = await measure(page);
      await snap("relay-down");
      const relayDown = { ...commonChecks(m), "the Relay problem shows instead of Relay is ready": !m.text.includes("Relay is ready") };
      await dialog.getByRole("radio", { name: "Only this network" }).click();
      await dialog.getByAltText("TerminalX phone pairing QR code").waitFor();
      await settle(page);
      m = await measure(page);
      await snap("only-this-network");
      failed += report(`${name}, Relay down`, {
        ...relayDown,
        ...Object.fromEntries(Object.entries(commonChecks(m)).map(([check, ok]) => [`Only this network: ${check}`, ok])),
        "Only this network makes a code with Relay down": m.qr && /Phone must be on this Wi-Fi/.test(m.text),
      }, m);
      await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (shots) console.log(`screenshots: ${shots}`);
process.exit(failed ? 1 : 0);
