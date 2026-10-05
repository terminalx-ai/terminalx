import { describe, expect, it } from "vitest";
import type { ModelInfo } from "@/lib/api";
import { EFFORT_LABEL, aliasRuns, modelForTab, modelGroups, modelLabel, modelNote, modelOptionText, offeredOn, prettyModelId, runningModelName, upgradeHint } from "@/lib/models";

const model = (id: string, label: string, upgrade: string | null = null): ModelInfo => ({
  id,
  label,
  harness: "codex",
  efforts: [],
  defaultEffort: null,
  acceptsImages: true,
  isDefault: false,
  upgrade,
  description: null,
});

describe("prettyModelId", () => {
  it("reads an id the list no longer carries", () => {
    expect(prettyModelId("gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    expect(prettyModelId("gpt-5.6-codex")).toBe("GPT-5.6 Codex");
    expect(prettyModelId("gpt-5.6")).toBe("GPT-5.6");
    expect(prettyModelId("openai/gpt-5")).toBe("GPT-5");
  });

  it("reads a full Claude id as family and version, without its date stamp", () => {
    expect(prettyModelId("claude-opus-5-5")).toBe("Opus 5.5");
    expect(prettyModelId("claude-opus-5")).toBe("Opus 5");
    expect(prettyModelId("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  });

  it("calls the empty id what the pickers call it", () => {
    expect(prettyModelId("")).toBe("Default");
  });
});

describe("modelLabel", () => {
  it("falls back to the id rather than going blank", () => {
    // Nothing has been loaded, so every id is unknown here.
    expect(modelLabel("codex", "gpt-5.6")).toBe("GPT-5.6");
    expect(modelLabel("opencode", "")).toBe("Default");
  });
});

describe("upgradeHint", () => {
  const all = [model("gpt-5.6-terra", "GPT-5.6 Terra"), model("gpt-5.4", "GPT-5.4", "gpt-5.6-terra")];

  it("names the replacement by its label", () => {
    expect(upgradeHint(all[1], all)).toBe("GPT-5.6 Terra");
  });

  it("says nothing about a current model", () => {
    expect(upgradeHint(all[0], all)).toBeNull();
  });

  it("still reads when the replacement is not on the list", () => {
    expect(upgradeHint(model("gpt-5.4", "GPT-5.4", "gpt-5.6-luna"), [])).toBe("GPT-5.6 Luna");
  });
});

describe("EFFORT_LABEL", () => {
  it("covers the efforts Codex now offers", () => {
    expect(EFFORT_LABEL.max).toBe("Max");
    expect(EFFORT_LABEL.ultra).toBe("Ultra");
  });
});

describe("a Claude alias and its pinned versions", () => {
  const claude = (id: string, label: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ ...model(id, label), harness: "claude", ...extra });
  const opus = claude("opus", "Opus", { alias: true, resolved: "claude-opus-5-5" });
  const unasked = claude("sonnet", "Sonnet", { alias: true, resolved: null });
  const pinned = claude("claude-opus-5", "Opus 5");
  const all = [opus, unasked, pinned];

  it("an alias says it follows the latest, and which version that is when the CLI said", () => {
    expect(modelNote(opus, all)).toBe("latest · Opus 5.5");
    expect(modelOptionText(opus, all)).toBe("Opus (latest · Opus 5.5)");
    // The CLI could not be asked: no version is made up.
    expect(modelNote(unasked, all)).toBe("latest");
    expect(modelOptionText(unasked, all)).toBe("Sonnet (latest)");
    expect(modelNote(pinned, all)).toBeNull();
    expect(modelOptionText(pinned, all)).toBe("Opus 5");
  });

  it("claims no version for a list drawn for another machine", () => {
    expect(modelNote(opus, all, false)).toBe("latest");
    expect(modelOptionText(opus, all, false)).toBe("Opus (latest)");
    expect(runningModelName(opus, null, false)).toBe("Opus");
  });

  it("the session's own report wins over what the CLI listed", () => {
    expect(runningModelName(opus)).toBe("Opus 5.5");
    expect(runningModelName(opus, "claude-opus-5")).toBe("Opus 5");
    // A cloud tab: nothing is claimed until its session reports.
    expect(runningModelName(opus, "claude-opus-5", false)).toBe("Opus 5");
    expect(runningModelName(unasked)).toBe("Sonnet");
  });

  it("ignores a report left over from another family", () => {
    // The reader just switched from Sonnet to Opus; the last message was Sonnet's.
    expect(aliasRuns(opus, "claude-sonnet-5-5")).toBe("claude-opus-5-5");
    expect(aliasRuns(pinned, "claude-opus-5-5")).toBeNull();
    expect(runningModelName(pinned, "claude-opus-5-5")).toBe("Opus 5");
  });

  it("offers only the aliases for another machine, whose CLI may not run a version pinned here", () => {
    const codex = model("gpt-5.6-sol", "GPT-5.6 Sol");
    expect(offeredOn([...all, codex], true).map((m) => m.id)).toEqual(["opus", "sonnet", "claude-opus-5", "gpt-5.6-sol"]);
    expect(offeredOn([pinned], false)).toEqual([]);
    // A different harness with no aliases is left as it is.
    expect(offeredOn([...all, codex], false).map((m) => m.id)).toEqual(["opus", "sonnet", "gpt-5.6-sol"]);
  });

  it("gives a pinned id the list does not carry its own entry, with its family's efforts", () => {
    const withEfforts = [{ ...opus, isDefault: true, efforts: ["low", "high"], defaultEffort: "high" }, { ...unasked, efforts: ["low"] }, pinned];
    expect(modelForTab(withEfforts, "opus")?.id).toBe("opus");
    expect(modelForTab(withEfforts, "claude-opus-4-8")).toMatchObject({ id: "claude-opus-4-8", label: "Opus 4.8", alias: false, isDefault: false, efforts: ["low", "high"], defaultEffort: "high" });
    expect(modelForTab(withEfforts, "claude-sonnet-4-6")).toMatchObject({ label: "Sonnet 4.6", efforts: ["low"] });
    // Anything else unknown still reads as the default, and so does no model at all.
    expect(modelForTab(withEfforts, "gpt-stale")?.id).toBe("opus");
    expect(modelForTab(withEfforts, "")?.id).toBe("opus");
    expect(modelForTab([], "claude-opus-4-8")).toMatchObject({ label: "Opus 4.8", efforts: [] });
  });

  it("lists the aliases, then the versions that can be pinned", () => {
    expect(modelGroups(all).map((g) => [g.title, g.models.map((m) => m.id)])).toEqual([
      [null, ["opus", "sonnet"]],
      ["Pinned version", ["claude-opus-5"]],
    ]);
    // A harness with no aliases is one plain list.
    const codex = [model("gpt-5.6-sol", "GPT-5.6 Sol")];
    expect(modelGroups(codex)).toEqual([{ title: null, models: codex }]);
  });
});
