#!/usr/bin/env node
// Real WebKit layout and interactions against the production Markdown renderer.
// pnpm build && node scripts/webkit/chat-controls.mjs
// On a disposable macOS guest: WEBKIT_CONTROLS_HEADED=1 WEBKIT_LAYOUT_SCREENSHOTS=/tmp/tx624/screenshots ...
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { webkit } from 'playwright';
import { open, openConversation, serve, tab } from './harness.mjs';

const table = '| Item | Current status |\n| --- | --- |\n| [Example task](https://example.com/task) | **Active:** checking a long description that should wrap within its cell. |\n| Another example with a longer title | Waiting for validation and a follow-up review. |\n| Completed task | **Done:** all example checks passed. |';
const rows = [
 ['Item', 'Current status'],
 ['Example task', 'Active: checking a long description that should wrap within its cell.'],
 ['Another example with a longer title', 'Waiting for validation and a follow-up review.'],
 ['Completed task', 'Done: all example checks passed.'],
];
const csv = rows.map(row => row.join(',')).join('\n');
const markdown = [rows[0], ['---', '---'], ...rows.slice(1)].map(row => `| ${row.join(' | ')} |`).join('\n');
const code = 'const value = "' + 'unbroken'.repeat(100) + '";';
const linkedCode = 'const url = "https://example.com/task";';
const wide = [Array.from({length:24}, (_,i) => `Column ${i}`), Array(24).fill('---'), ...Array.from({length:80}, (_,i) => Array(24).fill(`row ${i}`))].map(row => `| ${row.join(' | ')} |`).join('\n');
const text = `${table}\n\n\`\`\`js\n${code}\n\`\`\`\n\n\`\`\`js\n${linkedCode}\n\`\`\`\n\n${wide}`;
const clipboard = process.env.WEBKIT_CONTROLS_CLIPBOARD === '1';
if (clipboard) assert.equal(process.platform,'darwin');
const paste = () => execFileSync('/usr/bin/pbpaste',{encoding:'utf8',env:{...process.env,LANG:'en_US.UTF-8',LC_ALL:'en_US.UTF-8'}});
const screenshots = process.env.WEBKIT_LAYOUT_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, {recursive:true});
const server = await serve();
let browser;
async function menuGeometry(page, trigger, label, keyboard=false) {
 await trigger.scrollIntoViewIfNeeded();

 if (keyboard) { await trigger.focus(); await page.keyboard.press('Enter'); } else await trigger.click();
 const menu = page.getByRole('menu');
 await menu.waitFor();
 const result = await menu.evaluate(el => {
  const box = el.getBoundingClientRect();
  return {rect:box.toJSON(),zoom:getComputedStyle(document.documentElement).zoom,width:box.width, inside:box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1,
   items:[...el.querySelectorAll('[role="menuitem"]')].map(item => {
    const r=item.getBoundingClientRect(); const range=document.createRange(); range.selectNodeContents(item);
    return {width:r.width,height:r.height,lines:range.getClientRects().length,hit:item.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};
   })};
 });
 assert.ok(result.width >= 120 && result.inside, `${label}: menu geometry ${JSON.stringify(result)}`);
 assert.ok(result.items.every(i => i.width >= 110 && i.height >= 24 && i.lines === 1 && i.hit), `${label}: readable clickable rows ${JSON.stringify(result)}`);
 const anchor = await trigger.boundingBox(); const box = await menu.boundingBox();
 assert.ok(Math.abs(box.x + box.width - anchor.x - anchor.width) < 12 || Math.abs(box.x - anchor.x) < 12, `${label}: menu anchored`);
 return menu;
}
async function download(page, trigger, format, expected) {
 await trigger.click();
 const pending = page.waitForEvent('download');
 await page.getByRole('menuitem', {name:format,exact:true}).click();
 const file = await pending;
 assert.equal(await readFile(await file.path(), 'utf8'), expected, `${format} exact bytes`);
}
try {
 browser = await webkit.launch({ headless: !process.env.WEBKIT_CONTROLS_HEADED });
 for (const floating of [false,true]) {
  const extra = `localStorage.setItem("raccoon.prefs", JSON.stringify({linkBrowser:"system",linkBrowserChosen:true})); window.__PW_STUB__.answers.load_tab_events = ({tabId}) => [{id:'controls',seq:1,sessionId:'local-s1',tabId,harness:'claude',ts:'2026-10-24T00:00:00Z',payload:{type:'assistant_text',text:${JSON.stringify(text)}}}];
   window.__copies = []; const nativeClipboard = navigator.clipboard;
   Object.defineProperty(navigator, 'clipboard', {value:{write:async items => { if (${clipboard}) await nativeClipboard.write(items); window.__copies.push(await (await items[0].getType('text/plain')).text()); },writeText:async text=>{if (${clipboard}) await nativeClipboard.writeText(text); window.__copies.push(text);}}});`;
  const page = await open(browser, server.url, {cloud:false,localProjects:1,localSession:true,floating}, {width:1100,height:800}, {extra});
  if (!floating) { await openConversation(page,'claude tab'); await tab(page,'gemini tab').click(); }
  const chat = page.locator('[data-chat-scroller]:visible');
  const wrapper = chat.locator('[data-streamdown="table-wrapper"]').first();
  await wrapper.waitFor();
  await page.evaluate(() => document.fonts.ready);
  // Wait for initial transcript follow-to-bottom before scrolling as a reader.
  await page.waitForFunction(() => [...document.querySelectorAll('[data-chat-scroller]')].some(el=>el.clientWidth>0 && el.scrollTop>0));
  await chat.hover();
  await chat.dispatchEvent('wheel', {deltaY:-100});
  await chat.evaluate(el => { el.scrollTop=0; });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-chat-scroller]')].some(el=>el.clientWidth>0 && el.scrollTop===0));
  for (const [width,zoom,panel=false] of (floating ? [[1100,1],[360,1],[640,1.5]] : [[1100,1],[1100,1,true],[760,1],[760,1.5]])) {
   const label = `${floating?'floating':'main'}-${width}-${zoom}${panel?'-panel':''}`;
   if (panel) await page.getByRole('button',{name:'Toggle panel',exact:true}).click();
   await page.setViewportSize({width,height:800});
   await page.evaluate(zoom => {document.documentElement.style.zoom=String(zoom);},zoom);
   const dl = wrapper.getByRole('button',{name:'Download table',exact:true});
   const expand = wrapper.getByRole('button',{name:'View fullscreen',exact:true});
   for (let cycle=0;cycle<2;cycle++) {
    await menuGeometry(page,dl,label,cycle===1);
    if (screenshots && cycle===0) await page.screenshot({path:`${screenshots}/${label}-menu.png`});
    // The menu is non-modal: opening the viewer directly must dismiss it.
    if (cycle===1) { await page.keyboard.press('Escape'); assert.ok(await dl.evaluate(el=>el===document.activeElement)); }
    await expand.click();
    const viewer = page.getByRole('dialog',{name:'Table fullscreen'});
    await viewer.waitFor();
    assert.equal(await page.getByRole('menu').count(),0,`${label}: inline menu dismissed`);
    const bounds = await viewer.evaluate(el=> {
     const r=el.getBoundingClientRect();
     return {x:r.x,y:r.y,width:r.width,height:r.height,viewport:[innerWidth,innerHeight],focus:el.contains(document.activeElement),covers:[[4,100],[innerWidth/2,innerHeight/2],[innerWidth-4,innerHeight-4]].every(([x,y])=>el.contains(document.elementFromPoint(x,y)))};
    });
    assert.ok(Math.abs(bounds.x)<1 && Math.abs(bounds.y)<1 && Math.abs(bounds.width-bounds.viewport[0])<2 && Math.abs(bounds.height-bounds.viewport[1])<2 && bounds.focus && bounds.covers,`${label}: fullscreen covers viewport ${JSON.stringify(bounds)}`);
    assert.equal(await viewer.locator('table').innerText(),await wrapper.locator('table').innerText());
    assert.equal(await viewer.getByRole('link',{name:'Example task'}).getAttribute('href'),await wrapper.locator('a').first().getAttribute('href'));
    await viewer.getByRole('link',{name:'Example task'}).click();
    await menuGeometry(page,viewer.getByRole('button',{name:'Download table'}),label+' fullscreen');
    await page.keyboard.press('Escape');
    assert.ok(await viewer.isVisible(),`${label}: Escape closes menu first`);
    for (let i=0;i<8;i++) {await page.keyboard.press('Tab');assert.ok(await viewer.evaluate(el=>el.contains(document.activeElement)),`${label}: focus trapped`);}
    if (screenshots && cycle===0) await page.screenshot({path:`${screenshots}/${label}-fullscreen.png`});
    if (cycle===0) await viewer.getByRole('button',{name:'Exit fullscreen'}).click(); else await page.keyboard.press('Escape');
    await viewer.waitFor({state:'detached'});
    assert.ok(await expand.evaluate(el=>el===document.activeElement),`${label}: focus restored`);
   }
   assert.ok(await wrapper.locator('table').evaluate(table => [...table.querySelectorAll('th,td')].every(cell => {
    const box=cell.getBoundingClientRect(); const range=document.createRange(); range.selectNodeContents(cell);
    return [...range.getClientRects()].every(r=>r.left>=box.left-1 && r.right<=box.right+1);
   })),`${label}: cell text and links stay inside their cells`);
   await download(page,dl,'CSV',csv);
   await download(page,dl,'Markdown',markdown);
   await wrapper.getByRole('button',{name:'Copy table',exact:true}).click();
   await page.getByRole('menuitem',{name:'Markdown',exact:true}).click();
   await page.waitForFunction(expected=>window.__copies.at(-1)===expected,markdown);
   if (clipboard) assert.equal(paste(),markdown);
   // Stress both axes; reaching the last cell must leave the toolbar accessible.
   const stress = chat.locator('[data-streamdown="table-wrapper"]').last();
   await stress.getByRole('button',{name:'View fullscreen'}).click();
   const viewer = page.getByRole('dialog',{name:'Table fullscreen'});
   await download(page,viewer.getByRole('button',{name:'Download table'}),'CSV',wide.split('\n').filter((_,i)=>i!==1).map(row=>row.slice(2,-2).split(' | ').join(',')).join('\n'));
   const scroll = viewer.getByRole('region',{name:'Table content'});
   const scrollResult = await scroll.evaluate(el=> {el.scrollTop=el.scrollHeight;el.scrollLeft=el.scrollWidth;return {y:el.scrollTop,x:el.scrollLeft};});
   assert.ok(scrollResult.y>0,`${label}: long table scrolls`);
   if (width/zoom<=640) assert.ok(scrollResult.x>0,`${label}: wide table scrolls`);
   await viewer.getByRole('button',{name:'Exit fullscreen'}).click();
   for (const expected of [code,linkedCode]) {
    const block = chat.locator('[data-streamdown="code-block"]').filter({hasText:expected});
    await block.scrollIntoViewIfNeeded();
    if (expected===code) assert.ok(await block.evaluate(el=>[...el.querySelectorAll('*')].some(child=>child.scrollWidth>child.clientWidth && getComputedStyle(child).overflowX==='auto')),`${label}: code scrolls horizontally`);
    const pending = page.waitForEvent('download');
    await block.getByRole('button',{name:/Download/}).click();
    const file=await pending;
    assert.equal(await readFile(await file.path(),'utf8'),expected+'\n');
    const copy = block.getByRole('button',{name:/Copy/});
    const icon = await copy.locator('svg').innerHTML();
    await copy.click();
    await page.waitForFunction(expected=>window.__copies.at(-1)===expected+'\n',expected);
    if (clipboard) assert.equal(paste(),expected+'\n');
    await page.waitForFunction(({expected,icon})=> [...document.querySelectorAll('[data-streamdown="code-block"]')].filter(el=>el.textContent.includes(expected)).every(el=>el.querySelector('[data-streamdown="code-block-copy-button"] svg')?.innerHTML===icon),{expected,icon});
    assert.ok(await block.evaluate(el=>{const b=el.getBoundingClientRect();return [...el.querySelectorAll('button')].every(button=>{const r=button.getBoundingClientRect();return r.width>=20 && r.height>=20 && r.top>=b.top && r.bottom<=b.bottom && r.right<=b.right && button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));});}),`${label}: code controls visible and clickable`);
   }
   assert.ok(await chat.evaluate(el=>el.scrollWidth-el.clientWidth<=1),`${label}: conversation does not overflow`);
   if (panel) await page.getByRole('button',{name:'Toggle panel',exact:true}).click();
   console.log(`ok ${label}: menus, fullscreen cycles/focus/scroll, table and code exports`);
  }
  await page.close();
 }
} finally {await browser?.close();server.close();}
