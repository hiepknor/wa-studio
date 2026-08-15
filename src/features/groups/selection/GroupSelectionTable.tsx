import type { RuntimeGroupListGroup } from "@/shared/api/runtime-client";
import { Badge } from "@/shared/ui/Badge";
import { GroupCapabilityStatus } from "../GroupCapabilityStatus";

export interface GroupSelectionRow extends RuntimeGroupListGroup {}

interface GroupSelectionTableProps {
  caption?: string;
  disabled?: boolean;
  emptyMessage: string;
  loading: boolean;
  loadingMessage?: string;
  onToggle: (groupId: string) => void;
  onTogglePage: () => void;
  pageIds: string[];
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
  rows,
  selectedIds,
  unknownParticipantsTitle = "Participant count is unavailable.",
}: GroupSelectionTableProps) {
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const somePageSelected = pageIds.some((id) => selectedIds.has(id));
  return (
    <div aria-busy={loading || undefined} className="campaign-target-table group-selection-table">
      <table>
        <caption>{caption}</caption>
        <thead><tr><th className="campaign-target-check" scope="col"><input aria-checked={somePageSelected && !allPageSelected ? "mixed" : allPageSelected} aria-label="Select all groups on this page" checked={allPageSelected} disabled={disabled || !pageIds.length || loading} onChange={onTogglePage} ref={(node) => { if (node) node.indeterminate = somePageSelected && !allPageSelected; }} title="Select all groups on this page" type="checkbox" /></th><th scope="col">Group</th><th className="campaign-target-participants" scope="col">Participants</th><th className="campaign-target-capability" scope="col">Capability</th></tr></thead>
        <tbody>
          {loading && !rows.length ? <tr><td className="campaign-target-table-empty" colSpan={4}>{loadingMessage}</td></tr> : !rows.length ? <tr><td className="campaign-target-table-empty" colSpan={4}>{emptyMessage}</td></tr> : rows.map((row) => {
            const selected = selectedIds.has(row.groupId);
            return <tr data-selected={selected || undefined} key={row.groupId}><td className="campaign-target-check"><input aria-label={`Select ${row.groupName}`} checked={selected} disabled={disabled} onChange={() => onToggle(row.groupId)} type="checkbox" /></td><td className="campaign-target-group"><div><strong>{row.groupName}</strong>{!row.isActive && <Badge tone="neutral">Inactive</Badge>}</div><small>{row.groupId}</small></td><td className="campaign-target-participants" title={row.participantsCount === null ? unknownParticipantsTitle : undefined}>{participantCount(row.participantsCount)}</td><td className="campaign-target-capability"><GroupCapabilityStatus appearance="badge" capability={row.sendCapability} includeFreshness={false} /></td></tr>;
          })}
        </tbody>
      </table>
    </div>
  );
}
