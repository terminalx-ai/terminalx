// @vitest-environment jsdom
import { act, useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stage } from "@mobile/ui/testing/kit";
import { CloudApiError, type CloudApi } from "../api";
import { useCloudApi, useRead, type ReadOptions, type ReadState } from "./read";

// PRO-522: the reads the setup screens of boards 25.01 to 25.06 share.
const mocks = vi.hoisted(() => ({ catalog: null as { api: unknown } | null, focus: [] as (() => void)[] }));
vi.mock("../CloudProvider", () => ({ useCloudCatalog: () => mocks.catalog }));
// A page in view runs its focus effect once per callback, as the navigator does; `focus()` is it coming back.
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => void) => useEffect(() => { mocks.focus.push(effect); effect(); }, [effect]),
}));
const focus = () => act(async () => { mocks.focus.at(-1)!(); });

const page = stage();
const api = { name: "client" } as unknown as CloudApi;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve: (value: T) => act(async () => { resolve(value); await promise; }), reject: (error: unknown) => act(async () => { reject(error); await promise.catch(() => undefined); }) };
}

// What the hook gave on its last render, handed out after the render as a screen would see it.
let seen: ReadState<string>;
const see = (state: ReadState<string>) => { seen = state; };
function Probe({ read, deps = [], options }: { read: (client: CloudApi) => Promise<string>; deps?: unknown[]; options?: ReadOptions }) {
  const state = useRead(read, deps, options);
  useEffect(() => see(state));
  return <div data-testid="state">{state.state}</div>;
}

beforeEach(() => {
  mocks.catalog = { api };
  mocks.focus = [];
});

describe("useCloudApi", () => {
  it("is the signed-in catalog's client, and null while signed out", async () => {
    let client: CloudApi | null | undefined;
    const keep = (value: CloudApi | null) => { client = value; };
    const Show = () => { const value = useCloudApi(); useEffect(() => keep(value)); return null; };
    await page.show(<Show />);
    expect(client).toBe(api);
    mocks.catalog = null;
    await page.show(<Show key="again" />);
    expect(client).toBeNull();
  });
});

describe("useRead", () => {
  it("is reading until the first answer, then read with that answer, from the signed-in client", async () => {
    const answer = deferred<string>();
    const read = vi.fn(() => answer.promise);
    await page.show(<Probe read={read} />);
    expect(seen).toMatchObject({ state: "reading", value: null, error: null, refreshing: false });
    expect(read).toHaveBeenCalledWith(api);
    await answer.resolve("Northwind");
    expect(seen).toMatchObject({ state: "read", value: "Northwind", error: null, refreshing: false });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("could not be read carries the client's error and no value when nothing was read before", async () => {
    const answer = deferred<string>();
    await page.show(<Probe read={() => answer.promise} />);
    const error = new CloudApiError("cloud_workspace_unavailable", null, "network");
    await answer.reject(error);
    expect(seen).toMatchObject({ state: "could-not-be-read", value: null, refreshing: false });
    expect(seen.error).toBe(error);
  });

  it("keeps what was shown when a refresh fails, and is refreshing while it reads", async () => {
    const answers = [deferred<string>(), deferred<string>(), deferred<string>()];
    let call = 0;
    await page.show(<Probe read={() => answers[call++].promise} />);
    await answers[0].resolve("two providers");

    let done!: Promise<void>;
    await act(async () => { done = seen.refresh(); });
    expect(seen).toMatchObject({ state: "read", value: "two providers", refreshing: true });
    const error = new CloudApiError("cloud_provider_unavailable", 503);
    await answers[1].reject(error);
    await act(async () => { await done; });
    expect(seen).toMatchObject({ state: "could-not-be-read", value: "two providers", refreshing: false });
    expect(seen.error).toBe(error);

    // The next read that works is shown, and the failure is gone.
    await act(async () => { void seen.refresh(); });
    expect(seen).toMatchObject({ state: "could-not-be-read", value: "two providers", refreshing: true });
    await answers[2].resolve("three providers");
    expect(seen).toMatchObject({ state: "read", value: "three providers", error: null, refreshing: false });
  });

  it("reads something else afresh when what it depends on changes, and drops the answer for the old one", async () => {
    const answers: Record<string, ReturnType<typeof deferred<string>>> = { acme: deferred(), northwind: deferred() };
    const read = (orgId: string) => () => answers[orgId].promise;
    await page.show(<Probe read={read("acme")} deps={["acme"]} />);
    await page.show(<Probe read={read("northwind")} deps={["northwind"]} />);
    // Acme's answer arrives late: it is not Northwind's.
    await answers.acme.resolve("Acme's logins");
    expect(seen).toMatchObject({ state: "reading", value: null });
    await answers.northwind.resolve("Northwind's logins");
    expect(seen).toMatchObject({ state: "read", value: "Northwind's logins" });

    // A value shown for one organization is not kept for another.
    const next = deferred<string>();
    await page.show(<Probe read={() => next.promise} deps={["acme"]} />);
    expect(seen).toMatchObject({ state: "reading", value: null, error: null });
  });

  it("does not read again when only the read function's identity changes", async () => {
    const read = vi.fn(async () => "same");
    await page.show(<Probe read={() => read()} deps={["acme"]} />);
    await page.show(<Probe read={() => read()} deps={["acme"]} />);
    expect(read).toHaveBeenCalledTimes(1);
    expect(seen).toMatchObject({ state: "read", value: "same" });
  });

  it("shows only the newest of two refreshes", async () => {
    const answers = [deferred<string>(), deferred<string>(), deferred<string>()];
    let call = 0;
    await page.show(<Probe read={() => answers[call++].promise} />);
    await answers[0].resolve("first");
    await act(async () => { void seen.refresh(); void seen.refresh(); });
    await answers[2].resolve("newest");
    await answers[1].resolve("overtaken");
    expect(seen).toMatchObject({ state: "read", value: "newest", refreshing: false });
  });

  it("reads again on coming back into view only when asked, and never twice on the first showing", async () => {
    const asked = vi.fn(async () => "asked");
    await page.show(<Probe read={asked} options={{ refreshOnFocus: true }} />);
    expect(asked).toHaveBeenCalledTimes(1);
    await focus();
    expect(asked).toHaveBeenCalledTimes(2);

    const notAsked = vi.fn(async () => "not asked");
    await page.show(<Probe key="other" read={notAsked} />);
    await focus();
    expect(notAsked).toHaveBeenCalledTimes(1);
  });

  it("reads nothing while signed out, and reads once signed in", async () => {
    mocks.catalog = null;
    const read = vi.fn(async () => "Acme");
    await page.show(<Probe read={read} />);
    expect(read).not.toHaveBeenCalled();
    expect(seen).toMatchObject({ state: "reading", value: null });
    await act(async () => { await seen.refresh(); });
    expect(read).not.toHaveBeenCalled();

    mocks.catalog = { api };
    await page.show(<Probe read={read} />);
    expect(read).toHaveBeenCalledWith(api);
    expect(seen).toMatchObject({ state: "read", value: "Acme" });
  });

  it("never makes an error up: a fault in the read itself goes to the error boundary", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const answer = deferred<string>();
    await page.show(<Probe read={() => answer.promise} />);
    await expect(answer.reject(new TypeError("a bug"))).rejects.toThrow("a bug");
    quiet.mockRestore();
  });
});
