import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Badge } from "./Badge";
import { Button } from "./Button";
import { DataTable } from "./DataTable";
import {
  ActionFooter,
  DataTableFrame,
  DescriptionList,
  EmptyState,
  EvidenceList,
  MetricGrid,
  SectionHeader,
  SurfacePanel,
} from "./Composition";

describe("WA Design System composition patterns", () => {
  it("keeps section and panel headings as their accessible names", () => {
    render(<>
      <SectionHeader description="Operational evidence." eyebrow="Safety" title="Review" titleId="review-title" />
      <SurfacePanel title="Policy checks" titleId="checks-title">
        Checks
      </SurfacePanel>
    </>);

    expect(screen.getByRole("heading", { level: 2, name: "Review" })).toHaveAttribute("id", "review-title");
    expect(screen.getByRole("region", { name: "Policy checks" })).toBeInTheDocument();
  });

  it("uses descriptions and metrics without turning technical data into prose", () => {
    render(<>
      <MetricGrid ariaLabel="Target readiness" className="target-metrics" items={[
        { label: "Allowed", tone: "success", value: 71 },
        { label: "Denied", tone: "danger", value: 0 },
      ]} />
      <DescriptionList ariaLabel="Run details" items={[
        { id: "mode", label: "Mode", value: "Dry run" },
        { id: "run-id", label: "Run ID", value: "run-01", valueClassName: "ui-technical-text" },
      ]} />
    </>);

    const metrics = screen.getByRole("group", { name: "Target readiness" });
    expect(metrics).toHaveClass("ui-metric-grid", "target-metrics");
    expect(metrics).toHaveAttribute("data-variant", "metrics");
    expect(screen.getByText("71").parentElement).toHaveAttribute("data-tone", "success");
    expect(screen.getByRole("group", { name: "Run details" })).toHaveTextContent("Run IDrun-01");
  });

  it("composes evidence, data-table boundaries, empty states, and action footers", () => {
    render(<>
      <EvidenceList ariaLabel="Checks" items={[{
        description: "Image content is valid",
        id: "content",
        meta: "CONTENT_VALID",
        status: <Badge tone="success">Pass</Badge>,
        title: "Campaign content",
      }]} />
      <DataTableFrame label="Sessions" toolbar={<span>Toolbar</span>} footer={<span>Footer</span>}>
        <DataTable caption="Sessions"><tbody><tr><td>Session</td></tr></tbody></DataTable>
      </DataTableFrame>
      <DataTableFrame label="Activity" scroll={false} variant="flush"><span>Direct scroll owner</span></DataTableFrame>
      <EmptyState compact icon="activity" title="No activity">New activity will appear here.</EmptyState>
      <ActionFooter actions={<Button>Continue</Button>} description="All changes saved" title="Step 1" />
    </>);

    expect(screen.getByRole("list", { name: "Checks" })).toHaveTextContent("CONTENT_VALID");
    expect(screen.getByRole("region", { name: "Sessions" })).toHaveAttribute("data-variant", "outlined");
    expect(screen.getByRole("region", { name: "Sessions" })).toHaveTextContent("Toolbar");
    expect(screen.getByRole("region", { name: "Sessions" })).toHaveTextContent("Footer");
    expect(screen.getByRole("region", { name: "Activity" })).toHaveAttribute("data-variant", "flush");
    expect(screen.getByRole("region", { name: "Activity" })).not.toContainHTML("ui-data-table-scroll");
    expect(screen.getByText("New activity will appear here.").closest(".ui-empty-state")).toHaveAttribute("data-compact", "true");
    expect(screen.getByRole("button", { name: "Continue" }).closest(".ui-action-footer")).toBeInTheDocument();
  });
});
