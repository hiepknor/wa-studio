import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button } from "@/shared/ui/Button";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

describe("Settings primitives", () => {
  it("labels a section from its visible heading", () => {
    render(
      <SettingsSection
        action={<Button>Refresh</Button>}
        description="Current product and Runtime state."
        kicker="WA Studio"
        title="Product overview"
        titleId="product-overview-title"
      >
        <span>Section content</span>
      </SettingsSection>,
    );

    const section = screen.getByRole("region", { name: "Product overview" });
    expect(within(section).getByText("Current product and Runtime state.")).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(within(section).getByText("Section content")).toBeInTheDocument();
  });

  it("exposes a row label and description as one accessible group", () => {
    render(
      <SettingsRow
        action={<Button>Manage backups</Button>}
        description="Latest recovery point is stored on this device."
        label="Data protection"
      />,
    );

    const row = screen.getByRole("group", { name: "Data protection" });
    expect(row).toHaveAccessibleDescription(
      "Latest recovery point is stored on this device.",
    );
    expect(within(row).getByRole("button", { name: "Manage backups" })).toBeInTheDocument();
  });
});
