import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Avatar, AvatarStack, PresenceDot } from "./avatar";
import { Chip, ChipButton } from "./chip";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { contrast, rgb } from "@/styles/tokenContrast";
import { InlineError, NoAccessNote, OfflineBand, SkeletonRows, SurfaceState } from "./SurfaceState";

afterEach(cleanup);

describe("shared identity", () => {
  it("falls back after a broken photo, loads a different photo and removes it when authority stops supplying it", () => {
    const view = render(<Avatar name="Member" photoUrl="/allowed-photo" presence="away" />);
    const image = view.container.querySelector("img")!;
    expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
    fireEvent.error(image);
    expect(view.container.querySelector("img")).toBeNull();
    expect(screen.getByRole("img", { name: "Member · Away" }).textContent).toBe("M");
    view.rerender(<Avatar name="Changed member" photoUrl="/changed-photo" />);
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe("/changed-photo");
    view.rerender(<Avatar name="Changed member" photoUrl={null} />);
    expect(view.container.querySelector("img")).toBeNull();
  });

  it("does not invent presence, exposes unknown explicitly and supports decorative identity", () => {
    const view = render(<Avatar name="" />);
    expect(screen.getByRole("img", { name: "Unknown person" })).toBeTruthy();
    expect(screen.queryByLabelText(/Online/)).toBeNull();
    view.rerender(<PresenceDot presence="unknown" />);
    expect(screen.getByRole("img", { name: "Presence unavailable" })).toBeTruthy();
    view.rerender(<Avatar name="Member" decorative presence="online" />);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("keeps overflow identities and status accessible while bounding visuals, and clears an empty stack", () => {
    const people = ["First", "Second", "Third", "Fourth"].map((name) => ({ id: name, name, presence: "offline" as const }));
    const view = render(<AvatarStack people={people} max={2} label="Participants" />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("Participants: First · Offline, Second · Offline, Third · Offline, Fourth · Offline");
    expect(screen.getByText("+2")).toBeTruthy();
    view.rerender(<AvatarStack people={people} max={-1} />);
    expect(screen.getByText("+3")).toBeTruthy();
    view.rerender(<AvatarStack people={[]} />);
    expect(view.container.textContent).toBe("");
  });

  it("does not turn domain identities into DOM IDs when a person appears in several stacks", () => {
    const people = [{ id: "workspace-owner", name: "Member" }];
    const view = render(<><p id="workspace-owner">Workspace owner</p><AvatarStack people={people} /><AvatarStack people={people} /><Avatar id="intentional-avatar" name="Member" /></>);
    expect(view.container.querySelectorAll('[id="workspace-owner"]')).toHaveLength(1);
    expect(document.getElementById("workspace-owner")?.textContent).toBe("Workspace owner");
    expect(document.getElementById("intentional-avatar")?.getAttribute("aria-label")).toBe("Member");
  });
});

describe("shared chip and popover", () => {
  it("keeps passive labels out of the tab order and interactive chips out of form submission", () => {
    const choose = vi.fn();
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    const view = render(<form onSubmit={submit}><Chip>View only</Chip><ChipButton onClick={choose}>@Member</ChipButton></form>);
    expect(screen.getByText("View only").getAttribute("tabindex")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "@Member" }));
    expect(choose).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
    view.rerender(<ChipButton disabled onClick={choose}>@Member</ChipButton>);
    fireEvent.click(screen.getByRole("button"));
    expect(choose).toHaveBeenCalledOnce();
  });

  it("names details, focuses the close control, dismisses with Escape and restores the trigger", async () => {
    render(<Popover><PopoverTrigger asChild><ChipButton>Open profile</ChipButton></PopoverTrigger><PopoverContent label="Member profile"><button type="button">Copy name</button></PopoverContent></Popover>);
    const trigger = screen.getByRole("button", { name: "Open profile" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Member profile" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close Member profile" })));
    screen.getByRole("button", { name: "Copy name" }).focus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("closes by button and lets an outside focus target keep focus", async () => {
    render(<><Popover><PopoverTrigger asChild><ChipButton>Ports</ChipButton></PopoverTrigger><PopoverContent label="Forwarded ports"><p>No forwarded ports</p></PopoverContent></Popover><button type="button">Outside</button></>);
    const trigger = screen.getByRole("button", { name: "Ports" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Close Forwarded ports" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    const outside = screen.getByRole("button", { name: "Outside" });
    outside.focus();
    fireEvent.focusIn(outside);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(outside);
  });
});

describe("shared surface states", () => {
  it("announces loading without focus theft, disables repeats, then offers a named retry on failure", () => {
    const retry = vi.fn();
    const view = render(<SurfaceState status="loading" title="Loading people…" description="Checking access." action={{ label: "Try again", onAction: retry }} />);
    expect(screen.getByRole("status").textContent).toContain("Loading people…");
    fireEvent.click(screen.getByRole("button"));
    expect(retry).not.toHaveBeenCalled();
    view.rerender(<SurfaceState status="error" title="Could not load people" description="Try again." action={{ label: "Try again", onAction: retry }} />);
    expect(screen.getByRole("alert").textContent).toContain("Could not load people");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
    view.rerender(<SurfaceState status="no-access" title="Access ended" description="Ask an admin." />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Could not load people")).toBeNull();
  });
});

describe("inline state pieces", () => {
  it("draws an inline error with one retry, a no-access line, an offline band and hidden skeletons", () => {
    const retry = vi.fn();
    render(<>
      <InlineError retry={{ label: "Retry", onAction: retry }}>Couldn’t load automations.</InlineError>
      <NoAccessNote>Only admins can change this.</NoAccessNote>
      <OfflineBand>Offline · showing the last list</OfflineBand>
      <SkeletonRows rows={2} />
    </>);
    expect(screen.getByRole("alert").textContent).toContain("Couldn’t load automations.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.getByText("Only admins can change this.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Offline · showing the last list");
    expect(screen.getByTestId("skeleton-rows").getAttribute("aria-hidden")).toBe("true");
  });
});

// Exercise the exact foreground/surface pairs used here, using the existing
// repository color conversion. This verifies tokens, not rendered layout.
describe("team token contrast", () => {
  const tokenCss = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");
  const themes = [...tokenCss.matchAll(/(\[data-theme="[\s\S]*?)\{([^}]+)\}/g)];
  it("covers every supported theme mode", () => {
    expect(themes.flatMap(([, selector]) => [...selector.matchAll(/data-mode="(dark|light)"/g)])).toHaveLength(8);
  });
  for (const [, selector, declarations] of themes) {
    const tokens = Object.fromEntries([...declarations.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value]));
    it(`keeps text and focus visible in ${selector}`, () => {
      const mode = selector.includes('data-mode="dark"') ? "dark" : "light";
      const modeBlock = tokenCss.match(new RegExp(`\\[data-mode="${mode}"\\] \\{([^}]+)`))![1];
      const wellAlpha = Number(modeBlock.match(/--surface-well:.*?\/\s*([\d.]+)%/)![1]) / 100;
      for (const surface of ["surface-page", "surface-card", "surface-muted"]) {
        const ground = rgb(tokens[surface]);
        // bg-well is a black veil, not an opaque palette surface.
        const well = ground.map((channel) => channel * (1 - wellAlpha)) as typeof ground;
        for (const background of [ground, well]) {
          for (const ink of ["ink-strong", "ink-muted"]) {
            expect(contrast(rgb(tokens[ink]), background), `${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5);
          }
          expect(contrast(rgb(tokens["ink-strong"]), background)).toBeGreaterThanOrEqual(3);
        }
      }
    });
  }
});

it("orders Close before content actions and autofocuses it", async () => {
  render(<Popover><PopoverTrigger asChild><ChipButton>Details</ChipButton></PopoverTrigger><PopoverContent label="Details"><button type="button">First action</button><button type="button">Second action</button></PopoverContent></Popover>);
  const trigger = screen.getByRole("button", { name: "Details" });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "Details" });
  const buttons = [...dialog.querySelectorAll("button")];
  expect(buttons.map((button) => button.textContent || button.getAttribute("aria-label"))).toEqual(["Close Details", "First action", "Second action"]);
  await waitFor(() => expect(document.activeElement).toBe(buttons[0]));
});
