import type { ReactNode } from "react";

import { TablePagination } from "@/shared/ui/TablePagination";
import {
  GroupSelectionTable,
  type GroupSelectionTableProps,
} from "./GroupSelectionTable";
import {
  GroupSelectionToolbar,
  type GroupSelectionToolbarProps,
} from "./GroupSelectionToolbar";

interface GroupSelectionPanelProps {
  afterToolbar?: ReactNode;
  beforeToolbar?: ReactNode;
  description: string;
  headingLevel?: "h3" | "h4";
  pageNote?: ReactNode;
  pagination: {
    limit: number;
    loading: boolean;
    offset: number;
    onOffsetChange: (offset: number) => void;
    total: number;
  };
  summary?: ReactNode;
  table: GroupSelectionTableProps;
  title: string;
  titleId: string;
  toolbar: GroupSelectionToolbarProps;
}

export function GroupSelectionPanel({
  afterToolbar,
  beforeToolbar,
  description,
  headingLevel = "h3",
  pageNote,
  pagination,
  summary,
  table,
  title,
  titleId,
  toolbar,
}: GroupSelectionPanelProps) {
  const Heading = headingLevel;
  return (
    <section aria-labelledby={titleId} className="group-selection-section">
      <div className="group-selection-heading">
        <div><Heading id={titleId}>{title}</Heading><p>{description}</p></div>
        {summary && <div className="group-selection-heading-summary">{summary}</div>}
      </div>
      {beforeToolbar}
      <div className="group-selection-data">
        <GroupSelectionToolbar {...toolbar} />
        {afterToolbar}
        <GroupSelectionTable {...table} />
        {pageNote && <p className="group-selection-page-note">{pageNote}</p>}
        <TablePagination {...pagination} />
      </div>
    </section>
  );
}
