#!/usr/bin/env node
// PRO-306: Settings → Agents in the desktop's WebKit engine, in the states
// the design screens show: an API key saved (10.19), removed (10.20), and
// imported from the login shell into Codex (10.21), plus the offer before
// an import, a key the provider refused and Codex's custom provider. Each
// state must fit the Settings column with nothing overlapping, and a
// picture of each is written to $AGENT_LOGIN_SHOTS (default /tmp).
import { launch, open, report, serve } from "./harness.mjs";

const shots = process.env.AGENT_LOGIN_SHOTS ?? "/tmp";
const caps = { images: true, steer: false, permissionModes: true, effort: true, slashCommands: true, atMentions: true, fork: true, resume: true };
const harnesses = [
  { id: "claude", name: "Claude Code", binary: "claude", available: true, installable: true, path: "/Users/ada/.local/bin/claude", installHint: "curl -fsSL https://claude.ai/install.sh | bash", installUrl: "https://docs.claude.com/claude-code", caps },
  { id: "codex", name: "Codex", binary: "codex", available: true, installable: true, path: "/opt/homebrew/bin/codex", installHint: "curl -fsSL https://chatgpt.com/codex/install.sh | sh", installUrl: "https://developers.openai.com/codex/cli", caps },
  { id: "opencode", name: "OpenCode", binary: "opencode", available: false, installHint: "npm i -g opencode-ai", installUrl: "https://opencode.ai", caps },
];
// Runs in the page, after the stub: a backend for the agent login commands.
const backend = `(() => {
  const answers = window.__PW_STUB__.answers;
  const now = () => new Date().toISOString();
  const ready = (id) => ({ state: "ready", checkedAt: now(), version: id === "claude" ? "2.3.41" : "0.166.0", loginMethod: id === "claude" ? "Claude account" : "ChatGPT account", plan: id === "claude" ? "max" : "pro", account: "ada@example.com", organization: id === "claude" ? "Acme" : null });
  const state = window.__AGENT_LOGINS__ = {
    calls: [],
    verify: { ok: true },
    logins: {
      claude: { harness: "claude", variable: "ANTHROPIC_API_KEY", mode: "default" },
      codex: { harness: "codex", variable: "OPENAI_API_KEY", mode: "default", config: "~/.codex/config.toml" },
    },
    offers: { codex: { variable: "OPENAI_API_KEY", file: "~/.zshrc" } },
    tabs: { claude: [{ sessionId: "s1", tabId: "t1", current: true }, { sessionId: "s2", tabId: "t2", current: true }], codex: [] },
  };
  const masked = (harness) => harness === "claude" ? "sk-ant-api03-" + "•".repeat(24) + "4f2a" : "sk-proj-" + "•".repeat(24) + "9Qx1";
  const stale = (harness) => { state.tabs[harness] = state.tabs[harness].map((tab) => ({ ...tab, current: false })); };
  const log = (name, fn) => (args) => { state.calls.push(name); return fn(args); };
  answers.list_harnesses = ${JSON.stringify(harnesses)};
  answers.check_agent_readiness = ({ harness }) => harness === "opencode" ? { state: "missing", checkedAt: now(), version: null } : ready(harness);
  answers.agent_setup_running = null;
  answers.agent_login_status = ({ harness }) => state.logins[harness];
  answers.agent_login_shell_offer = ({ harness }) => state.offers[harness] ?? null;
  answers.agent_login_save_key = log("save", ({ harness }) => { state.logins[harness] = { ...state.logins[harness], mode: "api_key", saved: { masked: masked(harness), savedAt: now() }, verified: undefined }; stale(harness); return state.logins[harness]; });
  answers.agent_login_verify = log("verify", ({ harness }) => { const verified = { ...state.verify, checkedAt: now() }; state.logins[harness] = { ...state.logins[harness], verified }; return verified; });
  answers.agent_login_remove_key = log("remove", ({ harness }) => { state.logins[harness] = { ...state.logins[harness], mode: "subscription", saved: undefined, verified: undefined }; return state.logins[harness]; });
  answers.agent_login_set_mode = log("mode", ({ harness, mode }) => { state.logins[harness] = { ...state.logins[harness], mode }; return state.logins[harness]; });
  answers.agent_login_import_shell = log("import", ({ harness }) => { state.logins[harness] = { ...state.logins[harness], mode: "api_key", saved: { masked: masked(harness), savedAt: now(), fromShell: { file: state.offers[harness].file } } }; state.offers[harness] = null; stale(harness); return state.logins[harness]; });
  answers.agent_login_dismiss_shell = log("dismiss", ({ harness }) => { state.offers[harness] = null; return null; });
  answers.agent_login_set_base_url = log("baseUrl", ({ harness, baseUrl }) => { state.logins[harness] = { ...state.logins[harness], baseUrl: baseUrl ? baseUrl.replace(/\\/$/, "") : undefined }; return state.logins[harness]; });
  answers.agent_login_tabs = ({ harness }) => state.tabs[harness];
})();`;

