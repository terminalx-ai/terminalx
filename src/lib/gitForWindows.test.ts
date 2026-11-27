import { afterEach, describe, expect, it, vi } from "vitest";

// Missing Git for Windows is said once at start, on Windows only, with where to get it.
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));

const { checkGitForWindows, GIT_FOR_WINDOWS_URL } = await import("./gitForWindows");
const { dismissErrorKey, getErrorToasts } = await import("./errorToasts");

afterEach(() => {
  dismissErrorKey("git-for-windows");
  vi.clearAllMocks();
});

describe("checkGitForWindows", () => {
  it("raises one warning with the download link when sh.exe is missing on Windows", async () => {
    mocks.invoke.mockResolvedValue(true);
    expect(await checkGitForWindows(true)).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("posix_shell_missing");
    const toast = getErrorToasts().find((entry) => entry.key === "git-for-windows")!;
    expect(toast.title).toBe("Install Git for Windows");
    expect(toast.tone).toBe("warning");
    toast.actions![0].run();
    expect(mocks.openUrl).toHaveBeenCalledWith(GIT_FOR_WINDOWS_URL);
  });

  it("says nothing when Git for Windows is there, or off Windows", async () => {
    mocks.invoke.mockResolvedValue(false);
    expect(await checkGitForWindows(true)).toBe(false);
    expect(await checkGitForWindows(false)).toBe(false);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(getErrorToasts().some((entry) => entry.key === "git-for-windows")).toBe(false);
  });
});
