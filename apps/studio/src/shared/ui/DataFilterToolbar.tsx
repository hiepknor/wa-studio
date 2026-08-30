import { useEffect, useRef, type ReactNode, type Ref } from "react";

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
  panelMode?: "inline" | "popover";
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
  panelMode = "inline",
  resultSummary,
  searchLabel,
  searchInputRef,
  searchPlaceholder,
  searchValue,
}: DataFilterToolbarProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const filterTriggerRef = useRef<HTMLButtonElement>(null);

  function closeFilters() {
    onCloseFilters();
    window.requestAnimationFrame(() => filterTriggerRef.current?.focus());
  }

  useEffect(() => {
    if (!filtersOpen || panelMode !== "popover") return;
    function closeFromOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) onCloseFilters();
    }
    document.addEventListener("pointerdown", closeFromOutside);
    return () => document.removeEventListener("pointerdown", closeFromOutside);
  }, [filtersOpen, onCloseFilters, panelMode]);

  const filterPanel = filtersOpen
    ? (typeof children === "function" ? children(closeFilters) : children)
    : null;

  return (
    <div
      className={`data-table-toolbar data-filter-toolbar data-filter-toolbar-${panelMode}`}
      onKeyDown={(event) => {
        if (!filtersOpen || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        closeFilters();
      }}
      ref={rootRef}
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
          <div className="data-filter-trigger-wrap">
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
            {panelMode === "popover" && filterPanel}
          </div>
          {actions}
        </div>
        <span aria-live="polite" className="data-filter-result-summary">
          {resultSummary}
        </span>
      </div>
      {panelMode === "inline" && filterPanel}
    </div>
  );
}
