import { describe, expect, it } from "vitest";

import { deliveryTone } from "./run-presentation";

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
