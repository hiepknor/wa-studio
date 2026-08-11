import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./App";

describe("App", () => {
  it("renders inside the Ink application provider", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { name: "Connect to Automation Runtime" }),
    ).toBeInTheDocument();
  });
});
