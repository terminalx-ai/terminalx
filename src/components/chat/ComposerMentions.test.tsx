import "@testing-library/dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabEntry } from "@/types/session";

const { dragDropListener, invoke, openDialog } = vi.hoisted(() => ({ dragDropListener: vi.fn(), invoke: vi.fn(), openDialog: vi.fn() }));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: dragDropListener }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialog }));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/components/chat/Dictation", () => ({
  DictationStatus: () => null,
  // Only what the composer hands it: whether dictating into this composer is off.
  MicButton: ({ disabled }: { disabled?: boolean }) => (disabled === undefined ? null : <button aria-label="Dictate" disabled={disabled} />),
  useDictationInto: () => ({ dictating: false, toggle: vi.fn(), prepareSend: vi.fn(() => vi.fn()) }),
  useDictationShortcuts: vi.fn(),
}));
vi.mock("@/lib/hotkeys", () => ({ keycaps: () => [], useHotkey: vi.fn(), useShortcut: vi.fn(), useShortcutKeys: () => [], useShortcutKeycaps: () => () => [] }));
const listed = vi.hoisted(() => ({ models: [] as import("@/lib/api").ModelInfo[], loaded: false }));
vi.mock("@/lib/models", async (original) => ({
  // The pure helpers stay real; only the list and its loading are stubbed.
  ...(await original<typeof import("@/lib/models")>()),
  EFFORT_LABEL: {},
  PERMISSION_MODES: [{ id: "auto", label: "Auto", hint: "" }],
  refreshModels: vi.fn(),
  upgradeHint: () => null,
  useModels: () => listed.models,
  useModelsLoaded: () => listed.loaded,
}));
vi.mock("@/lib/dialogs", () => ({ chooseMode: vi.fn() }));

const roster = vi.hoisted(() => ({ people: [] as import("@/lib/mentions").MentionPerson[] }));
vi.mock("./useMentionPeople", () => ({ useMentionPeople: (orgId?: string | null) => (orgId ? roster.people : []) }));

const { Composer } = await import("./Composer");
const { MentionChip } = await import("./ComposerMentions");
import type { ComposerPeople } from "@/lib/mentionSends";

const tab: TabEntry = { id: "tab-1", harness: "codex", model: "default", permissionMode: "auto", status: "idle", created: "2026-09-04T00:00:00Z", modified: "2026-09-04T00:00:00Z" };
const aisha = { userId: "u-aisha", name: "Aisha Khan", email: "aisha@example.test", role: "member" };
const sam = { userId: "u-sam", name: "Sam Rivera", email: "sam@example.test", role: "member" };

function source(overrides: Partial<ComposerPeople> = {}): ComposerPeople {
  return {
    key: "org:ws:s-1", orgId: "org", workspaceId: "ws", sessionId: "s-1", collabKey: "cloud:org:ws", selfUserId: "me",
    workspaceName: () => "Push org events",
    check: vi.fn(async () => []),
    record: vi.fn(async () => []),
    share: vi.fn(),
    ...overrides,
  };
}

function Harness({ people, onSend, files }: { people: ComposerPeople | null; onSend: (text: string) => void; files?: boolean }) {
  const [draft, setDraft] = useState("");
  const search = async () => [{ path: "src/a.ts", name: "a.ts", score: 1 }];
  return <Composer tab={tab} people={people} files={files ? { key: "cloud:org:ws|s-1", search } : null} busy={false} draft={draft} onDraftChange={setDraft}
    onSend={(text) => onSend(text)} sentAfter={() => 41} onStop={vi.fn()} onSetModel={vi.fn()} onSetEffort={vi.fn()} onSetMode={vi.fn()} />;
}

