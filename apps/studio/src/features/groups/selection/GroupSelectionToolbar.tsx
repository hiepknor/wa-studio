import type { ReactNode } from "react";

import type {
  RuntimeGroupCapabilityFreshness,
  RuntimeGroupCapabilityStatus,
} from "@/shared/api/runtime-client";
import { Button } from "@/shared/ui/Button";
import { DataFilterToolbar } from "@/shared/ui/DataFilterToolbar";
import { FilterChip } from "@/shared/ui/FilterChip";
import { FilterOption } from "@/shared/ui/FilterOption";
import { formatListResultSummary } from "@/shared/ui/list-result-summary";
import { ParticipantRangeFilter } from "../ParticipantRangeFilter";
import type { ParticipantFilterErrors } from "../participant-range";
import "./group-selection.css";

export {
  validateParticipantRange,
  type ParticipantFilterErrors,
} from "../participant-range";

const CAPABILITY_OPTIONS: ReadonlyArray<{
  label: string;
  value: RuntimeGroupCapabilityStatus;
}> = [
  { label: "Allowed", value: "ALLOWED" },
  { label: "Denied", value: "DENIED" },
  { label: "Unknown", value: "UNKNOWN" },
];

const FRESHNESS_OPTIONS: ReadonlyArray<{
  label: string;
  value: RuntimeGroupCapabilityFreshness;
}> = [
  { label: "Current", value: "CURRENT" },
  { label: "Stale", value: "STALE" },
];

export interface GroupSelectionFilters {
  capabilityFreshness: RuntimeGroupCapabilityFreshness[];
  capabilityStatuses: RuntimeGroupCapabilityStatus[];
  isActive: boolean | undefined;
  maxParticipants: number | undefined;
  minParticipants: number | undefined;
}

export function emptyGroupSelectionFilters(): GroupSelectionFilters {
  return {
    capabilityFreshness: [],
    capabilityStatuses: [],
    isActive: undefined,
    maxParticipants: undefined,
    minParticipants: undefined,
  };
}

export function activeGroupSelectionFilterCount(filters: GroupSelectionFilters): number {
  return Number(filters.capabilityStatuses.length > 0)
    + Number(filters.capabilityFreshness.length > 0)
    + Number(filters.isActive !== undefined)
    + Number(filters.minParticipants !== undefined || filters.maxParticipants !== undefined);
}

function toggleOrdered<T extends string>(
  values: T[],
  value: T,
  options: ReadonlyArray<{ value: T }>,
): T[] {
  const toggled = values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
  return options.map((option) => option.value).filter((candidate) => toggled.includes(candidate));
}

export interface GroupSelectionToolbarProps {
  actions?: ReactNode;
  filterAriaLabel?: string;
  filterTitle?: string;
  filters: GroupSelectionFilters;
  filtersOpen: boolean;
  inputQuery: string;
  idPrefix?: string;
  loading: boolean;
  onFiltersChange: (filters: GroupSelectionFilters) => void;
  onFiltersOpenChange: (open: boolean) => void;
  onParticipantErrorsClear: () => void;
  onSearchChange: (value: string) => void;
  pageItemCount: number;
  pageOffset: number;
  participantErrors: ParticipantFilterErrors;
  searchLabel?: string;
  searchPlaceholder?: string;
  total: number;
}

export function GroupSelectionToolbar({
  actions,
  filterAriaLabel = "Group filters",
  filterTitle = "Filter groups",
  filters,
  filtersOpen,
  inputQuery,
  idPrefix = "group-selection",
  loading,
  onFiltersChange,
  onFiltersOpenChange,
  onParticipantErrorsClear,
  onSearchChange,
  pageItemCount,
  pageOffset,
  participantErrors,
  searchLabel = "Find synchronized groups",
  searchPlaceholder = "Search group name or ID",
  total,
}: GroupSelectionToolbarProps) {
  const filterCount = activeGroupSelectionFilterCount(filters);
  const hasCriteria = Boolean(inputQuery.trim() || filterCount);
  const firstItem = total === 0 ? 0 : pageOffset + 1;
  const lastItem = Math.min(pageOffset + pageItemCount, total);

  return (
    <DataFilterToolbar
      actions={actions}
      filterCount={filterCount}
      filtersOpen={filtersOpen}
      idPrefix={idPrefix}
      loading={loading}
      onCloseFilters={() => onFiltersOpenChange(false)}
      onSearchChange={onSearchChange}
      onToggleFilters={() => onFiltersOpenChange(!filtersOpen)}
      resultSummary={loading
        ? "Updating results…"
        : formatListResultSummary({
          firstItem,
          hasCriteria,
          lastItem,
          plural: "groups",
          singular: "group",
          total,
        })}
      searchLabel={searchLabel}
      searchPlaceholder={searchPlaceholder}
      searchValue={inputQuery}
    >
      {(closeFilters) => filtersOpen && (
        <GroupSelectionFilterPanel
          ariaLabel={filterAriaLabel}
          filters={filters}
          idPrefix={idPrefix}
          onChange={onFiltersChange}
          onClose={closeFilters}
          onParticipantErrorsClear={onParticipantErrorsClear}
          participantErrors={participantErrors}
          title={filterTitle}
        />
      )}
    </DataFilterToolbar>
  );
}

