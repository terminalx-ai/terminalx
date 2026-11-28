import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AnsiLog, ansiSpans, plainLog } from "./AnsiLog";

afterEach(cleanup);

it("renders raw and gh-escaped ANSI colors without interpreting log content as HTML", () => {
  const text = '\x1b[31;1merror\x1b[0m ^[[32mpassed^[[0m <img src=x onerror="alert(1)">';
  const { container } = render(<AnsiLog text={text} />);
  expect(screen.getByText("error").style.color).toMatch(/^rgb\(/);
  expect(screen.getByText("error").style.fontWeight).toBe("700");
  expect(screen.getByText("passed").style.color).toMatch(/^rgb\(/);
  expect(container.querySelector("img")).toBeNull();
  expect(plainLog(text)).toBe('error passed <img src=x onerror="alert(1)">');
});

it("supports extended colors and drops OSC links, clipboard actions and terminal controls", () => {
  const text = "\x1b]52;c;YWJj\x07\x1b]8;;https://evil.test\x1b\\link\x1b]8;;\x1b\\\x1b[2J\x1b[38;5;196mred\x1b[48;2;1;2;3m background\x1b[0m normal";
  expect(plainLog(text)).toBe("linkred background normal");
  const spans = ansiSpans(text);
  expect(spans.find((span) => span.text === "red")?.style.color).toBe("rgb(255, 0, 0)");
  expect(spans.find((span) => span.text === " background")?.style.backgroundColor).toBe("rgb(1, 2, 3)");
  expect(spans.at(-1)?.style).toEqual({});
});

describe("AnsiLog theme-aware palettes (U-27)", () => {
  it("uses readable ANSI black in dark mode and readable ANSI white in light mode", () => {
    const darkBlack = ansiSpans("\x1b[30mhello\x1b[0m", "dark")[0]?.style.color;
    const lightWhite = ansiSpans("\x1b[37mhello\x1b[0m", "light")[0]?.style.color;
    const lightBrightWhite = ansiSpans("\x1b[97mhello\x1b[0m", "light")[0]?.style.color;
    expect(darkBlack).not.toBe("#242424");
    expect(lightWhite).not.toBe("#c9c9c9");
    expect(lightWhite).not.toBe("#ffffff");
    expect(lightBrightWhite).not.toBe("#ffffff");
  });

  it("renders AnsiLog with semantic bg-terminal and text-foreground classes", () => {
    render(<AnsiLog text="build ok" />);
    const pre = screen.getByLabelText("Check log");
    expect(pre.className).toContain("bg-terminal");
    expect(pre.className).toContain("text-foreground");
    expect(pre.className).not.toContain("bg-[#181b20]");
  });
});