beforeEach(() => { roster.people = [aisha, sam]; invoke.mockResolvedValue([]); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(cleanup);

describe("@ mentions in the composer (PRO-141)", () => {
  it("lists people above files, and a picked person goes in as @Name with a chip", async () => {
    render(<Harness people={source()} onSend={vi.fn()} files />);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "@", selectionStart: 1 } });
    // Files arrive after a short search; people are there at once.
    await waitFor(() => expect(screen.getAllByTestId("picker-section").map((s) => s.textContent)).toEqual(["People", "Files"]));
    const options = await screen.findAllByRole("option");
    expect(options[0].textContent).toContain("Aisha Khan");
    expect(options[0].textContent).toContain("aisha@example.test");
    await waitFor(() => expect(screen.getAllByRole("option").at(-1)!.textContent).toContain("a.ts"));
    expect(screen.getByTestId("picker-footer").textContent).toContain("starts following this workspace");
    fireEvent.change(box, { target: { value: "ping @sa", selectionStart: 8 } });
    await waitFor(() => expect(screen.getAllByRole("option")[0].textContent).toContain("Sam Rivera"));
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("ping @Sam Rivera ");
    const chips = within(screen.getByTestId("composer-mentions")).getAllByTestId("mention-chip");
    expect(chips.map((chip) => chip.getAttribute("data-user-id"))).toEqual(["u-sam"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove mention of Sam Rivera" }));
    expect(box.value).toBe("ping ");
    expect(screen.queryByTestId("composer-mentions")).toBeNull();
  });

  it("checks access first, sends plain @Name text, then records ids only", async () => {
    const people = source();
    const onSend = vi.fn();
    render(<Harness people={people} onSend={onSend} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "@Aisha Khan can you check the widths?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("@Aisha Khan can you check the widths?"));
    expect(people.check).toHaveBeenCalledWith(["u-aisha"], "tab-1");
    await waitFor(() => expect(people.record).toHaveBeenCalledWith(["u-aisha"], "tab-1", "@Aisha Khan can you check the widths?", 41));
  });

  it("without access: shows 14.07's warning with Share, and sends and records nothing", async () => {
    const people = source({ check: vi.fn(async () => ["u-sam"]) });
    const onSend = vi.fn();
    render(<Harness people={people} onSend={onSend} />);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "@Sam Rivera take a look" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const warning = await screen.findByTestId("mention-refused");
    expect(warning.textContent).toContain("Sam Rivera can't follow Push org events yet. Share it with them, then mention them again.");
    expect(onSend).not.toHaveBeenCalled();
    expect(people.record).not.toHaveBeenCalled();
    expect(box.value).toBe("@Sam Rivera take a look");
    fireEvent.click(within(warning).getByRole("button", { name: "Share" }));
    expect(people.share).toHaveBeenCalledOnce();
  });

  it("does not send when the check cannot be made", async () => {
    const onSend = vi.fn();
    render(<Harness people={source({ check: vi.fn(async () => { throw new Error("offline"); }) })} onSend={onSend} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "@Sam Rivera hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByTestId("mention-refused")).textContent).toContain("nothing was sent");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("over the mention budget: says so on the check and sends nothing, or says the mention went undelivered after the send", async () => {
    const tooFast = { code: "cloud_workspace_rate_limited", status: 429 };
    const onSend = vi.fn();
    render(<Harness people={source({ check: vi.fn(async () => { throw tooFast; }) })} onSend={onSend} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "@Sam Rivera hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const checked = await screen.findByTestId("mention-refused");
    expect(checked.textContent).toBe("You're sending mentions too fast, so nothing was sent. Wait a minute, then try again.");
    expect(within(checked).queryByRole("button", { name: "Share" })).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
    cleanup();

    const people = source({ record: vi.fn(async () => { throw tooFast; }) });
    render(<Harness people={people} onSend={onSend} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "@Sam Rivera hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("@Sam Rivera hi"));
    expect((await screen.findByTestId("mention-refused")).textContent).toBe("Your message was sent, but you're sending mentions too fast, so nobody was told about this mention.");
  });

  it("says nothing more when recording fails for another reason", async () => {
    const people = source({ record: vi.fn(async () => { throw new Error("offline"); }) });
    const onSend = vi.fn();
    render(<Harness people={people} onSend={onSend} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "@Sam Rivera hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(people.record).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByTestId("mention-refused")).toBeNull();
  });

  it("keeps files-only behaviour where mentions are not offered", async () => {
    roster.people = [];
    const onSend = vi.fn();
    render(<Harness people={source()} onSend={onSend} files />);
    expect(screen.getByRole("button", { name: "Mention a file" })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "@Sam Rivera hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
  });

  it("draws the transcript chip as the design's: avatar and name, copying as @Name", () => {
    render(<p><MentionChip person={aisha} /></p>);
    const chip = screen.getByTestId("mention-chip");
    expect(chip.className).toContain("bg-mention/15");
    // The avatar, then the name; the hidden @ makes a copy read as typed.
    expect(chip.textContent).toMatch(/@Aisha Khan$/);
  });
});
