#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { transformWithEsbuild } from "vite";
import { launch, report } from "./harness.mjs";
import { createCheckServer } from "./vite-page.mjs";

const entry = `
import { createRoot } from "react-dom/client";
import { NotSharedNotice } from "/src/components/cloud/CloudCollab.tsx";
import { bootAccount } from "/src/lib/account.ts";
import { bootCloudCatalog, refreshCloudCatalog } from "/src/lib/cloudCatalog.ts";
import { refreshDataPrivacy } from "/src/lib/dataPrivacy.ts";
import "/src/styles/app.css";

const orgId = "org-a";
const workspaceId = "project-access";
const profile = { state: "signed-in", identity: { name: "You", email: "you@example.test", organization: "Acme", organizationId: orgId },
  context: { scope: "scope", revision: "scope:1", account: "account" }, expiresAt: null, lastError: null,
  organizations: [{ id: orgId, name: "Acme", isPersonal: false, role: "member", cloud: { enabled: true, flags: {} } }],
  phase2Readiness: window.__TEST_READY__ ? { [orgId]: ["cloud.workspaces.access-request-copy.v1"] } : {},
};
const workspace = { id: workspaceId, orgId, name: "A very long project name for an organization workspace whose access is requested from a narrow session",
  provider: "local-docker", state: "ready", accessMode: "organization", createdAt: 1, updatedAt: 1, releaseDisposition: null,
  createdBy: "creator", creator: { userId: "creator", displayName: "Aisha", photoUrl: null }, you: { role: "none", canApprove: false } };
Object.assign(window.__PW_STUB__.answers, {
  account_status: profile,
  account_refresh_roles: { status: profile, fresh: true },
  cloud_catalog_load: null,
  data_privacy_status: { enabled: false, managed: false },
  cloud_workspaces: { workspaces: [{ workspace, latestOperation: null }] },
  copy_text: ({ text }) => { window.__COPIED__ = text; },
});
await refreshDataPrivacy();
await bootAccount();
bootCloudCatalog();
await refreshCloudCatalog(orgId);
createRoot(document.querySelector("#root")).render(<div className="flex h-screen min-h-0"><NotSharedNotice requestTarget={{orgId, workspaceId}} onBack={() => {}} /></div>);
`;

const server = await createCheckServer({
  server: { host: "127.0.0.1" },
  plugins: [{
    resolveId(id) { if (id === "/access-request-check.tsx") return "\0access-request-check.tsx"; },
    async load(id) {
      if (id === "\0access-request-check.tsx") return (await transformWithEsbuild(entry, "access-request-check.tsx", { loader: "tsx", jsx: "automatic" })).code;
    },
    configureServer(vite) {
      vite.middlewares.use("/access-request-fixture", async (_request, response) => {
        response.setHeader("Content-Type", "text/html");
        response.end(await vite.transformIndexHtml("/access-request-fixture", '<div id="root"></div><script type="module" src="/access-request-check.tsx"></script>'));
      });
    },
  }],
});
let browser;
let failed = 0;
try {
  await server.listen();
  browser = await launch();
  const stub = await readFile(new URL("./tauri-stub.js", import.meta.url), "utf8");
  for (const ready of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 420, height: 520 } });
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => console.error(error.message));
    await page.addInitScript(`window.__TEST_READY__ = ${ready};\n${stub}`);
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/access-request-fixture`);
    const pane = page.getByTestId("cloud-not-shared");
    await pane.waitFor();
    if (ready) {
      await pane.getByRole("button", { name: "Request access" }).click();
      await pane.getByRole("button", { name: "Copied" }).waitFor();
      const field = pane.getByRole("textbox", { name: "Prepared access request" });
      const box = await field.boundingBox();
      failed += report("cloud access request", {
        "the exact prepared text was copied": await field.inputValue() === await page.evaluate(() => window.__COPIED__),
        "the long prepared message fits a narrow pane": !!box && box.x >= 0 && box.x + box.width <= 420
          && await pane.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      });
    } else {
      failed += report("cloud access request held", {
        "the original lock pane is shown": await pane.getByRole("button", { name: "Back", exact: true }).count() === 1
          && await pane.getByRole("button", { name: "Request access" }).count() === 0,
      });
    }
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
if (failed) process.exitCode = 1;
