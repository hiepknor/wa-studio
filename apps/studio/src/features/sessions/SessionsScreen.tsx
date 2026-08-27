import { useEffect, useMemo, useState } from "react";

import { useRuntimeConnection } from "@/app/RuntimeConnectionContext";
import { userFacingErrorMessage } from "@/shared/errors/error-message";
import { useLatestOperation } from "@/shared/hooks/useLatestOperation";
import { AppIcon } from "@/shared/ui/AppIcon";
import { Button } from "@/shared/ui/Button";
import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";
import { DataFilterToolbar } from "@/shared/ui/DataFilterToolbar";
import { FilterOption } from "@/shared/ui/FilterOption";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { formatListResultSummary } from "@/shared/ui/list-result-summary";
import { PageHeader } from "@/shared/ui/PageHeader";
import { TablePagination } from "@/shared/ui/TablePagination";
import { useToast } from "@/shared/ui/Toast";
import { SessionsTable } from "./SessionsTable";
import "./sessions.css";

const SESSIONS_PAGE_SIZE = 20;
const STATUS_OPTIONS = ["ready", "initializing", "authenticating", "disconnected", "failed"] as const;
type EngineFilter = "loaded" | "not-loaded";
type WorkspaceFilter = "selected" | "not-selected";

function statusLabel(status: string): string {
  return status.replace(/(^|[-_])(\w)/g, (_, __, letter: string) => ` ${letter.toUpperCase()}`).trim();
}

function toggleValue<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((candidate) => candidate !== value) : [...values, value];
}

interface SessionsScreenProps {
  onOpenGroups?: () => void;
}

