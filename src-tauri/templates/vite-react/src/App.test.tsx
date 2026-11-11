import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App.tsx";

describe("App", () => {
  it("shows the project name", () => {
    render(<App />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("{{name}}");
  });

  it("counts clicks", async () => {
    render(<App />);
    const button = screen.getByRole("button", { name: "Clicked 0 times" });
    await userEvent.click(button);
    expect(button).toHaveTextContent("Clicked 1 time");
    await userEvent.click(button);
    expect(button).toHaveTextContent("Clicked 2 times");
  });
});
