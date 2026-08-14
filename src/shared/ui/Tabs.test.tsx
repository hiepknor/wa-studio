import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { Tabs } from "./Tabs";

function Harness() {
  const [activeTab, setActiveTab] = useState<"overview" | "members">(
    "overview",
  );
  return (
    <Tabs
      activeTab={activeTab}
      ariaLabel="Inspector sections"
      idPrefix="test-inspector"
      onChange={setActiveTab}
      tabs={[
        { id: "overview", label: "Overview" },
        { badge: 30, id: "members", label: "Members", warning: true },
      ]}
    />
  );
}

describe("Tabs", () => {
  it("supports automatic arrow, Home, and End activation", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const overview = screen.getByRole("tab", { name: "Overview" });
    const members = screen.getByRole("tab", { name: /Members/ });

    overview.focus();
    await user.keyboard("{ArrowRight}");
    expect(members).toHaveFocus();
    expect(members).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Attention required")).toBeInTheDocument();

    await user.keyboard("{Home}");
    expect(overview).toHaveFocus();
    expect(overview).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{End}");
    expect(members).toHaveFocus();
  });

  it("disables unavailable workflow steps and skips them during keyboard navigation", async () => {
    const user = userEvent.setup();
    render(
      <Tabs
        activeTab="details"
        ariaLabel="Campaign steps"
        idPrefix="campaign-steps"
        onChange={() => undefined}
        tabs={[
          { id: "details", label: "Details" },
          { disabled: true, id: "targets", label: "Targets" },
          { id: "preflight", label: "Preflight" },
        ]}
      />,
    );

    const details = screen.getByRole("tab", { name: "Details" });
    const targets = screen.getByRole("tab", { name: "Targets" });
    const preflight = screen.getByRole("tab", { name: "Preflight" });
    expect(targets).toBeDisabled();
    details.focus();
    await user.keyboard("{ArrowRight}");
    expect(preflight).toHaveFocus();
    expect(targets).not.toHaveFocus();
  });
});
