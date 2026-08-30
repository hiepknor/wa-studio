import type {
  HTMLAttributes,
  ReactNode,
  TableHTMLAttributes,
  TdHTMLAttributes,
} from "react";

import "./data-table.css";

export interface DataTableProps extends TableHTMLAttributes<HTMLTableElement> {
  caption: ReactNode;
}

export function DataTable({
  caption,
  children,
  className = "",
  ...props
}: DataTableProps) {
  return (
    <table {...props} className={`ui-data-table ${className}`.trim()}>
      <caption>{caption}</caption>
      {children}
    </table>
  );
}

export interface DataTableScrollProps extends HTMLAttributes<HTMLDivElement> {
  busy?: boolean;
  updating?: boolean;
}

export function DataTableScroll({
  busy = false,
  children,
  className = "",
  updating = false,
  ...props
}: DataTableScrollProps) {
  return (
    <div
      {...props}
      aria-busy={busy}
      className={`ui-data-table-scroll ${className}`.trim()}
      data-updating={updating || undefined}
    >
      {children}
    </div>
  );
}

export interface DataTableEmptyCellProps extends TdHTMLAttributes<HTMLTableCellElement> {
  children: ReactNode;
}

export function DataTableEmptyCell({
  children,
  className = "",
  ...props
}: DataTableEmptyCellProps) {
  return (
    <td {...props} className={`ui-data-table-empty ${className}`.trim()}>
      {children}
    </td>
  );
}

export interface DataTableSelectionBarProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  actions?: ReactNode;
  active?: boolean;
  ariaLabel: string;
  detail?: ReactNode;
  selectedCount: number;
  summary?: ReactNode;
}

export function DataTableSelectionBar({
  actions,
  active = false,
  ariaLabel,
  className = "",
  detail,
  selectedCount,
  summary,
  ...props
}: DataTableSelectionBarProps) {
  return (
    <section
      {...props}
      aria-label={ariaLabel}
      className={`ui-data-table-selection-bar ${className}`.trim()}
      data-active={active || undefined}
    >
      <div aria-live="polite" className="ui-data-table-selection-summary">
        <strong>{summary ?? `${selectedCount.toLocaleString()} selected`}</strong>
        {detail !== undefined && <span>{detail}</span>}
      </div>
      {actions !== undefined && (
        <div className="ui-data-table-selection-actions">{actions}</div>
      )}
    </section>
  );
}
