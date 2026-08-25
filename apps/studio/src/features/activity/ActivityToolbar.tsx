import type { Dispatch, ReactNode, SetStateAction } from "react";

import type {
  RuntimeActivityCategory,
  RuntimeActivitySeverity,
} from "@/shared/api/runtime-client";
import { AppIcon } from "@/shared/ui/AppIcon";
import { Button } from "@/shared/ui/Button";
import { DataFilterToolbar } from "@/shared/ui/DataFilterToolbar";
import {
  activityCategoryLabel,
  activitySeverityLabel,
} from "./activity-presentation";

export interface ActivityListState {
  categories: RuntimeActivityCategory[];
  inputQuery: string;
  query: string;
  severities: RuntimeActivitySeverity[];
}

export const initialActivityListState = (): ActivityListState => ({
  categories: [],
  inputQuery: "",
  query: "",
  severities: [],
});

const CATEGORIES: RuntimeActivityCategory[] = ["RUN", "CAMPAIGN", "SYNC", "SESSION"];
const SEVERITIES: RuntimeActivitySeverity[] = ["INFO", "SUCCESS", "WARNING", "ERROR"];

function toggle<T extends string>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((candidate) => candidate !== value) : [...values, value];
}

export function ActivityToolbar({
  actions,
  count,
  filtersOpen,
  loading,
  retentionDays,
  setFiltersOpen,
  setState,
  state,
}: {
  actions?: ReactNode;
  count: number;
  filtersOpen: boolean;
  loading: boolean;
  retentionDays: number | null;
  setFiltersOpen: Dispatch<SetStateAction<boolean>>;
  setState: Dispatch<SetStateAction<ActivityListState>>;
  state: ActivityListState;
}) {
  const filterCount = state.categories.length + state.severities.length;
  return <DataFilterToolbar
    actions={actions}
    filterCount={filterCount}
    filtersOpen={filtersOpen}
    idPrefix="activity-list"
    loading={loading}
    onCloseFilters={() => setFiltersOpen(false)}
    onSearchChange={(inputQuery) => setState((current) => ({ ...current, inputQuery }))}
    onToggleFilters={() => setFiltersOpen((open) => !open)}
    resultSummary={loading ? "Updating activity…" : `${count} loaded${retentionDays ? ` · ${retentionDays}-day retention` : ""}`}
    searchLabel="Search activity"
    searchPlaceholder="Search subject, ID, event, or correlation"
    searchValue={state.inputQuery}
  >
    {(closeFilters) => filtersOpen && <section aria-label="Activity filters" className="data-filter-panel" id="activity-list-filter-panel">
      <header className="data-filter-panel-header"><div><strong>Filter activity</strong><span>{filterCount ? `${filterCount} applied` : "Server-side filters"}</span></div><button aria-label="Close activity filters" className="data-filter-panel-close" onClick={closeFilters} type="button"><AppIcon name="close" size="xs" /></button></header>
      <div className="data-filter-panel-body">
        <fieldset><legend>Category</legend><div className="data-filter-options">{CATEGORIES.map((category) => <FilterOption checked={state.categories.includes(category)} key={category} label={activityCategoryLabel(category)} onChange={() => setState((current) => ({ ...current, categories: toggle(current.categories, category) }))} />)}</div></fieldset>
        <fieldset><legend>Outcome</legend><div className="data-filter-options">{SEVERITIES.map((severity) => <FilterOption checked={state.severities.includes(severity)} key={severity} label={activitySeverityLabel(severity)} onChange={() => setState((current) => ({ ...current, severities: toggle(current.severities, severity) }))} />)}</div></fieldset>
      </div>
      <div className="data-filter-summary"><div className="data-filter-chips">{!filterCount && <span className="data-filter-summary-empty">No filters applied</span>}{state.categories.map((value) => <FilterChip key={value} label={activityCategoryLabel(value)} onRemove={() => setState((current) => ({ ...current, categories: current.categories.filter((candidate) => candidate !== value) }))} />)}{state.severities.map((value) => <FilterChip key={value} label={activitySeverityLabel(value)} onRemove={() => setState((current) => ({ ...current, severities: current.severities.filter((candidate) => candidate !== value) }))} />)}</div><Button disabled={!filterCount} onClick={() => setState((current) => ({ ...current, categories: [], severities: [] }))} size="sm" variant="ghost">Clear all</Button></div>
    </section>}
  </DataFilterToolbar>;
}

function FilterOption({ checked, label, onChange }: { checked: boolean; label: string; onChange: () => void }) {
  return <label><input checked={checked} onChange={onChange} type="checkbox" /><span aria-hidden="true" className="data-filter-check"><AppIcon name="check" size="xs" /></span><span>{label}</span></label>;
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return <button aria-label={`Remove ${label} filter`} className="data-filter-chip" onClick={onRemove} type="button"><span>{label}</span><AppIcon name="close" size="xs" /></button>;
}
