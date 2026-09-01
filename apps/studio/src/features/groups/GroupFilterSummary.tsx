import type { Dispatch, SetStateAction } from "react";

import { Button } from "@/shared/ui/Button";
import { FilterChip } from "@/shared/ui/FilterChip";
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
            key={value}
            label={filterValueLabel(value)}
            removeLabel={`Remove Capability: ${filterValueLabel(value)} filter`}
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
            key={value}
            label={filterValueLabel(value)}
            removeLabel={`Remove Freshness: ${filterValueLabel(value)} filter`}
            onRemove={() => setState((current) => ({
              ...current,
              capabilityFreshness: current.capabilityFreshness.filter(
                (candidate) => candidate !== value,
              ),
              offset: 0,
            }))}
          />
        ))}
        {state.minParticipants !== undefined && (
          <FilterChip
            label={`≥ ${state.minParticipants} participants`}
            removeLabel={`Remove Minimum participants: ${state.minParticipants} filter`}
            onRemove={() => setState((current) => ({
              ...current,
              minParticipants: undefined,
              offset: 0,
            }))}
          />
        )}
        {state.maxParticipants !== undefined && (
          <FilterChip
            label={`≤ ${state.maxParticipants} participants`}
            removeLabel={`Remove Maximum participants: ${state.maxParticipants} filter`}
            onRemove={() => setState((current) => ({
              ...current,
              maxParticipants: undefined,
              offset: 0,
            }))}
          />
        )}
        {state.isActive !== undefined && (
          <FilterChip
            label={state.isActive ? "Active groups" : "Inactive groups"}
            removeLabel={`Remove ${state.isActive ? "Active groups" : "Inactive groups"} filter`}
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
