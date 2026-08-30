import type { Dispatch, SetStateAction } from "react";

import { Button } from "@/shared/ui/Button";
import { FilterOption } from "@/shared/ui/FilterOption";
import {
  activeGroupFilterCount,
  CAPABILITY_FRESHNESS_OPTIONS,
  CAPABILITY_STATUS_OPTIONS,
  type GroupListState,
  toggleFilterValue,
} from "./group-list-filters";
import { GroupFilterSummary } from "./GroupFilterSummary";
import { ParticipantRangeFilter } from "./ParticipantRangeFilter";

interface GroupFilterPanelProps {
  idPrefix?: string;
  onClose: () => void;
  setState: Dispatch<SetStateAction<GroupListState>>;
  state: GroupListState;
}

export function GroupFilterPanel({ idPrefix = "group-list", onClose, setState, state }: GroupFilterPanelProps) {
  const filterCount = activeGroupFilterCount(state);

  return (
    <section
      aria-label="Group filters"
      className="data-filter-panel data-filter-panel-grid-2"
      id={`${idPrefix}-filter-panel`}
    >
      <header className="data-filter-panel-header">
        <div>
          <strong>Filter groups</strong>
          <span>{filterCount ? `${filterCount} applied` : "Optional criteria"}</span>
        </div>
        <Button
          aria-label="Close group filters"
          className="data-filter-panel-close"
          icon="close"
          onClick={onClose}
          variant="ghost"
        />
      </header>

      <div className="data-filter-panel-body">
        <fieldset>
          <legend>Send capability</legend>
          <div className="data-filter-options">
            {CAPABILITY_STATUS_OPTIONS.map((option) => (
              <FilterOption
                  checked={state.capabilityStatuses.includes(option.value)}
                  key={option.value}
                  onChange={() => setState((current) => ({
                    ...current,
                    capabilityStatuses: toggleFilterValue(
                      current.capabilityStatuses,
                      option.value,
                      CAPABILITY_STATUS_OPTIONS,
                    ),
                    offset: 0,
                  }))}
              >{option.label}</FilterOption>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>Participants</legend>
          <ParticipantRangeFilter
            idPrefix="group-list-filter"
            maxParticipants={state.maxParticipants}
            minParticipants={state.minParticipants}
            onChange={(range) => setState((current) => ({
              ...current,
              ...range,
              offset: 0,
            }))}
          />
        </fieldset>

        <fieldset>
          <legend>Freshness</legend>
          <div className="data-filter-options">
            {CAPABILITY_FRESHNESS_OPTIONS.map((option) => (
              <FilterOption
                  checked={state.capabilityFreshness.includes(option.value)}
                  key={option.value}
                  onChange={() => setState((current) => ({
                    ...current,
                    capabilityFreshness: toggleFilterValue(
                      current.capabilityFreshness,
                      option.value,
                      CAPABILITY_FRESHNESS_OPTIONS,
                    ),
                    offset: 0,
                  }))}
              >{option.label}</FilterOption>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>Group state</legend>
          <div className="data-filter-options data-filter-options-single">
            <FilterOption
                checked={state.isActive === undefined}
                name={`${idPrefix}-state-filter`}
                onChange={() => setState((current) => ({
                  ...current,
                  isActive: undefined,
                  offset: 0,
                }))}
                type="radio"
            >All states</FilterOption>
            <FilterOption
                checked={state.isActive === true}
                name={`${idPrefix}-state-filter`}
                onChange={() => setState((current) => ({
                  ...current,
                  isActive: true,
                  offset: 0,
                }))}
                type="radio"
            >Active</FilterOption>
            <FilterOption
                checked={state.isActive === false}
                name={`${idPrefix}-state-filter`}
                onChange={() => setState((current) => ({
                  ...current,
                  isActive: false,
                  offset: 0,
                }))}
                type="radio"
            >Inactive</FilterOption>
          </div>
        </fieldset>
      </div>

      <GroupFilterSummary clearLabel="Clear all" setState={setState} showEmpty state={state} />
    </section>
  );
}
