import { describe, expect, it } from "vitest";

import { RuntimeRequestError } from "@/shared/api/runtime-client";
import { groupListErrorMessage } from "./group-list-domain";

describe("groupListErrorMessage", () => {
  it.each([
    ["GROUP_LIST_NAME_CONFLICT", "already exists"],
    ["GROUP_LIST_IDEMPOTENCY_CONFLICT", "create key"],
    ["GROUP_LIST_GROUP_DUPLICATE", "only once"],
    ["GROUP_LIST_GROUP_LIMIT_EXCEEDED", "1,000"],
    ["GROUP_LIST_GROUP_NOT_FOUND", "no longer exist"],
    ["GROUP_LIST_GROUP_SESSION_MISMATCH", "list session"],
    ["GROUP_LIST_REVISION_CONFLICT", "canonical state"],
    ["GROUP_LIST_ARCHIVED", "archived"],
  ])("maps %s without parsing Runtime message text", (code, copy) => {
    const error = new RuntimeRequestError("opaque message", { code, status: 409 });
    expect(groupListErrorMessage(error, "fallback")).toContain(copy);
  });

  it("uses status-based authorization and missing-resource fallbacks", () => {
    expect(groupListErrorMessage(
      new RuntimeRequestError("opaque", { status: 401 }),
      "fallback",
    )).toContain("valid Runtime key");
    expect(groupListErrorMessage(
      new RuntimeRequestError("opaque", { status: 404 }),
      "fallback",
    )).toContain("no longer available");
  });
});
