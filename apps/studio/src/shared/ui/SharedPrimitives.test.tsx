import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Badge } from "./Badge";
import { InlineAlert } from "./InlineAlert";
import { PageHeader } from "./PageHeader";
import { StatusDot } from "./StatusDot";
import { TextField } from "./TextField";
import { SelectField } from "./SelectField";
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

  it("connects shared textarea and select labels to accessible descriptions", () => {
    render(<>
      <TextAreaField description="Persisted campaign content." label="Message text" />
      <SelectField description="Runtime schedule policy." label="Schedule"><option>Immediate</option></SelectField>
    </>);
    expect(screen.getByRole("textbox", { name: "Message text" })).toHaveAccessibleDescription("Persisted campaign content.");
    const select = screen.getByRole("combobox", { name: "Schedule" });
    expect(select).toHaveAccessibleDescription("Runtime schedule policy.");
    expect(select.closest(".text-field")).toHaveClass("ui-field", "ui-field-sm");
  });

  it("applies the same explicit size contract to native field primitives", () => {
    render(<>
      <TextField label="Campaign name" size="md" />
      <TextAreaField label="Message text" size="md" />
      <SelectField label="Schedule" size="md"><option>Immediate</option></SelectField>
    </>);

    expect(screen.getByRole("textbox", { name: "Campaign name" }).closest(".ui-field"))
      .toHaveClass("ui-field-md");
    expect(screen.getByRole("textbox", { name: "Message text" }).closest(".ui-field"))
      .toHaveClass("ui-field-md");
    expect(screen.getByRole("combobox", { name: "Schedule" }).closest(".ui-field"))
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
