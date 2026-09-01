import type {
  RuntimeCampaignScheduleType,
  RuntimeCampaignStatus,
} from "@/shared/api/runtime-client";

export interface CampaignListRequestState {
  offset: number;
  query: string;
  scheduleTypes: RuntimeCampaignScheduleType[];
  sessionId: string | null;
  statuses: RuntimeCampaignStatus[];
}

export interface CampaignListState extends CampaignListRequestState {
  inputQuery: string;
}

export const CAMPAIGN_STATUS_OPTIONS: ReadonlyArray<{
  label: string;
  value: RuntimeCampaignStatus;
}> = [
  { label: "Draft", value: "DRAFT" },
  { label: "Active", value: "ACTIVE" },
  { label: "Paused", value: "PAUSED" },
  { label: "Archived", value: "ARCHIVED" },
];

export const CAMPAIGN_SCHEDULE_OPTIONS: ReadonlyArray<{
  label: string;
  value: RuntimeCampaignScheduleType;
}> = [
  { label: "Immediate", value: "IMMEDIATE" },
  { label: "Once", value: "ONCE" },
];

export function initialCampaignListState(sessionId: string | null): CampaignListState {
  return {
    inputQuery: "",
    offset: 0,
    query: "",
    scheduleTypes: [],
    sessionId,
    statuses: [],
  };
}

export function toggleCampaignFilter<T extends string>(
  values: T[],
  value: T,
  options: ReadonlyArray<{ value: T }>,
): T[] {
  const toggled = values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
  return options.map((option) => option.value).filter((candidate) => toggled.includes(candidate));
}

export function campaignListRequestKey(state: CampaignListRequestState): string {
  return JSON.stringify({
    offset: state.offset,
    query: state.query,
    scheduleTypes: state.scheduleTypes,
    sessionId: state.sessionId,
    statuses: state.statuses,
  });
}

export function hasCampaignFilters(state: CampaignListState): boolean {
  return Boolean(state.statuses.length || state.scheduleTypes.length);
}

export function activeCampaignFilterCount(state: CampaignListState): number {
  return Number(state.statuses.length > 0) + Number(state.scheduleTypes.length > 0);
}

export function clearCampaignFilters(state: CampaignListState): CampaignListState {
  return { ...state, offset: 0, scheduleTypes: [], statuses: [] };
}
