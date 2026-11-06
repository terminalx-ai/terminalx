import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (original) => ({ ...(await original<object>()), invoke: native }));

import { getDataPrivacy, privacyBlocksCommand, refreshDataPrivacy, setDataPrivacy } from "./dataPrivacy";
import { invoke } from "./api";

beforeEach(async () => {
  native.mockResolvedValue({ enabled: false, managed: false });
  await refreshDataPrivacy();
  native.mockClear();
});

describe("data privacy command boundary", () => {
  it("blocks queued cloud, organisation, pairing and sign-in actions before IPC", async () => {
    native.mockResolvedValueOnce({ enabled: true, managed: false });
    await setDataPrivacy(true);
    native.mockClear();
    for (const command of ["cloud_workspaces", "cloud_catalog_feed", "cloud_remote_send", "cloud_agent_enqueue", "organization_create", "organization_workspace_config", "pairing_generate", "account_sign_in"]) {
      await expect(invoke(command)).rejects.toThrow("Turned off by data privacy mode");
    }
    expect(native).not.toHaveBeenCalled();
    expect(privacyBlocksCommand("account_status")).toBe(false);
    expect(privacyBlocksCommand("cloud_remote_detach")).toBe(false);
    expect(privacyBlocksCommand("session_send")).toBe(false);
  });

  it("restores actions after disable without asking to sign in", async () => {
    native.mockResolvedValueOnce({ enabled: true, managed: false });
    await setDataPrivacy(true);
    native.mockResolvedValueOnce({ enabled: false, managed: false });
    await setDataPrivacy(false);
    await invoke("cloud_workspaces");
    expect(native).toHaveBeenLastCalledWith("cloud_workspaces");
    expect(native.mock.calls.some(([command]) => command === "account_sign_in" || command === "account_sign_out")).toBe(false);
  });

  it("keeps networking off if the policy cannot be read, and recovers", async () => {
    native.mockRejectedValueOnce(new Error("unavailable"));
    await refreshDataPrivacy();
    expect(getDataPrivacy()).toMatchObject({ enabled: true, ready: false });
    native.mockResolvedValueOnce({ enabled: false, managed: false });
    await refreshDataPrivacy();
    expect(getDataPrivacy().enabled).toBe(false);
  });

  it("ignores a status read from before a completed toggle", async () => {
    let finish!: (value: { enabled: boolean; managed: boolean }) => void;
    native.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const oldRead = refreshDataPrivacy();
    native.mockResolvedValueOnce({ enabled: true, managed: false });
    await setDataPrivacy(true);
    finish({ enabled: false, managed: false });
    await oldRead;
    expect(getDataPrivacy().enabled).toBe(true);
  });
});

it("reports the applied off state with an owner synchronization error", async () => {
  native.mockResolvedValueOnce({ enabled: true, managed: false });
  await setDataPrivacy(true);
  native.mockResolvedValueOnce({ enabled: false, managed: false, error: "Owner unavailable" });
  await setDataPrivacy(false);
  expect(getDataPrivacy()).toMatchObject({ enabled: false, ready: true, error: "Owner unavailable" });
  expect(privacyBlocksCommand("cloud_workspaces")).toBe(false);
  native.mockResolvedValueOnce({ enabled: false, managed: false, error: "Owner unsupported" });
  await refreshDataPrivacy();
  expect(getDataPrivacy()).toMatchObject({ enabled: false, ready: true, error: "Owner unsupported" });
});
