import { useEffect, useState, type ReactNode } from "react";

import type {
  RuntimeGroupCapabilityFreshness,
  RuntimeGroupCapabilityStatus,
} from "@/shared/api/runtime-client";
import { AppIcon } from "@/shared/ui/AppIcon";
import { Button } from "@/shared/ui/Button";
import { DataFilterToolbar } from "@/shared/ui/DataFilterToolbar";
import { TextField } from "@/shared/ui/TextField";
import "./group-selection.css";

const MAX_PARTICIPANTS = 2_147_483_647;

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

export interface ParticipantFilterErrors {
  maxParticipants?: string;
  minParticipants?: string;
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

function participantValue(value: string, field: "Minimum" | "Maximum"): {
  error?: string;
  value?: number;
} {
  const normalized = value.trim();
  if (!normalized) return {};
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_PARTICIPANTS) {
    return { error: `${field} must be a whole number from 0 to ${MAX_PARTICIPANTS.toLocaleString()}.` };
  }
  return { value: parsed };
}

export function validateParticipantRange(minimum: string, maximum: string): {
  errors: ParticipantFilterErrors;
  maxParticipants?: number;
  minParticipants?: number;
} {
  const min = participantValue(minimum, "Minimum");
  const max = participantValue(maximum, "Maximum");
  const errors: ParticipantFilterErrors = {
    minParticipants: min.error,
    maxParticipants: max.error,
  };
  if (!min.error && !max.error && min.value !== undefined && max.value !== undefined
    && min.value > max.value) {
    errors.minParticipants = "Minimum must not exceed maximum.";
    errors.maxParticipants = "Maximum must be at least the minimum.";
  }
  return {
    errors,
    minParticipants: min.value,
    maxParticipants: max.value,
  };
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
        : `${firstItem}–${lastItem} of ${total}${hasCriteria ? " matches" : " groups"}`}
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
  const [minimum, setMinimum] = useState(filters.minParticipants?.toString() ?? "");
  const [maximum, setMaximum] = useState(filters.maxParticipants?.toString() ?? "");
  const [localErrors, setLocalErrors] = useState<ParticipantFilterErrors>({});
  const [rangeDirty, setRangeDirty] = useState(false);
  const filterCount = activeGroupSelectionFilterCount(filters);

  useEffect(() => {
    setMinimum(filters.minParticipants?.toString() ?? "");
    setMaximum(filters.maxParticipants?.toString() ?? "");
    setRangeDirty(false);
  }, [filters.maxParticipants, filters.minParticipants]);

  function applyParticipantRange() {
    const validation = validateParticipantRange(minimum, maximum);
    setLocalErrors(validation.errors);
    if (validation.errors.minParticipants || validation.errors.maxParticipants) return;
    onParticipantErrorsClear();
    setRangeDirty(false);
    onChange({
      ...filters,
      minParticipants: validation.minParticipants,
      maxParticipants: validation.maxParticipants,
    });
  }

  useEffect(() => {
    if (!rangeDirty) return;
    const timeout = window.setTimeout(applyParticipantRange, 500);
    return () => window.clearTimeout(timeout);
  }, [maximum, minimum, rangeDirty]);

  const minimumError = localErrors.minParticipants ?? participantErrors.minParticipants;
  const maximumError = localErrors.maxParticipants ?? participantErrors.maxParticipants;

  return (
    <section
      aria-label={ariaLabel}
      className="data-filter-panel group-selection-filter-panel"
      id={`${idPrefix}-filter-panel`}
    >
      <header className="data-filter-panel-header">
        <div><strong>{title}</strong><span>{filterCount ? `${filterCount} applied` : "Server-side filters"}</span></div>
        <button aria-label={`Close ${ariaLabel.toLocaleLowerCase()}`} className="data-filter-panel-close" onClick={onClose} type="button"><AppIcon name="close" size="xs" /></button>
      </header>
      <div className="data-filter-panel-body">
        <fieldset><legend>Capability</legend><div className="data-filter-options">
          {CAPABILITY_OPTIONS.map((option) => <label key={option.value}><input checked={filters.capabilityStatuses.includes(option.value)} onChange={() => onChange({ ...filters, capabilityStatuses: toggleOrdered(filters.capabilityStatuses, option.value, CAPABILITY_OPTIONS) })} type="checkbox" /><span aria-hidden="true" className="data-filter-check"><AppIcon name="check" size="xs" /></span><span>{option.label}</span></label>)}
        </div></fieldset>
        <fieldset><legend>Capability data</legend><div className="data-filter-options">
          {FRESHNESS_OPTIONS.map((option) => <label key={option.value}><input checked={filters.capabilityFreshness.includes(option.value)} onChange={() => onChange({ ...filters, capabilityFreshness: toggleOrdered(filters.capabilityFreshness, option.value, FRESHNESS_OPTIONS) })} type="checkbox" /><span aria-hidden="true" className="data-filter-check"><AppIcon name="check" size="xs" /></span><span>{option.label}</span></label>)}
        </div></fieldset>
        <fieldset><legend>Participants</legend><form className="group-selection-filter-range" noValidate onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) applyParticipantRange(); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); applyParticipantRange(); } }} onSubmit={(event) => { event.preventDefault(); applyParticipantRange(); }}>
          <TextField error={minimumError} inputMode="numeric" label="Minimum" labelHidden max={MAX_PARTICIPANTS} min={0} monospace onChange={(event) => { setMinimum(event.target.value); setRangeDirty(true); setLocalErrors((current) => ({ ...current, minParticipants: undefined })); onParticipantErrorsClear(); }} placeholder="Minimum" step={1} type="number" value={minimum} />
          <span aria-hidden="true" className="group-selection-filter-range-separator">–</span>
          <TextField error={maximumError} inputMode="numeric" label="Maximum" labelHidden max={MAX_PARTICIPANTS} min={0} monospace onChange={(event) => { setMaximum(event.target.value); setRangeDirty(true); setLocalErrors((current) => ({ ...current, maxParticipants: undefined })); onParticipantErrorsClear(); }} placeholder="Maximum" step={1} type="number" value={maximum} />
          <small>Inclusive range · unknown counts excluded.</small>
        </form></fieldset>
        <fieldset><legend>Group state</legend><div className="data-filter-options data-filter-options-single">
          <label><input checked={filters.isActive === undefined} name={`${idPrefix}-state-filter`} onChange={() => onChange({ ...filters, isActive: undefined })} type="radio" /><span>Active</span></label>
          <label><input checked={filters.isActive === false} name={`${idPrefix}-state-filter`} onChange={() => onChange({ ...filters, isActive: false })} type="radio" /><span>Inactive</span></label>
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
        {filters.isActive === false && <FilterChip label="Inactive groups" onRemove={() => onChange({ ...filters, isActive: undefined })} />}
      </div>
      <Button disabled={!hasFilters} onClick={() => onChange(emptyGroupSelectionFilters())} size="sm" variant="ghost">Clear all</Button>
    </div>
  );
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return <button aria-label={`Remove ${label} filter`} className="data-filter-chip" onClick={onRemove} type="button"><span>{label}</span><AppIcon name="close" size="xs" /></button>;
}
