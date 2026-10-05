// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";

// Exercise real native primitives through their web adapter; formatting and
// horizontal scrolling must be visible in the rendered output, not a mock.
vi.mock("react-native", () => vi.importActual("react-native-web"));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("./theme", () => ({ useTheme: () => ({ palette: {
  ink: "#222222", muted: "#777777", accent: "#a96f27", raised: "#eeeeee", border: "#cccccc",
} }) }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const render = async (text: string) => { await act(async () => root.render(<Markdown text={text} />)); };

it("draws bold and inline code, headings, nested lists, and selectable code blocks", async () => {
  await render("# Heading\n\n**Important** and `value`\n\n3. First\n4. Second\n   - Nested\n\n```ts\nconst answer = 42;\n```\n\n> A quote");
  expect(container.querySelector('[role="heading"]')?.textContent).toBe("Heading");
  const bold = [...container.querySelectorAll("span")].find((node) => node.textContent === "Important");
  expect(bold && getComputedStyle(bold).fontWeight).toBe("700");
  const code = [...container.querySelectorAll("span")].find((node) => node.textContent === "value");
  expect(code && getComputedStyle(code).fontFamily).toContain("monospace");
  expect(container.textContent).toContain("3.First");
  expect(container.textContent).toContain("4.Second");
  expect(container.textContent).toContain("•Nested");
  const block = container.querySelector('[aria-label="Code block"]');
  expect(block?.textContent).toBe("const answer = 42;");
  expect(block && getComputedStyle(block).overflowX).toBe("auto");
  expect(container.textContent).not.toContain("```");
  expect(container.textContent).toContain("A quote");
});

it("puts a formatted, aligned table in its own horizontal scroller", async () => {
  await render("| Name | Count | Details |\n| --- | ---: | --- |\n| **Answer** | 42 | `value` |\n| Other | 1 | Long detail |");
  const table = container.querySelector('[aria-label="Markdown table"]');
  expect(table && getComputedStyle(table).overflowX).toBe("auto");
  expect(table?.textContent).toBe("NameCountDetailsAnswer42valueOther1Long detail");
  expect(table?.textContent).not.toContain("|");
  const count = [...table!.querySelectorAll("div")].find((node) => node.textContent === "42" && getComputedStyle(node).textAlign === "right");
  expect(count && getComputedStyle(count).textAlign).toBe("right");
});

it("updates streaming text, renders an unfinished fence, and preserves literal markup in code", async () => {
  await render("**Partial");
  await render("**Complete**\n\n```xml\n<task-notification>example</task-notification>\n**literal**");
  expect(container.textContent).toContain("Complete");
  expect(container.textContent).not.toContain("**Complete**");
  expect(container.querySelector('[aria-label="Code block"]')?.textContent).toBe("<task-notification>example</task-notification>\n**literal**");
});

it("decodes prose entities, preserves code, and only activates external web or mail links", async () => {
  await render('A &amp; B &lt; C\n\n`&amp;`\n\n[Web](https://example.com) [Mail](mailto:test@example.com) [File](file:///tmp/test) [Unsafe](javascript:alert%281%29)');
  expect(container.textContent).toContain("A & B < C");
  expect(container.textContent).toContain("&amp;");
  expect([...container.querySelectorAll('[role="link"]')].map((node) => node.textContent)).toEqual(["Web", "Mail", "File"]);
});
