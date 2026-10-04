// Assert native scroll events and measureInWindow geometry, never mocked scroll calls.
// node check.mjs suite | <action> bottom | <action> preserve
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const endpoint = "http://127.0.0.1:18746";
const output = fileURLToPath(new URL("../../dist/viewport/", import.meta.url));
mkdirSync(output, { recursive: true });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const read = async () => (await fetch(`${endpoint}/metrics`)).json();
async function check(action, mode = "bottom") {
  const before = await read();
  if (action !== "measure") await fetch(`${endpoint}/command`, { method: "POST", body: JSON.stringify({ action }) });
  for (let attempt = 0; attempt < 40; attempt++) {
    const state = await read();
    if (state.scroll && (action === "measure" || state.label === action)) break;
    await pause(250);
  }
  await pause(2000); // Includes the fixture's delayed cold load/image resize.
  const after = await read();
  assert(after.bounds, "Native fixture must be running");
  assert(Date.now() - after.measuredAt < 1500, "Native measurements are stale; check the fixture app");
  if (action !== "measure") assert.equal(after.label, action);
  const edge = after.footer ?? after.latest;
  const gap = edge ? after.bounds.y + after.bounds.height - edge.y - edge.height : null;
  if (mode === "bottom" && after.items.length) {
    assert(Math.abs(after.scroll.offset) < 2, `Native viewport is above latest: ${after.scroll.offset}px`);
    assert(Math.abs(gap - (after.footer ? 40 : 24)) < 2, `Latest marker is outside the bottom padding: ${gap}px`);
  }
  if (mode === "away") assert(after.scroll.offset > 80, "Reader was forced back to latest");
  if (mode === "preserve") {
    const anchor = before.visible[Math.floor(before.visible.length / 2)];
    assert(anchor, "Scroll until a history marker is visible before testing preservation");
    const retained = after.visible.find((row) => row.id === anchor.id);
    assert(retained, `Visible history marker ${anchor.id} disappeared`);
    assert(Math.abs(retained.rect.y - anchor.rect.y) < 2, `Reading position moved: ${anchor.rect.y} -> ${retained.rect.y}`);
  }
  const result = { action, mode, gap, before, after };
  writeFileSync(`${output}${action}-${mode}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ action, mode, offset: after.scroll.offset, gap, visible: after.visible.map((row) => ({ id: row.id, y: row.rect.y })) }));
}
const [action = "suite", mode] = process.argv.slice(2);
if (action === "suite") {
  for (const action of ["empty", "short", "cold", "cached", "host", "live", "reconnect", "long", "grow", "image", "permission", "switch"]) await check(action);
} else await check(action, mode);
