import { describe, expect, it } from "vitest";
import { chatOwnsFocus, searchRanges } from "./chatSearchHighlights";

describe("chat search highlights", () => {
  it("spans emphasis, links and code tokens without changing the DOM", () => {
    const root = document.createElement("div");
    root.innerHTML = '<p>An <strong>error</strong> in <a href="https://example.test">file.ts</a>.</p><pre><code><span>error</span><span> in </span><span>file.ts</span></code></pre>';
    const before = root.innerHTML;
    expect(searchRanges(root, "error in file.ts", false).map((range) => range.toString())).toEqual(["error in file.ts", "error in file.ts"]);
    expect(root.innerHTML).toBe(before);
  });

  it("ignores code controls and normalizes whitespace without losing source offsets", () => {
    const root = document.createElement("div");
    root.innerHTML = '<div data-streamdown="code-block-header">needle</div><button>needle</button><pre>needle\n\n  here</pre><p>Needle here</p>';
    expect(searchRanges(root, "needle here", false).map((range) => range.toString())).toEqual(["needle\n\n  here", "Needle here"]);
    expect(searchRanges(root, "needle here", true)).toHaveLength(1);
  });
});

describe("find focus scope", () => {
  it("belongs to the chat and composer; excludes another chat, editor, terminal and portals", () => {
    const root = document.createElement("div");
    root.dataset.findScope = "chat";
    root.innerHTML = '<p>text</p><textarea></textarea><div class="cm-editor"><input /></div><div class="terminal-host"><div class="xterm"><textarea></textarea></div></div><div data-find-scope="chat"><input /></div>';
    expect(chatOwnsFocus(root, root)).toBe(true);
    expect(chatOwnsFocus(root, root.querySelector("p"))).toBe(true);
    expect(chatOwnsFocus(root, root.querySelector("textarea"))).toBe(true);
    for (const selector of [".cm-editor input", ".xterm textarea", '[data-find-scope="chat"] input']) expect(chatOwnsFocus(root, root.querySelector(selector))).toBe(false);
    expect(chatOwnsFocus(root, document.createElement("input"))).toBe(false);
    expect(chatOwnsFocus(root, null)).toBe(false);
  });
});