export function SessionsScreen({ onOpenGroups }: SessionsScreenProps) {
  const { connected, disconnect, refreshSessions, selectedSessionId, selectSession } = useRuntimeConnection();
  const toast = useToast();
  if (!connected) throw new Error("SessionsScreen requires a Runtime connection");

  const [search, setSearch] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [engines, setEngines] = useState<EngineFilter[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceFilter[]>([]);
  const [offset, setOffset] = useState(0);
  const [reloading, setReloading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [disconnectConfirmationOpen, setDisconnectConfirmationOpen] = useState(false);
  const reloadOperation = useLatestOperation();

  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredSessions = useMemo(() => connected.sessions.filter((session) => {
    const matchesSearch = !normalizedSearch || [
      session.name,
      session.id,
      session.phone,
      session.pushName,
      session.status,
    ].filter(Boolean).some((value) => value?.toLocaleLowerCase().includes(normalizedSearch));
    const matchesStatus = !statuses.length || statuses.includes(session.status);
    const matchesEngine = !engines.length
      || engines.includes(session.engineLoaded ? "loaded" : "not-loaded");
    const matchesWorkspace = !workspaces.length
      || workspaces.includes(session.id === selectedSessionId ? "selected" : "not-selected");
    return matchesSearch && matchesStatus && matchesEngine && matchesWorkspace;
  }), [connected.sessions, engines, normalizedSearch, selectedSessionId, statuses, workspaces]);

  const filterCount = statuses.length + engines.length + workspaces.length;
  const hasCriteria = Boolean(normalizedSearch || filterCount);
  const pageSessions = filteredSessions.slice(offset, offset + SESSIONS_PAGE_SIZE);
  const firstItem = filteredSessions.length === 0 ? 0 : offset + 1;
  const lastItem = Math.min(offset + pageSessions.length, filteredSessions.length);

  useEffect(() => {
    setOffset(0);
  }, [engines, normalizedSearch, statuses, workspaces]);

  useEffect(() => {
    if (offset < filteredSessions.length || offset === 0) return;
    setOffset(Math.max(0, Math.floor(Math.max(0, filteredSessions.length - 1) / SESSIONS_PAGE_SIZE) * SESSIONS_PAGE_SIZE));
  }, [filteredSessions.length, offset]);

  async function reloadSessions() {
    if (reloading) return;
    const token = reloadOperation.begin();
    setReloading(true);
    setSessionsError(null);
    try {
      const refreshed = await refreshSessions();
      if (!reloadOperation.isCurrent(token)) return;
      if (refreshed) {
        toast.notify({ id: "sessions-reload", title: "Sessions reloaded", tone: "success" });
      }
    } catch (error) {
      if (reloadOperation.isCurrent(token)) {
        setSessionsError(userFacingErrorMessage(error, "Could not reload sessions."));
      }
    } finally {
      if (reloadOperation.isCurrent(token)) setReloading(false);
    }
  }

  function clearFilters() {
    setStatuses([]);
    setEngines([]);
    setWorkspaces([]);
  }

  return (
    <div className="sessions-screen stack stack-lg">
      <PageHeader
        actions={(
          <div className="sessions-header-actions">
            <Button
              aria-label={reloading ? "Reloading sessions" : "Reload sessions"}
              aria-busy={reloading || undefined}
              disabled={reloading}
              icon="refresh"
              onClick={() => void reloadSessions()}
            >
              {reloading ? "Reloading…" : "Reload"}
            </Button>
            <Button
              aria-label="Disconnect workspace"
              icon="disconnect"
              onClick={() => setDisconnectConfirmationOpen(true)}
              variant="danger"
            >
              Disconnect
            </Button>
          </div>
        )}
        description="Manage available Gateway sessions and choose the workspace context."
        title="Sessions"
        titleId="sessions-title"
      />

      <div className="data-table-container sessions-list-panel">
        <DataFilterToolbar
          filterCount={filterCount}
          filtersOpen={filtersOpen}
          idPrefix="session-list"
          loading={reloading}
          onCloseFilters={() => setFiltersOpen(false)}
          onSearchChange={setSearch}
          onToggleFilters={() => setFiltersOpen((open) => !open)}
          resultSummary={formatListResultSummary({
            firstItem,
            hasCriteria,
            lastItem,
            plural: "sessions",
            singular: "session",
            total: filteredSessions.length,
          })}
          searchLabel="Session search"
          searchPlaceholder="Search name, ID, or phone"
          searchValue={search}
        >{(closeFilters) => (
          <section aria-label="Session filters" className="data-filter-panel" id="session-list-filter-panel">
            <header className="data-filter-panel-header">
              <div><strong>Filter sessions</strong><span>{filterCount ? `${filterCount} applied` : "Local filters"}</span></div>
              <Button aria-label="Close session filters" className="data-filter-panel-close" icon="close" onClick={closeFilters} variant="ghost" />
            </header>
            <div className="data-filter-panel-body">
              <fieldset><legend>Runtime status</legend><div className="data-filter-options">
                {STATUS_OPTIONS.map((status) => <FilterOption checked={statuses.includes(status)} key={status} onChange={() => setStatuses((current) => toggleValue(current, status))}>{statusLabel(status)}</FilterOption>)}
              </div></fieldset>
              <fieldset><legend>Engine</legend><div className="data-filter-options">
                {([ ["loaded", "Loaded"], ["not-loaded", "Not loaded"] ] as const).map(([value, label]) => <FilterOption checked={engines.includes(value)} key={value} onChange={() => setEngines((current) => toggleValue(current, value))}>{label}</FilterOption>)}
              </div></fieldset>
              <fieldset><legend>Workspace</legend><div className="data-filter-options">
                {([ ["selected", "Selected"], ["not-selected", "Not selected"] ] as const).map(([value, label]) => <FilterOption checked={workspaces.includes(value)} key={value} onChange={() => setWorkspaces((current) => toggleValue(current, value))}>{label}</FilterOption>)}
              </div></fieldset>
            </div>
            <div className="data-filter-summary"><div className="data-filter-chips">
              {!filterCount && <span className="data-filter-summary-empty">No filters applied</span>}
              {[...statuses.map((value) => ({ key: `status-${value}`, label: statusLabel(value), remove: () => setStatuses((current) => current.filter((item) => item !== value)) })), ...engines.map((value) => ({ key: `engine-${value}`, label: value === "loaded" ? "Loaded" : "Not loaded", remove: () => setEngines((current) => current.filter((item) => item !== value)) })), ...workspaces.map((value) => ({ key: `workspace-${value}`, label: value === "selected" ? "Selected" : "Not selected", remove: () => setWorkspaces((current) => current.filter((item) => item !== value)) }))].map((chip) => <button aria-label={`Remove ${chip.label} filter`} className="data-filter-chip" key={chip.key} onClick={chip.remove} type="button"><span>{chip.label}</span><AppIcon name="close" size="xs" /></button>)}
            </div><Button disabled={!filterCount} onClick={clearFilters} size="sm" variant="ghost">Clear all</Button></div>
          </section>
        )}</DataFilterToolbar>

        {sessionsError && <InlineAlert action={<Button onClick={() => void reloadSessions()} size="sm">Retry</Button>} className="data-table-error" title="Could not reload sessions">{sessionsError}</InlineAlert>}

        <SessionsTable
          emptyMessage={!connected.sessions.length
            ? "No allowlisted sessions are available from WA Runtime."
            : "No sessions match this search or filters."}
          loading={reloading}
          onOpenGroups={onOpenGroups}
          onSelectSession={selectSession}
          selectedSessionId={selectedSessionId}
          sessions={pageSessions}
        />
        <TablePagination
          limit={SESSIONS_PAGE_SIZE}
          loading={reloading}
          offset={offset}
          onOffsetChange={setOffset}
          total={filteredSessions.length}
        />
      </div>
      <ConfirmationDialog
        body="WA Studio will detach this window from the local workspace. Runtime and active syncs continue in the background."
        confirmLabel="Disconnect"
        confirmVariant="danger"
        onCancel={() => setDisconnectConfirmationOpen(false)}
        onConfirm={() => {
          setDisconnectConfirmationOpen(false);
          disconnect();
        }}
        open={disconnectConfirmationOpen}
        title="Disconnect workspace?"
      />
    </div>
  );
}
