import { describe, expect, it } from "vitest";

import { dataTablePageSelectionState } from "./data-table-selection";

describe("dataTablePageSelectionState", () => {
  it("keeps an empty page unselected", () => {
    expect(dataTablePageSelectionState([], new Set())).toEqual({
      allPageSelected: false,
      somePageSelected: false,
    });
  });

  it("reports a mixed page when only part of it is selected", () => {
    expect(dataTablePageSelectionState(["a", "b"], new Set(["a"]))).toEqual({
      allPageSelected: false,
      somePageSelected: true,
    });
  });

  it("reports a fully selected page without considering off-page rows", () => {
    expect(dataTablePageSelectionState(["a", "b"], new Set(["a", "b", "c"]))).toEqual({
      allPageSelected: true,
      somePageSelected: true,
    });
  });
});
