import { describe, expect, it } from "vitest";

import { reconcileMemberDatasetRevision } from "./member-dataset";

describe("member dataset revision reconciliation", () => {
  it("accepts legacy revision zero and projected first pages", () => {
    expect(reconcileMemberDatasetRevision(null, 0, true)).toEqual({
      action: "accept",
      revision: 0,
    });
    expect(reconcileMemberDatasetRevision(null, 73, true)).toEqual({
      action: "accept",
      revision: 73,
    });
  });

  it("keeps stable pages without a restart", () => {
    expect(reconcileMemberDatasetRevision(73, 73, true)).toEqual({
      action: "accept",
      revision: 73,
    });
  });

  it("restarts a changed dataset once and then accepts page zero", () => {
    expect(reconcileMemberDatasetRevision(73, 74, true)).toEqual({
      action: "restart",
      revision: 74,
    });
    expect(reconcileMemberDatasetRevision(74, 75, false)).toEqual({
      action: "accept",
      revision: 75,
    });
  });
});
