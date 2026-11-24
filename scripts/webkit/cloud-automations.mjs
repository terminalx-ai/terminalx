#!/usr/bin/env node
// Actual React dialog in WebKit; accepted contracts only, no provider/GitHub calls.
// Fixture-only availability exercises the editor; production availability is unchanged.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transformWithEsbuild } from "vite";
import { createCheckServer } from "./vite-page.mjs";
import { launch } from "./harness.mjs";
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { CloudSchedulesDialog } from '/src/components/cloud/CloudSchedulesDialog.tsx';
import { Toasts } from '/src/components/ui/Toasts.tsx';
import { api } from '/src/lib/api.ts';
import { bootAccount } from '/src/lib/account.ts';
import { refreshDataPrivacy } from '/src/lib/dataPrivacy.ts';
import '/src/styles/app.css';
const calls = window.automationCalls = [];
const params = new URLSearchParams(location.search);
const held = params.has('held');
const webhookEnabled = params.has('webhook');
const estimate = {currency:'USD',hourlyMicros:120000,perRunMaxMinutes:105,createPerRunMinutes:20,perRunMaxMicros:210000,monthlyRuns:720,monthlyMaxMicros:151200000,keepsMachineRunning:false,runningSlots:1,maxRunsPerDay:24};
let schedule = {id:'a1',workspaceId:'w1',name:'PR triage',createdBy:'u1',agent:'claude',mode:'acceptEdits',promptBytes:12,workspaceMode:'fresh',githubTrigger:{repositoryId:'row1',event:'opened',filters:[],allowForkPullRequests:false},schedule:null,missedRunPolicy:'skip',completionPolicy:'suspend',maxRunMinutes:60,state:'active',nextRunAt:null,estimate,lastRun:null};
api.accountStatus = async () => ({state:'signed-in',identity:{email:'fixture@example.test',name:'Fixture',organization:'Automation lab',organizationId:'o1'},context:{account:'fixture',scope:'profile',revision:'r1'},organizations:[{id:'o1',name:'Automation lab',role:'owner',isPersonal:false,cloud:{enabled:true,flags:{'organization.setup-flow.v1':webhookEnabled}}}],expiresAt:null,lastError:null});
api.phase2DesktopContractsAvailable = async () => !held;
api.cloudAutomations = async () => ({schedules:[schedule]});
api.cloudAutomation = async () => {
  calls.push({kind:'detail'});
  if (schedule.webhookTrigger) return {schedule,runs:[
    {id:'webhook-failed',scheduledFor:1,trigger:'webhook',state:'failed',category:'webhook-prompt-too-large'},
    {id:'manual-completed',scheduledFor:2,trigger:'manual',state:'completed'},
  ]};
  return ({schedule,runs:[{id:'pending',scheduledFor:1,trigger:'github',state:'creating-workspace',workspaceId:null},{id:'allocated',scheduledFor:2,trigger:'github',state:'completed',workspaceId:'run-own',archiveAt:3},{id:'archived',scheduledFor:3,trigger:'github',state:'completed',workspaceId:'run-archived',archivedAt:4}]});};
