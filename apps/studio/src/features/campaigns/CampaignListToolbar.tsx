import type { Dispatch, SetStateAction } from "react";

import { Button } from "@/shared/ui/Button";
import { DataFilterToolbar } from "@/shared/ui/DataFilterToolbar";
import { FilterChip } from "@/shared/ui/FilterChip";
import { FilterOption } from "@/shared/ui/FilterOption";
import { formatListResultSummary } from "@/shared/ui/list-result-summary";
import {
  activeCampaignFilterCount,
  CAMPAIGN_SCHEDULE_OPTIONS,
  CAMPAIGN_STATUS_OPTIONS,
  clearCampaignFilters,
  hasCampaignFilters,
  toggleCampaignFilter,
  type CampaignListState,
} from "./campaign-list-state";

interface CampaignListToolbarProps {
  filtersOpen: boolean;
  firstItem: number;
  lastItem: number;
  loading: boolean;
  setFiltersOpen: Dispatch<SetStateAction<boolean>>;
  setState: Dispatch<SetStateAction<CampaignListState>>;
  state: CampaignListState;
  total: number;
}

export function CampaignListToolbar({
  filtersOpen,
  firstItem,
  lastItem,
  loading,
  setFiltersOpen,
  setState,
  state,
  total,
}: CampaignListToolbarProps) {
  const filterCount = activeCampaignFilterCount(state);
  const hasCriteria = Boolean(state.query || filterCount);

  return (
    <DataFilterToolbar
      filterCount={filterCount}
      filtersOpen={filtersOpen}
      idPrefix="campaign-list"
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
          plural: "campaigns",
          singular: "campaign",
          total,
        })}
      searchLabel="Search campaigns"
      searchPlaceholder="Search campaign name or exact UUID"
      searchValue={state.inputQuery}
    >
      {(closeFilters) => filtersOpen && (
        <CampaignFilterPanel onClose={closeFilters} setState={setState} state={state} />
      )}
    </DataFilterToolbar>
  );
}

interface CampaignFilterPanelProps {
  onClose: () => void;
  setState: Dispatch<SetStateAction<CampaignListState>>;
  state: CampaignListState;
}

function CampaignFilterPanel({ onClose, setState, state }: CampaignFilterPanelProps) {
  const filterCount = activeCampaignFilterCount(state);
  return (
    <section aria-label="Campaign filters" className="data-filter-panel" id="campaign-list-filter-panel">
      <header className="data-filter-panel-header">
        <div><strong>Filter campaigns</strong><span>{filterCount ? `${filterCount} applied` : "Server-side filters"}</span></div>
        <Button aria-label="Close campaign filters" className="data-filter-panel-close" icon="close" onClick={onClose} variant="ghost" />
      </header>
      <div className="data-filter-panel-body">
        <fieldset><legend>Status</legend><div className="data-filter-options">
          {CAMPAIGN_STATUS_OPTIONS.map((option) => <FilterOption checked={state.statuses.includes(option.value)} key={option.value} onChange={() => setState((current) => ({ ...current, offset: 0, statuses: toggleCampaignFilter(current.statuses, option.value, CAMPAIGN_STATUS_OPTIONS) }))}>{option.label}</FilterOption>)}
        </div></fieldset>
        <fieldset><legend>Schedule</legend><div className="data-filter-options">
          {CAMPAIGN_SCHEDULE_OPTIONS.map((option) => <FilterOption checked={state.scheduleTypes.includes(option.value)} key={option.value} onChange={() => setState((current) => ({ ...current, offset: 0, scheduleTypes: toggleCampaignFilter(current.scheduleTypes, option.value, CAMPAIGN_SCHEDULE_OPTIONS) }))}>{option.label}</FilterOption>)}
        </div></fieldset>
      </div>
      <CampaignFilterSummary setState={setState} state={state} />
    </section>
  );
}

function CampaignFilterSummary({ setState, state }: Pick<CampaignFilterPanelProps, "setState" | "state">) {
  const filtersApplied = hasCampaignFilters(state);
  return (
    <div aria-label="Selected campaign filters" className="data-filter-summary">
      <div className="data-filter-chips">
        {!filtersApplied && <span className="data-filter-summary-empty">No filters applied</span>}
        {state.statuses.map((value) => <FilterChip key={value} label={CAMPAIGN_STATUS_OPTIONS.find((option) => option.value === value)?.label ?? value} onRemove={() => setState((current) => ({ ...current, offset: 0, statuses: current.statuses.filter((candidate) => candidate !== value) }))} />)}
        {state.scheduleTypes.map((value) => <FilterChip key={value} label={CAMPAIGN_SCHEDULE_OPTIONS.find((option) => option.value === value)?.label ?? value} onRemove={() => setState((current) => ({ ...current, offset: 0, scheduleTypes: current.scheduleTypes.filter((candidate) => candidate !== value) }))} />)}
      </div>
      <Button disabled={!filtersApplied} onClick={() => setState(clearCampaignFilters)} size="sm" variant="ghost">Clear all</Button>
    </div>
  );
}
