import type { Dispatch, SetStateAction } from "react";

import { AppIcon } from "@/shared/ui/AppIcon";
import {
  activeGroupFilterCount,
  CAPABILITY_FRESHNESS_OPTIONS,
  CAPABILITY_STATUS_OPTIONS,
  type GroupListState,
  toggleFilterValue,
} from "./group-list-filters";
import { GroupFilterSummary } from "./GroupFilterSummary";

interface GroupFilterPanelProps {
  onClose: () => void;
  setState: Dispatch<SetStateAction<GroupListState>>;
  state: GroupListState;
}

export function GroupFilterPanel({ onClose, setState, state }: GroupFilterPanelProps) {
  const filterCount = activeGroupFilterCount(state);

  return (
    <section
      aria-label="Group filters"
      className="groups-filter-panel"
      id="group-list-filter-panel"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
      }}
    >
      <header className="groups-filter-panel-header">
        <div>
          <strong>Filter groups</strong>
          <span>{filterCount ? `${filterCount} applied` : "Server-side filters"}</span>
        </div>
        <button
          aria-label="Close group filters"
          className="groups-filter-panel-close"
          onClick={onClose}
          type="button"
        >
          <AppIcon name="close" size="xs" />
        </button>
      </header>

      <div className="groups-filter-panel-body">
        <fieldset>
          <legend>Send capability</legend>
          <div className="groups-filter-options groups-filter-options-multi">
            {CAPABILITY_STATUS_OPTIONS.map((option) => (
              <label key={option.value}>
                <input
                  checked={state.capabilityStatuses.includes(option.value)}
                  onChange={() => setState((current) => ({
                    ...current,
                    capabilityStatuses: toggleFilterValue(
                      current.capabilityStatuses,
                      option.value,
                      CAPABILITY_STATUS_OPTIONS,
                    ),
                    offset: 0,
                  }))}
                  type="checkbox"
                />
                <span aria-hidden="true" className="groups-filter-option-check">
                  <AppIcon name="check" size="xs" />
                </span>
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>Freshness</legend>
          <div className="groups-filter-options groups-filter-options-multi">
            {CAPABILITY_FRESHNESS_OPTIONS.map((option) => (
              <label key={option.value}>
                <input
                  checked={state.capabilityFreshness.includes(option.value)}
                  onChange={() => setState((current) => ({
                    ...current,
                    capabilityFreshness: toggleFilterValue(
                      current.capabilityFreshness,
                      option.value,
                      CAPABILITY_FRESHNESS_OPTIONS,
                    ),
                    offset: 0,
                  }))}
                  type="checkbox"
                />
                <span aria-hidden="true" className="groups-filter-option-check">
                  <AppIcon name="check" size="xs" />
                </span>
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>Group state</legend>
          <div className="groups-filter-options groups-filter-options-single">
            <label>
              <input
                checked={state.isActive === undefined}
                name="group-state-filter"
                onChange={() => setState((current) => ({
                  ...current,
                  isActive: undefined,
                  offset: 0,
                }))}
                type="radio"
              />
              <span>Active</span>
            </label>
            <label>
              <input
                checked={state.isActive === false}
                name="group-state-filter"
                onChange={() => setState((current) => ({
                  ...current,
                  isActive: false,
                  offset: 0,
                }))}
                type="radio"
              />
              <span>Inactive</span>
            </label>
          </div>
        </fieldset>
      </div>

      <GroupFilterSummary clearLabel="Clear all" setState={setState} showEmpty state={state} />
    </section>
  );
}
