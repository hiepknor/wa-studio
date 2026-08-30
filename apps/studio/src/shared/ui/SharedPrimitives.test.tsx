import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Badge } from "./Badge";
import { InlineAlert } from "./InlineAlert";
import { PageHeader } from "./PageHeader";
import { StatusDot } from "./StatusDot";
import { TextField } from "./TextField";
import { TextAreaField } from "./TextAreaField";

describe("shared UI primitives", () => {
  it("connects TextField labels and descriptions to the native input", () => {
    render(
      <TextField
        description="Never written to disk."
        icon="key"
        label="WA Runtime API key"
        monospace
      />,
    );

    const input = screen.getByRole("textbox", { name: "WA Runtime API key" });
    expect(input).toHaveAccessibleDescription("Never written to disk.");
    expect(input).toHaveClass("text-field-input-mono", "text-field-input-with-icon");
    expect(input.closest(".text-field")).toHaveClass("ui-field", "ui-field-sm");
  });

  it("connects shared textarea labels to accessible descriptions", () => {
    render(<TextAreaField description="Persisted campaign content." label="Message text" />);
    expect(screen.getByRole("textbox", { name: "Message text" })).toHaveAccessibleDescription("Persisted campaign content.");
  });

  it("applies the same explicit size contract to native field primitives", () => {
    render(<>
      <TextField label="Campaign name" size="md" />
      <TextAreaField label="Message text" size="md" />
    </>);

    expect(screen.getByRole("textbox", { name: "Campaign name" }).closest(".ui-field"))
      .toHaveClass("ui-field-md");
    expect(screen.getByRole("textbox", { name: "Message text" }).closest(".ui-field"))
      .toHaveClass("ui-field-md");
  });

  it("uses one accessible invalid-state contract for textbox and textarea", () => {
    render(<>
      <TextField description="Original hint" error="Name is required." label="Campaign name" />
      <TextAreaField aria-invalid error="Message is required." label="Message text" />
    </>);

    const input = screen.getByRole("textbox", { name: "Campaign name" });
    const textarea = screen.getByRole("textbox", { name: "Message text" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Name is required.");
    expect(input.closest(".text-field")).toHaveAttribute("data-invalid", "true");
    expect(textarea).toHaveAttribute("aria-invalid", "true");
    expect(textarea).toHaveAccessibleDescription("Message is required.");
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(screen.queryByText("Original hint")).not.toBeInTheDocument();
  });

  it("keeps standalone status dots decorative", () => {
    const { container } = render(<StatusDot tone="success" />);
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

  it("announces informational feedback as status rather than an error alert", () => {
    render(
      <InlineAlert title="Refresh requested" tone="info">
        Waiting for WA Runtime.
      </InlineAlert>,
    );

    expect(screen.getByRole("status")).toHaveClass("inline-alert-info");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps InlineAlert copy aligned for every indicator and action combination", () => {
    const { container } = render(<>
      <InlineAlert title="Copy only" tone="neutral" />
      <InlineAlert indicator title="Indicator only" tone="success">Complete</InlineAlert>
      <InlineAlert action={<button type="button">Retry action</button>} title="Action only" tone="info" />
      <InlineAlert action={<button type="button">Resolve action</button>} indicator title="Indicator and action" tone="warning" />
    </>);

    const alerts = container.querySelectorAll(".inline-alert");
    expect(alerts[0]).not.toHaveAttribute("data-has-indicator");
    expect(alerts[0]).not.toHaveAttribute("data-has-action");
    expect(alerts[1]).toHaveAttribute("data-has-indicator", "true");
    expect(alerts[1]).not.toHaveAttribute("data-has-action");
    expect(alerts[2]).not.toHaveAttribute("data-has-indicator");
    expect(alerts[2]).toHaveAttribute("data-has-action", "true");
    expect(alerts[3]).toHaveAttribute("data-has-indicator", "true");
    expect(alerts[3]).toHaveAttribute("data-has-action", "true");
    expect(screen.getByText("Indicator only").closest(".inline-alert-copy")?.previousElementSibling)
      .toHaveClass("status-dot");
    expect(screen.getByRole("button", { name: "Resolve action" }).closest(".inline-alert-action"))
      .toBeInTheDocument();
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

    expect(screen.getByRole("heading", { level: 1, name: "Sessions" })).toHaveAttribute("id", "sessions-title");
    expect(screen.getByText("Selected")).toHaveClass("ui-badge-success");
  });
});
