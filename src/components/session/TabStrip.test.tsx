import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async () => {
  const { backend } = await import("@/test/tabsBackend");
  return { invoke: backend.invoke, Channel: class {} };
});
vi.mock("@tauri-apps/api/event", async () => {
  const { backend } = await import("@/test/tabsBackend");
  return { listen: backend.listen };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/confirm", () => ({ confirmInApp: vi.fn(async () => true), chooseInApp: vi.fn(async () => "action") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(async () => undefined), openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: async () => true, requestPermission: async () => "granted", sendNotification: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: async () => undefined, label: "main" }) }));

vi.mock("@/components/editor/DiffEditorPane", () => ({ DiffEditorPane: () => <div>Review diff</div> }));
vi.mock("@/components/changes/PrPanel", () => ({ PrPanel: () => <div>Review PR</div> }));
vi.mock("@/components/changes/ConflictView", () => ({ ConflictView: () => <div>Review conflict</div> }));
const { dropEditors, getEditors, openConflict, openDiff, openPr, setConflictCount, setEditorDirty } = await import("@/lib/editors");
const { confirmInApp: ask } = await import("@/lib/confirm");
const { getTerminalState, restoreSessionTabSelection, selectSessionTab } = await import("@/lib/terminal");
const { newTab } = await import("@/lib/tabActions");
const { workspaceRow } = await import("@/lib/sessionTabs");
const { backend, FEATURE } = await import("@/test/tabsBackend");
const { TabsHarness } = await import("@/test/TabsHarness");
const { bootSessions, refreshSessions, selectSession, getSessionStore } = await import("@/lib/sessions");
const { bootBrowser, refreshBrowserPages } = await import("@/lib/browser");
const { dropSessionTerminals, openTerminal, setSelectedAgent } = await import("@/lib/terminal");
const { resetTabLayouts } = await import("@/lib/tabLayouts");
const { setPrefs } = await import("@/lib/prefs");
const { newTabBlockedReason, NewTabHint, TabAccountMark, TabAccountLabel } = await import("@/components/session/TabStrip");
const { forgetAgentAccounts, takeAgentAccounts } = await import("@/lib/useSessionAgent");
const { SHORTCUT_ACTIONS, SHORTCUT_GROUPS, bindingProblem, defaultBindings, saveShortcut } = await import("@/lib/shortcuts");

const LONG = "Refactor the authentication middleware to use the new token service";
const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
const strip = () => screen.getByRole("tablist", { name: "Workspace tabs" });
const names = () => within(strip()).getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"));
const shown = () => within(strip()).getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.getAttribute("aria-label");
const composer = () => screen.getByRole("textbox", { name: "Composer" });
const terminal = () => screen.getByRole("textbox", { name: "Terminal input" });
/** A key pressed where the focus is, with Ctrl: the app's main modifier off macOS, which is what jsdom is. */
const press = (target: Element, init: KeyboardEventInit) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, ...init });
  act(() => void target.dispatchEvent(event));
  return event;
};
const digit = (n: number): KeyboardEventInit => ({ key: String(n), code: `Digit${n}` });

let shell = "";

beforeEach(async () => {
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  setPrefs({ shortcuts: {} });
  backend.reset();
  await bootSessions();
  await refreshSessions();
  dropSessionTerminals(["a", "b", "other"]);
  await bootBrowser();
  await refreshBrowserPages();
  resetTabLayouts();
  shell = (await openTerminal("a", FEATURE)).id;
  selectSession("a");
  setSelectedAgent("a", "a1");
  backend.calls = [];
});

afterEach(async () => {
  cleanup();
  dropEditors(() => true);
  const { dismissError, getErrorToasts } = await import("@/lib/errorToasts");
  for (const toast of getErrorToasts()) dismissError(toast.id);
});

