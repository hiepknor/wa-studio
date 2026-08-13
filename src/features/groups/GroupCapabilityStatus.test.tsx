import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  getGroupCapabilityPresentation,
  GroupCapabilityStatus,
} from "./GroupCapabilityStatus";

const currentCapability = {
  status: "ALLOWED" as const,
  reason: "SEND_ALLOWED",
  checkedAt: "2026-08-13T02:00:00.000Z",
  invalidatedAt: null,
  revision: 3,
};

describe("GroupCapabilityStatus", () => {
  it.each([
    ["ALLOWED", "success", "Allowed"],
    ["DENIED", "danger", "Denied"],
    ["UNKNOWN", "warning", "Unknown"],
  ] as const)("maps current %s capability to %s", (status, tone, label) => {
    expect(getGroupCapabilityPresentation({ ...currentCapability, status })).toMatchObject({
      label,
      stale: false,
      tone,
    });
  });

  it.each(["ALLOWED", "DENIED"] as const)(
    "shows stale %s as warning instead of a definitive status",
    (status) => {
      expect(getGroupCapabilityPresentation({
        ...currentCapability,
        status,
        invalidatedAt: "2026-08-13T03:00:00.000Z",
      })).toMatchObject({
        label: `${status === "ALLOWED" ? "Allowed" : "Denied"} · stale`,
        stale: true,
        tone: "warning",
      });
    },
  );

  it("treats an invalidated capability without a check timestamp as stale", () => {
    expect(getGroupCapabilityPresentation({
      ...currentCapability,
      checkedAt: null,
      invalidatedAt: "2026-08-13T03:00:00.000Z",
    }).stale).toBe(true);
  });

  it("can keep freshness visually separate while retaining an accessible stale label", () => {
    render(
      <GroupCapabilityStatus
        appearance="badge"
        capability={{
          ...currentCapability,
          invalidatedAt: "2026-08-13T03:00:00.000Z",
        }}
        includeFreshness={false}
      />,
    );

    expect(screen.getByText("Allowed")).toHaveClass("ui-badge-warning");
    expect(screen.getByLabelText("Allowed, stale")).toBeInTheDocument();
  });
});
