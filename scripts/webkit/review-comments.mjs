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
a.review_range={target:'main',base:'base',head:'head'};
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
 if(action.type==='reconcile') comments=comments.map(c=>({...c,outdated:c.outdated||(c.path===action.path&&action[c.side]?.split('\\n').slice(c.startLine-1,c.endLine).join('\\n')!==c.lineText)}));
 localStorage.setItem('review-fixture',JSON.stringify(comments)); return comments;
};
a.send_to_tab=()=>({queued:false,events:[]});
`;
try {
 const page = await open(browser, server.url, {cloud:false,localProjects:1,localSession:true}, {width:1500,height:1000}, {extra});
 page.on('pageerror', error=>errors.push(String(error)));
 await openConversation(page,'claude tab');
 await tab(page,'gemini tab').click();
 await page.getByRole('button',{name:'Changes',exact:true}).click();
 await page.getByRole('button',{name:/review.ts/}).click();
 for(const mode of ['Unified','Split']) {
   await page.getByRole('button',{name:mode,exact:true}).click();
   await page.getByRole('button',{name:'Comment on before line 2',exact:true}).click();
   await page.getByRole('button',{name:'Comment on before line 3',exact:true}).click({modifiers:['Shift']});
   await page.getByRole('textbox',{name:'Review comment',exact:true}).fill('Keep the old behavior '+mode);
   await page.getByRole('button',{name:'Save',exact:true}).click();
   const card = page.locator('.diff-pane article').filter({hasText:'Keep the old behavior '+mode});
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
   await page.locator('.diff-pane article').filter({hasText:'Please keep both lines '+mode}).waitFor();
   // A real pointer drag selects a range in CodeMirror's read-only document.
   const first = await page.locator('.diff-pane .cm-line').filter({hasText:/^new line$/}).boundingBox();
   const last = await page.locator('.diff-pane .cm-line').filter({hasText:/^new tail$/}).boundingBox();
   await page.mouse.move(first.x+2,first.y+first.height/2);
   await page.mouse.down();
   await page.mouse.move(last.x+65,last.y+last.height/2,{steps:8});
   await page.mouse.up();
   await page.getByRole('button',{name:'Comment on selection',exact:true}).click();
   await page.getByText('src/review.ts:2-3 (after)',{exact:true}).waitFor();
   await page.getByRole('button',{name:'Cancel',exact:true}).click();
 }
 await page.getByRole('button',{name:'Add all to chat (2)',exact:true}).click();
 const composer = page.locator('[data-composer]:visible');
 const draft = await composer.inputValue();
 assert.equal((draft.match(/src\/review.ts:2-3/g)||[]).length,2);
 assert.ok(draft.includes('> old line\n> old tail'));
 assert.ok(draft.includes('Please keep both lines Unified') && draft.includes('Please keep both lines Split'));
 await composer.fill(draft+'\nAlso run tests.');
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
 await page.evaluate(()=>{window.reviewAfter='one\nchanged line\nnew tail'; window.dispatchEvent(new Event('focus'));});
 await page.locator('.diff-pane article').filter({hasText:'Rename this line'}).getByText('Outdated',{exact:true}).waitFor();
 const output = process.env.REVIEW_SCREENSHOTS || '/tmp/pro230-ui/screenshots';
 await mkdir(output,{recursive:true});
 await page.screenshot({path:output+'/review-split.png'});
 // Reopen the page with persisted notes from the fixture, just like a store reload.
 await page.reload();
 await openConversation(page,'claude tab');
 await tab(page,'gemini tab').click();
 await page.getByRole('button',{name:'Changes',exact:true}).click();
 await page.getByText('3 review comments',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);
 console.log('PASS: unified/split range comments, inline layout, edit, batch draft, unsaved warning, outdated and reopen');
} finally { await browser.close(); server.close(); }
