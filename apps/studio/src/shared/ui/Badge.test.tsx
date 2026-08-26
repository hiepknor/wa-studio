import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Badge } from "./Badge";
import type { FeedbackTone } from "./feedback-tone";

describe("Badge", () => {
  it.each<FeedbackTone>(["neutral", "info", "success", "warning", "danger"])(
    "renders the %s semantic tone",
    (tone) => {
      render(<Badge tone={tone}>{tone}</Badge>);

      expect(screen.getByText(tone))
        .toHaveClass("ui-badge", `ui-badge-${tone}`, "ui-badge-label");
      expect(screen.getByText(tone)).toHaveAttribute("data-tone", tone);
      expect(screen.getByText(tone)).toHaveAttribute("data-variant", "label");
      expect(screen.getByText(tone).querySelector(".ui-badge-dot, .ui-badge-icon")).toBeNull();
    },
  );

  it("defaults to neutral and preserves native span attributes", () => {
    render(<Badge aria-label="Draft state" className="campaign-state">Draft</Badge>);

    expect(screen.getByLabelText("Draft state"))
      .toHaveClass("ui-badge-neutral", "campaign-state");
    expect(screen.getByLabelText("Draft state")).toHaveAttribute("data-tone", "neutral");
  });

  it("uses a dot for normal status tones", () => {
    render(<Badge tone="success" variant="status">Ready</Badge>);

    const badge = screen.getByText("Ready");
    expect(badge).toHaveClass("ui-badge-status");
    expect(badge.querySelector(".ui-badge-dot")).toBeInTheDocument();
    expect(badge.querySelector(".ui-badge-icon")).toBeNull();
  });

  it.each<FeedbackTone>(["warning", "danger"])(
    "uses the alert icon for the %s status tone",
    (tone) => {
      render(<Badge tone={tone} variant="status">Needs attention</Badge>);

      const badge = screen.getByText("Needs attention");
      expect(badge.querySelector(".ui-badge-icon")).toBeInTheDocument();
      expect(badge.querySelector(".ui-badge-dot")).toBeNull();
    },
  );
});
