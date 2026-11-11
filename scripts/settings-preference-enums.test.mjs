import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

const read = (path) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", path), "utf8");
const ast = (path) => ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
const strings = (node) => ts.isUnionTypeNode(node) && node.types.every((type) => ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal))
  ? node.types.map((type) => type.literal.text).sort() : null;

it("keeps every migrated preference enum in sync with its TypeScript type", () => {
  const defaults = JSON.parse(read("src/lib/userPreferenceDefaults.json"));
  const expected = {};
  const prefs = ast("src/lib/prefs.ts").statements.find((node) => ts.isInterfaceDeclaration(node) && node.name.text === "Prefs");
  expect(prefs).toBeDefined();
  for (const member of prefs.members) {
    if (!ts.isPropertySignature(member) || !member.type || !(member.name.getText() in defaults)) continue;
    const values = strings(member.type);
    if (values) expected[member.name.getText()] = values;
  }
  const theme = ast("src/lib/theme.ts");
  for (const [key, name] of [["theme", "ThemeId"], ["mode", "Mode"]]) {
    const alias = theme.statements.find((node) => ts.isTypeAliasDeclaration(node) && node.name.text === name);
    expect(alias).toBeDefined();
    expected[key] = strings(alias.type);
    expect(expected[key]).not.toBeNull();
  }
  const actual = Object.fromEntries([...read("src-tauri/src/store/settings/file.rs").matchAll(/"preferences\.([^"]+)" => &\[([^\]]+)\]/g)]
    .map(([, key, values]) => [key, JSON.parse(`[${values}]`).sort()]));
  expect(actual).toEqual(expected);
});
