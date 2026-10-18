import "@testing-library/dom";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueUser } from "@/lib/issueOps";

vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: ReactNode }) => children }));

const { AvatarStack, PeoplePicker, matchesPerson, peopleFor } = await import("./People");

const ada: IssueUser = { id: "ada", name: "Ada Lovelace", login: "ada", avatarUrl: "https://example.com/ada.png" };
const grace: IssueUser = { id: "ghopper", name: "Grace Hopper", login: "ghopper" };
const linus: IssueUser = { id: "user-linus", name: "Linus" };
const people = [ada, grace, linus];

const rows = () => screen.getAllByRole("option").map((row) => row.getAttribute("aria-label"));

afterEach(cleanup);

describe("people search", () => {
  it("matches names and logins, every word, ignoring case and a leading @", () => {
    expect(matchesPerson(grace, "grace")).toBe(true);
    expect(matchesPerson(grace, "GHOP")).toBe(true);
    expect(matchesPerson(grace, "@ghopper")).toBe(true);
    expect(matchesPerson(grace, "hopper grace")).toBe(true);
    expect(matchesPerson(grace, "grace lovelace")).toBe(false);
    expect(matchesPerson(linus, "")).toBe(true);
  });

  it("puts the chosen first, and keeps a chosen person the provider no longer offers", () => {
    const gone: IssueUser = { id: "gone", name: "gone", login: "gone" };
    expect(peopleFor(people, [linus, gone], "").map((person) => person.id)).toEqual(["user-linus", "gone", "ada", "ghopper"]);
    expect(peopleFor(people, [linus], "a").map((person) => person.id)).toEqual(["ada", "ghopper"]);
  });
});

describe("PeoplePicker", () => {
  it("lists the chosen first and filters as the search is typed", () => {
    render(<PeoplePicker people={people} chosen={[linus]} onPick={vi.fn()} />);
    expect(rows()).toEqual(["Linus", "Ada Lovelace (@ada)", "Grace Hopper (@ghopper)"]);
    expect(screen.getByRole("option", { name: "Linus" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hop" } });
    expect(rows()).toEqual(["Grace Hopper (@ghopper)"]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "nobody" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No one matches.")).toBeTruthy();
  });

  it("picks by click, and by arrow keys and Enter from the search box", () => {
    const onPick = vi.fn();
    render(<PeoplePicker people={people} onPick={onPick} multiple />);
    expect(screen.getByRole("listbox").getAttribute("aria-multiselectable")).toBe("true");
    fireEvent.click(screen.getByRole("option", { name: "Grace Hopper (@ghopper)" }));
    expect(onPick).toHaveBeenLastCalledWith(grace);

    const search = screen.getByRole("textbox");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onPick).toHaveBeenLastCalledWith(linus);

    fireEvent.change(search, { target: { value: "ada" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onPick).toHaveBeenLastCalledWith(ada);
  });

  it("doesn't pick a row it holds back, nor anything while disabled", () => {
    const onPick = vi.fn();
    const { rerender } = render(<PeoplePicker people={people} chosen={[ada]} onPick={onPick} isDisabled={(_, chosen) => !chosen} />);
    fireEvent.click(screen.getByRole("option", { name: "Linus" }));
    expect(screen.getByRole("option", { name: "Linus" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("option", { name: "Ada Lovelace (@ada)" }));
    expect(onPick).toHaveBeenCalledTimes(1);

    rerender(<PeoplePicker people={people} chosen={[ada]} onPick={onPick} disabled />);
    fireEvent.click(screen.getByRole("option", { name: "Ada Lovelace (@ada)" }));
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("keeps a row where it is when it is ticked, so it doesn't jump from under the pointer", () => {
    const { rerender } = render(<PeoplePicker people={people} chosen={[]} onPick={vi.fn()} multiple />);
    rerender(<PeoplePicker people={people} chosen={[grace]} onPick={vi.fn()} multiple />);
    expect(rows()).toEqual(["Ada Lovelace (@ada)", "Grace Hopper (@ghopper)", "Linus"]);
    expect(screen.getByRole("option", { name: "Grace Hopper (@ghopper)" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("AvatarStack", () => {
  it("names everyone, draws the first few and counts the rest", () => {
    const many = [ada, grace, linus, { id: "x", name: "Xia" }];
    const { container } = render(<AvatarStack people={many} max={2} />);
    expect(screen.getByRole("img", { name: "Ada Lovelace, Grace Hopper, Linus, Xia" })).toBeTruthy();
    expect(screen.getByText("+2")).toBeTruthy();
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://example.com/ada.png");
    // A person with no avatar gets their initial.
    expect(screen.getByText("G")).toBeTruthy();
  });

  it("draws nothing for nobody", () => {
    const { container } = render(<AvatarStack people={[]} />);
    expect(container.innerHTML).toBe("");
  });
});
