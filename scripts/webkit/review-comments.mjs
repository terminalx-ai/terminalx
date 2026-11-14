#!/usr/bin/env node
// Run in the local macOS VM after pnpm build. Production React and CodeMirror,
// with only the native boundary replaced by the durable fixture below.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { webkit } from 'playwright';
import { open, openConversation, serve, tab } from './harness.mjs';

const server = await serve();
const browser = await webkit.launch({ headless: true });
const errors = [];
const extra = `
localStorage.setItem('raccoon.prefs', JSON.stringify({panelOpen:true, panelWidth:540}));
const a=window.__PW_STUB__.answers;
a.work_status={isRepo:true,dirty:true,branch:'review',ahead:0,behind:0};
window.reviewBase='a'.repeat(40); window.reviewHead='head';
a.review_range=()=>({target:'main',base:window.reviewBase,head:window.reviewHead});
a.changes_between=[{path:'src/review.ts',status:'modified',additions:2,deletions:2}];
a.unfinished_merge=null;
window.reviewAfter='one\\nnew line\\nnew tail';
a.file_contents_at=()=>({before:'one\\nold line\\nold tail',after:window.reviewAfter});
a.load_tab_events=()=>[];
a.review_comments=({action})=>{
 let comments=JSON.parse(localStorage.getItem('review-fixture')||'[]');
 if(action.type==='save') {
   if(action.expected) comments=comments.map(c=>c.id===action.expected.id?{...c,note:action.note,revision:c.revision+1,sent:false}:c);
   else comments.push({...action.anchor,id:String(Date.now()),revision:1,note:action.note,sent:false,outdated:false});
 }
 if(action.type==='delete') comments=comments.filter(c=>c.id!==action.expected.id);
 if(action.type==='sent') comments=comments.map(c=>({...c,sent:c.sent||action.comments.some(e=>e.id===c.id&&e.revision===c.revision)}));
 if(action.type==='reconcile') comments=comments.map(c=>{
   if(c.base!==action.base||c.path!==action.path) return c;
   const lines=action[c.side]?.split('\\n')||[], quote=c.lineText.split('\\n');
   const found=lines.findIndex((_,i)=>quote.every((line,n)=>lines[i+n]===line));
   return {...c,outdated:found<0,startLine:found<0?c.startLine:found+1,endLine:found<0?c.endLine:found+quote.length};
 });
 localStorage.setItem('review-fixture',JSON.stringify(comments)); return comments;
};
a.send_to_tab=()=>({queued:false,events:[]});
`;
try {
 const page = await open(browser, server.url, {cloud:false,localProjects:1,localSession:true}, {width:1500,height:1000}, {extra});
 page.on('pageerror', error=>errors.push(String(error)));
 await openConversation(page,'claude tab');
 await tab(page,'gemini tab').click();
 await page.getByRole('button',{name:'Branch',exact:true}).click();
 await page.getByRole('tab',{name:'Changes',exact:true}).click();
 await page.getByRole('button',{name:/^Modified review\.ts/}).click();
 const centre=page.getByRole('tabpanel',{name:'review.ts · All changes',exact:true});
 for(const mode of ['Unified','Split']) {
   await centre.getByRole('button',{name:mode,exact:true}).click();
   await page.getByRole('button',{name:'Comment on before line 2',exact:true}).click();
   await page.getByRole('button',{name:'Comment on before line 3',exact:true}).click({modifiers:['Shift']});
   await page.getByRole('textbox',{name:'Review comment',exact:true}).fill('Keep the old behavior '+mode);
   await page.getByRole('button',{name:'Save',exact:true}).click();
   const card = centre.locator('.diff-pane article').filter({hasText:'Keep the old behavior '+mode});
   await card.waitFor();
   const rect = await card.boundingBox();
   assert.ok(rect.width>100 && rect.height>50, 'inline note has usable dimensions');
   const fits = await card.evaluate(el => {
     const pane = el.closest('.cm-editor').getBoundingClientRect();
     return [...el.querySelectorAll('button')].every(button => {
       const r = button.getBoundingClientRect();
       return r.left >= pane.left && r.right <= pane.right + 1;
     });
   });
   assert.ok(fits, `${mode}: every inline comment action fits the column`);
   await card.getByRole('button',{name:'Edit',exact:true}).click();
   await page.getByRole('textbox',{name:'Review comment',exact:true}).fill('Please keep both lines '+mode);
   await page.getByRole('button',{name:'Save',exact:true}).click();
   await centre.locator('.diff-pane article').filter({hasText:'Please keep both lines '+mode}).waitFor();
   // A real pointer drag selects a range in CodeMirror's read-only document.
   const first = await centre.locator('.diff-pane .cm-line').filter({hasText:/^new line$/}).boundingBox();
   const last = await centre.locator('.diff-pane .cm-line').filter({hasText:/^new tail$/}).boundingBox();
   await page.mouse.move(first.x+2,first.y+first.height/2);
   await page.mouse.down();
   await page.mouse.move(last.x+65,last.y+last.height/2,{steps:8});
   await page.mouse.up();
   await page.getByRole('button',{name:'Comment on selection',exact:true}).click();
   await page.getByText('src/review.ts:2-3 (after)',{exact:true}).waitFor();
   await page.getByRole('button',{name:'Cancel',exact:true}).click();
   const content=centre.locator('.cm-content').last();
   await content.focus();
   await content.press('Meta+Shift+m');
   await page.getByRole('textbox',{name:'Review comment',exact:true}).waitFor();
   await page.getByRole('textbox',{name:'Review comment',exact:true}).press('Escape');
   await page.waitForFunction(()=>document.activeElement?.classList.contains('cm-content'));
 }

 await centre.getByRole('button',{name:'Add all to chat (2)',exact:true}).click();
 const composer = page.locator('[data-composer]:visible');
 const draft = await composer.inputValue();
 assert.equal((draft.match(/src\/review.ts:2-3/g)||[]).length,2);
 assert.ok(draft.includes('> old line\n> old tail'));
 assert.ok(draft.includes('Please keep both lines Unified') && draft.includes('Please keep both lines Split'));
 await composer.fill(draft+'\nAlso run tests.');
 await page.getByRole('tab',{name:'review.ts · All changes',exact:true}).click();
 // Cancel must retain the dirty editor when the warning is declined.
 await page.getByRole('button',{name:'Comment on after line 2',exact:true}).click();
 await page.getByRole('textbox',{name:'Review comment',exact:true}).fill('Unsaved note');
 page.once('dialog',dialog=>dialog.dismiss());
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 assert.equal(await page.getByRole('textbox',{name:'Review comment',exact:true}).inputValue(),'Unsaved note');
 page.once('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByRole('button',{name:'Comment on after line 2',exact:true}).click();
 await page.getByRole('textbox',{name:'Review comment',exact:true}).fill('Rename this line');
 await page.getByRole('button',{name:'Save',exact:true}).click();
 // Insert above the anchor, then reload the existing centre comparison.
 await page.evaluate(()=>{window.reviewAfter='inserted\none\nnew line\nnew tail'; window.reviewHead='shifted';});
 await centre.getByRole('button',{name:'Refresh diff',exact:true}).click();
 const relocated=centre.locator('.diff-pane article').filter({hasText:'Rename this line'});
 await relocated.getByText('src/review.ts:3-4 (after)',{exact:true}).waitFor();
 assert.equal(await relocated.getByText('Outdated',{exact:true}).count(),0);
 // Its quotation disappears: retain it in the inventory, with no unrelated inline card.
 await page.evaluate(()=>{window.reviewAfter='inserted\none\nchanged line\nnew tail'; window.reviewHead='changed'; window.dispatchEvent(new Event('focus'));});
 await centre.getByRole('button',{name:'Refresh diff',exact:true}).click();
 await centre.getByText('All review comments',{exact:true}).click();
 await centre.locator('details article').filter({hasText:'Rename this line'}).getByText('Outdated',{exact:true}).waitFor();
 assert.equal(await centre.locator('.diff-pane article').filter({hasText:'Rename this line'}).count(),0);
 await centre.getByText('All review comments',{exact:true}).click();
 // Same text in a comparison with a different base must never inherit cards.
 await page.evaluate(()=>{window.reviewBase='b'.repeat(40); window.reviewHead='other-base';});
 await centre.getByRole('button',{name:'Refresh diff',exact:true}).click();
 await centre.getByRole('button',{name:'Copy file',exact:true}).waitFor();
 assert.equal(await centre.locator('.diff-pane article').count(),0);

 const output = process.env.REVIEW_SCREENSHOTS || '/tmp/pro230-ui/screenshots';
 await mkdir(output,{recursive:true});
 await page.screenshot({path:output+'/review-split.png'});
 // Reopen the page with persisted notes from the fixture, just like a store reload.
 await page.reload();
 await openConversation(page,'claude tab');
 await tab(page,'gemini tab').click();
 await page.getByRole('button',{name:'Branch',exact:true}).click();
 await page.getByRole('tab',{name:'Changes',exact:true}).click();
 await page.getByText('3 review comments',{exact:true}).filter({visible:true}).waitFor();
 assert.deepEqual(errors,[]);
 console.log('PASS: unified/split range comments, inline layout, edit, batch draft, unsaved warning, relocation, base isolation, outdated inventory and reopen');
} finally { await browser.close(); server.close(); }