describe("the new-tab button", () => {
  it("ends the row of tabs and opens the same menu as before", async () => {
    render(<TabsHarness />);
    const plus = screen.getByRole("button", { name: "New tab" });
    // After the strip, in the same header.
    expect(strip().compareDocumentPosition(plus) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(plus);
    const items = await screen.findAllByRole("menuitem");
    // PRO-381 (03.29): each agent's chat says where it opens; Terminal and Browser need no hint.
    expect(screen.getByText("New tab").textContent).toBe("New tab");
    expect(items.map((item) => item.textContent)).toEqual(["Claude Code chatSame worktreeCtrlT", "Codex chatSame worktree", "Gemini chatNot installed", "Terminal", "BrowserCtrlShiftB"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Terminal" }));
    await flush();
    expect(backend.callsOf("pty_spawn").at(-1)).toMatchObject({ cwd: FEATURE, title: "Terminal 2" });
    // A tab opened from here goes to the end of the row.
    expect(names().at(-1)).toBe("Terminal 2");
  });
});

describe("the tab shortcuts", () => {
  it("are nine remappable actions for a place in the row, reserving unshifted mod+1 for Overview", () => {
    const places = SHORTCUT_ACTIONS.filter((action) => /^session\.(tab\d|lastTab)$/.test(action.id));
    expect(places.map((action) => action.label)).toEqual([...Array.from({ length: 8 }, (_, i) => `Switch to tab ${i + 1}`), "Switch to last tab"]);
    for (const mac of [true, false]) {
      expect(places.map((action) => defaultBindings(action.id, mac))).toEqual([["mod+shift+1"], ...Array.from({ length: 7 }, (_, i) => [`mod+${i + 2}`]), ["mod+9"]]);
      // Each default is a key the app may take, and no other action has it.
      const all = SHORTCUT_ACTIONS.flatMap((action) => defaultBindings(action.id, mac));
      for (const action of [...places, ...SHORTCUT_ACTIONS.filter((other) => ["session.moveTabLeft", "session.moveTabRight", "session.reopenTab"].includes(other.id))]) {
        for (const binding of defaultBindings(action.id, mac)) {
          expect(bindingProblem(action.id, binding, mac)).toBeNull();
          expect(all.filter((other) => other === binding)).toHaveLength(1);
        }
      }
    }
    // Listed with the other session shortcuts in Settings.
    expect(places.every((action) => action.group === "Session" && SHORTCUT_GROUPS.includes(action.group))).toBe(true);
  });

  it("switch to a tab by its place while the focus is in the composer and in a terminal", async () => {
    render(<TabsHarness />);
    composer().focus();
    const typed = press(composer(), digit(2));
    expect(shown()).toBe("Fix flaky test");
    // The key is the app's: it is not typed into the composer.
    expect(typed.defaultPrevented).toBe(true);

    terminal().focus();
    expect(press(terminal(), digit(3)).defaultPrevented).toBe(true);
    expect(shown()).toBe("Review");

    // 9 is the last tab, however many there are.
    press(terminal(), digit(9));
    expect(shown()).toBe("Terminal 1");

    // There is no eighth tab: nothing changes, and the key still does not reach the shell.
    expect(press(terminal(), digit(8)).defaultPrevented).toBe(true);
    expect(shown()).toBe("Terminal 1");
  });

  it("count the row as shown, across the workspace's sessions, and never reach another workspace", async () => {
    render(<TabsHarness />);
    press(composer(), digit(4));
    await flush();
    // The fourth tab is the other session's: its session is opened with it.
    expect(getSessionStore().selectedSessionId).toBe("b");
    expect(shown()).toBe("Docs");
    for (let n = 1; n <= 9; n++) {
      press(composer(), { ...digit(n), shiftKey: n === 1 });
      await flush();
      expect(getSessionStore().selectedSessionId).not.toBe("other");
    }
  });

  it("follow the order the reader gave the row", async () => {
    render(<TabsHarness />);
    // Move the open tab right, with its own shortcut: Ctrl+Alt+Shift+].
    press(composer(), { key: "}", code: "BracketRight", altKey: true, shiftKey: true });
    await flush();
    expect(names().slice(0, 2)).toEqual(["Fix flaky test", LONG]);
    press(composer(), { ...digit(1), shiftKey: true });
    expect(shown()).toBe("Fix flaky test");
    press(composer(), { key: "{", code: "BracketLeft", altKey: true, shiftKey: true });
    await flush();
    // It is already first: nothing moves.
    expect(names().slice(0, 2)).toEqual(["Fix flaky test", LONG]);
    // Next and previous step through the same row.
    press(composer(), { key: "}", code: "BracketRight", shiftKey: true });
    expect(shown()).toBe(LONG);
    press(composer(), { key: "{", code: "BracketLeft", shiftKey: true });
    press(composer(), { key: "{", code: "BracketLeft", shiftKey: true });
    expect(shown()).toBe("Terminal 1");
  });

  it("use the keys the reader gave them", async () => {
    render(<TabsHarness />);
    expect(saveShortcut("session.tab2", ["mod+shift+2"])).toEqual({ ok: true });
    await flush();
    press(composer(), digit(2));
    expect(shown()).toBe(LONG);
    press(composer(), { key: "@", code: "Digit2", shiftKey: true });
    expect(shown()).toBe("Fix flaky test");
    // The others are as they were.
    press(composer(), digit(3));
    expect(shown()).toBe("Review");
  });

  it("close the open tab and bring the last closed one back", async () => {
    render(<TabsHarness />);
    press(composer(), digit(3));
    press(composer(), { key: "w", code: "KeyW" });
    await flush();
    expect(backend.callsOf("remove_tab")).toEqual([{ sessionId: "a", tabId: "a3" }]);
    expect(names()).not.toContain("Review");
    // Its neighbour took the view.
    expect(shown()).toBe("Docs");

    // Ctrl+Alt+Shift+T off macOS: the browser's own keys switch a tab to its terminal view here.
    press(composer(), { key: "T", code: "KeyT", altKey: true, shiftKey: true });
    await flush();
    expect(backend.callsOf("reopen_tab")).toEqual([{ sessionId: "a", tabId: "a3" }]);
    expect(names().indexOf("Review")).toBe(2);
    expect(shown()).toBe("Review");
    void shell;
  });

  it("leave a tab whose agent would not stop open, on screen, and say so (PRO-291)", async () => {
    const { api } = await import("@/lib/api");
    const { dismissError, getErrorToasts } = await import("@/lib/errorToasts");
    const refused = vi.spyOn(api, "removeTab").mockRejectedValueOnce("Claude Code didn't stop within 10 seconds");
    render(<TabsHarness />);
    press(composer(), digit(3));
    press(composer(), { key: "w", code: "KeyW" });
    await flush();
    await flush();
    expect(names()).toContain("Review");
    expect(shown()).toBe("Review");
    const [toast] = getErrorToasts();
    expect(toast).toMatchObject({ title: "Couldn't close the chat. Try again.", action: "Claude Code didn't stop within 10 seconds, so “Review” is still open", key: "close:agent:a3" });
    expect(toast.actions?.map((action) => action.label)).toEqual(["Try again"]);
    refused.mockRestore();
    dismissError(toast.id);
  });
});

describe("the local new-tab menu (PRO-291)", () => {
  it("closes a tab whose agent exited while starting and says why", async () => {
    const { agent } = await import("@/lib/api");
    const { dismissError, getErrorToasts } = await import("@/lib/errorToasts");
    const started = vi.spyOn(agent, "startOnOpen").mockRejectedValueOnce("codex exited while starting\nerror: unexpected argument '--yolo' found");
    render(<TabsHarness />);
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Codex chat" }));
    await flush();
    await flush();
    expect(backend.callsOf("add_tab")).toHaveLength(1);
    expect(backend.callsOf("remove_tab")).toHaveLength(1);
    expect(getSessionStore().sessions.find((entry) => entry.id === "a")!.tabs.map((tab) => tab.id)).toEqual(["a1", "a2", "a3"]);
    const [toast] = getErrorToasts();
    expect(toast).toMatchObject({ title: "Couldn't open a new Codex tab: codex exited while starting", cause: "error: unexpected argument '--yolo' found" });
    expect(toast.actions?.map((action) => action.label)).toEqual(["Try again"]);
    started.mockRestore();
    dismissError(toast.id);
  });
});

describe("the cloud new-tab menu's disabled hint", () => {
  const model = (fields: Partial<Parameters<typeof newTabBlockedReason>[0]> = {}) => ({
    backend: { readOnlyReason: null },
    connected: true,
    asleep: false,
    canWakeForTerminal: false,
    manage: false,
    ...fields,
  }) as Parameters<typeof newTabBlockedReason>[0];

  it("tells a driver, who is not view-only, that tabs need an admin", () => {
    const reason = newTabBlockedReason(model());
    expect(reason).toBe("New tabs and terminals need a workspace admin.");
    expect(reason).not.toMatch(/view only|attachment/i);
  });

  it("is absent for a manager and keeps a viewer's own reason", () => {
    expect(newTabBlockedReason(model({ manage: true }))).toBeNull();
    expect(newTabBlockedReason(model({ backend: { readOnlyReason: "View only: shared to watch." } as never }))).toBe("View only: shared to watch.");
  });

  it("names the machine on a machine session until it is connected (PRO-347)", () => {
    const machine = { machineId: "m1", projectId: "p1", record: null, name: "Mac mini", state: { state: "direct" } } as never;
    expect(newTabBlockedReason(model({ machine, manage: true }))).toBeNull();
    expect(newTabBlockedReason(model({ machine, manage: true, connected: false }))).toBe("Tabs and terminals open once Mac mini is connected.");
    // The composer's reason while it is away is the one the menu shows too.
    expect(newTabBlockedReason(model({ machine, connected: false, backend: { readOnlyReason: "Can't send until Mac mini is back" } as never }))).toBe("Can't send until Mac mini is back");
  });

  it("reads as a sentence, not the uppercase section header", () => {
    render(<NewTabHint>New tabs and terminals need a workspace admin.</NewTabHint>);
    const hint = screen.getByRole("note");
    expect(hint.className).toContain("normal-case");
    expect(hint.className).not.toMatch(/(^| )uppercase( |$)/);
  });
});


describe("review tabs in the workspace row", () => {
  const openReview = (kind: "diff" | "pr") => kind === "diff"
    ? openDiff("a", FEATURE, "app.ts", { scope: "all", range: { base: "base", head: null } })
    : openPr("a", FEATURE, { url: "https://github.com/org/repo/pull/12", number: 12, head: "feature", scope: { kind: "local", cwd: FEATURE } });
  const review = () => screen.queryByRole("tabpanel", { name: /app.ts|PR #12/ });
  const label = (kind: "diff" | "pr") => kind === "diff" ? "app.ts · All changes" : "PR #12";
  const chooseReview = (kind: "diff" | "pr") => fireEvent.click(within(strip()).getByRole("tab", { name: label(kind) }));

  it("names a merge conflict tab by its file and the conflicts left in it, with the warning icon (PRO-293)", () => {
    render(<TabsHarness reviews />);
    let id = "";
    act(() => { id = openConflict("a", FEATURE, "src/billing/seats.ts", { head: "1".repeat(40), mergeHead: "5".repeat(40) }, 2); });
    const conflict = within(strip()).getByRole("tab", { name: "seats.ts · 2 conflicts" });
    expect(shown()).toBe("seats.ts · 2 conflicts");
    expect(conflict.getAttribute("aria-description")).toBe("Merge conflict");
    const icon = within(conflict).getByLabelText("Merge conflict");
    expect(icon.getAttribute("class")).toContain("text-warning");
    expect(screen.getByText("Review conflict")).toBeTruthy();
    // The count follows the latest read of the file.
    act(() => setConflictCount(id, 1));
    expect(within(strip()).getByRole("tab", { name: "seats.ts · 1 conflict" })).toBeTruthy();
  });

  it.each(["diff", "pr"] as const)("clicks select agent, terminal and browser tabs while a %s stays open", async (kind) => {
    render(<TabsHarness reviews />);
    let id = "";
    act(() => { id = openReview(kind); });
    expect(review()).not.toBeNull();
    const targets = [LONG, "Terminal 1", "Preview"];
    // Get the browser's actual label from the row, independently of its fixture title.
    targets[2] = within(strip()).getAllByRole("tab").find((t) => t.getAttribute("aria-description") === "Browser page")!.getAttribute("aria-label")!;
    for (const name of targets) {
      fireEvent.click(within(strip()).getByRole("tab", { name }));
      await flush();
      expect(review()).toBeNull();
      expect(shown()).toBe(name);
      expect(getEditors().editors.some((e) => e.id === id)).toBe(true);
      chooseReview(kind);
      expect(review()).not.toBeNull();
    }
  });

  it.each(["diff", "pr"] as const)("includes %s in numbered, next and previous shortcuts and closes only the selected tab", async (kind) => {
    render(<TabsHarness reviews />);
    let id = "";
    act(() => { id = openReview(kind); });
    press(review()!, digit(2));
    expect(review()).toBeNull();
    expect(shown()).toBe("Fix flaky test");
    press(composer(), { key: "w", code: "KeyW" });
    await flush();
    expect(backend.callsOf("remove_tab")).toEqual([{ sessionId: "a", tabId: "a2" }]);
    expect(getEditors().editors.some((e) => e.id === id)).toBe(true);
    chooseReview(kind);
    press(review()!, { key: "}", code: "BracketRight", shiftKey: true });
    expect(review()).toBeNull();
    expect(shown()).toBe(LONG);
    press(composer(), { key: "{", code: "BracketLeft", shiftKey: true });
    expect(review()).not.toBeNull();
    press(review()!, digit(1));
    press(composer(), digit(9));
    expect(review()).not.toBeNull();
    press(review()!, { key: "w", code: "KeyW" });
    await flush();
    expect(getEditors().editors.some((e) => e.id === id)).toBe(false);
    expect(shown()).toBe("Terminal 1");
    press(terminal(), { key: "T", code: "KeyT", altKey: true, shiftKey: true });
    await flush();
    expect(review()).not.toBeNull();
    expect(shown()).toBe(label(kind));
  });

  it.each(["agent", "terminal", "browser"] as const)("a new %s tab replaces the review, and reopening an agent selects its transcript", async (kind) => {
    render(<TabsHarness reviews />);
    act(() => { openReview("diff"); });
    const row = workspaceRow(getSessionStore().sessions.find((s) => s.id === "a")!);
    await act(() => newTab(row, kind === "agent" ? { kind, harness: "claude", mode: "bypassPermissions" } : { kind }));
    expect(review()).toBeNull();
    expect(getTerminalState().selected.a.kind).toBe(kind);
    // Close an agent, open a review, then reopen the agent via its real shortcut.
    press(composer(), digit(2));
    press(composer(), { key: "w", code: "KeyW" });
    await flush();
    chooseReview("diff");
    press(review()!, { key: "T", code: "KeyT", altKey: true, shiftKey: true });
    await flush();
    expect(review()).toBeNull();
    expect(shown()).toBe("Fix flaky test");
  });

  it.each(["terminal", "browser"] as const)("closes the selected %s after leaving a review", async (kind) => {
    render(<TabsHarness reviews />);
    act(() => { openReview("diff"); });
    const target = kind === "terminal" ? within(strip()).getByRole("tab", { name: "Terminal 1" })
      : within(strip()).getAllByRole("tab").find((t) => t.getAttribute("aria-description") === "Browser page")!;
    fireEvent.click(target);
    await flush();
    press(composer(), { key: "w", code: "KeyW" });
    await flush();
    expect(backend.callsOf(kind === "terminal" ? "pty_kill" : "browser_close_page")).toHaveLength(1);
    expect(getEditors().editors).toHaveLength(1);
  });

  it("keeps a dirty review selected when closing is cancelled", async () => {
    render(<TabsHarness reviews />);
    act(() => { setEditorDirty(openReview("diff"), true); });
    vi.mocked(ask).mockResolvedValueOnce(false);
    press(review()!, { key: "w", code: "KeyW" });
    await flush();
    expect(review()).not.toBeNull();
    expect(shown()).toBe(label("diff"));
  });

  it.each(["agent", "terminal", "browser", "review"] as const)("restores a saved %s selection without putting another review on top", (kind) => {
    render(<TabsHarness reviews />);
    let id = "";
    act(() => { id = openReview("pr"); });
    const selected = { kind, id: kind === "agent" ? "a2" : kind === "terminal" ? shell : kind === "browser" ? "page-feature" : id };
    act(() => selectSessionTab("a", selected));
    const saved = localStorage.getItem("terminalx:selected-tabs:v1");
    act(() => selectSessionTab("a", { kind: "review", id }));
    act(() => selectSessionTab("a", restoreSessionTabSelection(saved).a));
    expect(getTerminalState().selected.a).toEqual(selected);
    expect(review() !== null).toBe(kind === "review");
  });
});

// #980: a tab shows its account only when its agent has several.
describe("the tab's agent account", () => {
  const WORK = "0123456789abcdef";
  const account = (agent: "claude" | "codex", id: string, label: string, email: string | null = null) =>
    ({ id, agent, kind: "subscription" as const, label, email, plan: null, organization: null, local: id === "local", isDefault: id === "local", missing: false, addedAt: null });
  const tab = (harness: string, fields: Record<string, unknown> = {}) => ({ id: `t-${harness}`, harness, title: "Fix it", status: "idle", model: "m", permissionMode: "manual", created: "", ...fields }) as unknown as import("@/types/session").TabEntry;
  const marks = (tabs: import("@/types/session").TabEntry[]) => {
    render(<>{tabs.map((t) => <div key={t.id} data-tab={t.id}><TabAccountMark tab={t} /><TabAccountLabel tab={t} /></div>)}</>);
  };
  beforeEach(() => forgetAgentAccounts());

  it("draws nothing with one account", async () => {
    act(() => takeAgentAccounts({ agent: "claude", accounts: [account("claude", "local", "This Mac's login")], defaultAccount: "local", projectDefaults: {} }));
    marks([tab("claude"), tab("claude", { id: "t-2", account: "local" })]);
    await flush();
    expect(screen.queryByTestId("tab-account-mark")).toBeNull();
    expect(screen.queryByTestId("tab-account-label")).toBeNull();
  });

  it("marks each tab with its account when the agent has several, and names it in the header", async () => {
    act(() => takeAgentAccounts({ agent: "claude", accounts: [account("claude", "local", "This Mac's login"), account("claude", WORK, "Work · Max", "work@example.com")], defaultAccount: "local", projectDefaults: {} }));
    act(() => takeAgentAccounts({ agent: "codex", accounts: [account("codex", "local", "This Mac's login")], defaultAccount: "local", projectDefaults: {} }));
    marks([tab("claude", { launchedAccount: WORK }), tab("claude", { id: "t-local" }), tab("codex")]);
    await flush();
    const [work, local] = screen.getAllByTestId("tab-account-mark");
    expect(screen.getAllByTestId("tab-account-mark")).toHaveLength(2);
    expect(work.getAttribute("aria-label")).toBe("On Work · Max");
    expect(work.textContent).toBe("W");
    // A tab that names no account runs on This Mac's login: any other is recorded at launch.
    expect(local.getAttribute("aria-label")).toBe("On This Mac's login");
    expect(screen.getAllByTestId("tab-account-label").map((label) => label.textContent)).toEqual(["Work · Max", "This Mac's login"]);
    // Codex has one account: its tab is drawn as before accounts.
    expect(document.querySelector('[data-tab="t-codex"]')!.textContent).toBe("");
  });

  // PRO-408: a machine session's tab names what the machine says, never this computer's account.
  it("names a machine session's tab by the account its machine names, and this computer's accounts say nothing of it", async () => {
    act(() => takeAgentAccounts({ agent: "claude", accounts: [account("claude", "local", "This Mac's login"), account("claude", WORK, "Work · Max")], defaultAccount: "local", projectDefaults: {} }));
    marks([
      tab("claude", { id: "t-on-machine", accountLabel: "ops@acme.dev · team" }),
      // One account there: nothing, even though this computer has two for Claude Code.
      tab("claude", { id: "t-one-there", accountLabel: null }),
    ]);
    await flush();
    expect(screen.getAllByTestId("tab-account-mark").map((mark) => mark.getAttribute("aria-label"))).toEqual(["On ops@acme.dev · team"]);
    expect(screen.getByTestId("tab-account-mark").textContent).toBe("O");
    expect(screen.getAllByTestId("tab-account-label").map((label) => label.textContent)).toEqual(["ops@acme.dev · team"]);
    expect(document.querySelector('[data-tab="t-one-there"]')!.textContent).toBe("");
  });

  it("marks the agent tabs in the workspace's row of tabs, and not a cloud session's", async () => {
    act(() => takeAgentAccounts({ agent: "claude", accounts: [account("claude", "local", "This Mac's login"), account("claude", WORK, "Work · Max")], defaultAccount: "local", projectDefaults: {} }));
    act(() => takeAgentAccounts({ agent: "codex", accounts: [account("codex", "local", "This Mac's login")], defaultAccount: "local", projectDefaults: {} }));
    const { unmount } = render(<TabsHarness />);
    await flush();
    const markOf = (name: string) => within(within(strip()).getAllByRole("tab").find((item) => item.getAttribute("aria-label") === name)!).queryByTestId("tab-account-mark");
    // Session a: two Claude tabs (on This Mac's login) and a Codex tab, whose agent has one account.
    expect(markOf(LONG)?.getAttribute("aria-label")).toBe("On This Mac's login");
    expect(markOf("Review")?.getAttribute("aria-label")).toBe("On This Mac's login");
    expect(markOf("Fix flaky test")).toBeNull();
    unmount();
    // A cloud session's tabs run on its machine's logins, not this computer's accounts.
    const { WorkspaceTabStrip } = await import("@/components/session/WorkspaceTabStrip");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    render(<TooltipProvider><WorkspaceTabStrip session={getSessionStore().sessions.find((item) => item.id === "a")!} selected={null} accounts={false} /></TooltipProvider>);
    await flush();
    expect(screen.queryByTestId("tab-account-mark")).toBeNull();
  });
});
