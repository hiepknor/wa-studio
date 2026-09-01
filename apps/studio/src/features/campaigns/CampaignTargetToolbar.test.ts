import { describe, expect, it } from "vitest";

import {
  activeCampaignTargetFilterCount,
  emptyCampaignTargetFilters,
  validateParticipantRange,
} from "./CampaignTargetToolbar";

describe("CampaignTargetToolbar", () => {
  it("accepts empty, zero, inclusive, and maximum participant bounds", () => {
    expect(validateParticipantRange("", "")).toEqual({
      errors: { minParticipants: undefined, maxParticipants: undefined },
      minParticipants: undefined,
      maxParticipants: undefined,
    });
    expect(validateParticipantRange("0", "0")).toMatchObject({
      errors: { minParticipants: undefined, maxParticipants: undefined },
      minParticipants: 0,
      maxParticipants: 0,
    });
    expect(validateParticipantRange("50", "2147483647")).toMatchObject({
      errors: { minParticipants: undefined, maxParticipants: undefined },
      minParticipants: 50,
      maxParticipants: 2_147_483_647,
    });
  });

  it("rejects invalid integers and reversed participant ranges locally", () => {
    expect(validateParticipantRange("-1", "1.5").errors).toEqual({
      minParticipants: expect.stringContaining("whole number"),
      maxParticipants: expect.stringContaining("whole number"),
    });
    expect(validateParticipantRange("501", "500").errors).toEqual({
      minParticipants: "Minimum must not exceed maximum.",
      maxParticipants: "Maximum must be at least the minimum.",
    });
  });

  it("counts filter dimensions rather than every selected value", () => {
    expect(activeCampaignTargetFilterCount({
      ...emptyCampaignTargetFilters(),
      capabilityStatuses: ["ALLOWED", "UNKNOWN"],
      capabilityFreshness: ["CURRENT"],
      isActive: false,
      minParticipants: 50,
      maxParticipants: 500,
    })).toBe(4);
  });
});
