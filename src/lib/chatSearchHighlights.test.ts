import { afterEach, describe, expect, it, vi } from "vitest";
import { chatOwnsFocus, revealSearchRange, searchRangeRects, searchRanges } from "./chatSearchHighlights";

afterEach(() => vi.restoreAllMocks());

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

describe("revealing clipped search results", () => {
  it("reveals through a hidden overflow wrapper as well as its nested code scroller", () => {
    const shell = document.createElement("div");
    const chat = document.createElement("div");
    const wrapper = document.createElement("div");
    const body = document.createElement("div");
    shell.append(chat);
    chat.append(wrapper);
    wrapper.append(body);
    body.textContent = "codeNeedle";
    shell.scrollTop = 345;
    chat.style.overflowY = body.style.overflowY = "auto";
    wrapper.style.overflowY = "hidden";

    // Replay the failed WebKit geometry: the wrapper still has a 202px
    // intrinsic box around a 384px code scroller. Scroll writes must clamp
    // like the browser; moving only the chat and code leaves the match clipped.
    const scrollport = (element: HTMLElement, initial: number, client: number, extent: number) => {
      let top = initial;
      Object.defineProperties(element, {
        clientHeight: { value: client },
        scrollHeight: { value: extent },
        scrollTop: { get: () => top, set: (value: number) => { top = Math.max(0, Math.min(extent - client, Math.floor(value))); } },
      });
    };
    scrollport(chat, 4686, 658, 480814);
    scrollport(wrapper, 0, 200, 412);
    scrollport(body, 787, 384, 2022);
    const wrapperTop = () => 3595 - chat.scrollTop;
    const bodyTop = () => wrapperTop() + 29 - wrapper.scrollTop;
    vi.spyOn(chat, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 120, 500, 658));
    vi.spyOn(wrapper, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, wrapperTop(), 500, 202));
    vi.spyOn(body, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, bodyTop(), 500, 384));
    const [range] = searchRanges(chat, "codeNeedle", false);
    vi.spyOn(range, "getBoundingClientRect").mockImplementation(() => new DOMRect(10, bodyTop() + 1978 - body.scrollTop, 75, 16));
    vi.spyOn(range, "getClientRects").mockImplementation(() => {
      const rect = range.getBoundingClientRect();
      return Object.assign([rect], { item: (index: number) => index === 0 ? rect : null });
    });
    expect(range.getBoundingClientRect().top).toBe(129);
    expect(searchRangeRects(range, chat, 218)).toEqual([]);

    revealSearchRange(range, chat, 218);

    const rect = range.getBoundingClientRect();
    expect(searchRangeRects(range, chat, 218)).toEqual([{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }]);
    expect(rect.top).toBeGreaterThanOrEqual(120);
    expect(rect.bottom).toBeLessThanOrEqual(778 - 218);
    expect(shell.scrollTop).toBe(345);
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
