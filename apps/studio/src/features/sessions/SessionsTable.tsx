import type { RuntimeSession } from "@/shared/api/runtime-client";
import { sessionIdentityLabel } from "@/shared/presentation/session";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { DataTable, DataTableEmptyCell, DataTableScroll } from "@/shared/ui/DataTable";
import { DateTime } from "@/shared/ui/DateTime";
import type { FeedbackTone } from "@/shared/ui/feedback-tone";

interface SessionsTableProps {
  emptyMessage: string;
  loading: boolean;
  onOpenGroups?: () => void;
  onSelectSession: (sessionId: string) => void;
  selectedSessionId: string | null;
  sessions: readonly RuntimeSession[];
}

function statusTone(status: string): FeedbackTone {
  if (status === "ready") return "success";
  if (status === "failed" || status === "disconnected") return "danger";
  if (status === "initializing" || status === "authenticating") return "warning";
  return "neutral";
}

function statusLabel(status: string): string {
  return status
    .replace(/(^|[-_])(\w)/g, (_, __, letter: string) => ` ${letter.toUpperCase()}`)
    .trim();
}

export function SessionsTable({
  emptyMessage,
  loading,
  onOpenGroups,
  onSelectSession,
  selectedSessionId,
  sessions,
}: SessionsTableProps) {
  const tableMessage = loading && sessions.length === 0
    ? "Reloading sessions…"
    : sessions.length === 0
      ? emptyMessage
      : null;

  return (
    <DataTableScroll
      busy={loading}
      className="sessions-table-scroll"
      updating={loading && sessions.length > 0}
    >
      <DataTable caption="WA Runtime sessions" className="sessions-table">
        <colgroup>
          <col className="sessions-column-name" />
          <col className="sessions-column-runtime" />
          <col className="sessions-column-engine" />
          <col className="sessions-column-synced" />
          <col className="sessions-column-workspace" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Session</th>
            <th className="data-cell-status" scope="col">Runtime status</th>
            <th className="data-cell-status" scope="col">Engine</th>
            <th className="data-column-time" scope="col">Last data sync</th>
            <th className="data-align-end" scope="col">Workspace</th>
          </tr>
        </thead>
        <tbody>
          {tableMessage ? (
            <tr><DataTableEmptyCell colSpan={5}>{tableMessage}</DataTableEmptyCell></tr>
          ) : sessions.map((session) => (
            <tr data-selected={session.id === selectedSessionId || undefined} key={session.id}>
              <td className="data-cell-primary">
                <div className="stack stack-xs">
                  <strong className="data-primary-text" title={session.name}>{session.name}</strong>
                  <span className="data-secondary-text" title={`Session ID: ${session.id}`}>
                    {sessionIdentityLabel(session)}
                  </span>
                </div>
              </td>
              <td className="data-cell-status">
                <Badge tone={statusTone(session.status)} variant="status">{statusLabel(session.status)}</Badge>
              </td>
              <td className="data-cell-status">
                <Badge tone={session.engineLoaded ? "success" : "warning"} variant="status">
                  {session.engineLoaded ? "Loaded" : "Not loaded"}
                </Badge>
              </td>
              <td className="data-cell-time">
                <DateTime fallback="Not synced" relativeStyle="compact" value={session.syncedAt} variant="relative" />
              </td>
              <td className="data-cell-action">
                {!session.syncedAt && onOpenGroups ? (
                  <Button
                    onClick={() => {
                      onSelectSession(session.id);
                      onOpenGroups();
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    Open Groups
                  </Button>
                ) : session.id === selectedSessionId ? (
                  <Badge tone="neutral">Selected</Badge>
                ) : (
                  <Button onClick={() => onSelectSession(session.id)} size="sm" variant="ghost">
                    Use session
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </DataTable>
    </DataTableScroll>
  );
}
