import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { cloneUrl, parseRepository, repositoryName, repositoryShown } from "./repository";
import { billingNote, idleChoice, idleChoices, idleValue, loginDetail, machineDetail, priceChangedText, priceDiffers, problemsOf, problemsTitle, quotedSize, sizeSheetNote, sizeValue, spendSentence } from "./words";

// PRO-530: the launch form's words. The spend confirmation is the owner's,
// word for word; every figure comes from the server's answers.
vi.mock("react-native", () => import("@mobile/ui/testing/native"));

const rate = (micros: number) => ({ activeHourlyMicros: micros, currency: "USD" });

describe("the spend confirmation", () => {
  it("is the owner's sentence for a provider that bills directly", () => {
    expect(spendSentence({ label: "Boat", billedByProvider: true }, "Northwind", rate(18_000))).toBe("Boat bills this workspace to Northwind directly, not TerminalX: about $0.018 for each hour it is active.");
  });

  it("is the owner's sentence for TerminalX Cloud, which TerminalX bills", () => {
    expect(spendSentence({ label: "TerminalX Cloud", billedByProvider: false }, "Northwind", rate(18_000))).toBe("TerminalX bills this workspace to Northwind: about $0.018 for each hour it is active.");
  });

  it("is chosen by the descriptor's billedByProvider, never by the provider's id or name", () => {
    // A provider named like TerminalX that bills directly, and one named like Boat that TerminalX bills.
    expect(spendSentence({ label: "TerminalX Cloud", billedByProvider: true }, "Acme", rate(250_000))).toBe("TerminalX Cloud bills this workspace to Acme directly, not TerminalX: about $0.250 for each hour it is active.");
    expect(spendSentence({ label: "Boat", billedByProvider: false }, "Acme", rate(1_500_000))).toBe("TerminalX bills this workspace to Acme: about $1.50 for each hour it is active.");
    expect(spendSentence.length).toBe(3);
  });
});

describe("prices", () => {
  it("puts the provider's own billing line before the estimate note", () => {
    expect(billingNote({ billing: "Per second, billed by Boat" }, "USD")).toBe("Per second, billed by Boat. Prices are estimates, in US dollars.");
    expect(billingNote({ billing: "Billed by TerminalX." }, "USD")).toBe("Billed by TerminalX. Prices are estimates, in US dollars.");
    expect(sizeSheetNote("Boat", "USD")).toBe("Boat · prices are estimates, in US dollars");
    expect(billingNote({ billing: "Billed by Example" }, "EUR")).toBe("Billed by Example. Prices are estimates, in euros.");
    expect(billingNote({ billing: "Billed by Example" }, "XTS")).toMatch(/^Billed by Example\. Prices are estimates, in /);
  });

  it("says what a different new price was", () => {
    expect(priceChangedText(rate(18_000))).toBe("The price changed since you last looked: it was $0.018 per active hour.");
    expect(priceDiffers({ ...rate(18_000), alwaysOnThirtyDayMicros: 1 }, { ...rate(20_000), alwaysOnThirtyDayMicros: 1 })).toBe(true);
    expect(priceDiffers({ ...rate(18_000), alwaysOnThirtyDayMicros: 1 }, { ...rate(18_000), alwaysOnThirtyDayMicros: 1 })).toBe(false);
  });

  it("writes sizes from the server's machine classes", () => {
    const small = { id: "small", label: "Small", vcpu: 2, memoryMiB: 4096, diskGiB: 40, activeHourlyMicros: 18_000 };
    expect(sizeValue(small, "USD")).toBe("Small · $0.018 / hour");
    expect(sizeValue({ ...small, label: "2 vCPU · 4 GB RAM", activeHourlyMicros: undefined }, "USD")).toBe("2 vCPU · 4 GB RAM");
    expect(machineDetail(small)).toBe("2 vCPU · 4 GiB memory · 40 GiB disk");
    expect(quotedSize({ machineClassLabel: "Small", vcpu: 2, memoryMiB: 4096, diskGiB: 40 } as never)).toBe("Small · 2 vCPU · 4 GiB · 40 GiB");
  });
});

describe("stop when idle", () => {
  it("offers the server's times with Never last, as the sheet and the row say them", () => {
    expect(idleChoices({ allowedIdleSuspendMinutes: [0, 5, 10, 15, 30, 60], maxIdleSuspendMinutes: null })).toEqual([5, 10, 15, 30, 60, 0]);
    expect([5, 0].map(idleChoice)).toEqual(["5 minutes", "Never: always on"]);
    expect([15, 0].map(idleValue)).toEqual(["After 15 minutes", "Never"]);
  });

  it("offers nothing above an organization's cap, and no Never under one", () => {
    expect(idleChoices({ allowedIdleSuspendMinutes: [5, 10, 15, 30, 60, 0], maxIdleSuspendMinutes: 30 })).toEqual([5, 10, 15, 30]);
  });
});

