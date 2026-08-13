import type { Dispatch, SetStateAction } from "react";

import { AppIcon } from "@/shared/ui/AppIcon";
import { Button } from "@/shared/ui/Button";
import {
  clearGroupFilters,
  filterValueLabel,
  hasGroupFilters,
  type GroupListState,
} from "./group-list-filters";

interface GroupFilterSummaryProps {
  clearLabel: string;
  setState: Dispatch<SetStateAction<GroupListState>>;
  showEmpty?: boolean;
  state: GroupListState;
}

interface FilterChipProps {
  accessibleLabel: string;
  label: string;
  onRemove: () => void;
}

function FilterChip({ accessibleLabel, label, onRemove }: FilterChipProps) {
  return (
    <button
      aria-label={`Remove ${accessibleLabel} filter`}
      className="data-filter-chip"
      onClick={onRemove}
      type="button"
    >
      <span>{label}</span>
      <AppIcon name="close" size="xs" />
    </button>
  );
}

export function GroupFilterSummary({
  clearLabel,
  setState,
  showEmpty = false,
  state,
}: GroupFilterSummaryProps) {
  const filtersApplied = hasGroupFilters(state);

  return (
    <div
      aria-label="Selected group filters"
      className="data-filter-summary"
    >
      <div className="data-filter-chips">
        {!filtersApplied && showEmpty && (
          <span className="data-filter-summary-empty">No filters applied</span>
        )}
        {state.capabilityStatuses.map((value) => (
          <FilterChip
            accessibleLabel={`Capability: ${filterValueLabel(value)}`}
            key={value}
            label={filterValueLabel(value)}
            onRemove={() => setState((current) => ({
              ...current,
              capabilityStatuses: current.capabilityStatuses.filter(
                (candidate) => candidate !== value,
              ),
              offset: 0,
            }))}
          />
        ))}
        {state.capabilityFreshness.map((value) => (
          <FilterChip
            accessibleLabel={`Freshness: ${filterValueLabel(value)}`}
            key={value}
            label={filterValueLabel(value)}
            onRemove={() => setState((current) => ({
              ...current,
              capabilityFreshness: current.capabilityFreshness.filter(
                (candidate) => candidate !== value,
              ),
              offset: 0,
            }))}
          />
        ))}
        {state.isActive !== undefined && (
          <FilterChip
            accessibleLabel="Inactive groups"
            label="Inactive groups"
            onRemove={() => setState((current) => ({
              ...current,
              isActive: undefined,
              offset: 0,
            }))}
          />
        )}
      </div>
      <Button
        disabled={!filtersApplied}
        onClick={() => setState(clearGroupFilters)}
        size="sm"
        variant="ghost"
      >
        {clearLabel}
      </Button>
    </div>
  );
}
