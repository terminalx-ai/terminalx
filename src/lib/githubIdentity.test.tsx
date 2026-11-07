import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ identity: vi.fn(), native: vi.fn() }));
vi.mock("@/lib/api", () => ({ issues: { githubIdentity: calls.identity } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: calls.native }));

import { refreshDataPrivacy, setDataPrivacy } from "./dataPrivacy";
import { refreshGithubIdentity, useGithubIdentity } from "./githubIdentity";
import type { GithubIdentity } from "./api";

const local: GithubIdentity = { login: null, source: null, email: "local@example.test", repo: "privacy/fixture", remoteHost: "github" };
const connected: GithubIdentity = { ...local, login: "reader", source: "ssh" };

beforeEach(async () => {
  calls.identity.mockReset();
  calls.native.mockReset().mockResolvedValue({ enabled: false, managed: false });
  await refreshDataPrivacy();
});
afterEach(cleanup);

async function policy(enabled: boolean, managed = false) {
  calls.native.mockResolvedValue({ enabled, managed });
  await act(() => setDataPrivacy(enabled));
}

it.each([false, true])("keeps local identity metadata on mount while privacy is on (managed=%s) and refreshes after disable", async (managed) => {
  await policy(true, managed);
  calls.identity.mockResolvedValue(local);
  const { result } = renderHook(() => useGithubIdentity(`/privacy-mount-${managed}`));
  await waitFor(() => expect(result.current).toEqual(local));
  expect(calls.identity).toHaveBeenCalledTimes(1);
  // Native identity owns the subprocess gate; this read still gives us local metadata.
  calls.identity.mockResolvedValue(connected);
  await policy(false);
  await waitFor(() => expect(result.current).toEqual(connected));
  expect(calls.identity).toHaveBeenLastCalledWith(`/privacy-mount-${managed}`, true);
  expect(calls.identity).toHaveBeenCalledTimes(2);
});

it("shares a pending lookup between headers", async () => {
  calls.identity.mockResolvedValue(connected);
  const { result } = renderHook(() => [useGithubIdentity("/shared-privacy"), useGithubIdentity("/shared-privacy/")]);
  await waitFor(() => expect(result.current).toEqual([connected, connected]));
  expect(calls.identity).toHaveBeenCalledTimes(1);
});

it("withdraws late answers across activation and off/on restoration", async () => {
  calls.identity.mockResolvedValue(local);
  const { result } = renderHook(() => useGithubIdentity("/late-privacy"));
  calls.identity.mockResolvedValue(local);
  let finish!: (identity: GithubIdentity) => void;
  calls.identity.mockImplementationOnce(() => new Promise<GithubIdentity>((resolve) => { finish = resolve; }));
  const stale = refreshGithubIdentity("/late-privacy");
  const refused = expect(stale).rejects.toThrow("Turned off by data privacy mode");
  await policy(true);
  await waitFor(() => expect(result.current).toEqual(local));
  calls.identity.mockResolvedValue({ ...connected, login: "restored" });
  await policy(false);
  await waitFor(() => expect(result.current?.login).toBe("restored"));
  await act(async () => { finish(connected); await refused; });
  expect(result.current?.login).toBe("restored");
});

it("waits for a known native policy before startup or explicit refresh", async () => {
  calls.native.mockRejectedValueOnce(new Error("owner unavailable"));
  await act(() => refreshDataPrivacy());
  calls.identity.mockResolvedValue(connected);
  const { result } = renderHook(() => useGithubIdentity("/unready-privacy"));
  await expect(refreshGithubIdentity("/unready-privacy")).rejects.toThrow("Could not verify data privacy mode");
  expect(calls.identity).not.toHaveBeenCalled();
  await policy(false);
  await waitFor(() => expect(result.current).toEqual(connected));
  expect(calls.identity).toHaveBeenCalledTimes(1);
});
