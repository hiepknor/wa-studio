import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { DecisionGroup } from "./DecisionGroup";
import { SegmentedControl } from "./SegmentedControl";

const OPTIONS = [
  { description: "No scheduled timestamp.", label: "Immediate", value: "IMMEDIATE" },
  { description: "Send at one scheduled time.", label: "Once", value: "ONCE" },
] as const;

function SegmentedHarness({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState<"IMMEDIATE" | "ONCE">("IMMEDIATE");
  return <SegmentedControl disabled={disabled} label="Schedule" onChange={setValue} options={OPTIONS} value={value} />;
}

function DecisionHarness() {
  const [value, setValue] = useState<"DRY_RUN" | "LIVE">("DRY_RUN");
  return <DecisionGroup label="Preflight mode" onChange={setValue} options={[
    { description: "Evaluate as a simulation.", label: "Dry run", value: "DRY_RUN" },
    { description: "Apply live policy.", label: "Live policy", value: "LIVE" },
  ]} value={value} />;
}

describe("selector controls", () => {
  it("exposes a labelled segmented radio group and its selected description", async () => {
    const user = userEvent.setup();
    render(<SegmentedHarness />);
    const group = screen.getByRole("radiogroup", { name: "Schedule" });
    expect(within(group).getByRole("radio", { name: "Immediate" })).toBeChecked();
    expect(screen.getByText("No scheduled timestamp.")).toBeVisible();

    await user.click(within(group).getByRole("radio", { name: "Once" }));
    expect(within(group).getByRole("radio", { name: "Once" })).toBeChecked();
    expect(screen.getByText("Send at one scheduled time.")).toBeVisible();
  });

  it("disables every segmented option as one field", () => {
    render(<SegmentedHarness disabled />);
    expect(screen.getAllByRole("radio")).toEqual(expect.arrayContaining([
      expect.objectContaining({ disabled: true }),
      expect.objectContaining({ disabled: true }),
    ]));
  });

  it("keeps consequential decisions visible without a popup", async () => {
    const user = userEvent.setup();
    render(<DecisionHarness />);
    const group = screen.getByRole("radiogroup", { name: "Preflight mode" });
    expect(within(group).getByRole("radio", { name: "Dry run" })).toBeChecked();
    expect(screen.getByText("Apply live policy.")).toBeVisible();
    await user.click(within(group).getByRole("radio", { name: "Live policy" }));
    expect(within(group).getByRole("radio", { name: "Live policy" })).toBeChecked();
  });
});
