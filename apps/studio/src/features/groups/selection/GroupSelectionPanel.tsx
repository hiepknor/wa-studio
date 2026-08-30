import { useState, type ReactNode } from "react";

import { DataTableFrame } from "@/shared/ui/Composition";
import { TablePagination } from "@/shared/ui/TablePagination";
import {
  GroupSelectionTable,
  type GroupSelectionTableProps,
  type GroupSelectionTableView,
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
  table: Omit<GroupSelectionTableProps, "onViewChange" | "view">;
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
  const [tableView, setTableView] = useState<GroupSelectionTableView>("results");
  return (
    <section aria-labelledby={titleId} className="group-selection-section">
      <div className="group-selection-heading">
        <div><Heading id={titleId}>{title}</Heading><p>{description}</p></div>
        {summary && <div className="group-selection-heading-summary">{summary}</div>}
      </div>
      {beforeToolbar}
      <DataTableFrame
        className="group-selection-data"
        label={`${title} directory`}
        scroll={false}
      >
        <GroupSelectionToolbar {...toolbar} />
        {afterToolbar}
        <GroupSelectionTable {...table} onViewChange={setTableView} view={tableView} />
        {tableView === "results" && pageNote && <p className="group-selection-page-note">{pageNote}</p>}
        {tableView === "results" && <TablePagination {...pagination} />}
      </DataTableFrame>
    </section>
  );
}
