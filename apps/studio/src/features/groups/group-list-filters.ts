import type {
  RuntimeGroupCapabilityFreshness,
  RuntimeGroupCapabilityStatus,
} from "@/shared/api/runtime-client";

export interface GroupListRequestState {
  sessionId: string | null;
  query: string;
  capabilityStatuses: RuntimeGroupCapabilityStatus[];
  capabilityFreshness: RuntimeGroupCapabilityFreshness[];
  isActive: boolean | undefined;
  offset: number;
}

export interface GroupListState extends GroupListRequestState {
  inputQuery: string;
}

export const CAPABILITY_STATUS_OPTIONS: ReadonlyArray<{
  label: string;
  value: RuntimeGroupCapabilityStatus;
}> = [
  { label: "Allowed", value: "ALLOWED" },
  { label: "Denied", value: "DENIED" },
  { label: "Unknown", value: "UNKNOWN" },
];

export const CAPABILITY_FRESHNESS_OPTIONS: ReadonlyArray<{
  label: string;
  value: RuntimeGroupCapabilityFreshness;
}> = [
  { label: "Current", value: "CURRENT" },
  { label: "Stale", value: "STALE" },
];

export function initialGroupListState(sessionId: string | null): GroupListState {
  return {
    sessionId,
    inputQuery: "",
    query: "",
    capabilityStatuses: [],
    capabilityFreshness: [],
    isActive: undefined,
    offset: 0,
  };
}

export function toggleFilterValue<T extends string>(
  values: T[],
  value: T,
  options: ReadonlyArray<{ value: T }>,
): T[] {
  const toggled = values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
  return options
    .map((option) => option.value)
    .filter((candidate) => toggled.includes(candidate));
}

export function groupListRequestKey(state: GroupListRequestState): string {
  return JSON.stringify({
    sessionId: state.sessionId,
    query: state.query,
    capabilityStatuses: state.capabilityStatuses,
    capabilityFreshness: state.capabilityFreshness,
    isActive: state.isActive,
    offset: state.offset,
  });
}

export function hasGroupFilters(state: GroupListState): boolean {
  return Boolean(
    state.capabilityStatuses.length
    || state.capabilityFreshness.length
    || state.isActive !== undefined
  );
}

export function activeGroupFilterCount(state: GroupListState): number {
  return Number(state.capabilityStatuses.length > 0)
    + Number(state.capabilityFreshness.length > 0)
    + Number(state.isActive !== undefined);
}

export function clearGroupFilters(state: GroupListState): GroupListState {
  return {
    ...state,
    capabilityStatuses: [],
    capabilityFreshness: [],
    isActive: undefined,
    offset: 0,
  };
}

export function filterValueLabel(value: string): string {
  return [...CAPABILITY_STATUS_OPTIONS, ...CAPABILITY_FRESHNESS_OPTIONS]
    .find((option) => option.value === value)?.label ?? value;
}
