import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { WorkflowStepper } from "./WorkflowStepper";

function Harness() {
  const [activeStep, setActiveStep] = useState<"details" | "targets" | "preflight">(
    "details",
  );
  return (
    <WorkflowStepper
      activeStep={activeStep}
      ariaLabel="Campaign steps"
      idPrefix="campaign-steps"
      onChange={setActiveStep}
      steps={[
        { id: "details", label: "Details", step: 1 },
        { disabled: true, id: "targets", label: "Targets", step: 2 },
        { id: "preflight", label: "Preflight", step: 3 },
      ]}
    />
  );
}

describe("WorkflowStepper", () => {
  it("marks the current step and skips unavailable steps during keyboard navigation", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const details = screen.getByRole("tab", { name: "Details" });
    const targets = screen.getByRole("tab", { name: "Targets" });
    const preflight = screen.getByRole("tab", { name: "Preflight" });
    expect(details).toHaveAttribute("aria-current", "step");
    expect(details.closest("[role='tablist']")).toHaveClass("workflow-stepper");
    expect(targets).toBeDisabled();

    details.focus();
    await user.keyboard("{ArrowRight}");
    expect(preflight).toHaveFocus();
    expect(preflight).toHaveAttribute("aria-current", "step");
    expect(targets).not.toHaveFocus();
  });
});
