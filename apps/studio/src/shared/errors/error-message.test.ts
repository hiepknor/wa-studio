import { describe, expect, it } from "vitest";

import { userFacingErrorMessage } from "./error-message";

describe("userFacingErrorMessage", () => {
  it("redacts every occurrence of submitted secrets", () => {
    expect(userFacingErrorMessage(
      new Error("secret-long and secret failed; secret-long remains"),
      "Safe fallback",
      ["secret", "secret-long"],
    )).toBe("[redacted] and [redacted] failed; [redacted] remains");
  });

  it("uses the safe fallback for non-Errors and empty messages", () => {
    expect(userFacingErrorMessage({ message: "untrusted" }, "Safe fallback"))
      .toBe("Safe fallback");
    expect(userFacingErrorMessage(new Error(""), "Safe fallback"))
      .toBe("Safe fallback");
  });
});
