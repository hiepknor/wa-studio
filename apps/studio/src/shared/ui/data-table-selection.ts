export interface DataTablePageSelectionState {
  allPageSelected: boolean;
  somePageSelected: boolean;
}

export function dataTablePageSelectionState(
  pageIds: readonly string[],
  selectedIds: ReadonlySet<string>,
): DataTablePageSelectionState {
  return {
    allPageSelected: pageIds.length > 0
      && pageIds.every((id) => selectedIds.has(id)),
    somePageSelected: pageIds.some((id) => selectedIds.has(id)),
  };
}
