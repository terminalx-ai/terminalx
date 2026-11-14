import { afterEach, describe, expect, it } from "vitest";
import { installAppContextMenu } from "./contextMenu";

afterEach(() => document.body.replaceChildren());

describe("app context menus", () => {
  it("suppresses the webview menu on app surfaces, including non-text controls", () => {
    const uninstall = installAppContextMenu();
    for (const markup of ["<div>Sidebar</div>", "<button>Action</button>", '<input type="checkbox">', '<div contenteditable="false">Label</div>']) {
      document.body.innerHTML = markup;
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      document.body.firstElementChild!.dispatchEvent(event);
      expect(event.defaultPrevented, markup).toBe(true);
    }
    uninstall();
    expect(document.body.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))).toBe(true);
  });

  it("preserves native editing menus on text fields and rich-text descendants", () => {
    const uninstall = installAppContextMenu();
    try {
      for (const markup of ['<input value="Name">', '<input type="search">', "<textarea>Draft</textarea>", '<div contenteditable="true"><span>Draft</span></div>', '<div contenteditable="plaintext-only"><span>Draft</span></div>']) {
        document.body.innerHTML = markup;
        const target = document.body.querySelector("span") ?? document.body.firstElementChild!;
        const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
        target.dispatchEvent(event);
        expect(event.defaultPrevented, markup).toBe(false);
      }
    } finally {
      uninstall();
    }
  });
});
