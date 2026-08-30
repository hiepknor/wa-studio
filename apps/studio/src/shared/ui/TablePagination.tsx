import type { ReactNode } from "react";

import { Button } from "./Button";
import "./table-pagination.css";

export interface TablePaginationProps {
  limit: number;
  label?: ReactNode;
  loading?: boolean;
  nextButtonAriaLabel?: string;
  offset: number;
  onOffsetChange: (offset: number) => void;
  previousButtonAriaLabel?: string;
  total: number;
}

export function TablePagination({
  limit,
  label,
  loading = false,
  nextButtonAriaLabel,
  offset,
  onOffsetChange,
  previousButtonAriaLabel,
  total,
}: TablePaginationProps) {
  const pageCount = total === 0 ? 0 : Math.ceil(total / limit);
  const pageNumber = total === 0 ? 0 : Math.floor(offset / limit) + 1;
  const defaultLabel = total === 0
    ? "No results"
    : pageCount === 1
      ? "All results shown"
      : `Page ${pageNumber} of ${pageCount}`;
  return (
    <div className="table-pagination">
      <span>{label ?? defaultLabel}</span>
      <div>
        <Button
          aria-label={previousButtonAriaLabel}
          disabled={loading || offset <= 0}
          onClick={() => onOffsetChange(Math.max(0, offset - limit))}
          size="sm"
        >
          Previous
        </Button>
        <Button
          aria-label={nextButtonAriaLabel}
          disabled={loading || offset + limit >= total}
          onClick={() => onOffsetChange(offset + limit)}
          size="sm"
        >
          Next
        </Button>
      </div>
    </div>
  );
}
