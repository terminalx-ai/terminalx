import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
import { refreshDataPrivacy } from "@/lib/dataPrivacy";
import { AccountAvatar } from "./AccountAvatar";

afterEach(cleanup);

it.each([false, true])("withdraws service and fallback pictures under privacy (managed=%s), then restores them", async (managed) => {
  mocks.invoke.mockResolvedValue({ enabled: false, managed: false });
  await refreshDataPrivacy();
  render(<AccountAvatar identity={{ name: "Ada", email: "ada@example.test", picture: "https://img.example/ada.png" }} />);
  expect(screen.getByTestId("account-picture").getAttribute("src")).toBe("https://img.example/ada.png");
  mocks.invoke.mockResolvedValue({ enabled: true, managed });
  await act(() => refreshDataPrivacy());
  expect(screen.queryByTestId("account-picture")).toBeNull();
  mocks.invoke.mockResolvedValue({ enabled: false, managed: false });
  await act(() => refreshDataPrivacy());
  fireEvent.error(screen.getByTestId("account-picture"));
  expect(screen.getByTestId("account-picture").getAttribute("src")).toContain("avatars.githubusercontent.com");
  mocks.invoke.mockResolvedValue({ enabled: true, managed });
  await act(() => refreshDataPrivacy());
  expect(screen.queryByTestId("account-picture")).toBeNull();
  mocks.invoke.mockResolvedValue({ enabled: false, managed: false });
  await act(() => refreshDataPrivacy());
  expect(screen.getByTestId("account-picture").getAttribute("src")).toContain("avatars.githubusercontent.com");
});
