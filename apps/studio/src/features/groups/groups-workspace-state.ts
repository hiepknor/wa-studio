import type {
  RuntimeGroupCapabilityFreshness,
  RuntimeGroupCapabilityStatus,
  RuntimeGroupList,
  RuntimeGroupListGroup,
} from "@/shared/api/runtime-client";
import { MAX_GROUP_SELECTION } from "./selection/group-selection";

export type GroupsScope =
  | { mode: "directory" }
  | { list: RuntimeGroupList; mode: "list:view" };

export type GroupListMetadataSource = "scope" | "selection";

export type GroupListMetadataDraft =
  | {
    baselineDescription: "";
    baselineName: "";
    canonical: null;
    createIdempotencyKey: string;
    description: string;
    memberIds: string[];
    mode: "create";
    name: string;
    sessionId: string;
    source: GroupListMetadataSource;
  }
  | {
    baselineDescription: string;
    baselineName: string;
    canonical: RuntimeGroupList;
    createIdempotencyKey: null;
    description: string;
    memberIds: [];
    mode: "edit";
    name: string;
    sessionId: string;
    source: "scope";
  };

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

export function createGroupListMetadataDraft(input: {
  idempotencyKey: string;
  memberIds?: readonly string[];
  sessionId: string;
  source: GroupListMetadataSource;
}): GroupListMetadataDraft {
  return {
    baselineDescription: "",
    baselineName: "",
    canonical: null,
    createIdempotencyKey: input.idempotencyKey,
    description: "",
    memberIds: uniqueIds(input.memberIds ?? []),
    mode: "create",
    name: "",
    sessionId: input.sessionId,
    source: input.source,
  };
}

export function editGroupListMetadataDraft(
  list: RuntimeGroupList,
): GroupListMetadataDraft {
  return {
    baselineDescription: list.description ?? "",
    baselineName: list.name,
    canonical: list,
    createIdempotencyKey: null,
    description: list.description ?? "",
    memberIds: [],
    mode: "edit",
    name: list.name,
    sessionId: list.sessionId,
    source: "scope",
  };
}

export function groupListMetadataDirty(draft: GroupListMetadataDraft): boolean {
  return draft.name.trim() !== draft.baselineName
    || draft.description.trim() !== draft.baselineDescription;
}

export function updateGroupListMetadataDraft(
  draft: GroupListMetadataDraft,
  metadata: { description: string; name: string },
): GroupListMetadataDraft {
  return { ...draft, ...metadata };
}

export function filterGroupListMembership(
  rows: readonly RuntimeGroupListGroup[],
  input: {
    active?: boolean;
    capabilityFreshness?: readonly RuntimeGroupCapabilityFreshness[];
    capabilityStatuses?: readonly RuntimeGroupCapabilityStatus[];
    maxParticipants?: number;
    minParticipants?: number;
    query: string;
  },
): RuntimeGroupListGroup[] {
  const query = input.query.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (query && !`${row.groupName} ${row.groupId}`.toLocaleLowerCase().includes(query)) {
      return false;
    }
    if (input.active !== undefined && row.isActive !== input.active) return false;
    if (
      input.minParticipants !== undefined
      && (row.participantsCount === null || row.participantsCount < input.minParticipants)
    ) return false;
    if (
      input.maxParticipants !== undefined
      && (row.participantsCount === null || row.participantsCount > input.maxParticipants)
    ) return false;
    if (
      input.capabilityStatuses?.length
      && !input.capabilityStatuses.includes(row.sendCapability.status)
    ) return false;
    if (input.capabilityFreshness?.length) {
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
