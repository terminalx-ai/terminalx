#!/usr/bin/env node
// PRO-314: the Pair a phone dialog and the connected bar in the desktop's WebKit,
// at the window's smallest size (760×520, tauri.conf.json) and a roomy one, in
// the light and the dark theme. The dialog opens from the command palette; then
// it shows a live code, a phone waiting for approval, an expired code, and Relay
// down with Only this network chosen. In each: the dialog stays inside the
// window and its two columns, nothing overlaps or is cut, no text is under
// 11 px, the fingerprints are mono, device rows are 56 px, and the connected
// bar sits top-centre, whole, clear of the dialog.
//
// Pictures of every case go to PAIR_PHONE_SHOTS, by default scripts/webkit/output/pair-phone;
// that default folder ignores itself, so a run leaves the worktree clean.
//
//   pnpm build && npx playwright install webkit && node scripts/webkit/pair-phone.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, open, report, serve } from "./harness.mjs";

const output = fileURLToPath(new URL("./output/", import.meta.url));
const shots = process.env.PAIR_PHONE_SHOTS ?? join(output, "pair-phone");
await mkdir(shots, { recursive: true });
if (!process.env.PAIR_PHONE_SHOTS) await writeFile(join(output, ".gitignore"), "*\n");

const RELAY_DOWN = "TerminalX Relay service is temporarily unavailable. Retrying automatically. You can pair on this network meanwhile.";

// Runs in the page, after the stub: the Mac's pairing status, and a way to change it as the Mac would.
const fixture = `(() => {
  const answers = window.__PW_STUB__.answers;
  const now = Date.now();
  const offer = (mode) => ({
    pairingUrl: "terminalx://pair?v=2&code=" + "A1b2C3d4E5".repeat(mode === "automatic" ? 40 : 12),
    expiresAt: Date.now() + 292000,
    connectionMode: mode,
    directAvailable: true,
    transport: mode === "automatic" ? "relay" : "direct",
  });
  const devices = [
    { id: "phone-1", label: "Paresh’s iPhone", platform: "ios", token: "t", scope: "driver", provenance: "explicit", bindingGeneration: 0, publicKey: "k",
      createdAt: "2026-10-01T09:00:00Z", lastSeenAt: "2026-11-12T09:00:00Z", fingerprint: "7F3A·91C2", approvedAt: "2026-10-01T09:00:00Z",
      connection: { transport: "relay", since: "2026-11-12T09:00:00Z" }, lastSeenTransport: "relay" },
    { id: "ipad-1", label: "Studio iPad", platform: "ios", token: "t", scope: "driver", provenance: "explicit", bindingGeneration: 0, publicKey: "k",
      createdAt: "2026-10-01T09:00:00Z", lastSeenAt: "2026-11-03T18:20:00Z", fingerprint: "C04E·5B17", lastSeenTransport: "direct" },
  ];
  let status = {
    relay: { phase: "connected", message: null, attempt: 0 },
    host: null,
    devices,
    activePairing: offer("automatic"),
    pendingApproval: null,
    keepAwake: true,
    lastError: null,
  };
  answers.pairing_status = () => status;
  answers.pairing_generate = ({ connectionMode }) => (status = { ...status, activePairing: offer(connectionMode) });
  window.__PAIRING__ = {
    now,
    set(patch) {
      status = { ...status, ...patch };
      window.__PW_STUB__.emit("pairing_status", status);
    },
    offer,
  };
})();`;

/** Layout facts about the open dialog and the connected bar. */
function measure(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const bar = document.querySelector('[data-testid="phone-connected-bar"]');
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
      out.fingerprints = fingerprints.map((el) => ({ text: el.textContent, mono: getComputedStyle(el).fontFamily === mono }));
      out.rows = [...dialog.querySelectorAll('[data-testid="paired-device"]')].map((row) => Math.round(row.getBoundingClientRect().height));
      out.headerTitle = dialog.querySelector("h2")?.textContent ?? null;
      out.qr = !!dialog.querySelector('img[alt="TerminalX phone pairing QR code"]');
      out.text = dialog.textContent;
    }
    if (bar) out.bar = { ...box(bar), text: bar.textContent, cut: [...bar.querySelectorAll("span")].some((s) => s.scrollWidth > s.clientWidth + 1) };
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
    "the connected bar is top-centre and whole": !!m.bar && Math.abs((m.bar.left + m.bar.right) / 2 - vw / 2) < 1.5 && m.bar.top < 12 && !m.bar.cut && m.bar.text.startsWith("Paresh’s iPhone is connected · it can see and drive your sessions"),
    "the connected bar is clear of the dialog": !!m.bar && !!m.dialog && m.bar.bottom <= m.dialog.top,
  };
}

