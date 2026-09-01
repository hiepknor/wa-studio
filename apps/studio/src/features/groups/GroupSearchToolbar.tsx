import type { Dispatch, ReactNode, Ref, SetStateAction } from "react";

import { DataFilterToolbar } from "@/shared/ui/DataFilterToolbar";
import { formatListResultSummary } from "@/shared/ui/list-result-summary";
import {
  activeGroupFilterCount,
  type GroupListState,
} from "./group-list-filters";
import { GroupFilterPanel } from "./GroupFilterPanel";

interface GroupSearchToolbarProps {
  actions?: ReactNode;
  filtersOpen: boolean;
  firstItem: number;
  idPrefix?: string;
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
  idPrefix = "group-list",
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
      idPrefix={idPrefix}
      loading={loading}
      leading={leading}
      onCloseFilters={() => setFiltersOpen(false)}
      onSearchChange={(inputQuery) => setState((current) => ({ ...current, inputQuery }))}
      onToggleFilters={() => setFiltersOpen((open) => !open)}
      resultSummary={loading
        ? "Updating results…"
        : formatListResultSummary({
          firstItem,
          hasCriteria: hasAppliedCriteria,
          lastItem,
          plural: "groups",
          singular: "group",
          total,
        })}
      searchLabel={searchLabel}
      searchInputRef={searchInputRef}
      searchPlaceholder={searchPlaceholder}
      searchValue={state.inputQuery}
    >
      {(closeFilters) => filtersOpen && (
        <GroupFilterPanel
          idPrefix={idPrefix}
          onClose={closeFilters}
          setState={setState}
          state={state}
        />
      )}
    </DataFilterToolbar>
  );
}
