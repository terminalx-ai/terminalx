#!/usr/bin/env node
// PRO-254: production tray layout and controls in WebKit, with a runtime fixture.
// pnpm build && node scripts/webkit/held-queue.mjs (run UI checks in the Lume VM).
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launch, open, openConversation, serve, tab } from "./harness.mjs";

const extra = `(() => {
  localStorage.setItem("raccoon.prefs", JSON.stringify({ followUps: "hold" }));
  const queue = { items: [
    { id: "one", text: "First, fix the typo in the heading.", images: [] },
    { id: "two", text: "Then check this screenshot.", images: [{url:"/shot.png",name:"screenshot.png"}] },
    { id: "three", text: "Finally, run the targeted tests.", images: [] },
  ], paused: false, sending: null, next: null, error: null };
  let seq = 1;
  const event = (tabId, payload) => ({ id: "held-" + ++seq, seq, sessionId:"local-s1",tabId,harness:"claude",ts:new Date().toISOString(),payload });
  const snapshot = tabId => event(tabId, { type:"held_queue", queue:JSON.parse(JSON.stringify(queue)) });
  const answers = window.__PW_STUB__.answers;
  answers.load_tab_events = ({tabId}) => [event(tabId,{type:"user_message",text:"Work on the page",queued:false}),event(tabId,{type:"turn_started"}),snapshot(tabId)];
  answers.change_held_queue = ({tabId,change}) => {
    window.__lastQueueChange = change;
    switch(change.type) {
      case "pause": queue.paused=change.paused; break;
      case "edit": queue.items.find(item=>item.id===change.id).text=change.text; break;
      case "delete": queue.items=queue.items.filter(item=>item.id!==change.id); break;
      case "move": {
        const item=queue.items.find(item=>item.id===change.id);
        queue.items=queue.items.filter(item=>item.id!==change.id);
        queue.items.splice(change.beforeId ? queue.items.findIndex(item=>item.id===change.beforeId) : queue.items.length,0,item); break;
      }
      case "enqueue": queue.items.push({id:"new-"+seq,text:change.text,images:change.images}); break;
      case "sendNow": queue.items=queue.items.filter(item=>item.id!==change.id); break;
    }
    return {queued:true,events:[snapshot(tabId)]};
  };
})();`;
const server = await serve();
const screenshots = process.env.WEBKIT_LAYOUT_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });
let browser;
try {
  browser = await launch({ headless: true });
  for (const colorScheme of ["light", "dark"]) {
  const page = await open(browser, server.url, { cloud:false, localProjects:1, localSession:true }, { width:1100, height:800 }, { extra, colorScheme });
  await openConversation(page, "Local long session");
  await tab(page, "gemini tab").click();
  const tray = page.getByRole("region", { name:"Held follow-ups" }).filter({ visible: true });
  await tray.waitFor();
  for (const width of [1100,760]) {
    await page.setViewportSize({width,height:800});
    const bounds = await tray.evaluate(el=>{
      const rect=el.getBoundingClientRect();
      return { x:rect.x, right:rect.right, bottom:rect.bottom, overflow:el.scrollWidth-el.clientWidth, viewport:innerWidth,
        buttons:[...el.querySelectorAll('button')].every(button=>{const b=button.getBoundingClientRect(); return b.left>=rect.left && b.right<=rect.right+1;}) };
    });
    assert.ok(bounds.x>=0 && bounds.right<=bounds.viewport+1 && bounds.bottom<=800 && bounds.overflow<=1 && bounds.buttons,JSON.stringify(bounds));
    if(screenshots) await page.screenshot({path:screenshots+"/held-queue-"+colorScheme+"-"+width+".png"});
  }
  await tray.getByRole("button",{name:"3 held follow-ups",exact:true}).click();
  assert.equal(await tray.getByText("First, fix the typo in the heading.").count(),0);
  await tray.getByRole("button",{name:"3 held follow-ups",exact:true}).click();
  await tray.getByLabel("Edit follow-up 2",{exact:true}).click();
  assert.equal(await tray.getByLabel("Edit held follow-up").evaluate(el=>el===document.activeElement),true);
  await tray.getByLabel("Edit held follow-up").fill("Check the updated screenshot.");
  await tray.getByLabel("Edit held follow-up").press("Meta+Enter");
  await tray.getByText("Check the updated screenshot.",{exact:true}).waitFor();
  assert.equal(await tray.getByText("screenshot.png",{exact:true}).count(),1);
  await tray.getByRole("button",{name:"Pause queue",exact:true}).waitFor();
  assert.equal(await tray.getByLabel("Edit follow-up 2",{exact:true}).evaluate(el=>el===document.activeElement),true);
  await tray.getByLabel("Move follow-up 2 up",{exact:true}).click();
  await page.waitForFunction(()=>window.__lastQueueChange?.type==="move");
  await tray.locator("li").first().getByText("Check the updated screenshot.", {exact:true}).waitFor();
  await tray.getByLabel("Delete follow-up 2",{exact:true}).click();
  await tray.getByRole("button",{name:"2 held follow-ups",exact:true}).waitFor();
  await tray.getByRole("button",{name:"Pause queue",exact:true}).click();
  await tray.getByRole("button",{name:"Resume",exact:true}).click();
  await tray.getByRole("button",{name:"Pause queue",exact:true}).waitFor();
  const composer = page.locator("textarea[data-composer]:visible");
  await composer.fill("Send this immediately.");
  await composer.press("Meta+Enter");
  await page.waitForFunction(()=>window.__lastQueueChange?.type==="enqueue" && window.__lastQueueChange.sendNow===true);
  await page.close();
  }
  console.log("Held queue: light/dark layout at 1100/760px, collapse, edit, attachments, reorder, delete, pause/resume and Cmd+Enter passed.");
} finally { await browser?.close(); server.close(); }
