import { describe, expect, it } from "vitest";

import {
  CAMPAIGN_STATUS_OPTIONS,
  activeCampaignFilterCount,
  campaignListRequestKey,
  clearCampaignFilters,
  initialCampaignListState,
  toggleCampaignFilter,
} from "./campaign-list-state";

describe("campaign list state", () => {
  it("starts without optional search or filters", () => {
    expect(initialCampaignListState("session-id")).toEqual({
      inputQuery: "",
      offset: 0,
      query: "",
      scheduleTypes: [],
      sessionId: "session-id",
      statuses: [],
    });
  });

  it("orders and toggles only known multi-select values", () => {
    expect(toggleCampaignFilter(["PAUSED"], "DRAFT", CAMPAIGN_STATUS_OPTIONS))
      .toEqual(["DRAFT", "PAUSED"]);
    expect(toggleCampaignFilter(["DRAFT", "PAUSED"], "DRAFT", CAMPAIGN_STATUS_OPTIONS))
      .toEqual(["PAUSED"]);
  });

  it("clears filters and offset without clearing search", () => {
    const state = {
      ...initialCampaignListState("session-id"),
      inputQuery: "release",
      query: "release",
      offset: 50,
      statuses: ["DRAFT" as const],
      scheduleTypes: ["ONCE" as const],
    };
    expect(clearCampaignFilters(state)).toMatchObject({
      inputQuery: "release",
      query: "release",
      offset: 0,
      statuses: [],
      scheduleTypes: [],
    });
    expect(activeCampaignFilterCount(state)).toBe(2);
  });

  it("keys requests by applied criteria, page, and session but not raw search input", () => {
    const state = initialCampaignListState("session-id");
    const stateWithRawInput = { ...state, inputQuery: "typing" };
    expect(campaignListRequestKey(stateWithRawInput))
      .toBe(campaignListRequestKey(state));
    expect(campaignListRequestKey({ ...state, query: "typing" }))
      .not.toBe(campaignListRequestKey(state));
  });
});
