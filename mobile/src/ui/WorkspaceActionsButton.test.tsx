// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { ActionSheetIOS, Alert, Platform } from "react-native";
import type { RowAction } from "./row-actions";
import { stage } from "./testing/kit";
import { WorkspaceActionsButton } from "./WorkspaceActionsButton";

// PRO-542: the ••• in a workspace's header, which opens the row's action sheet (25.06).
vi.mock("react-native", () => import("@mobile/ui/testing/native"));
vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()));
vi.mock("lucide-react-native", async () => (await import("@mobile/ui/testing/kit")).namedIcons());

const page = stage();
const sheet = vi.mocked(ActionSheetIOS.showActionSheetWithOptions);
const alert = vi.mocked(Alert.alert);
const stop = vi.fn();
const remove = vi.fn();
const actions: RowAction[] = [{ name: "stop", label: "Stop workspace", run: stop }, { name: "delete", label: "Delete workspace…", run: remove, destructive: true }];
const button = () => page.byId("workspace-actions");

beforeEach(() => { sheet.mockReset(); alert.mockReset(); stop.mockReset(); remove.mockReset(); (Platform as { OS: string }).OS = "ios"; });

it("is the round glass button with the ••• mark, named for what it opens", async () => {
  await page.show(<WorkspaceActionsButton title="Checkout redesign" actions={actions} />);
  expect(button()!.getAttribute("role")).toBe("button");
  expect(button()!.getAttribute("aria-label")).toBe("Workspace actions");
  expect(page.icon("MoreHorizontal")!.dataset).toMatchObject({ size: "20", color: "#f4ecee" });
  expect(page.styleOf(button()!.firstElementChild)).toMatchObject({ width: 40, height: 40, borderRadius: 20 });
});

it("is not drawn for someone with nothing to do to the workspace", async () => {
  await page.show(<WorkspaceActionsButton title="Checkout redesign" actions={[]} />);
  expect(page.container.innerHTML).toBe("");
});

it("opens the system's sheet under the workspace's title, with Delete in red and Cancel last", async () => {
  await page.show(<WorkspaceActionsButton title="Checkout redesign" actions={actions} />);
  await page.press(button());
  expect(sheet).toHaveBeenCalledTimes(1);
  expect(sheet.mock.calls[0][0]).toEqual({ title: "Checkout redesign", options: ["Stop workspace", "Delete workspace…", "Cancel"], cancelButtonIndex: 2, destructiveButtonIndex: [1] });
  expect(stop).not.toHaveBeenCalled();
  sheet.mock.calls[0][1](1);
  expect(remove).toHaveBeenCalledTimes(1);
  sheet.mock.calls[0][1](2);
  expect(stop).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledTimes(1);
});

it("marks nothing red in a sheet that deletes nothing", async () => {
  await page.show(<WorkspaceActionsButton title="Billing export" actions={[{ name: "start", label: "Start workspace", run: stop }]} />);
  await page.press(button());
  expect(sheet.mock.calls[0][0]).toEqual({ title: "Billing export", options: ["Start workspace", "Cancel"], cancelButtonIndex: 1 });
});

it("offers the same actions in an alert where there is no action sheet", async () => {
  (Platform as { OS: string }).OS = "android";
  await page.show(<WorkspaceActionsButton title="Checkout redesign" actions={actions} />);
  await page.press(button());
  expect(sheet).not.toHaveBeenCalled();
  expect(alert).toHaveBeenCalledExactlyOnceWith("Checkout redesign", undefined, [{ text: "Stop workspace", onPress: stop }, { text: "Delete workspace…", onPress: remove, style: "destructive" }, { text: "Cancel", style: "cancel" }]);
});

it("opens nothing while the workspace cannot be acted on", async () => {
  await page.show(<WorkspaceActionsButton title="Checkout redesign" actions={actions} disabled />);
  expect(button()!.getAttribute("aria-disabled")).toBe("true");
  await page.press(button());
  expect(sheet).not.toHaveBeenCalled();
});
