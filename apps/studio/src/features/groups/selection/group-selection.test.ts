import { describe, expect, it } from "vitest";

import {
  applyGroupSelectionSnapshot,
  groupSelectionDiff,
  groupSelectionRowOrder,
  sameGroupSelection,
} from "./group-selection";

describe("group selection snapshots", () => {
  it("adds multiple snapshots as an ordered deduplicated union", () => {
    const first = applyGroupSelectionSnapshot(["manual@g.us"], ["a@g.us", "manual@g.us"], "add");
    const second = applyGroupSelectionSnapshot(first.nextIds, ["a@g.us", "b@g.us"], "add");
    expect(first).toEqual({ addedCount: 1, nextIds: ["manual@g.us", "a@g.us"], ok: true });
    expect(second).toEqual({ addedCount: 1, nextIds: ["manual@g.us", "a@g.us", "b@g.us"], ok: true });
    expect(applyGroupSelectionSnapshot(second.nextIds, [], "add"))
      .toEqual({ addedCount: 0, nextIds: second.nextIds, ok: true });
  });

  it("replaces with the complete snapshot, including an explicit empty set", () => {
    expect(applyGroupSelectionSnapshot(["old@g.us"], ["new@g.us"], "replace").nextIds)
      .toEqual(["new@g.us"]);
    expect(applyGroupSelectionSnapshot(["old@g.us"], [], "replace").nextIds).toEqual([]);
  });

  it("accepts 1,000 and leaves the staged selection unchanged above the limit", () => {
    const thousand = Array.from({ length: 1_000 }, (_, index) => `${index}@g.us`);
    expect(applyGroupSelectionSnapshot([], thousand, "add").ok).toBe(true);
    const rejected = applyGroupSelectionSnapshot(["manual@g.us"], thousand, "add");
    expect(rejected).toEqual({ addedCount: 0, nextIds: ["manual@g.us"], ok: false });
  });

  it("compares complete selections independent of response ordering", () => {
    expect(sameGroupSelection(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameGroupSelection(["a"], ["a", "b"])).toBe(false);
  });

  it("describes the complete saved-to-staged selection diff", () => {
    expect(groupSelectionDiff(["saved@g.us", "removed@g.us"], ["saved@g.us", "added@g.us"]))
      .toEqual({
        addedIds: ["added@g.us"],
        removedIds: ["removed@g.us"],
        savedCount: 2,
        stagedCount: 2,
      });
  });

  it("keeps current-page server order stable and only pins retained groups outside the page", () => {
    const order = groupSelectionRowOrder(
      ["selected-on-page@g.us", "selected-outside@g.us", "selected-on-page@g.us"],
      ["first@g.us", "selected-on-page@g.us", "last@g.us"],
    );

    expect(order.rowIds).toEqual([
      "selected-outside@g.us",
      "first@g.us",
      "selected-on-page@g.us",
      "last@g.us",
    ]);
    expect(order.pinnedIds).toEqual(new Set(["selected-outside@g.us"]));
  });
});
