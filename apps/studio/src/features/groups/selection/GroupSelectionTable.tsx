import type { RuntimeGroupListGroup } from "@/shared/api/runtime-client";
import { Badge } from "@/shared/ui/Badge";
import { GroupCapabilityStatus } from "../GroupCapabilityStatus";
import "./group-selection.css";

export interface GroupSelectionRow extends RuntimeGroupListGroup {}

export interface GroupSelectionTableProps {
  caption?: string;
  disabled?: boolean;
  emptyMessage: string;
  loading: boolean;
  loadingMessage?: string;
  onToggle: (groupId: string) => void;
  onTogglePage: () => void;
  pageIds: string[];
  pinnedIds?: ReadonlySet<string>;
  pinnedLabel?: string;
  rows: GroupSelectionRow[];
  selectedIds: ReadonlySet<string>;
  unknownParticipantsTitle?: string;
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
  pageIds,
  pinnedIds = new Set<string>(),
  pinnedLabel = "Saved or selected outside current results",
  rows,
  selectedIds,
  unknownParticipantsTitle = "Participant count is unavailable.",
}: GroupSelectionTableProps) {
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const somePageSelected = pageIds.some((id) => selectedIds.has(id));
  const pinnedRows = rows.filter((row) => pinnedIds.has(row.groupId));
  const resultRows = rows.filter((row) => !pinnedIds.has(row.groupId));
  function renderRow(row: GroupSelectionRow) {
    const selected = selectedIds.has(row.groupId);
    return <tr data-selected={selected || undefined} key={row.groupId}><td className="group-selection-check"><input aria-label={`Select ${row.groupName}`} checked={selected} disabled={disabled} onChange={() => onToggle(row.groupId)} type="checkbox" /></td><td className="group-selection-group"><div><strong>{row.groupName}</strong>{!row.isActive && <Badge tone="neutral">Inactive</Badge>}</div><small>{row.groupId}</small></td><td className="group-selection-participants" title={row.participantsCount === null ? unknownParticipantsTitle : undefined}>{participantCount(row.participantsCount)}</td><td className="group-selection-capability"><GroupCapabilityStatus capability={row.sendCapability} includeFreshness={false} /></td></tr>;
  }
  return (
    <div aria-busy={loading || undefined} className="group-selection-table">
      <table>
        <caption>{caption}</caption>
        <thead><tr><th className="group-selection-check" scope="col"><input aria-checked={somePageSelected && !allPageSelected ? "mixed" : allPageSelected} aria-label="Select all groups on this page" checked={allPageSelected} disabled={disabled || !pageIds.length || loading} onChange={onTogglePage} ref={(node) => { if (node) node.indeterminate = somePageSelected && !allPageSelected; }} title="Select all groups on this page" type="checkbox" /></th><th scope="col">Group</th><th className="group-selection-participants" scope="col">Participants</th><th className="group-selection-capability" scope="col">Capability</th></tr></thead>
        {loading && !rows.length ? <tbody><tr><td className="group-selection-table-empty" colSpan={4}>{loadingMessage}</td></tr></tbody>
          : !rows.length ? <tbody><tr><td className="group-selection-table-empty" colSpan={4}>{emptyMessage}</td></tr></tbody>
          : <>
            {pinnedRows.length > 0 && <tbody aria-label={pinnedLabel}><tr className="group-selection-divider"><th colSpan={4} scope="rowgroup">{pinnedLabel} <span>{pinnedRows.length}</span></th></tr>{pinnedRows.map(renderRow)}</tbody>}
            {resultRows.length > 0 && <tbody aria-label="Current results">{pinnedRows.length > 0 && <tr className="group-selection-divider"><th colSpan={4} scope="rowgroup">Current results <span>{resultRows.length}</span></th></tr>}{resultRows.map(renderRow)}</tbody>}
          </>}
      </table>
    </div>
  );
}
