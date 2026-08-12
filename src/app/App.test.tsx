import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./App";

describe("App", () => {
  it("renders the connection screen", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { name: "Connect to WA Runtime" }),
    ).toBeInTheDocument();
  });
});
