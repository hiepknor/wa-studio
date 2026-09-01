import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DateTime } from "./DateTime";
import { formatDateTime, formatExactDateTime, formatRelativeDateTime } from "./date-time";

const TIMESTAMP = "2026-08-15T20:40:32.000Z";

describe("DateTime", () => {
  it("uses the stable full-date, 24-hour presentation", () => {
    expect(formatDateTime(TIMESTAMP, { timeZone: "UTC" }))
      .toBe("15 Aug 2026 · 20:40");
    expect(formatDateTime(TIMESTAMP, { precision: "second", timeZone: "UTC" }))
      .toBe("15 Aug 2026 · 20:40:32");
    expect(formatExactDateTime(TIMESTAMP, "UTC"))
      .toBe("15 Aug 2026 · 20:40:32 GMT+0");
  });

  it("renders semantic machine time and keeps exact time in accessible metadata", () => {
    render(<DateTime timeZone="UTC" value={TIMESTAMP} />);

    const time = screen.getByText("15 Aug 2026 · 20:40");
    expect(time).toHaveAttribute("datetime", TIMESTAMP);
    expect(time).toHaveAccessibleName("15 Aug 2026 · 20:40:32 GMT+0");
    expect(time).toHaveAttribute("title", "15 Aug 2026 · 20:40:32 GMT+0");
  });

  it("supports the compact relative presentation used by operational tables", () => {
    const now = new Date("2026-08-15T20:40:32.000Z");
    expect(formatRelativeDateTime("2026-08-15T20:40:10.000Z", { now, timeZone: "UTC" })).toBe("Just now");
    expect(formatRelativeDateTime("2026-08-15T20:36:00.000Z", { now, timeZone: "UTC" })).toBe("4 min ago");
    expect(formatRelativeDateTime("2026-08-14T19:40:32.000Z", { now, timeZone: "UTC" })).toBe("Yesterday, 19:40");
    expect(formatRelativeDateTime("2026-08-06T19:40:32.000Z", { now, timeZone: "UTC" })).toBe("06 Aug, 19:40");
    expect(formatRelativeDateTime("2026-08-15T20:40:10.000Z", { now, style: "compact", timeZone: "UTC" })).toBe("Now");
    expect(formatRelativeDateTime("2026-08-15T20:36:00.000Z", { now, style: "compact", timeZone: "UTC" })).toBe("4m ago");
    expect(formatRelativeDateTime("2026-08-14T19:40:32.000Z", { now, style: "compact", timeZone: "UTC" })).toBe("1d ago");
    expect(formatRelativeDateTime("2026-08-06T19:40:32.000Z", { now, style: "compact", timeZone: "UTC" })).toBe("06 Aug");
  });

  it("uses context-specific fallback copy for missing or invalid values", () => {
    const { rerender } = render(<DateTime fallback="Not synced" value={null} />);
    expect(screen.getByText("Not synced")).toBeInTheDocument();

    rerender(<DateTime fallback="Unavailable" value="not-a-date" />);
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
  });
});
