import { useRef, type ReactNode, type Ref } from "react";

import { Button } from "./Button";
import { SearchField } from "./SearchField";
import "./data-filter-toolbar.css";

interface DataFilterToolbarProps {
  actions?: ReactNode;
  children?: ReactNode | ((closeFilters: () => void) => ReactNode);
  filterCount: number;
  filtersOpen: boolean;
  idPrefix: string;
  leading?: ReactNode;
  loading?: boolean;
  onCloseFilters: () => void;
  onSearchChange: (value: string) => void;
  onToggleFilters: () => void;
  resultSummary: ReactNode;
  searchLabel: string;
  searchInputRef?: Ref<HTMLInputElement>;
  searchPlaceholder: string;
  searchValue: string;
}

export function DataFilterToolbar({
  actions,
  children,
  filterCount,
  filtersOpen,
  idPrefix,
  leading,
  loading = false,
  onCloseFilters,
  onSearchChange,
  onToggleFilters,
  resultSummary,
  searchLabel,
  searchInputRef,
  searchPlaceholder,
  searchValue,
}: DataFilterToolbarProps) {
  const filterTriggerRef = useRef<HTMLButtonElement>(null);

  function closeFilters() {
    onCloseFilters();
    window.requestAnimationFrame(() => filterTriggerRef.current?.focus());
  }

  const filterPanel = filtersOpen
    ? (typeof children === "function" ? children(closeFilters) : children)
    : null;

  return (
    <div
      className="ui-data-filter-toolbar data-filter-toolbar"
      onKeyDown={(event) => {
        if (!filtersOpen || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        closeFilters();
      }}
    >
      <div className="data-filter-toolbar-row">
        <div className="data-filter-controls">
          {leading}
          <SearchField
            id={`${idPrefix}-search`}
            inputRef={searchInputRef}
            label={searchLabel}
            loading={loading}
            onChange={onSearchChange}
            placeholder={searchPlaceholder}
            value={searchValue}
            variant="toolbar"
          />
          <Button
            aria-controls={`${idPrefix}-filter-panel`}
            aria-expanded={filtersOpen}
            icon="settings"
            onClick={onToggleFilters}
            ref={filterTriggerRef}
            size="md"
          >
            Filters{filterCount ? ` · ${filterCount}` : ""}
          </Button>
          {actions}
        </div>
        <span aria-live="polite" className="data-filter-result-summary">
          {resultSummary}
        </span>
      </div>
      {filterPanel}
    </div>
  );
}