api.cloudWorkspaceRepositories = async () => ({configured:true,repositories:[{id:'row1',fullName:'acme/repo',state:'accessible'},{fullName:'acme/no-id',state:'accessible'}]});
api.cloudAutomationEstimate = async (input) => {calls.push({kind:'estimate',input});return {estimate,supported:true,nextRunAt:null};};
api.cloudAutomationCreate = async (input) => {
  calls.push({kind:'create',input});
  if (!input.webhookTrigger) return schedule;
  schedule = {...schedule,name:input.name,workspaceMode:'existing',githubTrigger:null,webhookTrigger:{url:'https://example.test/webhooks/'+ 'a'.repeat(72),secretUpdatedAt:null}};
  return {...schedule,webhookSecret:'create-'+'a'.repeat(72)};
};
api.cloudAutomationRotateWebhookSecret = async (id, orgId) => {
  calls.push({kind:'rotate',id,orgId});
  schedule = {...schedule,webhookTrigger:{...schedule.webhookTrigger,secretUpdatedAt:Date.now()}};
  return {...schedule,webhookSecret:'rotate-'+'b'.repeat(72)};
};
api.cloudAutomationSetActive = async (id,active) => {calls.push({kind:'active',id,active});return {...schedule,state:active?'active':'paused'};};
api.cloudScheduleDelete = async (id) => {calls.push({kind:'delete',id});};
api.cloudSchedulesPauseAll = async () => {calls.push({kind:'pause-all'});return {paused:1};};
await refreshDataPrivacy();await bootAccount();
createRoot(document.getElementById('root')).render(<><CloudSchedulesDialog orgId='o1' workspaceId='w1' name='Automation lab' onClose={()=>{}}/><Toasts /></>);
`;
const stub = readFileSync(new URL('./tauri-stub.js', import.meta.url), 'utf8');
const server = await createCheckServer({server:{host:'127.0.0.1' },plugins:[{
 resolveId(id){if(id==='/cloud-automation-regression.tsx')return '\0cloud-automation-regression.tsx';},
 async load(id){if(id==='\0cloud-automation-regression.tsx')return (await transformWithEsbuild(entry,'cloud-automation-regression.tsx',{loader:'tsx',jsx:'automatic'})).code;},
 configureServer(server){server.middlewares.use('/cloud-automation-test',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/cloud-automation-test','<div id="root"></div><script type="module" src="/cloud-automation-regression.tsx"></script>'));});}
}]});
let browser;
try {
 await server.listen();browser=await launch();
 for(const width of [1100,390,320]){
  const page=await browser.newPage({viewport:{width,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(`window.__PW_FIXTURE__={cloud:true};${stub}`);
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/cloud-automation-test`);
  const dialog=page.getByTestId('cloud-schedules-dialog');await dialog.waitFor();
  await dialog.getByText('PR triage',{exact:true}).waitFor();
  assert.equal(await dialog.getByText(/Next run/).count(),0,'GitHub has no fabricated timer');
  await dialog.getByRole('button',{name:'Show runs',exact:true}).click();
  await dialog.getByText('Run workspace not allocated.',{exact:true}).first().waitFor();
  assert.equal(await dialog.getByRole('button',{name:'Open run workspace',exact:true}).count(),2,'both allocated run workspaces, including archived, enable navigation');
  await dialog.getByText(/archival not observed/).waitFor();
  await dialog.getByTestId('automation-run-archived').getByText(/^Archived /).waitFor();
  assert.equal(await dialog.getByTestId('automation-run-archived').getByRole('button',{name:'Open run workspace',exact:true}).count(),1,'observed archival retains its own workspace link');
  await dialog.getByRole('button',{name:'New scheduled task',exact:true}).click();
  await dialog.getByLabel('Name',{exact:true}).fill('PR report');await dialog.getByLabel('Prompt',{exact:true}).fill('Review the change.');
  await dialog.getByLabel('Trigger',{exact:true}).selectOption('github');
  await dialog.getByLabel('GitHub repository',{exact:true}).selectOption('row1');
  const missingId = dialog.getByRole('option',{name:'acme/no-id (repository ID unavailable)',exact:true});
  assert(await missingId.evaluate(el=>el instanceof HTMLOptionElement && el.disabled && el.hasAttribute('disabled')), 'missing authoritative repository ID disables native option');
  await dialog.getByLabel('Workspace mode',{exact:true}).selectOption('fresh');
  await dialog.getByLabel('Archive after days',{exact:true}).fill('365');
  await dialog.getByLabel('Allow pull requests from forks',{exact:true}).check();
  await dialog.getByTestId('cloud-schedule-cost').getByText(/Creation is already included/).waitFor();
  for(let i=0;i<5;i++) {await dialog.getByRole('button',{name:'Add filter',exact:true}).click();await dialog.getByLabel('Filter '+(i+1)+' value',{exact:true}).fill('main');}
  assert(await dialog.getByRole('button',{name:'Add filter',exact:true}).isDisabled(),'five filters maximum');
  // Measure actual form and controls, not a fixture-specific replacement UI.
  assert(await dialog.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1&&el.scrollWidth<=el.clientWidth+1;}),width+'px dialog stays within viewport without horizontal overflow');
  await dialog.getByRole('checkbox',{name:/I understand this task starts/}).check();
  await dialog.getByRole('button',{name:'Create scheduled task',exact:true}).click();
  await page.waitForFunction(()=>window.automationCalls.some(c=>c.kind==='create'));
  const created=await page.evaluate(()=>window.automationCalls.find(c=>c.kind==='create').input);
  const githubTrigger={repositoryId:'row1',event:'opened',filters:Array.from({length:5},()=>({field:'label',operator:'is',value:'main'})),allowForkPullRequests:true};
  assert.deepEqual(created,{workspaceId:'w1',workspaceMode:'fresh',completionPolicy:'suspend',maxRunMinutes:60,githubTrigger,archiveAfterDays:365,archiveOnPrMerge:false,name:'PR report',prompt:'Review the change.',agent:'claude',mode:'acceptEdits',missedRunPolicy:'skip'},'exact accepted create payload');
  const quoted=await page.evaluate(()=>window.automationCalls.filter(c=>c.kind==='estimate').at(-1).input);
  assert.deepEqual(quoted,{workspaceId:'w1',workspaceMode:'fresh',completionPolicy:'suspend',maxRunMinutes:60,githubTrigger},'exact quote excludes all create-only fields');
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/cloud-automation-test?webhook`);
  await dialog.getByRole('button',{name:'New scheduled task',exact:true}).click();
  await dialog.getByLabel('Name',{exact:true}).fill('Webhook report');
  await dialog.getByLabel('Prompt',{exact:true}).fill('Report on {{payload.ref}}.');
  await dialog.getByLabel('Trigger',{exact:true}).selectOption('webhook');
  await dialog.getByText('{{payload.*}}',{exact:true}).waitFor();
  const checkLayout = async (panel, name) => {
    assert(await panel.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1&&el.scrollWidth<=el.clientWidth+1;}),width+'px '+name+' stays inside the viewport');
  };
  await checkLayout(dialog,'webhook editor');
  await dialog.getByRole('checkbox',{name:/I understand this task starts/}).check();
  await dialog.getByRole('button',{name:'Create scheduled task',exact:true}).click();
  const disclosure=page.getByTestId('webhook-secret');
  await disclosure.getByText(/^create-a{72}$/).waitFor();
  await checkLayout(disclosure,'create secret');
  await disclosure.getByRole('button',{name:'Done',exact:true}).click();
  assert.equal(await page.getByText(/^create-a{72}$/).count(),0,'closing removes the secret immediately');
  await dialog.getByRole('button',{name:'Show webhook details',exact:true}).click();
  const webhook=dialog.getByTestId('webhook-details');
  await webhook.getByText(/Authorization: Bearer \$TERMINALX_WEBHOOK_SECRET/).waitFor();
  await checkLayout(webhook,'webhook details');
  await checkLayout(dialog,'dialog with webhook details');
  await webhook.getByRole('button',{name:'Rotate secret',exact:true}).click();
  const confirm=page.getByTestId('webhook-rotate-confirm');
  await confirm.getByText('Rotate the webhook secret?',{exact:true}).waitFor();
  await checkLayout(confirm,'rotation confirmation');
  await confirm.getByRole('button',{name:'Rotate secret',exact:true}).click();
  await disclosure.getByText(/^rotate-b{72}$/).waitFor();
  await checkLayout(disclosure,'rotated secret');
  await disclosure.getByRole('button',{name:'Done',exact:true}).click();
  await webhook.getByText('New secret · just now',{exact:true}).waitFor();
  await page.getByText('Webhook secret rotated',{exact:true}).waitFor();
  assert.equal(await page.getByText(/^rotate-b{72}$/).count(),0,'closing removes the rotated secret immediately');
  await dialog.getByRole('button',{name:'Show runs',exact:true}).click();
  await dialog.getByTestId('automation-run-webhook-failed').getByText(/prompt exceeded 32 KiB.*· Webhook/).waitFor();
  await dialog.getByTestId('automation-run-manual-completed').getByText(/Completed · Manual/).waitFor();
  await checkLayout(dialog,'rotated state and run history');
  assert.deepEqual(errors,[]);await page.close();console.log('ok cloud-automations '+width+'px: real form, single trigger, filters, authoritative IDs, fresh quote, run states and webhook create/rotate');
 }
 const page=await browser.newPage({viewport:{width:390,height:800}});
 await page.addInitScript(`window.__PW_FIXTURE__={cloud:true};${stub}`);
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/cloud-automation-test?held`);
 const dialog=page.getByTestId('cloud-schedules-dialog');await dialog.getByText('PR triage',{exact:true}).waitFor();
 await dialog.getByRole('button',{name:'Pause',exact:true}).click();
 await page.waitForFunction(()=>window.automationCalls.some(c=>c.kind==='active'&&c.active===false));
 assert.equal(await page.evaluate(()=>window.automationCalls.filter(c=>c.kind==='estimate'||c.kind==='create').length),0,'held pause has no quote/create preflight');
 await dialog.getByRole('button',{name:'Delete PR triage',exact:true}).click();await dialog.getByTestId('cloud-schedule-delete-confirm').getByRole('button',{name:'Delete',exact:true}).click();
 await page.waitForFunction(()=>window.automationCalls.some(c=>c.kind==='delete'));
 assert.equal(await page.evaluate(()=>window.automationCalls.filter(c=>c.kind==='detail').length),0,'safety actions perform no detail preflight');
 await dialog.getByRole('button',{name:'New scheduled task',exact:true}).click();
 await dialog.getByLabel('Name',{exact:true}).fill('Held report');await dialog.getByLabel('Prompt',{exact:true}).fill('Review safely.');
 await dialog.getByRole('checkbox',{name:/I understand this task starts/}).check();
 assert(await dialog.getByRole('button',{name:'Create scheduled task',exact:true}).isEnabled(),'valid legacy form and spend consent permit create before switching mode');
 const priorEstimates=await page.evaluate(()=>window.automationCalls.filter(c=>c.kind==='estimate').length);
 await dialog.getByLabel('Workspace mode',{exact:true}).selectOption('fresh');
 // The quote debounce is 400ms: observe beyond two complete debounce windows.
 await page.waitForTimeout(1000);
 assert(await dialog.getByRole('button',{name:'Create scheduled task',exact:true}).isDisabled());
 assert.equal(await page.evaluate(()=>window.automationCalls.filter(c=>c.kind==='estimate').length),priorEstimates,'held fresh mode issues no estimate after debounce');
 assert.equal(await page.evaluate(()=>window.automationCalls.filter(c=>c.kind==='create').length),0,'advanced create stays held locally');
 console.log('ok cloud-automations held: pause/delete reachable without preflight, fresh create refused');await page.close();
} finally {await browser?.close();await server.close();}
