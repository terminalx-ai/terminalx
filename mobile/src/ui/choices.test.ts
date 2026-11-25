import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  os: "android" as string,
  sheet: vi.fn(),
  alert: vi.fn(),
}));
vi.mock("react-native", () => ({
  Platform: { get OS() { return native.os; } },
  ActionSheetIOS: { showActionSheetWithOptions: native.sheet },
  Alert: { alert: native.alert },
}));

const { showChoices } = await import("./choices");
const { keyboardEvents } = await import("./keyboard");

beforeEach(() => {
  native.sheet.mockReset();
  native.alert.mockReset();
});

describe("a chooser on the phone", () => {
  it("the + button opens a chooser on Android instead of the iOS sheet", () => {
    native.os = "android";
    const choose = vi.fn();
    showChoices("Add attachment", ["Photo Library", "Choose File", "Worktree note"], choose);
    expect(native.sheet).not.toHaveBeenCalled();
    const [title, , buttons, options] = native.alert.mock.calls[0]!;
    expect(title).toBe("Add attachment");
    expect(buttons.map((button: { text: string }) => button.text)).toEqual(["Photo Library", "Choose File", "Worktree note"]);
    expect(options).toEqual({ cancelable: true });
    buttons[1].onPress();
    expect(choose).toHaveBeenCalledWith("Choose File");
  });

  it("keeps the iOS sheet, with Cancel last and picking nothing", () => {
    native.os = "ios";
    const choose = vi.fn();
    showChoices("Add attachment", ["Photo Library", "Choose File"], choose);
    expect(native.alert).not.toHaveBeenCalled();
    const [options, picked] = native.sheet.mock.calls[0]!;
    expect(options).toEqual({ options: ["Photo Library", "Choose File", "Cancel"], cancelButtonIndex: 2 });
    picked(2);
    expect(choose).not.toHaveBeenCalled();
    picked(0);
    expect(choose).toHaveBeenCalledWith("Photo Library");
  });
});

describe("the keyboard", () => {
  it("follows keyboardDidShow on Android, where no Will events come", () => {
    expect(keyboardEvents("android")).toEqual({ show: "keyboardDidShow", hide: "keyboardDidHide" });
    expect(keyboardEvents("ios")).toEqual({ show: "keyboardWillShow", hide: "keyboardWillHide" });
  });
});
