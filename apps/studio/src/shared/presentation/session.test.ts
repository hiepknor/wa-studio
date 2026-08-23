import { describe, expect, it } from "vitest";

import { sessionIdentityLabel } from "./session";

describe("sessionIdentityLabel", () => {
  it("combines the WhatsApp profile name and phone", () => {
    expect(sessionIdentityLabel({
      id: "session-id",
      phone: "8490111222",
      pushName: "Operations",
    })).toBe("Operations · 8490111222");
  });

  it("falls back cleanly when profile identity fields are missing", () => {
    expect(sessionIdentityLabel({ id: "session-id", phone: null, pushName: null }))
      .toBe("session-id");
    expect(sessionIdentityLabel({ id: "session-id", phone: "8490111222", pushName: "  " }))
      .toBe("8490111222");
  });
});
