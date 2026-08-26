import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./App";

describe("App", () => {
  it("starts by discovering the bundled local Runtime", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { name: "Preparing this machine." }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Preparing local workspace" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Inspecting the bundled Runtime");
  });
});
