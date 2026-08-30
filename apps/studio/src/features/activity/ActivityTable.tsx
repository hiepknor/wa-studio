import type { RuntimeActivityEvent } from "@/shared/api/runtime-client";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { DateTime } from "@/shared/ui/DateTime";
import { DataTable, DataTableEmptyCell, DataTableScroll } from "@/shared/ui/DataTable";
import { DataTablePrimaryAction } from "@/shared/ui/DataTablePrimaryAction";
import {
  activitySeverityLabel,
  activityTitle,
  activityTone,
} from "./activity-presentation";

interface ActivityTableProps {
  activeEventId: string | null;
  emptyMessage: string;
  events: readonly RuntimeActivityEvent[];
  loading: boolean;
  onInspect: (event: RuntimeActivityEvent) => void;
}

export function ActivityTable({
  activeEventId,
  emptyMessage,
  events,
  loading,
  onInspect,
}: ActivityTableProps) {
  const tableMessage = loading && events.length === 0
    ? "Loading operational activity…"
    : events.length === 0
      ? emptyMessage
      : null;

  return (
    <DataTableScroll
      busy={loading}
      className="activity-table-scroll"
      updating={loading && events.length > 0}
    >
      <DataTable caption="Retained operational activity for the active session" className="activity-table">
        <colgroup>
          <col className="activity-column-event" />
          <col className="activity-column-subject" />
          <col className="activity-column-outcome" />
          <col className="activity-column-occurred" />
          <col className="activity-column-action" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Event</th>
            <th className="activity-subject-col" scope="col">Subject</th>
            <th className="data-cell-status" scope="col">Outcome</th>
            <th className="data-column-time" scope="col">Occurred</th>
            <th className="data-column-actions" scope="col">
              <span className="ui-data-table-visually-hidden">Inspect</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {tableMessage ? (
            <tr><DataTableEmptyCell colSpan={5}>{tableMessage}</DataTableEmptyCell></tr>
          ) : events.map((event) => (
            <tr data-selected={event.id === activeEventId || undefined} key={event.id}>
              <td className="data-cell-primary">
                <div className="stack stack-xs">
                  <DataTablePrimaryAction onClick={() => onInspect(event)}>{activityTitle(event)}</DataTablePrimaryAction>
                  <span className="data-identifier">{event.eventType} · v{event.eventVersion}</span>
                </div>
              </td>
              <td className="activity-subject-col priority-low">
                <span className="activity-subject-name" title={event.subject.labelSnapshot}>{event.subject.labelSnapshot}</span>
                <span className="data-identifier" title={event.subject.id}>{event.subject.id}</span>
              </td>
              <td className="data-cell-status"><Badge tone={activityTone(event.severity)} variant="status">{activitySeverityLabel(event.severity)}</Badge></td>
              <td className="data-cell-time"><DateTime relativeStyle="compact" value={event.occurredAt} variant="relative" /></td>
              <td className="data-cell-action data-cell-action-icon focus-overflow-owner">
                <Button aria-label={`Inspect ${activityTitle(event)}`} icon="chevron-right" onClick={() => onInspect(event)} variant="ghost" />
              </td>
            </tr>
          ))}
        </tbody>
      </DataTable>
    </DataTableScroll>
  );
}
