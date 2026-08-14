import { describe, expect, it } from "vitest";

import type { components } from "./generated/runtime";
import openapiSnapshot from "../../../contracts/wa-runtime/v1/openapi.json?raw";

type UpdateCampaignDto = components["schemas"]["UpdateCampaignDto"];

describe("authoritative WA Runtime contract", () => {
  it("keeps the canonical snapshot at the pinned SHA-256", async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(openapiSnapshot),
    );
    const checksum = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(checksum)
      .toBe("3b8ff2cbb110ebf1f79ff40f1b8b9549a51527cf6e2488dec292ceb727034e7a");
  });

  it("generates nullable scheduledAt for UpdateCampaignDto", () => {
    const immediate: UpdateCampaignDto = { scheduleType: "IMMEDIATE", scheduledAt: null };
    const contentOnly: UpdateCampaignDto = { text: "Changed without scheduling" };
    expect(immediate.scheduledAt).toBeNull();
    expect(contentOnly).not.toHaveProperty("scheduledAt");
  });
});
