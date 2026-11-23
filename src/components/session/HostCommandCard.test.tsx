import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostCommandCard, type HostCommandCardState, type HostCommandPresentation } from "./HostCommandCard";

afterEach(cleanup);

const request: HostCommandPresentation = Object.freeze({
  requestId: "host-request-1",
  executable: "/usr/bin/printf",
  arguments: Object.freeze(["%s\\n", "hello world", ""]),
  cwd: "/Users/example/project",
  agent: "Claude Code",
  turn: "turn-19",
  originAccount: "example-account",
  originDevice: "Example Mac",
  timeoutMs: 60_000,
});

function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function detail(label: string): HTMLElement {
  return screen.getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
}

describe("HostCommandCard isolated presentation foundation", () => {
  it("discloses the complete executable, ordered argv, local cwd, identity labels and timeout", () => {
    render(<HostCommandCard request={request} state="pending" onIntent={vi.fn()} />);
    for (const [label, value] of [
      ["Request", request.requestId], ["Executable", request.executable],
      ["Working directory on this computer", request.cwd], ["Requesting agent", request.agent],
      ["Turn", request.turn], ["Origin account (display only)", request.originAccount],
      ["Origin device (display only)", request.originDevice],
    ]) expect(detail(label).textContent).toBe(JSON.stringify(value));
    expect(within(detail("Arguments (in order)")).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(request.arguments.map((argument) => JSON.stringify(argument)));
    expect(detail("Timeout").textContent).toBe("60000 ms");
    expect(screen.getByText(/standard output and standard error go back to the requesting agent/)).toBeTruthy();
    expect(screen.getByText(/may contain sensitive information/)).toBeTruthy();
    expect(screen.getByText(/Cancellation may not undo side effects/)).toBeTruthy();
    expect(screen.queryByText(/Only you see|Always allow|Enter to/i)).toBeNull();
  });

  it("preserves a full explicit shell invocation and long values without truncating them", () => {
    const script = `printf '%s' '${"x".repeat(6000)}'`;
    const { container } = render(<HostCommandCard request={{ ...request, executable: "/bin/sh", arguments: ["-c", script] }} state="pending" />);
    expect(detail("Executable").textContent).toBe('"/bin/sh"');
    expect(within(detail("Arguments (in order)")).getAllByRole("listitem")[1].textContent).toBe(JSON.stringify(script));
    expect(container.querySelector("[title], .truncate, .line-clamp-1, .line-clamp-2")).toBeNull();
    for (const code of container.querySelectorAll("code")) {
      expect(code.getAttribute("dir")).toBe("ltr");
      expect(code.className).toContain("whitespace-pre-wrap");
      expect(code.className).toContain("[overflow-wrap:anywhere]");
      expect(code.className).toContain("[unicode-bidi:isolate]");
    }
  });

  it("distinguishes an empty argv from one empty argument", () => {
    const view = render(<HostCommandCard request={{ ...request, arguments: [] }} />);
    expect(detail("Arguments (in order)").textContent).toBe("No arguments");
    view.rerender(<HostCommandCard request={{ ...request, arguments: [""] }} />);
    expect(within(detail("Arguments (in order)")).getAllByRole("listitem")[0].textContent).toBe('""');
  });

  it("escapes controls, bidi and invisible formatting in every untrusted string field", () => {
    const unsafe = '<img src=x onerror="alert(1)">\n\r\t\x00\x1b\x7f\x85\u00ad\u061c\u200b\u200f\u2028\u202e\u2066\ufeff\\u202e';
    const escaped = '"<img src=x onerror=\\"alert(1)\\">\\n\\r\\t\\u0000\\u001b\\u007f\\u0085\\u00ad\\u061c\\u200b\\u200f\\u2028\\u202e\\u2066\\ufeff\\\\u202e"';
    const { container } = render(<HostCommandCard request={{
      ...request, requestId: unsafe, executable: unsafe, arguments: [unsafe], cwd: unsafe,
      agent: unsafe, turn: unsafe, originAccount: unsafe, originDevice: unsafe,
    }} state="pending" />);
    const values = [...container.querySelectorAll("code")];
    expect(values).toHaveLength(8);
    expect(values.every((value) => value.textContent === escaped)).toBe(true);
    expect(container.querySelector("img, script")).toBeNull();
    expect(container.textContent).not.toMatch(/[\x00-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/);
  });

  it("has an accessible region, heading, live status and disclosure descriptions", () => {
    render(<HostCommandCard request={request} state="pending" />);
    const region = screen.getByRole("region", { name: "Run this command on your computer?" });
    const heading = screen.getByRole("heading", { level: 3 });
    expect(region.getAttribute("aria-labelledby")).toBe(heading.id);
    const descriptions = region.getAttribute("aria-describedby")!.split(" ")
      .map((id) => document.getElementById(id)?.textContent);
    expect(descriptions[0]).toContain("standard output and standard error");
    expect(descriptions[1]).toContain("control characters and text direction controls are escaped");
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
  });

  it("uses unique accessible ids when multiple cards are present", () => {
    render(<><HostCommandCard request={request} /><HostCommandCard request={{ ...request, requestId: "second" }} /></>);
    const ids = screen.getAllByRole("region").map((region) => region.getAttribute("aria-labelledby"));
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id && document.getElementById(id))).toBe(true);
  });

  it("defaults to unavailable with no action when state is absent or unknown", () => {
    const intent = vi.fn();
    const view = render(<HostCommandCard request={request} onIntent={intent} />);
    expect(screen.getByRole("status").textContent).toBe("Unavailable");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    view.rerender(<HostCommandCard request={request} state={"unexpected" as HostCommandCardState} onIntent={intent} />);
    expect(screen.getByRole("status").textContent).toBe("Unavailable");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(intent).not.toHaveBeenCalled();
  });

  it("offers only Deny then Run once, with no autofocus, submit action or default Enter approval", () => {
    const intent = vi.fn();
    const { container } = render(<form><HostCommandCard request={request} state="pending" onIntent={intent} /></form>);
    expect(screen.getAllByRole("button").map((element) => element.textContent)).toEqual(["Deny", "Run once"]);
    for (const element of screen.getAllByRole("button")) expect(element.getAttribute("type")).toBe("button");
    expect(container.querySelector("[autofocus], [aria-keyshortcuts]")).toBeNull();
    expect(document.activeElement).not.toBe(button("Run once"));
    fireEvent.keyDown(document.body, { key: "Enter", code: "Enter" });
    fireEvent.keyDown(screen.getByRole("region"), { key: "Enter", code: "Enter" });
    expect(intent).not.toHaveBeenCalled();
  });

  it.each(["Run once", "Deny"])("sends only a presentation intent for explicit %s and prevents repeat decisions", (action) => {
    const intent = vi.fn();
    const view = render(<HostCommandCard request={request} state="pending" onIntent={intent} />);
    expect(intent).not.toHaveBeenCalled();
    fireEvent.click(button(action));
    expect(intent).toHaveBeenCalledExactlyOnceWith({ kind: action === "Run once" ? "run-once" : "deny", request });
    expect(intent.mock.calls[0][0].request).toBe(request);
    expect(Object.keys(intent.mock.calls[0][0]).sort()).toEqual(["kind", "request"]);
    expect(button("Run once").disabled).toBe(true);
    expect(button("Deny").disabled).toBe(true);
    view.rerender(<HostCommandCard request={{ ...request }} state="pending" onIntent={intent} />);
    fireEvent.click(button("Run once"));
    fireEvent.click(button("Deny"));
    expect(intent).toHaveBeenCalledTimes(1);
  });

  it("blocks synchronous callback re-entry before React renders disabled buttons", () => {
    const intent = vi.fn(() => { fireEvent.click(button("Deny")); });
    render(<HostCommandCard request={request} state="pending" onIntent={intent} />);
    fireEvent.click(button("Run once"));
    expect(intent).toHaveBeenCalledTimes(1);
  });

  it("leaves pending and running actions disabled when no callback is supplied", () => {
    const view = render(<HostCommandCard request={request} state="pending" />);
    expect(button("Run once").disabled).toBe(true);
    expect(button("Deny").disabled).toBe(true);
    view.rerender(<HostCommandCard request={request} state="running" />);
    expect(button("Cancel").disabled).toBe(true);
  });

  it.each([
    { executable: "" }, { cwd: " " }, { agent: "" }, { turn: "" },
    { originAccount: "" }, { originDevice: "" }, { requestId: "" },
    { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: 1.5 },
    { timeoutMs: NaN }, { timeoutMs: Infinity }, { timeoutMs: Number.MAX_SAFE_INTEGER + 1 },
    { arguments: null }, { arguments: [42] }, { arguments: Array(1) },
  ])("disables Run once but permits Deny for incomplete details: %j", (invalid) => {
    const intent = vi.fn();
    render(<HostCommandCard request={{ ...request, ...invalid } as HostCommandPresentation} state="pending" onIntent={intent} />);
    expect(button("Run once").disabled).toBe(true);
    expect(button("Deny").disabled).toBe(false);
    expect(screen.getByText("Request details are incomplete. Run once is unavailable.")).toBeTruthy();
    fireEvent.click(button("Run once"));
    expect(intent).not.toHaveBeenCalled();
    fireEvent.click(button("Deny"));
    expect(intent.mock.calls[0][0].kind).toBe("deny");
  });

  it("allows a separate Cancel intent after Run once and retains externally controlled status", () => {
    const intent = vi.fn();
    const view = render(<HostCommandCard request={request} state="pending" onIntent={intent} />);
    fireEvent.click(button("Run once"));
    expect(screen.getByRole("status").textContent).toBe("Waiting for a decision");
    view.rerender(<HostCommandCard request={request} state="running" onIntent={intent} />);
    expect(screen.getByRole("status").textContent).toBe("Running");
    expect(screen.queryByRole("button", { name: "Run once" })).toBeNull();
    expect(button("Cancel").disabled).toBe(false);
    fireEvent.click(button("Cancel"));
    expect(intent.mock.calls.map(([value]) => value.kind)).toEqual(["run-once", "cancel"]);
    expect(button("Cancel").disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Running");
    fireEvent.click(button("Cancel"));
    expect(intent).toHaveBeenCalledTimes(2);
    view.rerender(<HostCommandCard request={request} state="cancelling" onIntent={intent} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it.each([
    ["cancelling", "Cancellation requested"], ["cancelled", "Cancelled"], ["denied", "Denied"],
    ["expired", "Expired"], ["completed", "Completed"], ["failed", "Failed"],
  ] as const)("renders %s without actions or callback side effects", (state, label) => {
    const intent = vi.fn();
    render(<HostCommandCard request={request} state={state} onIntent={intent} />);
    expect(screen.getByRole("status").textContent).toBe(label);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(detail("Executable").textContent).toBe(JSON.stringify(request.executable));
    expect(intent).not.toHaveBeenCalled();
  });

  it("ignores a stale pending button after external expiry", () => {
    const intent = vi.fn();
    const view = render(<HostCommandCard request={request} state="pending" onIntent={intent} />);
    const run = button("Run once");
    view.rerender(<HostCommandCard request={request} state="expired" onIntent={intent} />);
    fireEvent.click(run);
    expect(intent).not.toHaveBeenCalled();
  });

  it("does not carry a prior intent to a different request or emit one on unmount", () => {
    const intent = vi.fn();
    const next = { ...request, requestId: "host-request-2", arguments: ["second command"] };
    const view = render(<HostCommandCard request={request} state="pending" onIntent={intent} />);
    fireEvent.click(button("Deny"));
    view.rerender(<HostCommandCard request={next} state="pending" onIntent={intent} />);
    expect(button("Run once").disabled).toBe(false);
    fireEvent.click(button("Run once"));
    expect(intent).toHaveBeenLastCalledWith({ kind: "run-once", request: next });
    view.unmount();
    expect(intent).toHaveBeenCalledTimes(2);
  });
});
