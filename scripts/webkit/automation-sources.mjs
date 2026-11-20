#!/usr/bin/env node
// The local automation editor's trigger picker and the Linear issue and GitHub
// pull request fields (PRO-485), in WebKit at a wide and two narrow widths:
// nothing overflows the editor sideways and no two fields overlap.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, transformWithEsbuild } from "vite";
import { launch } from "./harness.mjs";

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AutomationEditor } from '/src/components/automations/AutomationEditor.tsx';
import { bootSessions } from '/src/lib/sessions.ts';
import '/src/styles/app.css';
// The editor starts on the first project, so the store has its projects first.
await Promise.race([bootSessions().catch(() => {}), new Promise((done) => setTimeout(done, 3000))]);
createRoot(document.getElementById('root')).render(<div style={{height:'100vh'}}><AutomationEditor open automation={null} onOpenChange={()=>{}} onSaved={()=>{}}/></div>);
`;
const fixture = `
const a = window.__PW_STUB__.answers;
a.linear_teams = [{id:'team-1',key:'ENG',name:'Engineering with a fairly long team name'},{id:'team-2',key:'OPS',name:'Ops'}];
a.issue_options = {provider:'linear',states:[{id:'s1',name:'In Review',type:'started',color:'',position:1}],closeReasons:[],members:[{id:'u1',name:'Sam'}],labels:[],priorities:[],capabilities:{}};
a.github_repo = 'acme/widgets';
a.automation_source_preview = ({source}) => source.kind === 'linearIssue'
  ? [{id:'u1',identifier:'ENG-1042',title:'Login times out after the session cookie expires on a slow network',url:'https://linear.app/x/ENG-1042',detail:'In Progress'}]
  : [{id:'12',identifier:'#12',title:'Cache the repository list between refreshes so the sidebar stops flickering',url:'https://github.com/acme/widgets/pull/12',detail:'feature/cache-repository-list → main · draft'}];
`;
const stub = readFileSync(new URL("./tauri-stub.js", import.meta.url), "utf8");
const server = await createServer({ server: { host: "127.0.0.1", port: 0 }, plugins: [{
  name: "automation-sources-regression",
  resolveId(id) { if (id === "/automation-sources-regression.tsx") return "\0automation-sources-regression.tsx"; },
  async load(id) { if (id === "\0automation-sources-regression.tsx") return (await transformWithEsbuild(entry, "automation-sources-regression.tsx", { loader: "tsx", jsx: "automatic" })).code; },
  configureServer(server) { server.middlewares.use("/automation-sources-test", async (_req, res) => { res.setHeader("Content-Type", "text/html"); res.end(await server.transformIndexHtml("/automation-sources-test", '<div id="root"></div><script type="module" src="/automation-sources-regression.tsx"></script>')); }); },
}] });

/** Sideways overflow of the editor, and pairs of fields drawn over each other. */
const measure = () => {
  const scroller = document.querySelector(".automation-workspace .overflow-y-auto");
  const grid = document.querySelector(".automation-editor-grid");
  const fields = [...grid.children].filter((el) => el.getBoundingClientRect().height > 0);
  const overlaps = [];
  for (let i = 0; i < fields.length; i++) for (let j = i + 1; j < fields.length; j++) {
    const a = fields[i].getBoundingClientRect(), b = fields[j].getBoundingClientRect();
    if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps.push(`${fields[i].textContent.slice(0, 30)} / ${fields[j].textContent.slice(0, 30)}`);
  }
  const picker = [...document.querySelectorAll('[aria-label="Automation trigger"]')].map((el) => el.getBoundingClientRect()).find((rect) => rect.width > 0);
  const wide = [...grid.querySelectorAll("*")].filter((el) => el.getBoundingClientRect().right > grid.getBoundingClientRect().right + 1).map((el) => el.tagName + ":" + el.textContent.slice(0, 30));
  return { sideways: scroller.scrollWidth > scroller.clientWidth + 1, overlaps, pickerInside: !!picker && picker.right <= innerWidth + 1, wide: wide.slice(0, 5) };
};

let browser;
try {
  await server.listen();
  browser = await launch();
  for (const width of [1100, 600, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(`window.__PW_FIXTURE__={cloud:false,localProjects:1};${stub};${fixture}`);
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/automation-sources-test`);
    await page.getByRole("heading", { name: "New automation" }).waitFor();

    // Wide editors show the choices side by side; narrow ones a list.
    const pick = async (name) => {
      const radio = page.getByRole("radio", { name, exact: true });
      if (await radio.isVisible()) return radio.click();
      await page.getByRole("combobox", { name: "Automation trigger", exact: true }).selectOption({ label: name });
    };
    await pick("Linear issue");
    await page.getByText("ENG-1042", { exact: true }).waitFor();
    await page.getByText("1 matching issue now").waitFor();
    let layout = await page.evaluate(measure);
    assert.deepEqual(layout, { sideways: false, overlaps: [], pickerInside: true, wide: [] }, `${width}px Linear issue fields fit`);

    await pick("GitHub pull request");
    await page.getByText("#12", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("Repository", { exact: true }).inputValue(), "acme/widgets", "the repository fills in from the project");
    layout = await page.evaluate(measure);
    assert.deepEqual(layout, { sideways: false, overlaps: [], pickerInside: true, wide: [] }, `${width}px pull request fields fit`);

    assert.deepEqual(errors, []);
    await page.close();
    console.log(`ok automation-sources ${width}px: four triggers, Linear and pull request fields and their previews fit`);
  }
} finally {
  await browser?.close();
  await server.close();
}
