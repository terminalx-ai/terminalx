import { expect, it } from "vitest";
import { cloudBrowserAskDetail, isCloudBrowserAsk, parseDesktopAgent } from "./cloudBrowser";

it("reads desktop.agent and ignores anything malformed", () => {
  expect(parseDesktopAgent({ event: "desktop.agent", params: { browser: "on", driving: { agent: "Claude Code", tabTitle: "Push org events", action: "Clicking “Sign in”", actions: 6, held: false } } } as any))
    .toEqual({ browser: "on", driving: { agent: "Claude Code", tabTitle: "Push org events", action: "Clicking “Sign in”", actions: 6, held: false } });
  expect(parseDesktopAgent({ event: "desktop.agent", params: { browser: "packages-missing", driving: null } } as any)).toEqual({ browser: "packages-missing", driving: null });
  for (const params of [{ browser: "maybe", driving: null }, { browser: "on", driving: { agent: "" } }, { browser: "on", driving: "x" }]) {
    expect(parseDesktopAgent({ event: "desktop.agent", params } as any)).toBeNull();
  }
  expect(parseDesktopAgent({ event: "desktop.available", params: {} } as any)).toBeNull();
});

it("knows the browser session's card and what it asks", () => {
  expect(isCloudBrowserAsk({ toolName: "mcp__cloud_browser__open" })).toBe(true);
  expect(isCloudBrowserAsk({ toolName: "mcp__cloud_browser__click" })).toBe(false);
  expect(cloudBrowserAskDetail({ input: { url: "http://localhost:3000", plan: " Sign in ", agent: "Codex" } })).toEqual({ url: "http://localhost:3000", plan: "Sign in", agent: "Codex" });
  expect(cloudBrowserAskDetail({ input: null }).agent).toBe("The agent");
});