describe("failed checks", () => {
  it("are said in the board's sentences, naming the repository or the login", () => {
    const problems = problemsOf([
      { kind: "repository", cloneUrl: "https://github.com/acme/app.git", status: "failed", errorCode: "cloud_workspace_repository_credential_required" },
      { kind: "credential", provider: "codex", credentialId: "c1", status: "failed", errorCode: "cloud_agent_credential_reauth_required" },
      { kind: "repository", cloneUrl: "https://github.com/acme/app.git", status: "failed", errorCode: "cloud_workspace_repository_ref_not_found" },
      { kind: "credential", provider: "claude", credentialId: "c2", status: "verified" },
      { kind: "agent-credential", agent: "cursor", status: "failed", errorCode: "something_new_from_the_server" },
    ], []);
    expect(problems.map((problem) => problem.text)).toEqual([
      "acme/app: this repository needs a GitHub personal access token.",
      "Codex: sign-in required.",
      "acme/app: that branch or tag was not found in the repository.",
      "Cursor: that did not work. Try again in a moment.",
    ]);
    expect(problems.map((problem) => problem.field)).toEqual([{ kind: "repository" }, { kind: "login", credentialId: "c1", provider: "codex" }, { kind: "repository" }, { kind: "login", credentialId: null, provider: "cursor" }]);
    expect(problems.some((problem) => problem.text.includes("something_new"))).toBe(false);
  });

  it("are headed by how many there are", () => {
    expect(problemsTitle(2)).toBe("Two things to fix before this can be priced");
    expect(problemsTitle(1)).toBe("One thing to fix before this can be priced");
  });

  it("name a login by who it is, else how it signs in", () => {
    expect(loginDetail({ displayIdentity: "alex@example.com", authKind: "oauth-credentials-json" })).toBe("alex@example.com");
    expect(loginDetail({ authKind: "api-key" })).toBe("API key");
  });
});

describe("the repository", () => {
  it("takes a GitHub URL typed or pasted, in any of its usual forms", () => {
    for (const typed of ["github.com/acme/app", "https://github.com/acme/app", "https://github.com/acme/app.git", " github.com/acme/app/ ", "https://www.github.com/acme/app"]) {
      expect(cloneUrl(typed)).toBe("https://github.com/acme/app.git");
      expect(repositoryShown(typed)).toBe("github.com/acme/app");
    }
    expect(repositoryName("https://github.com/acme/app.git")).toBe("acme/app");
  });

  it("refuses what is not one GitHub repository", () => {
    for (const typed of ["", "acme/app", "http://github.com/acme/app", "https://gitlab.com/acme/app", "github.com/acme", "github.com/acme/app/tree/main", "github.com/acme/a pp", "github.com/acme/.."]) expect(parseRepository(typed)).toBeNull();
  });
});

describe("the launch code", () => {
  // Sizes, regions, idle times, models and prices are the server's: none is written into the app.
  const here = fileURLToPath(new URL(".", import.meta.url));
  const product = [
    ...readdirSync(here).filter((name) => !name.includes(".test.")).map((name) => join(here, name)),
    ...readdirSync(join(here, "../../../../app/cloud/launch")).map((name) => join(here, "../../../../app/cloud/launch", name)),
  ];

  it("writes no size, region, idle time, model or price of its own", () => {
    expect(product.length).toBeGreaterThanOrEqual(8);
    for (const file of product) {
      const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(source, file).not.toMatch(/\$\s?\d/);
      expect(source, file).not.toMatch(/\b\d+\s?(vCPU|GiB|GB|MiB)\b/);
      expect(source, file).not.toMatch(/(activeHourlyMicros|alwaysOnThirtyDayMicros|idleSuspendMinutes|retentionDays|memoryMiB|diskGiB|vcpu)\s*:\s*\d/);
      expect(source, file).not.toMatch(/(machineClassId|locationId|sourceId)\s*:\s*["']/);
      expect(source, file).not.toMatch(/\[\s*5\s*,\s*10\b|\b(claude|gpt|opus|sonnet|haiku)-\w/i);
      expect(source, file).not.toMatch(/\b(box|boat|agent37|machine0|terminalx-cloud)\b["']/i);
    }
  });
});
