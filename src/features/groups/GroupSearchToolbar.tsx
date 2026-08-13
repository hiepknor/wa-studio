import { useRef, type Dispatch, type SetStateAction } from "react";

import { AppIcon } from "@/shared/ui/AppIcon";
import { Button } from "@/shared/ui/Button";
import { TextField } from "@/shared/ui/TextField";
import {
  activeGroupFilterCount,
  type GroupListState,
} from "./group-list-filters";
import { GroupFilterPanel } from "./GroupFilterPanel";

interface GroupSearchToolbarProps {
  filtersOpen: boolean;
  firstItem: number;
  lastItem: number;
  loading: boolean;
  setFiltersOpen: Dispatch<SetStateAction<boolean>>;
  setState: Dispatch<SetStateAction<GroupListState>>;
  state: GroupListState;
  total: number;
}

export function GroupSearchToolbar({
  filtersOpen,
  firstItem,
  lastItem,
  loading,
  setFiltersOpen,
  setState,
  state,
  total,
}: GroupSearchToolbarProps) {
  const filterTriggerRef = useRef<HTMLButtonElement>(null);
  const filterCount = activeGroupFilterCount(state);
  const hasAppliedCriteria = Boolean(state.query || filterCount);

  function closeFilters() {
    setFiltersOpen(false);
    window.requestAnimationFrame(() => filterTriggerRef.current?.focus());
  }

  return (
    <div
      className="data-table-toolbar groups-toolbar"
      onKeyDown={(event) => {
        if (!filtersOpen || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        closeFilters();
      }}
    >
      <div className="groups-toolbar-row">
        <div className="groups-search-controls">
          <div className="groups-search-field-wrap">
            <TextField
              aria-busy={loading || undefined}
              containerClassName="groups-filter"
              icon="search"
              id="group-filter"
              label="Search all synchronized groups"
              labelHidden
              onChange={(event) => {
                const inputQuery = event.currentTarget.value;
                setState((current) => ({ ...current, inputQuery }));
              }}
              placeholder="Search name, ID, or description"
              size="sm"
              type="search"
              value={state.inputQuery}
            />
            {state.inputQuery && (
              <button
                aria-label="Clear group search"
                className="groups-search-clear"
                onClick={() => setState((current) => ({
                  ...current,
                  inputQuery: "",
                  query: "",
                  offset: 0,
                }))}
                type="button"
              >
                <AppIcon name="close" size="xs" />
              </button>
            )}
          </div>
          <Button
            aria-controls="group-list-filter-panel"
            aria-expanded={filtersOpen}
            icon="settings"
            onClick={() => setFiltersOpen((open) => !open)}
            ref={filterTriggerRef}
            size="sm"
          >
            Filters{filterCount ? ` · ${filterCount}` : ""}
          </Button>
        </div>
        <span className="groups-range" aria-live="polite">
          {loading
            ? "Updating results…"
            : `${firstItem}–${lastItem} of ${total}${hasAppliedCriteria ? " matches" : ""}`}
        </span>
      </div>

      {filtersOpen && (
        <GroupFilterPanel
          onClose={closeFilters}
          setState={setState}
          state={state}
        />
      )}
    </div>
  );
}
