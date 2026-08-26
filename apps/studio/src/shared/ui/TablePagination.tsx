import type { ReactNode } from "react";

import { Button } from "./Button";
import "./table-pagination.css";

interface TablePaginationProps {
  limit: number;
  label?: ReactNode;
  loading?: boolean;
  offset: number;
  onOffsetChange: (offset: number) => void;
  total: number;
}

export function TablePagination({
  limit,
  label,
  loading = false,
  offset,
  onOffsetChange,
  total,
}: TablePaginationProps) {
  const pageCount = total === 0 ? 0 : Math.ceil(total / limit);
  const pageNumber = total === 0 ? 0 : Math.floor(offset / limit) + 1;
  return (
    <div className="table-pagination">
      <span>{label ?? (total === 0 ? "No results" : `Page ${pageNumber} of ${pageCount}`)}</span>
      <div>
        <Button disabled={loading || offset <= 0} onClick={() => onOffsetChange(Math.max(0, offset - limit))} size="sm">Previous</Button>
        <Button disabled={loading || offset + limit >= total} onClick={() => onOffsetChange(offset + limit)} size="sm">Next</Button>
      </div>
    </div>
  );
}
