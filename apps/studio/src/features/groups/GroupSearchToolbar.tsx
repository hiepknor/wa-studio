import type { Dispatch, ReactNode, Ref, SetStateAction } from "react";

import { DataFilterToolbar } from "@/shared/ui/DataFilterToolbar";
import {
  activeGroupFilterCount,
  type GroupListState,
} from "./group-list-filters";
import { GroupFilterPanel } from "./GroupFilterPanel";

interface GroupSearchToolbarProps {
  actions?: ReactNode;
  filtersOpen: boolean;
  firstItem: number;
  lastItem: number;
  loading: boolean;
  leading?: ReactNode;
  setFiltersOpen: Dispatch<SetStateAction<boolean>>;
  setState: Dispatch<SetStateAction<GroupListState>>;
  state: GroupListState;
  searchLabel?: string;
  searchInputRef?: Ref<HTMLInputElement>;
  searchPlaceholder?: string;
  total: number;
}

export function GroupSearchToolbar({
  actions,
  filtersOpen,
  firstItem,
  lastItem,
  loading,
  leading,
  setFiltersOpen,
  setState,
  state,
  searchLabel = "Search all synchronized groups",
  searchInputRef,
  searchPlaceholder = "Search name, ID, or description",
  total,
}: GroupSearchToolbarProps) {
  const filterCount = activeGroupFilterCount(state);
  const hasAppliedCriteria = Boolean(state.query || filterCount);

  return (
    <DataFilterToolbar
      actions={actions}
      filterCount={filterCount}
      filtersOpen={filtersOpen}
      idPrefix="group-list"
      loading={loading}
      leading={leading}
      onCloseFilters={() => setFiltersOpen(false)}
      onSearchChange={(inputQuery) => setState((current) => ({ ...current, inputQuery }))}
      onToggleFilters={() => setFiltersOpen((open) => !open)}
      resultSummary={loading
        ? "Updating results…"
        : `${firstItem}–${lastItem} of ${total}${hasAppliedCriteria ? " matches" : ""}`}
      searchLabel={searchLabel}
      searchInputRef={searchInputRef}
      searchPlaceholder={searchPlaceholder}
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
