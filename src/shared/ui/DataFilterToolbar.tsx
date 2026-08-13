import { useRef, type ReactNode } from "react";

import { AppIcon } from "./AppIcon";
import { Button } from "./Button";
import { TextField } from "./TextField";
import "./data-filter-toolbar.css";

interface DataFilterToolbarProps {
  children?: ReactNode | ((closeFilters: () => void) => ReactNode);
  clearSearchLabel?: string;
  filterCount: number;
  filtersOpen: boolean;
  idPrefix: string;
  loading?: boolean;
  onClearSearch: () => void;
  onCloseFilters: () => void;
  onSearchChange: (value: string) => void;
  onToggleFilters: () => void;
  resultSummary: ReactNode;
  searchLabel: string;
  searchPlaceholder: string;
  searchValue: string;
}

export function DataFilterToolbar({
  children,
  clearSearchLabel,
  filterCount,
  filtersOpen,
  idPrefix,
  loading = false,
  onClearSearch,
  onCloseFilters,
  onSearchChange,
  onToggleFilters,
  resultSummary,
  searchLabel,
  searchPlaceholder,
  searchValue,
}: DataFilterToolbarProps) {
  const filterTriggerRef = useRef<HTMLButtonElement>(null);

  function closeFilters() {
    onCloseFilters();
    window.requestAnimationFrame(() => filterTriggerRef.current?.focus());
  }

  return (
    <div
      className="data-table-toolbar data-filter-toolbar"
      onKeyDown={(event) => {
        if (!filtersOpen || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        closeFilters();
      }}
    >
      <div className="data-filter-toolbar-row">
        <div className="data-filter-controls">
          <div className="data-filter-search-wrap">
            <TextField
              aria-busy={loading || undefined}
              containerClassName="data-filter-search"
              icon="search"
              id={`${idPrefix}-search`}
              label={searchLabel}
              labelHidden
              onChange={(event) => onSearchChange(event.currentTarget.value)}
              placeholder={searchPlaceholder}
              size="sm"
              type="search"
              value={searchValue}
            />
            {searchValue && (
              <button
                aria-label={clearSearchLabel ?? `Clear ${searchLabel.toLocaleLowerCase()}`}
                className="data-filter-search-clear"
                onClick={onClearSearch}
                type="button"
              >
                <AppIcon name="close" size="xs" />
              </button>
            )}
          </div>
          <Button
            aria-controls={`${idPrefix}-filter-panel`}
            aria-expanded={filtersOpen}
            icon="settings"
            onClick={onToggleFilters}
            ref={filterTriggerRef}
            size="sm"
          >
            Filters{filterCount ? ` · ${filterCount}` : ""}
          </Button>
        </div>
        <span aria-live="polite" className="data-filter-result-summary">
          {resultSummary}
        </span>
      </div>
      {filtersOpen && (typeof children === "function" ? children(closeFilters) : children)}
    </div>
  );
}
