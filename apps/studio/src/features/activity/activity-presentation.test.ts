import { describe, expect, it } from "vitest";

import {
  activityMetadataLabel,
  activityMetadataValue,
  activityOriginLabel,
  activitySubjectTypeLabel,
} from "./activity-presentation";
import { activityTimeRangeStart } from "./ActivityToolbar";

describe("activity presentation", () => {
  it("turns retained technical vocabulary into stable operator-facing labels", () => {
    expect(activityOriginLabel("STUDIO")).toBe("WA Studio");
    expect(activityOriginLabel("RUNTIME")).toBe("WA Runtime");
    expect(activityOriginLabel("GATEWAY")).toBe("OpenWA Gateway");
    expect(activitySubjectTypeLabel("CAMPAIGN_RUN")).toBe("Campaign run");
    expect(activityMetadataLabel("executionMode")).toBe("Execution mode");
    expect(activityMetadataLabel("policy_version")).toBe("Policy version");
  });

  it("serializes nested metadata deterministically", () => {
    expect(activityMetadataValue({ z: 1, a: { y: true, b: false } }))
      .toBe('{"a":{"b":false,"y":true},"z":1}');
    expect(activityMetadataValue(null)).toBe("null");
  });

  it("calculates explicit UTC starts for retained time presets", () => {
    const now = Date.parse("2026-09-02T12:00:00.000Z");
    expect(activityTimeRangeStart("ALL", now)).toBeUndefined();
    expect(activityTimeRangeStart("24H", now)).toBe("2026-09-01T12:00:00.000Z");
    expect(activityTimeRangeStart("7D", now)).toBe("2026-08-26T12:00:00.000Z");
    expect(activityTimeRangeStart("30D", now)).toBe("2026-08-03T12:00:00.000Z");
  });
});
