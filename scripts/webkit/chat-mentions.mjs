#!/usr/bin/env node
// PRO-141: chat @mentions in WebKit, dark and light. Checks the composer's @ menu with People above Files (13.02),
// the mention chips above the text and in a sent message (13.03), the no-access warning with its Share button
// (14.07), and the "mentioned you" notification with Open and Mark as read (13.03). Each is checked at a wide and a
// narrow column: chips 22px tall with a 16px avatar, nothing outside its box, no text cut off, no horizontal overflow.
// pnpm exec node scripts/webkit/chat-mentions.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { searchForWorkspaceRoot, transformWithEsbuild } from "vite";
import { createCheckServer } from "./vite-page.mjs";
import { launch } from "./harness.mjs";

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MentionChips, MentionRefusal, PersonAvatar } from '/src/components/chat/ComposerMentions.tsx';
import { PickerMenu } from '/src/components/chat/PickerMenu.tsx';
import { LinkedText } from '/src/components/chat/LinkedText.tsx';
import { MentionPeopleContext } from '/src/components/chat/useMentionPeople.tsx';
import { MentionNotices } from '/src/components/layout/MentionNotices.tsx';
import { showMentionNotice } from '/src/lib/mentionNotices.ts';
import { setMode } from '/src/lib/theme.ts';
import '/src/styles/app.css';
window.setMode = setMode;
const people = [
  { userId: 'u1', name: 'Aisha Khan', email: 'aisha.khan@example.test', role: 'member' },
  { userId: 'u2', name: 'Bartholomew Featherstonehaugh-Smythe', email: 'bartholomew.featherstonehaugh@example.test', role: 'member' },
];
const items = [
  ...people.map((p, i) => ({ id: 'person:' + p.userId, label: p.name, detail: p.email + (i === 0 ? ' · Driver · in this tab' : ''), icon: <PersonAvatar person={p} online={i === 0} />, section: 'People', stacked: true })),
  { id: 'src/a.ts', label: 'a.ts', detail: 'src/components/a.ts', section: 'Files' },
];
showMentionNotice({ id: '1', organizationId: 'o', workspaceId: 'w', sessionId: 's', tabId: 't', messageId: 'm', actorId: 'u1', actorName: 'Aisha Khan', workspaceName: 'Session overview table', quote: '@Paresh can you check the widths? The second column wraps at 1280 and the third one never does.', at: 0 });
function Column({ id, width }) {
  return <div id={id} style={{ width, padding: 12 }} className="bg-chat">
    <MentionRefusal refused={{ kind: 'no-access', message: "Bartholomew Featherstonehaugh-Smythe can't follow Session overview table yet. Share it with them, then mention them again." }} onShare={() => {}} onDismiss={() => {}} />
    <div data-composer-box className="rounded-2xl border border-hairline bg-composer p-2">
      <div className="relative h-0"><div className="absolute bottom-2 left-0 right-0"><PickerMenu items={items} highlighted={0} onPick={() => {}} onHover={() => {}} title="Files" empty="none"
        footer={<><span>People first, then files</span><span>A person you mention starts following this workspace</span></>} /></div></div>
      <MentionChips people={people} onRemove={() => {}} />
      <textarea defaultValue="@Aisha Khan @Bartholomew Featherstonehaugh-Smythe can you check?" className="w-full bg-transparent" />
    </div>
    <MentionPeopleContext.Provider value={people}>
      <p data-message className="mt-3 text-[14px]"><LinkedText mentions text="@Aisha Khan can you check the widths? cc @Bartholomew Featherstonehaugh-Smythe" /></p>
    </MentionPeopleContext.Provider>
  </div>;
}
createRoot(document.getElementById('root')).render(<div style={{ display: 'flex', gap: 24 }}>
  <div style={{ paddingTop: 320 }}><Column id="wide" width={720} /></div>
  <div style={{ paddingTop: 320 }}><Column id="narrow" width={360} /></div>
  <div data-notice-column style={{ width: 360 }} className="flex flex-col gap-2 p-2"><MentionNotices /></div>
</div>);
`;
const server = await createCheckServer({
  server: {
    host: "127.0.0.1",
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), await realpath(fileURLToPath(new URL("../../node_modules", import.meta.url)))] },
  },
  plugins: [{
    resolveId(id) { if (id === "/chat-mentions.tsx") return "\0chat-mentions.tsx"; },
    async load(id) {
      if (id === "\0chat-mentions.tsx") return (await transformWithEsbuild(entry, "chat-mentions.tsx", { loader: "tsx", jsx: "automatic" })).code;
    },
    configureServer(server) {
      server.middlewares.use("/mentions-test", async (_request, response) => {
        response.setHeader("Content-Type", "text/html");
        response.end(await server.transformIndexHtml("/mentions-test", '<div id="root"></div><script type="module" src="/chat-mentions.tsx"></script>'));
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on("pageerror", (error) => console.error(error));
  await page.addInitScript(await readFile(new URL("./tauri-stub.js", import.meta.url), "utf8"));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/mentions-test`);
  await page.locator("[data-testid=mention-notice]").waitFor();
  const shots = process.env.WEBKIT_LAYOUT_SCREENSHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  for (const mode of ["dark", "light"]) {
    await page.evaluate((mode) => window.setMode(mode), mode);
    await page.waitForFunction((mode) => document.documentElement.getAttribute("data-mode") === mode, mode);
    await page.evaluate(() => document.fonts.ready);
    const r = await page.evaluate(() => {
      const box = (el) => el.getBoundingClientRect();
      const inside = (inner, outer, slack = 1) => { const a = box(inner), b = box(outer); return a.left >= b.left - slack && a.right <= b.right + slack && a.top >= b.top - slack && a.bottom <= b.bottom + slack; };
      const clipped = (root) => [...root.querySelectorAll("span, p, button")].filter((el) => !el.classList.contains("sr-only") && getComputedStyle(el).overflow !== "visible" && !el.className.toString().includes("truncate") && !el.className.toString().includes("line-clamp") && el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent.slice(0, 40));
      const column = (id) => {
        const root = document.getElementById(id);
        const chips = [...root.querySelectorAll("[data-testid=mention-chip]")];
        const warning = root.querySelector("[data-testid=mention-refused]");
        const share = root.querySelector("[data-testid=mention-refused-share]");
        const menu = root.querySelector("[role=listbox]") ?? root.querySelector("[data-testid=picker-section]").closest("div");
        return {
          chips: chips.length,
          chipHeights: chips.map((chip) => Math.round(box(chip).height)),
          avatars: chips.map((chip) => Math.round(box(chip.firstElementChild).width)),
          chipColor: getComputedStyle(chips[0]).backgroundColor,
          chipsInside: chips.every((chip) => inside(chip, root)),
          shareInside: inside(share, warning),
          warningInside: inside(warning, root),
          sections: [...root.querySelectorAll("[data-testid=picker-section]")].map((el) => el.textContent),
          footer: !!root.querySelector("[data-testid=picker-footer]"),
          // It opens upward, over what is above the box, so only its sides are held to the column.
          menuInside: box(menu).left >= box(root).left - 1 && box(menu).right <= box(root).right + 1,
          messageChips: root.querySelectorAll("[data-message] [data-testid=mention-chip]").length,
          // What a copy of the message keeps: its text without what cannot be selected (the avatars' initials), the
          // hidden "@" included. Read from the text nodes, not the Selection API, which headless WebKit on Linux leaves empty.
          messageText: (() => {
            const message = root.querySelector("[data-message]");
            const unselectable = (el) => {
              for (let at = el; at && at !== message.parentElement; at = at.parentElement) {
                const style = getComputedStyle(at);
                if ((style.userSelect || style.webkitUserSelect) === "none") return true;
              }
              return false;
            };
            const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
            let copied = "";
            for (let node = walker.nextNode(); node; node = walker.nextNode()) if (!unselectable(node.parentElement)) copied += node.textContent;
            return copied;
          })(),
          clipped: clipped(root),
        };
      };
      const notice = document.querySelector("[data-testid=mention-notice]");
      return {
        wide: column("wide"),
        narrow: column("narrow"),
        notice: {
          buttons: [...notice.querySelectorAll("button")].map((b) => b.textContent.trim() || b.getAttribute("aria-label")),
          buttonsInside: [...notice.querySelectorAll("button")].every((b) => inside(b, notice)),
          body: notice.querySelector("[data-testid=mention-notice-body]").textContent,
          title: notice.querySelector("p").textContent,
        },
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
      };
    });
    console.log(mode, JSON.stringify(r));
    if (shots) await page.screenshot({ path: join(shots, `chat-mentions-${mode}.png`) });
    for (const [name, c] of Object.entries({ wide: r.wide, narrow: r.narrow })) {
      const where = `${mode} ${name}`;
      assert.equal(c.chips, 4, `${where}: two composer chips and two in the message`);
      assert(c.chipHeights.every((h) => h === 22), `${where}: chip heights ${c.chipHeights}`);
      assert(c.avatars.every((w) => w === 16), `${where}: avatar sizes ${c.avatars}`);
      assert.notEqual(c.chipColor, "rgba(0, 0, 0, 0)", `${where}: the chip has the mention colour`);
      assert(c.chipsInside, `${where}: chips stay in the column`);
      assert(c.warningInside && c.shareInside, `${where}: warning and Share fit`);
      assert.deepEqual(c.sections, ["People", "Files"], `${where}: People above Files`);
      assert(c.footer, `${where}: the menu's footer`);
      assert(c.menuInside, `${where}: the menu stays in the column`);
      assert.equal(c.messageChips, 2, `${where}: both names drawn as chips in the message`);
      assert.equal(c.messageText.replace(/\s+/g, " ").trim(), "@Aisha Khan can you check the widths? cc @Bartholomew Featherstonehaugh-Smythe", `${where}: a copy reads as sent`);
      assert.deepEqual(c.clipped, [], `${where}: nothing cut off`);
    }
    assert.equal(r.notice.title, "Aisha Khan mentioned you");
    assert(r.notice.body.startsWith("Session overview table · “@Paresh can you check"), r.notice.body);
    assert.deepEqual(r.notice.buttons, ["Dismiss mention", "Open", "Mark as read"]);
    assert(r.notice.buttonsInside, `${mode}: notice buttons inside`);
    assert(!r.overflow, `${mode}: no horizontal overflow`);
    console.log(`ok chat mentions in ${mode}: @ menu People/Files, chips 22px with 16px avatars, 14.07 warning, notice`);
  }
} finally {
  await browser?.close();
  await server.close();
}
