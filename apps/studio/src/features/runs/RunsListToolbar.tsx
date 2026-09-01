import type { Dispatch, SetStateAction } from "react";

import { Button } from "@/shared/ui/Button";
import { DataFilterToolbar } from "@/shared/ui/DataFilterToolbar";
import { FilterChip } from "@/shared/ui/FilterChip";
import { FilterOption } from "@/shared/ui/FilterOption";
import { formatListResultSummary } from "@/shared/ui/list-result-summary";
import type {
  RuntimeCampaignExecutionMode,
  RuntimeCampaignRunStatus,
} from "@/shared/api/runtime-client";
import { runStatusLabel } from "./run-presentation";
import { toggleRunFilter, type RunsListState } from "./runs-list-state";

const STATUS_OPTIONS: RuntimeCampaignRunStatus[] = [
  "PREPARING", "BLOCKED", "SCHEDULED", "RUNNING", "PAUSED", "CANCELLING",
  "COMPLETED", "PARTIAL_FAILED", "CANCELLED", "FAILED",
];
const MODE_OPTIONS: RuntimeCampaignExecutionMode[] = ["LIVE", "DRY_RUN"];

interface RunsListToolbarProps {
  filtersOpen: boolean;
  firstItem: number;
  lastItem: number;
  loading: boolean;
  setFiltersOpen: Dispatch<SetStateAction<boolean>>;
  setState: Dispatch<SetStateAction<RunsListState>>;
  state: RunsListState;
  total: number;
}

export function RunsListToolbar({
  filtersOpen,
  firstItem,
  lastItem,
  loading,
  setFiltersOpen,
  setState,
  state,
  total,
}: RunsListToolbarProps) {
  const filterCount = state.statuses.length + state.executionModes.length;
  const hasCriteria = Boolean(state.query || filterCount);
  return (
    <DataFilterToolbar
      filterCount={filterCount}
      filtersOpen={filtersOpen}
      idPrefix="runs-list"
      loading={loading}
      onCloseFilters={() => setFiltersOpen(false)}
      onSearchChange={(inputQuery) => setState((current) => ({ ...current, inputQuery }))}
      onToggleFilters={() => setFiltersOpen((open) => !open)}
      resultSummary={loading
        ? "Updating results…"
        : formatListResultSummary({
          firstItem,
          hasCriteria,
          lastItem,
          plural: "runs",
          singular: "run",
          total,
        })}
      searchLabel="Search runs"
      searchPlaceholder="Search campaign, campaign ID, or run ID"
      searchValue={state.inputQuery}
    >
      {(closeFilters) => filtersOpen && (
        <section aria-label="Run filters" className="data-filter-panel" id="runs-list-filter-panel">
          <header className="data-filter-panel-header">
            <div><strong>Filter runs</strong><span>{filterCount ? `${filterCount} applied` : "Server-side filters"}</span></div>
            <Button aria-label="Close run filters" className="data-filter-panel-close" icon="close" onClick={closeFilters} variant="ghost" />
          </header>
          <div className="data-filter-panel-body">
            <fieldset><legend>Status</legend><div className="data-filter-options">
              {STATUS_OPTIONS.map((status) => <FilterOption checked={state.statuses.includes(status)} key={status} onChange={() => setState((current) => ({ ...current, offset: 0, statuses: toggleRunFilter(current.statuses, status) }))}>{runStatusLabel(status)}</FilterOption>)}
            </div></fieldset>
            <fieldset><legend>Execution</legend><div className="data-filter-options">
              {MODE_OPTIONS.map((mode) => <FilterOption checked={state.executionModes.includes(mode)} key={mode} onChange={() => setState((current) => ({ ...current, offset: 0, executionModes: toggleRunFilter(current.executionModes, mode) }))}>{mode === "LIVE" ? "Live" : "Dry run"}</FilterOption>)}
            </div></fieldset>
          </div>
          <div aria-label="Selected run filters" className="data-filter-summary">
            <div className="data-filter-chips">
              {!filterCount && <span className="data-filter-summary-empty">No filters applied</span>}
              {state.statuses.map((status) => <FilterChip key={status} label={runStatusLabel(status)} onRemove={() => setState((current) => ({ ...current, offset: 0, statuses: current.statuses.filter((candidate) => candidate !== status) }))} />)}
              {state.executionModes.map((mode) => <FilterChip key={mode} label={mode === "LIVE" ? "Live" : "Dry run"} onRemove={() => setState((current) => ({ ...current, offset: 0, executionModes: current.executionModes.filter((candidate) => candidate !== mode) }))} />)}
            </div>
            <Button disabled={!filterCount} onClick={() => setState((current) => ({ ...current, executionModes: [], offset: 0, statuses: [] }))} size="sm" variant="ghost">Clear all</Button>
          </div>
        </section>
      )}
    </DataFilterToolbar>
  );
}
