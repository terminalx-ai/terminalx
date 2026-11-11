#!/usr/bin/env node
// Run after pnpm build. Covers a secret host dialog and a scoped guest screen.
// The host opens the session from its conversation row (the chat-first sidebar,
// #484); the Share button is in the session's header.
import { launch, open, openConversation, report, serve } from "./harness.mjs";

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  const host = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true, localSharing: "host" }, { width: 1280, height: 760 });
  await openConversation(host, "claude tab");
  await host.getByRole("button", { name: "Share session…" }).click();
  // A first-time host sees the introduction before the link settings (#852).
  await host.getByTestId("share-intro").waitFor();
  failed += report("sharing introduction", {
    "the risk notice is visible": await host.getByTestId("share-terms").getByText("A driver can act", { exact: true }).isVisible()
      && await host.getByTestId("share-terms").getByText(/can have the agent change files and run commands on this computer/).isVisible(),
  });
  await host.getByRole("button", { name: "Continue", exact: true }).click();
  await host.getByRole("button", { name: "More settings", exact: true }).click();
  failed += report("host sharing settings", {
    "approval is an explicit unchecked grant": await host.getByRole("switch", { name: "Guests may approve permissions" }).getAttribute("aria-checked") === "false",
  });
  await host.getByRole("button", { name: "Create share link" }).click();
  await host.getByLabel("Secret share link").waitFor();
  failed += report("host sharing", {
    "the link stays concealed": await host.getByLabel("Secret share link").getAttribute("type") === "password",
  });
  await host.screenshot({ path: "/tmp/terminalx-sharing-host.png" });
  await host.close();

  const guest = await open(browser, server.url, { cloud: false, localProjects: 0, localSharing: "guest" }, { width: 1280, height: 760 });
  await guest.getByRole("heading", { name: "Shared local session" }).waitFor();
  await guest.waitForFunction(() => window.__PW_SHARE_CALLS__.some((request) => request.method === "session.tail"));
  await guest.screenshot({ path: "/tmp/terminalx-sharing-guest-debug.png" });
  await guest.getByText("Run the tests", { exact: false }).waitFor();
  await guest.getByLabel("Prompt to agent").fill("Check the build");
  await guest.getByRole("button", { name: "Send", exact: true }).click();
  await guest.waitForFunction(() => window.__PW_SHARE_CALLS__.some((request) => request.method === "session.send"));
  failed += report("guest sharing", {
    "the transcript names the verified sender": await guest.locator('[data-user-id="guest"]').isVisible(),
    "all RPCs stay bound to the invitation": await guest.evaluate(() => window.__PW_SHARE_CALLS__.every((request) => request.params.sessionId === "invited-session")),
  });
  await guest.evaluate(() => window.__PW_SHARE_VIEWER__());
  await guest.waitForFunction(() => document.querySelector('[aria-label="Prompt to agent"]').disabled);
  failed += report("live demotion", {
    "the agent composer is disabled": await guest.getByLabel("Prompt to agent").isDisabled(),
    "notes remain available": await guest.getByLabel("Note to people").isEnabled(),
  });
  await guest.screenshot({ path: "/tmp/terminalx-sharing-guest.png" });
  await guest.close();
} finally {
  await browser.close();
  server.close();
}
process.exitCode = failed ? 1 : 0;
