import { describe, expect, it } from "vitest";

import { anchoredPopupLayout } from "./anchored-popup";

describe("anchoredPopupLayout", () => {
  it("places a popup below when the clipped boundary has enough room", () => {
    expect(anchoredPopupLayout({
      boundary: { bottom: 500, top: 0 },
      gap: 6,
      maxHeight: 260,
      naturalHeight: 180,
      triggerBottom: 100,
      triggerTop: 66,
    })).toEqual({ maxHeight: 260, placement: "down" });
  });

  it("places a popup above and constrains it to the shared boundary", () => {
    expect(anchoredPopupLayout({
      boundary: { bottom: 240, top: 0 },
      gap: 6,
      maxHeight: 260,
      naturalHeight: 130,
      triggerBottom: 190,
      triggerTop: 150,
    })).toEqual({ maxHeight: 144, placement: "up" });
  });
});
