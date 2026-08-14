import { describe, expect, it } from "vitest";

import type { components, paths } from "./generated/runtime";
import openapiSnapshot from "../../../contracts/wa-runtime/v1/openapi.json?raw";

type UpdateCampaignDto = components["schemas"]["UpdateCampaignDto"];
type CampaignListQuery = NonNullable<
  paths["/api/v1/campaigns"]["get"]["parameters"]["query"]
>;

describe("authoritative WA Runtime contract", () => {
  it("keeps the canonical snapshot at the pinned SHA-256", async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(openapiSnapshot),
    );
    const checksum = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(checksum)
      .toBe("e77b1058958dfa8238ebc3f71940165eaf5b82fd7ae2a487b183c3990071cdf2");
  });

  it("generates nullable scheduledAt for UpdateCampaignDto", () => {
    const immediate: UpdateCampaignDto = { scheduleType: "IMMEDIATE", scheduledAt: null };
    const contentOnly: UpdateCampaignDto = { text: "Changed without scheduling" };
    expect(immediate.scheduledAt).toBeNull();
    expect(contentOnly).not.toHaveProperty("scheduledAt");
  });

  it("generates the authoritative campaign search and multi-filter query", () => {
    const query: CampaignListQuery = {
      limit: 20,
      offset: 0,
      sessionId: "session-id",
      query: "release",
      status: ["DRAFT", "PAUSED"],
      scheduleType: ["IMMEDIATE", "ONCE"],
    };
    expect(query.status).toEqual(["DRAFT", "PAUSED"]);
    expect(query.scheduleType).toEqual(["IMMEDIATE", "ONCE"]);
  });
});
