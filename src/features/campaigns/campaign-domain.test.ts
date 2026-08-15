import { describe, expect, it } from "vitest";

import type { RuntimeCampaign, RuntimeCampaignPreflight } from "@/shared/api/runtime-client";
import {
  campaignTargetDiff,
  campaignErrorMessage,
  createCampaignPayload,
  isPreflightStale,
  updateCampaignPayload,
  validateCampaignForm,
  validateTargetReplacement,
  type CampaignFormValues,
} from "./campaign-domain";

const campaign: RuntimeCampaign = {
  id: "campaign-id",
  sessionId: "session-id",
  name: "Release",
  text: "Ship it",
  scheduleType: "ONCE",
  scheduledAt: "2026-09-01T02:00:00.000Z",
  status: "DRAFT",
  targetCount: 2,
  revision: 4,
  targetsRevision: 7,
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
};

const validOnce: CampaignFormValues = {
  name: "Release",
  text: "Ship it",
  scheduleType: "ONCE",
  scheduledAt: "2026-09-01T09:00",
};

describe("campaign scheduling", () => {
  it("creates IMMEDIATE without a timestamp and treats the Runtime DTO null as canonical", () => {
    const payload = createCampaignPayload("session-id", {
      ...validOnce,
      scheduleType: "IMMEDIATE",
      scheduledAt: "2026-09-01T09:00",
    });
    expect(payload).toEqual({
      sessionId: "session-id",
      name: "Release",
      text: "Ship it",
      scheduleType: "IMMEDIATE",
    });
    expect({ ...campaign, scheduleType: "IMMEDIATE", scheduledAt: null }.scheduledAt).toBeNull();
  });

  it("creates ONCE with an ISO timestamp carrying UTC timezone", () => {
    expect(createCampaignPayload("session-id", validOnce).scheduledAt).toMatch(/Z$/);
  });

  it.each([
    ["", "Choose when"],
    ["invalid", "valid date"],
    ["2026-08-13T09:00", "future"],
  ])("validates required, invalid, and past ONCE values", (scheduledAt, copy) => {
    expect(validateCampaignForm(
      { ...validOnce, scheduledAt },
      new Date("2026-08-14T00:00:00.000Z"),
    ).scheduledAt).toContain(copy);
  });

  it("keeps scheduling fields out of a content-only PATCH", () => {
    expect(updateCampaignPayload(campaign, { ...validOnce, text: "Updated" })).toEqual({
      text: "Updated",
    });
  });

  it("clears scheduledAt when changing ONCE to IMMEDIATE", () => {
    expect(updateCampaignPayload(campaign, {
      ...validOnce,
      scheduleType: "IMMEDIATE",
      scheduledAt: "",
    })).toEqual({ scheduleType: "IMMEDIATE", scheduledAt: null });
  });
});

describe("campaign target and revision invariants", () => {
  it("derives staged additions and removals from the authoritative target set", () => {
    expect(campaignTargetDiff(
      ["saved@g.us", "removed@g.us"],
      ["saved@g.us", "added@g.us"],
    )).toEqual({
      addedIds: ["added@g.us"],
      removedIds: ["removed@g.us"],
      savedCount: 2,
      selectedCount: 2,
    });
    expect(campaignTargetDiff([], [])).toEqual({
      addedIds: [],
      removedIds: [],
      savedCount: 0,
      selectedCount: 0,
    });
  });

  it("accepts an empty complete replacement", () => {
    expect(validateTargetReplacement([])).toEqual({ ok: true, groupIds: [] });
  });

  it("rejects duplicate and 1,001-item replacement sets before Runtime", () => {
    expect(validateTargetReplacement(["a@g.us", "a@g.us"])).toMatchObject({
      code: "CAMPAIGN_TARGET_DUPLICATE",
      ok: false,
    });
    expect(validateTargetReplacement(Array.from({ length: 1_001 }, (_, index) => `${index}@g.us`)))
      .toMatchObject({ code: "CAMPAIGN_TARGET_LIMIT_EXCEEDED", ok: false });
  });

  it("marks preflight stale from either Runtime revision", () => {
    const report = {
      campaignRevision: 4,
      targetsRevision: 7,
    } as RuntimeCampaignPreflight;
    expect(isPreflightStale(report, campaign)).toBe(false);
    expect(isPreflightStale(report, { revision: 5, targetsRevision: 7 })).toBe(true);
    expect(isPreflightStale(report, { revision: 4, targetsRevision: 8 })).toBe(true);
  });

  it.each([
    "CAMPAIGN_TARGET_SESSION_MISMATCH",
    "CAMPAIGN_TARGET_NOT_FOUND",
    "CAMPAIGN_NOT_EDITABLE",
    "CAMPAIGN_IDEMPOTENCY_CONFLICT",
  ])("uses typed code %s instead of parsing Runtime messages", (code) => {
    expect(campaignErrorMessage({ code, message: "opaque" }, "fallback")).not.toBe("opaque");
  });
});
