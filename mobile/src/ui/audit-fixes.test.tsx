// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { BotQuestionSheet } from "./BotQuestionSheet";
import { FactRows } from "./FactRows";
import { OneTimeCode } from "./OneTimeCode";
import { BranchSheet } from "./repositories/parts";
import { ChatTabs } from "./SessionChrome";
import { LargeText } from "./text-size";
import { themePalette, type ThemeName } from "./theme";
import { WorkGroup } from "./WorkGroup";
import { stage } from "./testing/kit";

vi.mock("react-native", () => import("@mobile/ui/testing/native"));
vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()));
vi.mock("lucide-react-native", async () => (await import("@mobile/ui/testing/kit")).namedIcons());
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => ({}) }));
vi.mock("./AgentMark", () => ({ AgentMark: () => <i data-testid="agent-mark" /> }));
vi.mock("./MacIcon", () => ({ StateMark: () => null }));

const page = stage();

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function lum([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function blend(fgHex: string, bgHex: string, alpha: number): [number, number, number] {
  const fg = rgb(fgHex);
  const bg = rgb(bgHex);
  return [
    Math.round(fg[0] * alpha + bg[0] * (1 - alpha)),
    Math.round(fg[1] * alpha + bg[1] * (1 - alpha)),
    Math.round(fg[2] * alpha + bg[2] * (1 - alpha)),
  ];
}
function contrast(c1: [number, number, number], c2: [number, number, number]): number {
  const l1 = lum(c1);
  const l2 = lum(c2);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

describe("U-54: WCAG AA contrast for Light themes", () => {
  it.each<ThemeName>(["Den", "Slate", "Moss"])("%s light semantic colors achieve >=4.5:1 on all light surfaces and tinted badges", (name) => {
    const p = themePalette(name, "light");
    const surfaces = [p.page, p.card, p.raised, p.selected];
    for (const color of [p.success, p.warning, p.info, p.danger]) {
      for (const surface of surfaces) {
        expect(contrast(rgb(color), rgb(surface))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(rgb(color), blend(color, surface, 0x24 / 255))).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("U-11 & U-60: VoiceOver Escape, internal Close buttons, and touch targets", () => {
  it("BotQuestionSheet exposes onAccessibilityEscape, >=44pt Close button, and hitSlop on Send reply", async () => {
    const onClose = vi.fn();
    await page.show(
      <BotQuestionSheet
        bot={{ id: "b1", name: "Scout", roleTemplateId: "qa" }}
        item={{
          number: 7,
          title: "Deploy?",
          state: "needsYou",
          modified: Date.now(),
          question: { text: "Ship release?", answers: ["Yes", "No"], recommended: 0 },
        } as never}
        connected
        busy={false}
        onAnswer={vi.fn(async () => ({ ok: true as const, note: null }))}
        onClose={onClose}
      />,
    );
    const sheet = page.byId("bot-question-sheet")!;
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(sheet.getAttribute("data-has-escape")).toBe("true");
    const closeBtn = page.byId("bot-question-close")!;
    expect(page.styleOf(closeBtn).minHeight).toBeGreaterThanOrEqual(44);
    expect(page.styleOf(closeBtn).minWidth).toBeGreaterThanOrEqual(44);
    const sendBtn = page.byLabel("Send reply")!;
    expect(sendBtn.getAttribute("data-hit-slop")).toBe("6");
    await page.press(closeBtn);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("BranchSheet exposes onAccessibilityEscape and >=44pt internal Close button", async () => {
    const onClose = vi.fn();
    await page.show(
      <BranchSheet
        repository={{ cloneUrl: "https://github.com/acme/app", fullName: "acme/app", ref: "", defaultBranch: "main", private: false, typed: false }}
        onDone={vi.fn()}
        onRemove={vi.fn()}
        onClose={onClose}
      />,
    );
    const sheet = page.byId("branch-sheet")!;
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(sheet.getAttribute("data-has-escape")).toBe("true");
    const closeBtn = page.byId("branch-sheet-close")!;
    expect(page.styleOf(closeBtn).minHeight).toBeGreaterThanOrEqual(44);
    await page.press(closeBtn);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("WorkGroup CommandLine has >=13pt vertical hitSlop to reach 44pt touch target", async () => {
    await page.show(
      <WorkGroup
        calls={[{ callId: "c1", name: "Bash", input: { command: "pnpm test" } } as never]}
      />,
    );
    await page.press(page.byId("work-group-header"));
    const cmd = page.byId("work-group-command")!;
    expect(JSON.parse(cmd.getAttribute("data-hit-slop")!)).toMatchObject({ top: 13, bottom: 13 });
  });
});

describe("U-57: ChatTabs Close button is a sibling of the tab Pressable", () => {
  it("renders tab select and Close button as siblings under a tablist", async () => {
    const onClose = vi.fn();
    const session = {
      id: "s1",
      title: "Fix",
      project: "app",
      kind: "worktree",
      tabs: [
        { id: "t1", title: "Claude", harness: "claude", status: "idle", kind: "agent" },
        { id: "t2", title: "Codex", harness: "codex", status: "idle", kind: "agent" },
      ],
    } as never;
    await page.show(<ChatTabs session={session} selectedTabId="t1" onSelect={vi.fn()} onClose={onClose} />);
    expect(page.container.querySelector("[role='tablist']")).not.toBeNull();
    const tab = page.container.querySelector("[role='tab'][aria-selected='true']")!;
    const close = page.byLabel("Close Claude")!;
    // Close must NOT be a descendant of the tab element (sibling so VoiceOver/TalkBack can focus it).
    expect(tab.contains(close)).toBe(false);
    expect(tab.parentElement).toBe(close.parentElement);
    await page.press(close);
    expect(onClose).toHaveBeenCalledWith("t1");
  });
});

describe("U-62: Dynamic Type stacking and wrapping", () => {
  it("FactRows switches pairs and sentences to stacked block layout under useLargeText()", async () => {
    await page.show(
      <LargeText.Provider value>
        <FactRows testID="facts" layout="sentences" facts={[{ label: "Compute", value: "The machine is removed." }]} />
      </LargeText.Provider>,
    );
    const row = page.byId("facts")!.firstElementChild as HTMLElement;
    expect(page.styleOf(row).flexDirection).toBeUndefined();
    expect(page.styleOf(page.byText("Compute")).width).toBeUndefined();
  });

  it("OneTimeCode wraps its label row for large text", async () => {
    await page.show(<OneTimeCode testID="otc" code="K7QM-4TXP" expiresAt={Date.now() + 60_000} />);
    const labelRow = page.byText("One-time code")!.parentElement as HTMLElement;
    expect(page.styleOf(labelRow).flexWrap).toBe("wrap");
  });
});
