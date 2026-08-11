import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button } from "./Button";

describe("Button", () => {
  it("uses a safe default type and exposes its visual label", () => {
    render(<Button icon="refresh">Refresh</Button>);

    const button = screen.getByRole("button", { name: "Refresh" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("button-md", "button-secondary");
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
});
