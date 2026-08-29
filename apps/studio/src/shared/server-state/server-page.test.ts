import { describe, expect, it } from "vitest";

import { lastPageOffset, reconciledPageOffset } from "./server-page";

describe("server page reconciliation", () => {
  it("aligns the final page to the requested limit", () => {
    expect(lastPageOffset(0, 20)).toBe(0);
    expect(lastPageOffset(1, 20)).toBe(0);
    expect(lastPageOffset(20, 20)).toBe(0);
    expect(lastPageOffset(21, 20)).toBe(20);
  });

  it("recovers only an empty page beyond the authoritative total", () => {
    expect(reconciledPageOffset({ limit: 20, offset: 40, rowCount: 0, total: 39 })).toBe(20);
    expect(reconciledPageOffset({ limit: 20, offset: 40, rowCount: 0, total: 0 })).toBe(0);
    expect(reconciledPageOffset({ limit: 20, offset: 40, rowCount: 1, total: 39 })).toBeNull();
    expect(reconciledPageOffset({ limit: 20, offset: 20, rowCount: 0, total: 21 })).toBeNull();
    expect(reconciledPageOffset({ limit: 20, offset: 0, rowCount: 0, total: 0 })).toBeNull();
  });
});
