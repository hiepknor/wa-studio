import type { RuntimeGroup } from "@/shared/api/runtime-client";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Checkbox } from "@/shared/ui/Checkbox";
import { DateTime } from "@/shared/ui/DateTime";
import { GroupCapabilityStatus } from "./GroupCapabilityStatus";

export interface GroupsTableRow extends Pick<
  RuntimeGroup,
  "id" | "isActive" | "name" | "participantsCount" | "sendCapability" | "sessionId" | "syncedAt"
> {}

interface GroupsTableSelection {
  disabled?: boolean;
  onToggle: (groupId: string) => void;
  onTogglePage: () => void;
  pageIds: readonly string[];
  pinnedIds?: ReadonlySet<string>;
  pinnedLabel?: string;
  selectedIds: ReadonlySet<string>;
}

interface GroupsTableProps {
  activeGroupId?: string | null;
  caption: string;
  emptyMessage: string;
  error?: boolean;
  loading: boolean;
  loadingMessage?: string;
  onView: (group: GroupsTableRow, trigger: HTMLButtonElement) => void;
  rows: readonly GroupsTableRow[];
  selection?: GroupsTableSelection;
}

function participantCount(value: number | null): string {
  return value === null ? "—" : value.toLocaleString();
}

export function GroupsTable({
  activeGroupId = null,
  caption,
  emptyMessage,
  error = false,
  loading,
  loadingMessage = "Loading groups…",
  onView,
  rows,
  selection,
}: GroupsTableProps) {
  const columnCount = selection ? 6 : 5;
  const selectedIds = selection?.selectedIds ?? new Set<string>();
  const pinnedIds = selection?.pinnedIds ?? new Set<string>();
  const pinnedRows = rows.filter((row) => pinnedIds.has(row.id));
  const resultRows = rows.filter((row) => !pinnedIds.has(row.id));
  const allPageSelected = Boolean(
    selection
    && selection.pageIds.length > 0
    && selection.pageIds.every((id) => selectedIds.has(id)),
  );
  const somePageSelected = Boolean(
    selection?.pageIds.some((id) => selectedIds.has(id)),
  );

  function renderRow(row: GroupsTableRow) {
    const selected = selectedIds.has(row.id);
    return (
      <tr
        data-active={row.id === activeGroupId || undefined}
        data-selected={selected || undefined}
        key={row.id}
      >
        {selection && (
          <td className="groups-selection-cell">
            <Checkbox
              aria-label={`Select ${row.name}`}
              checked={selected}
              disabled={selection.disabled}
              onChange={() => selection.onToggle(row.id)}
            />
          </td>
        )}
        <td className="data-cell-primary">
          <div className="stack stack-xs groups-name-cell">
            <span className="groups-name-line">
              <strong className="data-primary-text" title={row.name}>{row.name}</strong>
              {!row.isActive && <Badge tone="neutral" variant="status">Inactive</Badge>}
            </span>
            <span className="data-identifier" title={row.id}>{row.id}</span>
          </div>
        </td>
        <td className="data-cell-number">{participantCount(row.participantsCount)}</td>
        <td className="data-cell-status">
          <GroupCapabilityStatus capability={row.sendCapability} />
        </td>
        <td className="data-cell-time"><DateTime value={row.syncedAt} /></td>
        <td className="data-cell-action">
          <Button
            aria-label={`View ${row.name}`}
            onClick={(event) => onView(row, event.currentTarget)}
            size="sm"
            variant="ghost"
          >
            View
          </Button>
        </td>
      </tr>
    );
  }

  const empty = loading && rows.length === 0
    ? loadingMessage
    : error
      ? "Groups are unavailable."
      : rows.length === 0
        ? emptyMessage
        : null;

  return (
    <div
      aria-busy={loading}
      className="data-table-scroll groups-table-scroll"
      data-updating={(loading && rows.length > 0) || undefined}
    >
      <table className="data-table">
        <caption>{caption}</caption>
        <colgroup>
          {selection && <col className="groups-column-selection" />}
          <col className="groups-column-identity" />
          <col className="groups-column-participants" />
          <col className="groups-column-capability" />
          <col className="groups-column-synced" />
          <col className="groups-column-action" />
        </colgroup>
        <thead>
          <tr>
            {selection && (
              <th className="groups-selection-cell" scope="col">
                <Checkbox
                  aria-checked={somePageSelected && !allPageSelected ? "mixed" : allPageSelected}
                  aria-label="Select all groups on this page"
                  checked={allPageSelected}
                  disabled={selection.disabled || !selection.pageIds.length || loading}
                  onChange={selection.onTogglePage}
                  ref={(node) => {
                    if (node) node.indeterminate = somePageSelected && !allPageSelected;
                  }}
                />
              </th>
            )}
            <th scope="col">Group</th>
            <th className="data-column-number" scope="col">Participants</th>
            <th scope="col">Send capability</th>
            <th className="data-column-time" scope="col">Record synced</th>
            <th aria-label="Actions" scope="col" />
          </tr>
        </thead>
        {empty ? (
          <tbody><tr><td className="data-table-empty" colSpan={columnCount}>{empty}</td></tr></tbody>
        ) : (
          <>
            {pinnedRows.length > 0 && (
              <tbody aria-label={selection?.pinnedLabel ?? "Saved or staged outside current results"}>
                <tr className="groups-table-divider">
                  <th colSpan={columnCount} scope="rowgroup">
                    {selection?.pinnedLabel ?? "Saved or staged outside current results"}
                    <span>{pinnedRows.length}</span>
                  </th>
                </tr>
                {pinnedRows.map(renderRow)}
              </tbody>
            )}
            {resultRows.length > 0 && (
              <tbody aria-label="Current results">
                {pinnedRows.length > 0 && (
                  <tr className="groups-table-divider">
                    <th colSpan={columnCount} scope="rowgroup">Current results <span>{resultRows.length}</span></th>
                  </tr>
                )}
                {resultRows.map(renderRow)}
              </tbody>
            )}
          </>
        )}
      </table>
    </div>
  );
}
