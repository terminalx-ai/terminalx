// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptImageContext, PromptImages } from "./PromptImages";

vi.mock("./theme", () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock("react-native", () => {
  const Box = ({ children, accessibilityLabel }: { children?: ReactNode; accessibilityLabel?: string }) => <div aria-label={accessibilityLabel}>{children}</div>;
  return {
    View: Box, Text: Box, StyleSheet: { create: (styles: unknown) => styles },
    Image: ({ source, accessibilityLabel }: any) => <img alt={accessibilityLabel} src={source.uri} />,
    Modal: ({ visible, children }: any) => visible ? <div role="dialog">{children}</div> : null,
    Pressable: ({ children, onPress, accessibilityLabel }: any) => <button aria-label={accessibilityLabel} onClick={onPress}>{children}</button>,
  };
});

let root: Root;
let container: HTMLDivElement;
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

describe("a prompt's images in its bubble", () => {
  it("asks the Mac for each once, and opens one full screen", async () => {
    const load = vi.fn(async () => ({ uri: "data:image/png;base64,cG5n" }));
    const images = [{ url: "/mac/attachments/s/a.png", name: "a.png" }];
    const draw = () => root.render(<PromptImageContext.Provider value={{ scope: "once", load }}><PromptImages images={images} /></PromptImageContext.Provider>);
    await act(async () => draw()); await settle();
    await act(async () => draw()); await settle();
    expect(load).toHaveBeenCalledTimes(1);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,cG5n");
    await act(async () => (container.querySelector("[aria-label='Open a.png']") as HTMLButtonElement).click());
    expect(container.querySelector("[role='dialog'] img")).not.toBeNull();
  });

  it("names an image it cannot draw, saying why", async () => {
    const load = vi.fn(async () => ({ error: "The image is no longer on the Mac." }));
    await act(async () => root.render(<PromptImageContext.Provider value={{ scope: "gone", load }}><PromptImages images={[{ url: "/mac/b.png", name: "b.png" }]} /></PromptImageContext.Provider>));
    await settle();
    expect(container.textContent).toContain("The image is no longer on the Mac.");
    expect(container.querySelector("img")).toBeNull();
  });

  it("draws an image that comes as data without asking, and names one with no Mac to ask", async () => {
    await act(async () => root.render(<PromptImages images={[{ url: "data:image/png;base64,eA==", name: "c.png" }, { url: "/mac/d.png", name: "d.png" }]} />));
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,eA==");
    expect(container.textContent).toContain("d.png");
  });
});
