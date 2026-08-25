import type {
  RuntimeGroupCapabilityFreshness,
  RuntimeGroupCapabilityStatus,
  RuntimeGroupList,
  RuntimeGroupListGroup,
} from "@/shared/api/runtime-client";
import {
  groupSelectionDiff,
  groupSelectionRowOrder,
  MAX_GROUP_SELECTION,
  sameGroupSelection,
} from "./selection/group-selection";

export type GroupMembershipFilter = "all" | "in-list" | "not-in-list";

export interface GroupListDraft {
  baselineDescription: string;
  baselineIds: string[];
  baselineName: string;
  canonical: RuntimeGroupList | null;
  createIdempotencyKey: string;
  description: string;
  memberIds: string[];
  membershipRows: Record<string, RuntimeGroupListGroup>;
  name: string;
  sessionId: string;
}

export type GroupsScope =
  | { mode: "directory" }
  | { list: RuntimeGroupList; mode: "list:view" }
  | { draft: GroupListDraft; mode: "list:create" }
  | { draft: GroupListDraft; mode: "list:edit" };

export interface GroupListDraftDiff {
  addedIds: string[];
  membershipDirty: boolean;
  metadataDirty: boolean;
  removedIds: string[];
  savedCount: number;
  stagedCount: number;
}

export interface DraftSelectionResult {
  draft: GroupListDraft;
  ok: boolean;
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

export function createGroupListDraft(input: {
  description?: string;
  idempotencyKey: string;
  memberIds?: readonly string[];
  name: string;
  sessionId: string;
}): GroupListDraft {
  return {
    baselineDescription: "",
    baselineIds: [],
    baselineName: "",
    canonical: null,
    createIdempotencyKey: input.idempotencyKey,
    description: input.description?.trim() ?? "",
    memberIds: uniqueIds(input.memberIds ?? []),
    membershipRows: {},
    name: input.name.trim(),
    sessionId: input.sessionId,
  };
}

export function editGroupListDraft(
  membership: {
    data: RuntimeGroupListGroup[];
    list: RuntimeGroupList;
  },
  idempotencyKey: string,
): GroupListDraft {
  const memberIds = uniqueIds(membership.data.map((group) => group.groupId));
  return {
    baselineDescription: membership.list.description ?? "",
    baselineIds: memberIds,
    baselineName: membership.list.name,
    canonical: membership.list,
    createIdempotencyKey: idempotencyKey,
    description: membership.list.description ?? "",
    memberIds,
    membershipRows: Object.fromEntries(
      membership.data.map((group) => [group.groupId, group]),
    ),
    name: membership.list.name,
    sessionId: membership.list.sessionId,
  };
}

export function groupListDraftDiff(draft: GroupListDraft): GroupListDraftDiff {
  const membership = groupSelectionDiff(draft.baselineIds, draft.memberIds);
  return {
    ...membership,
    membershipDirty: !sameGroupSelection(draft.baselineIds, draft.memberIds),
    metadataDirty:
      draft.name.trim() !== draft.baselineName
      || draft.description.trim() !== draft.baselineDescription,
  };
}

export function isGroupsScopeDirty(scope: GroupsScope): boolean {
  if (scope.mode === "list:create") return true;
  if (scope.mode !== "list:edit") return false;
  const diff = groupListDraftDiff(scope.draft);
  return diff.metadataDirty || diff.membershipDirty;
}

export function updateGroupListDraftMetadata(
  draft: GroupListDraft,
  metadata: { description: string; name: string },
): GroupListDraft {
  return { ...draft, ...metadata };
}

export function toggleGroupListDraftMember(
  draft: GroupListDraft,
  groupId: string,
  limit = MAX_GROUP_SELECTION,
): DraftSelectionResult {
  if (draft.memberIds.includes(groupId)) {
    return {
      draft: {
        ...draft,
        memberIds: draft.memberIds.filter((id) => id !== groupId),
      },
      ok: true,
    };
  }
  if (draft.memberIds.length >= limit) return { draft, ok: false };
  return {
    draft: { ...draft, memberIds: [...draft.memberIds, groupId] },
    ok: true,
  };
}

export function toggleGroupListDraftPage(
  draft: GroupListDraft,
  pageIds: readonly string[],
  limit = MAX_GROUP_SELECTION,
): DraftSelectionResult {
  const uniquePageIds = uniqueIds(pageIds);
  const selected = new Set(draft.memberIds);
  const allSelected =
    uniquePageIds.length > 0 && uniquePageIds.every((id) => selected.has(id));
  if (allSelected) {
    const page = new Set(uniquePageIds);
    return {
      draft: {
        ...draft,
        memberIds: draft.memberIds.filter((id) => !page.has(id)),
      },
      ok: true,
    };
  }
  const nextIds = [
    ...draft.memberIds,
    ...uniquePageIds.filter((id) => !selected.has(id)),
  ];
  if (nextIds.length > limit) return { draft, ok: false };
  return { draft: { ...draft, memberIds: nextIds }, ok: true };
}

export function groupListDraftRowOrder(
  draft: GroupListDraft,
  currentPageIds: readonly string[],
) {
  const selected = new Set(draft.memberIds);
  const retainedIds = [
    ...draft.memberIds,
    ...draft.baselineIds.filter((id) => !selected.has(id)),
  ];
  return groupSelectionRowOrder(retainedIds, currentPageIds);
}

export function filterGroupListMembership(
  rows: readonly RuntimeGroupListGroup[],
  input: {
    active?: boolean;
    capabilityFreshness?: readonly RuntimeGroupCapabilityFreshness[];
    capabilityStatuses?: readonly RuntimeGroupCapabilityStatus[];
    membership: GroupMembershipFilter;
    query: string;
    selectedIds?: ReadonlySet<string>;
  },
): RuntimeGroupListGroup[] {
  const query = input.query.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    const selected = input.selectedIds?.has(row.groupId) ?? true;
    if (input.membership === "in-list" && !selected) return false;
    if (input.membership === "not-in-list" && selected) return false;
    if (query && !`${row.groupName} ${row.groupId}`.toLocaleLowerCase().includes(query)) {
      return false;
    }
    if (input.active !== undefined && row.isActive !== input.active) return false;
    if (
      input.capabilityStatuses?.length
      && !input.capabilityStatuses.includes(row.sendCapability.status)
    ) return false;
    if (
      input.capabilityFreshness?.length
    ) {
      const freshness: RuntimeGroupCapabilityFreshness =
        row.sendCapability.invalidatedAt === null ? "CURRENT" : "STALE";
      if (!input.capabilityFreshness.includes(freshness)) return false;
    }
    return true;
  });
}

export function groupListCapacityLabel(count: number): string | null {
  if (count < 900) return null;
  if (count >= MAX_GROUP_SELECTION) return "Limit reached";
  return `${MAX_GROUP_SELECTION - count} remaining`;
}
