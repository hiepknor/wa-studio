import type { RuntimeGroupListGroup } from "@/shared/api/runtime-client";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Checkbox } from "@/shared/ui/Checkbox";
import { dataTablePageSelectionState } from "@/shared/ui/data-table-selection";
import { GroupCapabilityStatus } from "../GroupCapabilityStatus";
import "./group-selection.css";

export interface GroupSelectionRow extends Pick<
  RuntimeGroupListGroup,
  "groupId" | "groupName" | "isActive" | "participantsCount" | "sendCapability"
> {}

export type GroupSelectionTableView = "results" | "selection";

export interface GroupSelectionTableProps {
  caption?: string;
  disabled?: boolean;
  emptyMessage: string;
  loading: boolean;
  loadingMessage?: string;
  onToggle: (groupId: string) => void;
  onTogglePage: () => void;
  onViewChange: (view: GroupSelectionTableView) => void;
  outsideResultIds?: ReadonlySet<string>;
  pageIds: string[];
  rows: GroupSelectionRow[];
  savedIds?: ReadonlySet<string>;
  selectedIds: ReadonlySet<string>;
  unknownParticipantsTitle?: string;
  view: GroupSelectionTableView;
}

function participantCount(value: number | null): string {
  return value === null ? "—" : new Intl.NumberFormat().format(value);
}

export function GroupSelectionTable({
  caption = "Groups available to this static selection",
  disabled = false,
  emptyMessage,
  loading,
  loadingMessage = "Loading groups…",
  onToggle,
  onTogglePage,
  onViewChange,
  outsideResultIds = new Set<string>(),
  pageIds,
  rows,
  savedIds = new Set<string>(),
  selectedIds,
  unknownParticipantsTitle = "Participant count is unavailable.",
  view,
}: GroupSelectionTableProps) {
  const { allPageSelected, somePageSelected } = dataTablePageSelectionState(
    pageIds,
    selectedIds,
  );
  const resultRows = rows.filter((row) => !outsideResultIds.has(row.groupId));
  const selectionRows = rows.filter((row) => (
    selectedIds.has(row.groupId) || savedIds.has(row.groupId)
  ));
  const visibleRows = view === "selection" ? selectionRows : resultRows;
  const outsideSelectionCount = [...selectedIds]
    .filter((groupId) => outsideResultIds.has(groupId)).length;
  const addedCount = [...selectedIds].filter((groupId) => !savedIds.has(groupId)).length;
  const removedCount = [...savedIds].filter((groupId) => !selectedIds.has(groupId)).length;
  const columnCount = 4;
  function renderRow(row: GroupSelectionRow) {
    const selected = selectedIds.has(row.groupId);
    const added = view === "selection" && selected && !savedIds.has(row.groupId);
    const removed = view === "selection" && !selected && savedIds.has(row.groupId);
    return (
      <tr
        data-selected={selected || undefined}
        key={row.groupId}
      >
        <td className="data-selection-cell">
          <Checkbox
            aria-label={`Select ${row.groupName}`}
            checked={selected}
            disabled={disabled}
            onChange={() => onToggle(row.groupId)}
          />
        </td>
        <td className="data-cell-primary group-selection-group">
          <div>
            <strong className="data-primary-text" title={row.groupName}>{row.groupName}</strong>
            {!row.isActive && <Badge tone="neutral" variant="status">Inactive</Badge>}
            {added && <Badge tone="success" variant="status">Added</Badge>}
            {removed && <Badge tone="danger" variant="status">Pending removal</Badge>}
          </div>
          <small className="data-identifier" title={row.groupId}>{row.groupId}</small>
        </td>
        <td
          className="data-cell-number group-selection-participants"
          title={row.participantsCount === null ? unknownParticipantsTitle : undefined}
        >
          {participantCount(row.participantsCount)}
        </td>
        <td className="data-cell-status group-selection-capability">
          <GroupCapabilityStatus capability={row.sendCapability} includeFreshness={false} />
        </td>
      </tr>
    );
  }
  return (
    <>
      <section
        aria-label="Target selection view"
        className="data-selection-bar"
        data-active={selectedIds.size > 0 || undefined}
      >
        <div aria-live="polite" className="data-selection-summary">
          <strong>{selectedIds.size.toLocaleString()} selected</strong>
          <span>{view === "selection"
            ? addedCount || removedCount
              ? `+${addedCount} added · −${removedCount} pending removal`
              : "Saved selection"
            : outsideSelectionCount
              ? `${outsideSelectionCount.toLocaleString()} outside current view`
              : selectedIds.size
                ? "All selected groups are in the current view"
                : "Select groups from the current results"}</span>
        </div>
        <div className="data-selection-actions">
          <Button
            disabled={view === "results" && selectionRows.length === 0}
            onClick={() => onViewChange(view === "results" ? "selection" : "results")}
            size="sm"
            variant="ghost"
          >
            {view === "results" ? "Show selected" : "Show results"}
          </Button>
        </div>
      </section>
      <div aria-busy={view === "results" && loading || undefined} className="data-table-scroll group-selection-table">
        <table className="data-table">
          <caption>{caption}</caption>
          <thead><tr><th aria-label="Selection" className="data-selection-cell" scope="col">{view === "results" && <Checkbox aria-checked={somePageSelected && !allPageSelected ? "mixed" : allPageSelected} aria-label="Select all groups on this page" checked={allPageSelected} disabled={disabled || !pageIds.length || loading} onChange={onTogglePage} ref={(node) => { if (node) node.indeterminate = somePageSelected && !allPageSelected; }} title="Select all groups on this page" />}</th><th scope="col">Group</th><th className="data-column-number group-selection-participants" scope="col">Participants</th><th className="group-selection-capability" scope="col">Send capability</th></tr></thead>
          {view === "results" && loading && !visibleRows.length ? <tbody><tr><td className="data-table-empty group-selection-table-empty" colSpan={columnCount}>{loadingMessage}</td></tr></tbody>
            : !visibleRows.length ? <tbody><tr><td className="data-table-empty group-selection-table-empty" colSpan={columnCount}>{view === "selection" ? "No groups selected." : emptyMessage}</td></tr></tbody>
              : <tbody aria-label={view === "selection" ? "Selected groups" : "Current results"}>{visibleRows.map(renderRow)}</tbody>}
        </table>
      </div>
    </>
  );
}
