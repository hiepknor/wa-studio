import { describe, expect, it } from "vitest";

import { deliveryTone, runStatusLabel } from "./run-presentation";

describe("deliveryTone", () => {
  it.each([
    ["PENDING", "info"],
    ["MATERIALIZED", "info"],
    ["PROCESSING", "info"],
    ["DRY_RUN_COMPLETED", "success"],
    ["ACCEPTED", "success"],
    ["SENT", "success"],
    ["DELIVERED", "success"],
    ["READ", "success"],
    ["FAILED", "danger"],
    ["UNKNOWN", "danger"],
    ["BLOCKED_CAPABILITY_CHANGED", "danger"],
    ["CANCELLED", "neutral"],
  ] as const)("maps %s to %s", (status, tone) => {
    expect(deliveryTone(status)).toBe(tone);
  });
});

describe("runStatusLabel", () => {
  it("keeps delivery states explicit", () => {
    expect(runStatusLabel("DRY_RUN_COMPLETED")).toBe("Dry Run Completed");
    expect(runStatusLabel("BLOCKED_CAPABILITY_CHANGED")).toBe("Blocked Capability Changed");
  });
});
