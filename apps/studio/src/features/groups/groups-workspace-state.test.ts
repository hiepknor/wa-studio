import { describe, expect, it } from "vitest";
import type {
  RuntimeGroupList,
  RuntimeGroupListGroup,
} from "@/shared/api/runtime-client";
import {
  createGroupListMetadataDraft,
  editGroupListMetadataDraft,
  filterGroupListMembership,
  groupListCapacityLabel,
  groupListMetadataDirty,
  updateGroupListMetadataDraft,
} from "./groups-workspace-state";

const list: RuntimeGroupList = {
  archivedAt: null,
  createdAt: "2026-08-25T00:00:00.000Z",
  description: "Priority accounts",
  groupCount: 2,
  id: "list-1",
  membershipRevision: 3,
  name: "North America",
  revision: 4,
  sessionId: "session-1",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

function membershipRow(
  groupId: string,
  overrides: Partial<RuntimeGroupListGroup> = {},
): RuntimeGroupListGroup {
  return {
    groupId,
    groupName: `Group ${groupId}`,
    isActive: true,
    participantsCount: 20,
    sendCapability: {
      checkedAt: "2026-08-25T00:00:00.000Z",
      invalidatedAt: null,
      reason: "eligible",
      revision: 1,
      status: "ALLOWED",
    },
    syncedAt: "2026-08-25T00:00:00.000Z",
    ...overrides,
  };
}

describe("groups workspace state", () => {
  it("creates a metadata draft without consuming or mutating its seed selection", () => {
    const seed = ["group-1", "group-2"];
    const draft = createGroupListMetadataDraft({
      idempotencyKey: "create-key",
      memberIds: seed,
      sessionId: "session-1",
      source: "selection",
    });

    expect(draft.memberIds).toEqual(seed);
    expect(draft.memberIds).not.toBe(seed);
    expect(draft.name).toBe("");
    expect(draft.description).toBe("");
    expect(groupListMetadataDirty(draft)).toBe(false);
  });

  it("builds an edit draft from canonical metadata only", () => {
    const draft = editGroupListMetadataDraft(list);

    expect(draft.name).toBe("North America");
    expect(draft.description).toBe("Priority accounts");
    expect(draft.memberIds).toEqual([]);
    expect(groupListMetadataDirty(draft)).toBe(false);
  });

  it("tracks trimmed metadata changes", () => {
    const draft = editGroupListMetadataDraft(list);
    const unchanged = updateGroupListMetadataDraft(
      draft,
      { description: "Priority accounts  ", name: "North America  " },
    );
    const changed = updateGroupListMetadataDraft(
      draft,
      { description: "Priority accounts", name: "North America v2" },
    );

    expect(groupListMetadataDirty(unchanged)).toBe(false);
    expect(groupListMetadataDirty(changed)).toBe(true);
  });

  it("filters membership rows with the same real group semantics", () => {
    const rows = [
      membershipRow("allowed", { participantsCount: 120 }),
      membershipRow("denied", {
        groupName: "Dormant Europe",
        isActive: false,
        sendCapability: {
          checkedAt: null,
          invalidatedAt: "2026-08-25T00:00:00.000Z",
          reason: "not_admin",
          revision: 2,
          status: "DENIED",
        },
      }),
    ];

    expect(filterGroupListMembership(rows, {
      active: false,
      capabilityFreshness: ["STALE"],
      capabilityStatuses: ["DENIED"],
      query: "europe",
    })).toEqual([rows[1]]);
    expect(filterGroupListMembership(rows, {
      minParticipants: 100,
      query: "",
    })).toEqual([rows[0]]);
  });

  it("shows capacity only near the hard limit", () => {
    expect(groupListCapacityLabel(899)).toBeNull();
    expect(groupListCapacityLabel(900)).toBe("100 remaining");
    expect(groupListCapacityLabel(1_000)).toBe("Limit reached");
  });
});
