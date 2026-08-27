import { describe, expect, it } from "vitest";

import {
  formatListResultSummary,
  formatLoadedResultSummary,
} from "./list-result-summary";

describe("list result summaries", () => {
  it("uses domain nouns for complete unfiltered result sets", () => {
    expect(formatListResultSummary({
      firstItem: 0,
      hasCriteria: false,
      lastItem: 0,
      plural: "groups",
      singular: "group",
      total: 0,
    })).toBe("0 groups");
    expect(formatListResultSummary({
      firstItem: 1,
      hasCriteria: false,
      lastItem: 1,
      plural: "sessions",
      singular: "session",
      total: 1,
    })).toBe("1 session");
  });

  it("uses match language only when criteria are active", () => {
    expect(formatListResultSummary({
      firstItem: 0,
      hasCriteria: true,
      lastItem: 0,
      plural: "campaigns",
      singular: "campaign",
      total: 0,
    })).toBe("0 matches");
    expect(formatListResultSummary({
      firstItem: 1,
      hasCriteria: true,
      lastItem: 4,
      plural: "campaigns",
      singular: "campaign",
      total: 4,
    })).toBe("4 matches");
  });

  it("keeps paged summaries compact", () => {
    expect(formatListResultSummary({
      firstItem: 21,
      hasCriteria: false,
      lastItem: 40,
      plural: "runs",
      singular: "run",
      total: 91,
    })).toBe("21–40 of 91");
    expect(formatListResultSummary({
      firstItem: 21,
      hasCriteria: true,
      lastItem: 40,
      plural: "runs",
      singular: "run",
      total: 91,
    })).toBe("21–40 of 91 matches");
  });

  it("distinguishes cursor-loaded results from known totals", () => {
    expect(formatLoadedResultSummary(1, "event", "events")).toBe("1 event loaded");
    expect(formatLoadedResultSummary(4, "event", "events")).toBe("4 events loaded");
  });
});
