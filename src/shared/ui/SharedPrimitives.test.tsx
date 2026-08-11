import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Badge } from "./Badge";
import { InlineAlert } from "./InlineAlert";
import { PageHeader } from "./PageHeader";
import { StatusIndicator } from "./StatusIndicator";
import { TextField } from "./TextField";

describe("shared UI primitives", () => {
  it("connects TextField labels and descriptions to the native input", () => {
    render(
      <TextField
        description="Never written to disk."
        icon="key"
        label="Runtime API key"
        monospace
      />,
    );

    const input = screen.getByRole("textbox", { name: "Runtime API key" });
    expect(input).toHaveAccessibleDescription("Never written to disk.");
    expect(input).toHaveClass("text-field-input-mono", "text-field-input-with-icon");
  });

  it("uses semantic status text while keeping its dot decorative", () => {
    const { container } = render(
      <StatusIndicator tone="success">Operational</StatusIndicator>,
    );

    expect(screen.getByText("Operational")).toBeInTheDocument();
    expect(container.querySelector(".status-dot")).toHaveAttribute("aria-hidden", "true");
  });

  it("announces danger alerts and renders an optional action", () => {
    render(
      <InlineAlert action={<button type="button">Retry</button>} title="Sync failed">
        Runtime unavailable
      </InlineAlert>,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Sync failed");
    expect(alert).toHaveTextContent("Runtime unavailable");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("composes page headings and visual badges without owning feature state", () => {
    render(
      <PageHeader
        actions={<Badge tone="success">Selected</Badge>}
        description="Choose a session."
        title="Sessions"
        titleId="sessions-title"
      />,
    );

    expect(screen.getByRole("heading", { name: "Sessions" })).toHaveAttribute("id", "sessions-title");
    expect(screen.getByText("Selected")).toHaveClass("ui-badge-success");
  });
});
