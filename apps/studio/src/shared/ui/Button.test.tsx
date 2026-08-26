import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button } from "./Button";

describe("Button", () => {
  it("uses a safe default type and exposes its visual label", () => {
    render(<Button icon="refresh">Refresh</Button>);

    const button = screen.getByRole("button", { name: "Refresh" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("button-md", "button-secondary");
    expect(button).not.toHaveClass("button-icon-only");
    expect(button.querySelector("svg")).toHaveClass("ui-icon-md");
  });

  it("keeps a stable visual label while exposing loading semantics", () => {
    render(
      <Button aria-label="Refreshing sessions" loading>
        Refresh
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Refreshing sessions" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveTextContent("Refresh");
  });

  it("does not render an empty label for icon-only buttons", () => {
    render(<Button aria-label="Disconnect" icon="disconnect" />);

    const button = screen.getByRole("button", { name: "Disconnect" });
    expect(button).toHaveTextContent("");
    expect(button).toHaveClass("button-icon-only");
    expect(button.querySelector(".button-label")).not.toBeInTheDocument();
    expect(button.querySelector("svg")).toHaveClass("ui-icon-md");
  });
});
