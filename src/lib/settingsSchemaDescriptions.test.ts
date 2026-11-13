// PRO-140: the published settings schema takes each key's description from
// schemas/settings-descriptions.json, which must say what the Settings row says.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SETTINGS_ROWS } from "@/components/settings/settingsRegistry";

const PREFIX = "$TERMINALX_HOME/settings.json#";

/** Every row stored at one dotted key of the user file, by key, in key order. */
function expectedDescriptions(): Record<string, string> {
  const rows: Record<string, string> = {};
  for (const row of SETTINGS_ROWS) {
    const location: string = row.storage.location;
    if (!location.startsWith(PREFIX)) continue;
    // "preferences.linkBrowser, preferences.linkBrowserChosen" names two keys; a path after a comma is another store.
    for (const key of location.slice(PREFIX.length).split(", ")) {
      if (!/^[A-Za-z][\w.]*$/.test(key)) continue;
      // Two rows on one key would give the schema two descriptions: keep the first, as the registry lists it.
      rows[key] ??= row.description;
    }
  }
  return Object.fromEntries(Object.keys(rows).sort().map((key) => [key, rows[key]]));
}

describe("schemas/settings-descriptions.json", () => {
  it("matches the Settings registry row for every key of the user file", () => {
    const path = resolve(__dirname, "../../schemas/settings-descriptions.json");
    const committed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const expected = expectedDescriptions();
    if (JSON.stringify(committed) !== JSON.stringify(expected)) {
      // Paste this into schemas/settings-descriptions.json, then regenerate the schema
      // (TERMINALX_WRITE_SCHEMAS=1 cargo t --lib store::settings::schema).
      console.error(`${JSON.stringify(expected, null, 2)}\n`);
    }
    expect(committed).toEqual(expected);
  });
});