interface GroupSelectionFilterPanelProps {
  ariaLabel: string;
  filters: GroupSelectionFilters;
  idPrefix: string;
  onChange: (filters: GroupSelectionFilters) => void;
  onClose: () => void;
  onParticipantErrorsClear: () => void;
  participantErrors: ParticipantFilterErrors;
  title: string;
}

function GroupSelectionFilterPanel({
  ariaLabel,
  filters,
  idPrefix,
  onChange,
  onClose,
  onParticipantErrorsClear,
  participantErrors,
  title,
}: GroupSelectionFilterPanelProps) {
  const filterCount = activeGroupSelectionFilterCount(filters);

  return (
    <section
      aria-label={ariaLabel}
      className="data-filter-panel data-filter-panel-grid-2 group-selection-filter-panel"
      id={`${idPrefix}-filter-panel`}
    >
      <header className="data-filter-panel-header">
        <div><strong>{title}</strong><span>{filterCount ? `${filterCount} applied` : "Optional criteria"}</span></div>
        <Button aria-label={`Close ${ariaLabel.toLocaleLowerCase()}`} className="data-filter-panel-close" icon="close" onClick={onClose} variant="ghost" />
      </header>
      <div className="data-filter-panel-body">
        <fieldset><legend>Capability</legend><div className="data-filter-options">
          {CAPABILITY_OPTIONS.map((option) => <FilterOption checked={filters.capabilityStatuses.includes(option.value)} key={option.value} onChange={() => onChange({ ...filters, capabilityStatuses: toggleOrdered(filters.capabilityStatuses, option.value, CAPABILITY_OPTIONS) })}>{option.label}</FilterOption>)}
        </div></fieldset>
        <fieldset><legend>Capability data</legend><div className="data-filter-options">
          {FRESHNESS_OPTIONS.map((option) => <FilterOption checked={filters.capabilityFreshness.includes(option.value)} key={option.value} onChange={() => onChange({ ...filters, capabilityFreshness: toggleOrdered(filters.capabilityFreshness, option.value, FRESHNESS_OPTIONS) })}>{option.label}</FilterOption>)}
        </div></fieldset>
        <fieldset><legend>Participants</legend><ParticipantRangeFilter errors={participantErrors} idPrefix={idPrefix} maxParticipants={filters.maxParticipants} minParticipants={filters.minParticipants} onChange={(range) => onChange({ ...filters, ...range })} onErrorsClear={onParticipantErrorsClear} /></fieldset>
        <fieldset><legend>Group state</legend><div className="data-filter-options data-filter-options-single">
          <FilterOption checked={filters.isActive === undefined} name={`${idPrefix}-state-filter`} onChange={() => onChange({ ...filters, isActive: undefined })} type="radio">All states</FilterOption>
          <FilterOption checked={filters.isActive === true} name={`${idPrefix}-state-filter`} onChange={() => onChange({ ...filters, isActive: true })} type="radio">Active</FilterOption>
          <FilterOption checked={filters.isActive === false} name={`${idPrefix}-state-filter`} onChange={() => onChange({ ...filters, isActive: false })} type="radio">Inactive</FilterOption>
        </div></fieldset>
      </div>
      <CampaignTargetFilterSummary filters={filters} onChange={onChange} />
    </section>
  );
}

function CampaignTargetFilterSummary({
  filters,
  onChange,
}: Pick<GroupSelectionFilterPanelProps, "filters" | "onChange">) {
  const hasFilters = activeGroupSelectionFilterCount(filters) > 0;
  return (
    <div aria-label="Selected group filters" className="data-filter-summary">
      <div className="data-filter-chips">
        {!hasFilters && <span className="data-filter-summary-empty">No filters applied</span>}
        {filters.capabilityStatuses.map((value) => <FilterChip key={value} label={CAPABILITY_OPTIONS.find((option) => option.value === value)?.label ?? value} onRemove={() => onChange({ ...filters, capabilityStatuses: filters.capabilityStatuses.filter((candidate) => candidate !== value) })} />)}
        {filters.capabilityFreshness.map((value) => <FilterChip key={value} label={FRESHNESS_OPTIONS.find((option) => option.value === value)?.label ?? value} onRemove={() => onChange({ ...filters, capabilityFreshness: filters.capabilityFreshness.filter((candidate) => candidate !== value) })} />)}
        {filters.minParticipants !== undefined && <FilterChip label={`≥ ${filters.minParticipants} participants`} onRemove={() => onChange({ ...filters, minParticipants: undefined })} />}
        {filters.maxParticipants !== undefined && <FilterChip label={`≤ ${filters.maxParticipants} participants`} onRemove={() => onChange({ ...filters, maxParticipants: undefined })} />}
        {filters.isActive !== undefined && <FilterChip label={filters.isActive ? "Active groups" : "Inactive groups"} onRemove={() => onChange({ ...filters, isActive: undefined })} />}
      </div>
      <Button disabled={!hasFilters} onClick={() => onChange(emptyGroupSelectionFilters())} size="sm" variant="ghost">Clear all</Button>
    </div>
  );
}