const settle = (page) => page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const mode of ["light", "dark"]) {
    for (const viewport of [{ width: 760, height: 520 }, { width: 1280, height: 800 }]) {
      const name = `${mode}, ${viewport.width}×${viewport.height}`;
      const shot = (state) => join(shots, `pair-phone-${mode}-${viewport.width}x${viewport.height}-${state}.png`);
      const page = await open(browser, server.url, { cloud: true, localProjects: 1 }, viewport, {
        extra: `localStorage.setItem("raccoon.mode", ${JSON.stringify(mode)});\n${fixture}`,
      });
      await page.locator('[data-testid="sidebar-rail"]').waitFor();
      await page.keyboard.press("Meta+K");
      const palette = page.getByRole("dialog");
      await palette.locator("input").fill("Pair a phone");
      await palette.getByRole("option", { name: /^Pair a phone…/ }).click();
      const dialog = page.getByRole("dialog", { name: "Pair a phone" });
      await dialog.getByAltText("TerminalX phone pairing QR code").waitFor();
      await settle(page);

      // 1. A live Relay code.
      let m = await measure(page);
      await page.screenshot({ path: shot("code") });
      failed += report(`${name}, live code`, {
        ...commonChecks(m),
        "opened from the command palette, titled Pair a phone": m.headerTitle === "Pair a phone",
        "the QR, Expires in m:ss and Generate a new code show": m.qr && /Expires in \d:\d\d/.test(m.text) && m.text.includes("Generate a new code"),
        "Relay is ready": m.text.includes("Relay is ready"),
      }, m);

      // 2. A phone scanned it and waits for approval.
      await page.evaluate(() => window.__PAIRING__.set({ pendingApproval: { requestId: "req-1", deviceId: "phone-9", fingerprint: "1177·11ED", transport: "relay", requestedAt: Date.now(), expiresAt: Date.now() + 118000 } }));
      await dialog.getByRole("group", { name: "Approve this phone" }).waitFor();
      m = await measure(page);
      await page.screenshot({ path: shot("approval") });
      failed += report(`${name}, approval`, {
        ...commonChecks(m),
        "the waiting phone's fingerprint is shown, mono, with Approve and Decline": m.fingerprints.some((f) => f.text === "1177·11ED" && f.mono) && m.text.includes("Approve") && m.text.includes("Decline"),
        "the QR is gone while a phone waits": !m.qr,
      }, m);

      // 3. Declined, then the code ran out: it cannot be scanned.
      await page.evaluate(() => window.__PAIRING__.set({ pendingApproval: null, activePairing: { ...window.__PAIRING__.offer("automatic"), expiresAt: Date.now() - 1000 } }));
      await dialog.getByText("This code has expired").waitFor();
      m = await measure(page);
      await page.screenshot({ path: shot("expired") });
      failed += report(`${name}, expired`, {
        ...commonChecks(m),
        "no QR for an expired code, and Generate a new code stays": !m.qr && m.text.includes("Generate a new code") && !/Expires in/.test(m.text),
      }, m);

      // 4. Relay down: its problem shows, and Only this network still pairs.
      await page.evaluate((message) => window.__PAIRING__.set({ relay: { phase: "offline", message, attempt: 7 }, activePairing: null }), RELAY_DOWN);
      await dialog.getByText(RELAY_DOWN).waitFor();
      m = await measure(page);
      await page.screenshot({ path: shot("relay-down") });
      const relayDown = { ...commonChecks(m), "the Relay problem shows instead of Relay is ready": !m.text.includes("Relay is ready") };
      await dialog.getByRole("radio", { name: "Only this network" }).click();
      await dialog.getByAltText("TerminalX phone pairing QR code").waitFor();
      await settle(page);
      m = await measure(page);
      await page.screenshot({ path: shot("only-this-network") });
      failed += report(`${name}, Relay down`, {
        ...relayDown,
        ...Object.fromEntries(Object.entries(commonChecks(m)).map(([check, ok]) => [`Only this network: ${check}`, ok])),
        "Only this network makes a code with Relay down": m.qr && /Phone must be on this Wi-Fi/.test(m.text),
      }, m);
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`screenshots: ${shots}`);
process.exit(failed ? 1 : 0);
