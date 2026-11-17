import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SettingsFileLayer } from "@/types/settingsSources";
import { ProjectSettingsFiles } from "./SettingsFiles";

const mocks = vi.hoisted(() => ({ files: vi.fn(), readText: vi.fn(), listen: vi.fn(), watch: vi.fn() }));
vi.mock("@/lib/configuration", () => ({ configuration: { files: mocks.files, watch: mocks.watch } }));
vi.mock("@/lib/api", () => ({ fs: { readText: mocks.readText } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("./SettingSources", () => ({
  openSettingsPath: vi.fn(), ProblemSentence: () => null, shortFileName: (path: string) => path,
}));

const file = (project = "/a"): SettingsFileLayer => ({
  layer: "repositoryShared", path: `${project}/settings.json`, displayPath: `${project}/settings.json`,
  exists: true, keys: 1, git: "committed", problem: null,
});
const read = (value: string) => ({ binary: false, content: `{"branchPrefix":"${value}"}` });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let userChanged: () => void;
let projectChanged: () => void;
let stopUser: ReturnType<typeof vi.fn<() => void>>;
let stopProject: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  stopUser = vi.fn();
  stopProject = vi.fn();
  mocks.listen.mockImplementation(async (_name, callback) => { userChanged = callback; return stopUser; });
  mocks.watch.mockImplementation(async (_path, callback) => { projectChanged = callback; return stopProject; });
  mocks.files.mockImplementation(async (project) => [file(project)]);
  mocks.readText.mockResolvedValue(read("old"));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function open() {
  const view = render(<ProjectSettingsFiles projectPath="/a" />);
  await act(async () => {});
  await act(async () => fireEvent.click(screen.getByRole("button", { expanded: false })));
  return view;
}
async function change(callback = projectChanged) {
  await act(async () => { callback(); await vi.advanceTimersByTimeAsync(150); });
}
const content = () => screen.getByLabelText("Contents of /a/settings.json").textContent;

it.each(["project", "user"])("refreshes an expanded file after a %s event with unchanged metadata", async (source) => {
  await open();
  expect(content()).toContain('"old"');
  mocks.readText.mockResolvedValue(read("edited"));
  await change(source === "user" ? userChanged : projectChanged);
  expect(content()).toContain('"edited"');
  expect(screen.getByRole("button", { expanded: true })).toBeTruthy();
});

it("debounces rapid events and ignores older reads that finish last", async () => {
  await open();
  const older = deferred<ReturnType<typeof read>>();
  mocks.readText.mockReturnValueOnce(older.promise);
  await change();
  mocks.readText.mockResolvedValue(read("newest"));
  await act(async () => {
    projectChanged(); userChanged(); projectChanged();
    await vi.advanceTimersByTimeAsync(150);
  });
  expect(mocks.readText).toHaveBeenCalledTimes(3);
  expect(content()).toContain('"newest"');
  await act(async () => older.resolve(read("stale")));
  expect(content()).toContain('"newest"');
});

it("ignores metadata requests that finish after a newer reload", async () => {
  await open();
  const older = deferred<SettingsFileLayer[]>();
  mocks.files.mockReturnValueOnce(older.promise);
  await change();
  mocks.readText.mockResolvedValue(read("newest"));
  await change();
  await act(async () => older.resolve([file("/stale")]));
  expect(content()).toContain('"newest"');
  expect(screen.queryByText("/stale/settings.json")).toBeNull();
});

it("drops old contents and pending reads/reloads when switching projects", async () => {
  const view = await open();
  const oldRead = deferred<ReturnType<typeof read>>();
  mocks.readText.mockReturnValueOnce(oldRead.promise);
  await change();
  const oldList = deferred<SettingsFileLayer[]>();
  mocks.files.mockReturnValueOnce(oldList.promise);
  await change();
  const newList = deferred<SettingsFileLayer[]>();
  mocks.files.mockReturnValueOnce(newList.promise);
  const oldChanged = projectChanged;
  view.rerender(<ProjectSettingsFiles projectPath="/b" />);
  expect(screen.queryByLabelText("Contents of /a/settings.json")).toBeNull();
  expect(stopUser).toHaveBeenCalledTimes(1);
  expect(stopProject).toHaveBeenCalledTimes(1);
  await act(async () => { oldRead.resolve(read("stale")); oldList.resolve([file()]); });
  expect(screen.queryByRole("button")).toBeNull();
  await act(async () => newList.resolve([file("/b")]));
  mocks.readText.mockResolvedValue(read("project-b"));
  await act(async () => fireEvent.click(screen.getByRole("button", { expanded: false })));
  expect(screen.getByLabelText("Contents of /b/settings.json").textContent).toContain('"project-b"');
  const calls = mocks.files.mock.calls.length;
  await change(oldChanged);
  expect(mocks.files).toHaveBeenCalledTimes(calls);
});

it("clears a previous read error after the file becomes readable", async () => {
  mocks.readText.mockRejectedValueOnce(new Error("temporarily unavailable"));
  await open();
  expect(screen.getByRole("alert").textContent).toBe("temporarily unavailable");
  await change();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(content()).toContain('"old"');
});

it("cleans up late listener registrations and queued reloads on unmount", async () => {
  const user = deferred<() => void>();
  const project = deferred<() => void>();
  mocks.listen.mockReturnValueOnce(user.promise);
  mocks.watch.mockReturnValueOnce(project.promise);
  const view = await open();
  const changed = mocks.watch.mock.calls[0][1] as () => void;
  act(() => changed());
  view.unmount();
  await act(async () => { user.resolve(stopUser); project.resolve(stopProject); await vi.advanceTimersByTimeAsync(150); });
  expect(stopUser).toHaveBeenCalledTimes(1);
  expect(stopProject).toHaveBeenCalledTimes(1);
  expect(mocks.files).toHaveBeenCalledTimes(1);
});
