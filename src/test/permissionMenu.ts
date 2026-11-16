import { fireEvent, screen, waitFor, within } from "@testing-library/react";

/** The composer's permission chip (the mode's label and lock are on it). */
export async function permissionEntry(): Promise<HTMLElement> {
  return screen.findByTestId("permission-mode");
}

/** Open the permission chip's menu and return it. */
export async function openPermissionModes(): Promise<HTMLElement> {
  fireEvent.keyDown(await permissionEntry(), { key: "Enter" });
  return waitFor(() => {
    const menu = screen.getAllByRole("menu").find((m) => within(m).queryAllByRole("menuitemradio").length > 0);
    if (!menu) throw new Error("the permission menu is not open");
    return menu;
  });
}
