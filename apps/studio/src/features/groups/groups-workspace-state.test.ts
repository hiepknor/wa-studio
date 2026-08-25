import { describe, expect, it } from "vitest";
import type {
  RuntimeGroupList,
  RuntimeGroupListGroup,
} from "@/shared/api/runtime-client";
import {
  createGroupListDraft,
  editGroupListDraft,
  filterGroupListMembership,
  groupListCapacityLabel,
  groupListDraftDiff,
  groupListDraftRowOrder,
  isGroupsScopeDirty,
  toggleGroupListDraftMember,
  toggleGroupListDraftPage,
  updateGroupListDraftMetadata,
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
  it("creates a new-list draft without consuming or mutating its seed selection", () => {
    const seed = ["group-1", "group-2"];
    const draft = createGroupListDraft({
      description: "  Reusable  ",
      idempotencyKey: "create-key",
      memberIds: seed,
      name: "  Founders  ",
      sessionId: "session-1",
    });

    expect(draft.memberIds).toEqual(seed);
    expect(draft.memberIds).not.toBe(seed);
    expect(draft.name).toBe("Founders");
    expect(draft.description).toBe("Reusable");
    expect(isGroupsScopeDirty({ draft, mode: "list:create" })).toBe(true);
  });

  it("builds an edit draft from canonical metadata and membership", () => {
    const rows = [membershipRow("group-1"), membershipRow("group-2")];
    const draft = editGroupListDraft({ data: rows, list }, "unused-key");

    expect(draft.baselineIds).toEqual(["group-1", "group-2"]);
    expect(draft.membershipRows["group-2"]).toBe(rows[1]);
    expect(isGroupsScopeDirty({ draft, mode: "list:edit" })).toBe(false);
  });

  it("tracks metadata and set-based membership changes independently", () => {
    const draft = editGroupListDraft(
      { data: [membershipRow("group-1"), membershipRow("group-2")], list },
      "unused-key",
    );
    const changed = updateGroupListDraftMetadata(
      toggleGroupListDraftMember(draft, "group-1").draft,
      { description: "Priority accounts", name: "North America v2" },
    );

    expect(groupListDraftDiff(changed)).toMatchObject({
      membershipDirty: true,
      metadataDirty: true,
      removedIds: ["group-1"],
      savedCount: 2,
      stagedCount: 1,
    });
  });

  it("toggles a visible page atomically and enforces capacity", () => {
    const draft = createGroupListDraft({
      idempotencyKey: "create-key",
      memberIds: ["group-1"],
      name: "Founders",
      sessionId: "session-1",
    });
    const selected = toggleGroupListDraftPage(draft, ["group-1", "group-2"], 2);
    expect(selected.ok).toBe(true);
    expect(selected.draft.memberIds).toEqual(["group-1", "group-2"]);

    const rejected = toggleGroupListDraftMember(selected.draft, "group-3", 2);
    expect(rejected.ok).toBe(false);
    expect(rejected.draft).toBe(selected.draft);

    const cleared = toggleGroupListDraftPage(selected.draft, ["group-1", "group-2"], 2);
    expect(cleared.draft.memberIds).toEqual([]);
  });

  it("pins saved or staged membership outside the current directory page", () => {
    const draft = editGroupListDraft(
      { data: [membershipRow("saved"), membershipRow("visible")], list },
      "unused-key",
    );
    const changed = toggleGroupListDraftMember(
      toggleGroupListDraftMember(draft, "saved").draft,
      "staged",
    ).draft;

    const order = groupListDraftRowOrder(changed, ["visible", "page"]);
    expect(order.rowIds).toEqual(["staged", "saved", "visible", "page"]);
    expect([...order.pinnedIds]).toEqual(["staged", "saved"]);
  });

  it("filters membership rows with the same real group semantics", () => {
    const rows = [
      membershipRow("allowed"),
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
      membership: "in-list",
      query: "europe",
      selectedIds: new Set(["denied"]),
    })).toEqual([rows[1]]);
    expect(filterGroupListMembership(rows, {
      membership: "not-in-list",
      query: "",
      selectedIds: new Set(["denied"]),
    })).toEqual([rows[0]]);
  });

  it("shows capacity only near the hard limit", () => {
    expect(groupListCapacityLabel(899)).toBeNull();
    expect(groupListCapacityLabel(900)).toBe("100 remaining");
    expect(groupListCapacityLabel(1_000)).toBe("Limit reached");
  });
});
