import type {
  RuntimeCampaignExecutionMode,
  RuntimeCampaignRunStatus,
} from "@/shared/api/runtime-client";

export const RUNS_PAGE_SIZE = 50;

export interface RunsListState {
  executionModes: RuntimeCampaignExecutionMode[];
  inputQuery: string;
  offset: number;
  query: string;
  statuses: RuntimeCampaignRunStatus[];
}

export const initialRunsListState = (): RunsListState => ({
  executionModes: [],
  inputQuery: "",
  offset: 0,
  query: "",
  statuses: [],
});

export function toggleRunFilter<T extends string>(values: T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}
