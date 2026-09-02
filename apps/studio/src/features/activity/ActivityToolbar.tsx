import type { Dispatch, SetStateAction } from "react";

import type {
  RuntimeActivityCategory,
  RuntimeActivitySeverity,
} from "@/shared/api/runtime-client";
import { Button } from "@/shared/ui/Button";
import { DataFilterToolbar } from "@/shared/ui/DataFilterToolbar";
import { FilterChip } from "@/shared/ui/FilterChip";
import { FilterOption as FilterOptionControl } from "@/shared/ui/FilterOption";
import { formatLoadedResultSummary } from "@/shared/ui/list-result-summary";
import {
  activityCategoryLabel,
  activitySeverityLabel,
} from "./activity-presentation";

export interface ActivityListState {
  categories: RuntimeActivityCategory[];
  inputQuery: string;
  query: string;
  severities: RuntimeActivitySeverity[];
  timeRange: ActivityTimeRange;
}

export type ActivityTimeRange = "ALL" | "24H" | "7D" | "30D";

export const initialActivityListState = (): ActivityListState => ({
  categories: [],
  inputQuery: "",
  query: "",
  severities: [],
  timeRange: "ALL",
});

const CATEGORIES: RuntimeActivityCategory[] = ["RUN", "CAMPAIGN", "SYNC", "SESSION"];
const SEVERITIES: RuntimeActivitySeverity[] = ["INFO", "SUCCESS", "WARNING", "ERROR"];
const TIME_RANGES: readonly { label: string; value: ActivityTimeRange }[] = [
  { label: "All retained", value: "ALL" },
  { label: "Last 24 hours", value: "24H" },
  { label: "Last 7 days", value: "7D" },
  { label: "Last 30 days", value: "30D" },
];

export function activityTimeRangeStart(
  range: ActivityTimeRange,
  now = Date.now(),
): string | undefined {
  const duration = range === "24H"
    ? 24 * 60 * 60 * 1_000
    : range === "7D"
      ? 7 * 24 * 60 * 60 * 1_000
      : range === "30D"
        ? 30 * 24 * 60 * 60 * 1_000
        : null;
  return duration === null ? undefined : new Date(now - duration).toISOString();
}

function toggle<T extends string>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((candidate) => candidate !== value) : [...values, value];
}

export function ActivityToolbar({
  count,
  filtersOpen,
  loading,
  setFiltersOpen,
  setState,
  state,
}: {
  count: number;
  filtersOpen: boolean;
  loading: boolean;
  setFiltersOpen: Dispatch<SetStateAction<boolean>>;
  setState: Dispatch<SetStateAction<ActivityListState>>;
  state: ActivityListState;
}) {
  const filterCount = state.categories.length
    + state.severities.length
    + (state.timeRange === "ALL" ? 0 : 1);
  return <DataFilterToolbar
    filterCount={filterCount}
    filtersOpen={filtersOpen}
    idPrefix="activity-list"
    loading={loading}
    onCloseFilters={() => setFiltersOpen(false)}
    onSearchChange={(inputQuery) => setState((current) => ({ ...current, inputQuery }))}
    onToggleFilters={() => setFiltersOpen((open) => !open)}
    resultSummary={loading
      ? "Updating activity…"
      : formatLoadedResultSummary(count, "event", "events")}
    searchLabel="Search activity"
    searchPlaceholder="Search subject, ID, event, or correlation"
    searchValue={state.inputQuery}
  >
    {(closeFilters) => filtersOpen && <section aria-label="Activity filters" className="data-filter-panel" id="activity-list-filter-panel">
      <header className="data-filter-panel-header"><div><strong>Filter activity</strong><span>{filterCount ? `${filterCount} applied` : "Server-side filters"}</span></div><Button aria-label="Close activity filters" className="data-filter-panel-close" icon="close" onClick={closeFilters} variant="ghost" /></header>
      <div className="data-filter-panel-body">
        <fieldset><legend>Category</legend><div className="data-filter-options">{CATEGORIES.map((category) => <FilterOption checked={state.categories.includes(category)} key={category} label={activityCategoryLabel(category)} onChange={() => setState((current) => ({ ...current, categories: toggle(current.categories, category) }))} />)}</div></fieldset>
        <fieldset><legend>Severity</legend><div className="data-filter-options">{SEVERITIES.map((severity) => <FilterOption checked={state.severities.includes(severity)} key={severity} label={activitySeverityLabel(severity)} onChange={() => setState((current) => ({ ...current, severities: toggle(current.severities, severity) }))} />)}</div></fieldset>
        <fieldset><legend>Time range</legend><div className="data-filter-options">{TIME_RANGES.map((range) => <FilterOption checked={state.timeRange === range.value} key={range.value} label={range.label} name="activity-time-range" onChange={() => setState((current) => ({ ...current, timeRange: range.value }))} type="radio" />)}</div></fieldset>
      </div>
      <div className="data-filter-summary"><div className="data-filter-chips">{!filterCount && <span className="data-filter-summary-empty">No filters applied</span>}{state.categories.map((value) => <FilterChip key={value} label={activityCategoryLabel(value)} onRemove={() => setState((current) => ({ ...current, categories: current.categories.filter((candidate) => candidate !== value) }))} />)}{state.severities.map((value) => <FilterChip key={value} label={activitySeverityLabel(value)} onRemove={() => setState((current) => ({ ...current, severities: current.severities.filter((candidate) => candidate !== value) }))} />)}{state.timeRange !== "ALL" && <FilterChip label={TIME_RANGES.find((range) => range.value === state.timeRange)?.label ?? state.timeRange} onRemove={() => setState((current) => ({ ...current, timeRange: "ALL" }))} />}</div><Button disabled={!filterCount} onClick={() => setState((current) => ({ ...current, categories: [], severities: [], timeRange: "ALL" }))} size="sm" variant="ghost">Clear all</Button></div>
    </section>}
  </DataFilterToolbar>;
}

function FilterOption({ checked, label, name, onChange, type = "checkbox" }: { checked: boolean; label: string; name?: string; onChange: () => void; type?: "checkbox" | "radio" }) {
  return <FilterOptionControl checked={checked} name={name} onChange={onChange} type={type}>{label}</FilterOptionControl>;
}
