import { useRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { searchId } from "@/lib/chatSearch";
import { buildTranscript, type Transcript } from "@/lib/transcript";
import { useChatFind } from "./ChatFind";

const transcript: Transcript = {
  ...buildTranscript([], false),
  turns: [{ key: "turn", seq: 1, ts: "", toolCount: 0, editedFiles: 0, live: false,
    work: [{ kind: "text", key: "answer", seq: 2, text: "codeNeedle" }] }],
};

function Fixture({ generation }: { generation: number }) {
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const find = useChatFind({ root, scroller, transcript, footerHeight: 0 });
  return <div ref={root} data-find-scope="chat" tabIndex={-1}>
    {find.bar}
    <div ref={scroller} data-testid="chat-scroller">
      <div id={searchId("turn", "answer")} data-chat-search>
        <div key={generation} data-testid="code-body" style={{ overflowY: "auto" }}>
          <span>codeNeedle</span>
        </div>
      </div>
    </div>
  </div>;
}

beforeEach(() => {
  // The match is 400px down a 100px code scroller inside a 500px chat.
  // Replacing that code scroller, as asynchronous syntax rendering does,
  // creates a new element with scrollTop=0 even though the query is unchanged.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "code-body" ? new DOMRect(0, 20, 100, 100) : new DOMRect(0, 0, 200, 500);
  });
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
    const code = this.startContainer.parentElement?.closest<HTMLElement>('[data-testid="code-body"]');
    return new DOMRect(0, 420 - (code?.scrollTop ?? 0), 50, 16);
  });
  vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (this: Range) {
    const rect = this.getBoundingClientRect();
    return Object.assign([rect], { item: (index: number) => index === 0 ? rect : null });
  });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([false, true])("keeps the selected code visible across DOM replacement (native=%s), until the reader scrolls", async (native) => {
  vi.stubGlobal("Highlight", native ? class extends Set<Range> { priority = 0; constructor(...ranges: Range[]) { super(ranges); } } : undefined);
  vi.stubGlobal("CSS", { escape: CSS.escape.bind(CSS), highlights: new Map() });
  const view = render(<Fixture generation={0} />, { wrapper: TooltipProvider });
  const root = view.container.firstElementChild as HTMLElement;
  root.focus();
  fireEvent.keyDown(root, { key: "f", ctrlKey: true });
  fireEvent.change(screen.getByRole("textbox", { name: "Find in chat" }), { target: { value: "codeNeedle" } });
  await waitFor(() => expect(screen.getByTestId("code-body").scrollTop).toBeGreaterThan(0));
  const before = screen.getByTestId("code-body");
  view.rerender(<Fixture generation={1} />);
  expect(screen.getByTestId("code-body")).not.toBe(before);
  await waitFor(() => expect(screen.getByTestId("code-body").scrollTop).toBeGreaterThan(0));

  fireEvent.wheel(screen.getByTestId("chat-scroller"), { deltaY: -100 });
  await act(async () => { view.rerender(<Fixture generation={2} />); });
  expect(screen.getByRole("status").textContent).toBe("1 of 1");
  expect(screen.getByTestId("code-body").scrollTop).toBe(0);
  fireEvent.change(screen.getByRole("textbox", { name: "Find in chat" }), { target: { value: "missing" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Find in chat" }), { target: { value: "codeNeedle" } });
  await waitFor(() => expect(screen.getByTestId("code-body").scrollTop).toBeGreaterThan(0));
});
