import { describe, expect, it } from "vitest";

import {
  activeGroupFilterCount,
  clearGroupFilters,
  CAPABILITY_FRESHNESS_OPTIONS,
  CAPABILITY_STATUS_OPTIONS,
  hasGroupFilters,
  initialGroupListState,
  toggleFilterValue,
} from "./group-list-filters";

describe("group list filters", () => {
  it("treats Runtime's default active-only behavior as no explicit filter", () => {
    const state = initialGroupListState("session-id");

    expect(state.isActive).toBeUndefined();
    expect(state.minParticipants).toBeUndefined();
    expect(state.maxParticipants).toBeUndefined();
    expect(hasGroupFilters(state)).toBe(false);
    expect(activeGroupFilterCount(state)).toBe(0);
  });

  it("counts filter groups instead of selected values", () => {
    const state = initialGroupListState("session-id");
    state.capabilityStatuses = ["DENIED", "UNKNOWN"];
    state.capabilityFreshness = ["CURRENT", "STALE"];
    state.isActive = false;
    state.minParticipants = 20;
    state.maxParticipants = 500;

    expect(activeGroupFilterCount(state)).toBe(4);
  });

  it("clears filters without clearing the current search", () => {
    const state = initialGroupListState("session-id");
    state.inputQuery = "release";
    state.query = "release";
    state.capabilityStatuses = ["DENIED"];
    state.minParticipants = 20;
    state.maxParticipants = 500;
    state.offset = 40;

    expect(clearGroupFilters(state)).toMatchObject({
      inputQuery: "release",
      query: "release",
      capabilityStatuses: [],
      capabilityFreshness: [],
      isActive: undefined,
      minParticipants: undefined,
      maxParticipants: undefined,
      offset: 0,
    });
  });

  it("keeps every selected value in contract order", () => {
    const denied = toggleFilterValue([], "DENIED", CAPABILITY_STATUS_OPTIONS);
    const deniedAndAllowed = toggleFilterValue(
      denied,
      "ALLOWED",
      CAPABILITY_STATUS_OPTIONS,
    );

    expect(deniedAndAllowed).toEqual(["ALLOWED", "DENIED"]);
    expect(toggleFilterValue(
      deniedAndAllowed,
      "UNKNOWN",
      CAPABILITY_STATUS_OPTIONS,
    )).toEqual(["ALLOWED", "DENIED", "UNKNOWN"]);
    expect(toggleFilterValue(
      ["CURRENT"],
      "STALE",
      CAPABILITY_FRESHNESS_OPTIONS,
    )).toEqual(["CURRENT", "STALE"]);
  });
});