/** Whether the Agents panel and the toasts fit, with no two buttons on top of each other. */
async function layout(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[role="tabpanel"]').parentElement;
    const main = panel.closest("main") ?? document.body;
    const scroller = [...document.querySelectorAll("*")].find((element) => element.contains(panel) && getComputedStyle(element).overflowY === "auto");
    const bounds = panel.getBoundingClientRect();
    const buttons = [...panel.querySelectorAll("button"), ...document.querySelectorAll('[role="status"][aria-label] button')]
      .map((button) => ({ label: button.getAttribute("aria-label") ?? button.textContent.trim(), box: button.getBoundingClientRect(), lines: Math.round(button.getBoundingClientRect().height / parseFloat(getComputedStyle(button).lineHeight || "16")) }))
      .filter(({ box }) => box.width > 0);
    const overlaps = [];
    for (let a = 0; a < buttons.length; a++)
      for (let b = a + 1; b < buttons.length; b++) {
        const one = buttons[a].box, two = buttons[b].box;
        if (one.left < two.right - 1 && two.left < one.right - 1 && one.top < two.bottom - 1 && two.top < one.bottom - 1) overlaps.push([buttons[a].label, buttons[b].label]);
      }
    const outside = [...panel.querySelectorAll("button, input, dl")].filter((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && (box.left < bounds.left - 1 || box.right > bounds.right + 1);
    }).map((element) => element.getAttribute("aria-label") ?? element.textContent.trim().slice(0, 30));
    return { noOverflow: main.scrollWidth <= main.clientWidth + 1 && (!scroller || scroller.scrollWidth <= scroller.clientWidth + 1), overlaps, outside, text: panel.textContent };
  });
}

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1440, height: 900 }, { extra: backend, colorScheme: "dark", locale: "en-US" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("main", { name: "Settings", exact: true });
  await settings.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("tablist", { name: "Agents" }).waitFor();
  const shoot = async (name) => {
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${shots}/pro-306-${name}.png` });
  };
  const check = async (name, checks) => {
    const found = await layout(page);
    failed += report(name, { "the panel fits the Settings column": found.noOverflow && found.outside.length === 0, "no two buttons overlap": found.overlaps.length === 0, ...checks(found) }, found);
  };

  // Signed in with the subscription: which login, and where it came from.
  await page.getByText("Claude Max · ada@example.com").waitFor();
  await shoot("subscription");
  await check("Claude Code signed in", ({ text }) => ({
    "the sign-in choice names the variable": /Claude subscriptionclaude \/loginAPI keyANTHROPIC_API_KEY/.test(text),
    "the Login row says which login": text.includes("LoginClaude Max · ada@example.com") && text.includes("OrganizationAcme"),
  }));

  // 10.19: a key saved, verified, and the running tabs counted.
  await page.getByRole("radio", { name: /API key/ }).click();
  await page.getByLabel("Anthropic API key", { exact: true }).fill("sk-ant-api03-Zq9vLwPq3bXbmTkF0aB7cD2eF4gH6iJ8kL0mN2oP4qR6sT8uV0wX2yZ4-4f2a");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const saved = page.getByRole("status", { name: "API key saved to the Keychain" });
  await saved.waitFor();
  await page.getByText("Using an API key · verified just now").waitFor();
  await shoot("saved");
  await check("API key saved (10.19)", ({ text }) => ({
    "the key is masked, with Saved and Remove": text.includes("sk-ant-api03-••••••••••••••••••••••••4f2a") && text.includes("Saved") && text.includes("Remove"),
    "the Keychain line": text.includes("Kept in the Keychain. TerminalX passes it to Claude Code when a tab starts, in place of ANTHROPIC_API_KEY."),
    "the Login row says API key, the variable and Keychain": text.includes("LoginAPI key · ANTHROPIC_API_KEY · Keychain"),
  }));
  failed += report("saved toast", {
    "says new tabs use it and how many keep their login": /New Claude Code tabs use it\. 2 running tabs keep their current login until you restart them\./.test(await saved.textContent()),
    "offers to restart exactly those": (await saved.getByRole("button", { name: "Restart 2 tabs" }).count()) === 1,
  });

  // 10.20: removed; the subscription login again.
  await saved.getByRole("button", { name: "Dismiss" }).click();
  await page.getByRole("button", { name: "Remove" }).click();
  const removed = page.getByRole("status", { name: "API key removed · Claude Code uses your Claude login again" });
  await removed.waitFor();
  await page.getByRole("radio", { name: /Claude subscription/, checked: true }).waitFor();
  await shoot("removed");
  await check("API key removed (10.20)", ({ text }) => ({
    "signed in with the account": text.includes("Signed in") && text.includes("LoginClaude Max · ada@example.com"),
    "no key field is left": !text.includes("Anthropic API key"),
  }));
  failed += report("removed toast", { "says where the key went and which login new tabs use": /Deleted from the Keychain\. New tabs sign in with Claude Max \(ada@example\.com\)\./.test(await removed.textContent()) });
  await removed.getByRole("button", { name: "Dismiss" }).click();

  // A key the provider refuses.
  await page.evaluate(() => { window.__AGENT_LOGINS__.verify = { ok: false, reason: "api.anthropic.com refused this key (HTTP 401). Check it was copied whole, or make a new one" }; });
  await page.getByRole("radio", { name: /API key/ }).click();
  await page.getByLabel("Anthropic API key", { exact: true }).fill("sk-ant-api03-not-a-real-key-000000000000000000000000-dead");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText(/not verified: api\.anthropic\.com refused this key/).waitFor();
  await page.getByRole("status", { name: "API key saved to the Keychain" }).getByRole("button", { name: "Dismiss" }).click();
  await shoot("not-verified");
  await check("a key that is not verified", ({ text }) => ({ "says why": text.includes("Using an API key · not verified: api.anthropic.com refused this key (HTTP 401)") }));

  // 10.21: Codex, the login shell's key offered, then imported.
  await page.getByRole("tab", { name: /Codex/ }).click();
  await page.getByText(/Found OPENAI_API_KEY in your login shell/).waitFor();
  await shoot("codex-offer");
  const importedByLooking = await page.evaluate(() => window.__AGENT_LOGINS__.calls.includes("import"));
  await check("Codex with a key in the login shell", ({ text }) => ({
    "the offer names the variable and the file": text.includes("Found OPENAI_API_KEY in your login shell (~/.zshrc)."),
    "ChatGPT, API key and Custom provider are listed": /ChatGPTada@example\.com · Pro/.test(text) && /API keyOPENAI_API_KEY/.test(text) && text.includes("Custom providerAny OpenAI-compatible endpoint, set with OPENAI_BASE_URL"),
    "nothing was imported by looking": !importedByLooking,
  }));
  await page.evaluate(() => { window.__AGENT_LOGINS__.verify = { ok: true }; });
  await page.getByRole("button", { name: "Import to the Keychain" }).click();
  const imported = page.getByRole("status", { name: "Imported OPENAI_API_KEY from your shell environment" });
  await imported.waitFor();
  await page.getByLabel("Verified").waitFor();
  await shoot("codex-imported");
  await check("Codex key imported from the shell (10.21)", ({ text }) => ({
    "the From your shell note names the file": text.includes("From your shellFound in your login shell (~/.zshrc). A copy is now in the Keychain, so it works without that file."),
    "the key is masked with Remove": text.includes("sk-proj-••••••••••••••••••••••••9Qx1") && text.includes("Remove"),
    "the Config and Executable rows": text.includes("Config~/.codex/config.toml") && text.includes("Executable/opt/homebrew/bin/codex"),
  }));
  failed += report("imported toast", { "says Codex uses it and the user can switch back": /Codex uses it in new tabs\. Switch back to ChatGPT any time\./.test(await imported.textContent()) });
  await imported.getByRole("button", { name: "Dismiss" }).click();

  // Codex's custom provider.
  await page.getByRole("button", { name: /Custom provider/ }).click();
  await page.getByLabel("Base URL").fill("https://llm.example.com/v1");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: /Custom provider\s*https:\/\/llm\.example\.com\/v1/ }).waitFor();
  await shoot("codex-custom-provider");
  await check("Codex custom provider", ({ text }) => ({ "the address is shown": text.includes("https://llm.example.com/v1") && text.includes("Use OpenAI") }));

  // Another agent: install and sign in, as before.
  await page.getByRole("tab", { name: /OpenCode/ }).click();
  await page.getByRole("region", { name: "OpenCode setup" }).waitFor();
  await shoot("opencode");
  await check("an agent without a key choice", ({ text }) => ({ "shows its status and setup": text.includes("Not installed") && !text.includes("API key") }));
  await page.close();
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
