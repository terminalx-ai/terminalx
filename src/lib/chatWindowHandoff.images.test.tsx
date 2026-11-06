import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  emitTo: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("./fileDrop", () => ({ registerFileDropTarget: () => () => {} }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, listener: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(event, listener);
    return () => mocks.listeners.delete(event);
  }),
  emitTo: mocks.emitTo,
}));

beforeEach(() => {
  vi.resetModules();
  mocks.listeners.clear();
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.open.mockReset().mockResolvedValue(["/tmp/shot.png"]);
  mocks.emitTo.mockReset().mockImplementation(async (_target, _event, payload) => {
    mocks.listeners.get("chat-window-drafts-result")?.({ payload: { id: payload.id } });
  });
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: () => "blob:shot", revokeObjectURL: vi.fn() }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function source() {
  const { useImageAttachments } = await import("@/components/chat/useImageAttachments");
  const { openChatWindowInMain } = await import("./chatWindowHandoff");
  const { setDraft } = await import("./drafts");
  const hook = renderHook(() => useImageAttachments({ textareaRef: useRef(null), draft: "", onDraftChange: vi.fn() }));
  const file = new File(["an image"], "shot.png", { type: "image/png" });
  return { hook, file, openChatWindowInMain, setDraft };
}

it.each([false, true])("keeps unsent images in their source window (with text: %s)", async (withText) => {
  const { hook, file, openChatWindowInMain, setDraft } = await source();
  if (withText) setDraft("tab", "Explain this image");
  await act(async () => { await hook.result.current.addFiles([file]); });
  const images = hook.result.current.images;
  // Mirror the native close policy: destroying the source would discard its real hook state.
  mocks.invoke.mockImplementation(async (_command, args) => { if (args.closeSource !== false) hook.unmount(); });
  await act(async () => { await openChatWindowInMain("session", "tab"); });
  expect(mocks.invoke).toHaveBeenCalledWith("chat_window_open_in_main", { sessionId: "session", tabId: "tab", closeSource: false });
  expect(hook.result.current.images).toEqual(images);
  expect(hook.result.current.attachments[0].name).toBe("shot.png");
  expect(mocks.emitTo).not.toHaveBeenCalled(); // Text and images stay together in this composer.
  act(() => hook.result.current.remove(hook.result.current.attachments[0].id));
  expect(hook.result.current.images).toEqual([]); // It is still a live, editable view.
});

it("keeps the source while a native image read is pending", async () => {
  const { hook, openChatWindowInMain } = await source();
  let finish!: (image: { name: string; mediaType: string; data: string }) => void;
  mocks.invoke.mockImplementation((command) => command === "read_image_file"
    ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve());
  let picking!: Promise<void>;
  await act(async () => { picking = hook.result.current.chooseFiles(); });
  await openChatWindowInMain("session", "tab");
  expect(mocks.invoke).toHaveBeenCalledWith("chat_window_open_in_main", { sessionId: "session", tabId: "tab", closeSource: false });
  await act(async () => { finish({ name: "shot.png", mediaType: "image/png", data: "AQID" }); await picking; });
  expect(hook.result.current.images).toEqual([{ name: "shot.png", mediaType: "image/png", data: "AQID" }]);
});

it("keeps images set aside for an unresolved send, including after a failed send restores them", async () => {
  const { hook, file, openChatWindowInMain } = await source();
  await act(async () => { await hook.result.current.addFiles([file]); });
  let aside!: ReturnType<typeof hook.result.current.setAside>;
  act(() => { aside = hook.result.current.setAside(); });
  expect(hook.result.current.attachments).toEqual([]);
  await openChatWindowInMain("session", "tab");
  expect(mocks.invoke).toHaveBeenLastCalledWith("chat_window_open_in_main", { sessionId: "session", tabId: "tab", closeSource: false });
  act(() => aside.settle(false));
  expect(hook.result.current.images).toEqual(aside.images);
});

it("preserves an image that arrives while main is acknowledging a text draft", async () => {
  const { hook, file, openChatWindowInMain, setDraft } = await source();
  setDraft("tab", "A message being handed over");
  mocks.emitTo.mockResolvedValue(undefined);
  const moving = openChatWindowInMain("session", "tab");
  await waitFor(() => expect(mocks.emitTo).toHaveBeenCalledOnce());
  const request = mocks.emitTo.mock.lastCall![2];
  await act(async () => { await hook.result.current.addFiles([file]); });
  mocks.listeners.get("chat-window-drafts-result")?.({ payload: { id: request.id } });
  await moving;
  expect(mocks.invoke).toHaveBeenLastCalledWith("chat_window_open_in_main", { sessionId: "session", tabId: "tab", closeSource: false });
  expect(hook.result.current.attachments[0].name).toBe("shot.png");
});

it("considers other mounted composers and releases their protection on unmount", async () => {
  const inactive = await source();
  const active = await source();
  await act(async () => { await inactive.hook.result.current.addFiles([inactive.file]); });
  await active.openChatWindowInMain("active-session", "active-tab");
  expect(mocks.invoke).toHaveBeenLastCalledWith("chat_window_open_in_main", { sessionId: "active-session", tabId: "active-tab", closeSource: false });
  inactive.hook.unmount();
  await active.openChatWindowInMain("active-session", "active-tab");
  expect(mocks.invoke).toHaveBeenLastCalledWith("chat_window_open_in_main", { sessionId: "active-session", tabId: "active-tab", closeSource: true });
});

it("allows handoff again after the images are removed or their send succeeds", async () => {
  const { hook, file, openChatWindowInMain } = await source();
  await act(async () => { await hook.result.current.addFiles([file]); });
  act(() => hook.result.current.remove(hook.result.current.attachments[0].id));
  await openChatWindowInMain("session", "tab");
  expect(mocks.invoke).toHaveBeenLastCalledWith("chat_window_open_in_main", { sessionId: "session", tabId: "tab", closeSource: true });
  await act(async () => { await hook.result.current.addFiles([file]); });
  let aside!: ReturnType<typeof hook.result.current.setAside>;
  act(() => { aside = hook.result.current.setAside(); });
  act(() => aside.settle(true));
  await openChatWindowInMain("session", "tab");
  expect(mocks.invoke).toHaveBeenLastCalledWith("chat_window_open_in_main", { sessionId: "session", tabId: "tab", closeSource: true });
});
