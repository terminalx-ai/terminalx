import { describe, expect, it } from "vitest";
import type { ModelInfo } from "@/lib/api";
import { EFFORT_LABEL, modelLabel, prettyModelId, upgradeHint } from "@/lib/models";

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
