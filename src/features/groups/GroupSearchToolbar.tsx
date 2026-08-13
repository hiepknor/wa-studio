import type { Dispatch, SetStateAction } from "react";

import { DataFilterToolbar } from "@/shared/ui/DataFilterToolbar";
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
  const filterCount = activeGroupFilterCount(state);
  const hasAppliedCriteria = Boolean(state.query || filterCount);

  return (
    <DataFilterToolbar
      clearSearchLabel="Clear group search"
      filterCount={filterCount}
      filtersOpen={filtersOpen}
      idPrefix="group-list"
      loading={loading}
      onClearSearch={() => setState((current) => ({
        ...current,
        inputQuery: "",
        query: "",
        offset: 0,
      }))}
      onCloseFilters={() => setFiltersOpen(false)}
      onSearchChange={(inputQuery) => setState((current) => ({ ...current, inputQuery }))}
      onToggleFilters={() => setFiltersOpen((open) => !open)}
      resultSummary={loading
        ? "Updating results…"
        : `${firstItem}–${lastItem} of ${total}${hasAppliedCriteria ? " matches" : ""}`}
      searchLabel="Search all synchronized groups"
      searchPlaceholder="Search name, ID, or description"
      searchValue={state.inputQuery}
    >
      {(closeFilters) => filtersOpen && (
        <GroupFilterPanel
          onClose={closeFilters}
          setState={setState}
          state={state}
        />
      )}
    </DataFilterToolbar>
  );
}
