import { useMemo, useState } from "react";

import { useRuntimeConnection } from "@/app/RuntimeConnectionContext";
import type { RuntimeSession } from "@/shared/api/runtime-client";
import { AppIcon } from "@/shared/ui/AppIcon";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { DataFilterToolbar } from "@/shared/ui/DataFilterToolbar";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { PageHeader } from "@/shared/ui/PageHeader";
import type { FeedbackTone } from "@/shared/ui/feedback-tone";
import { useToast } from "@/shared/ui/Toast";
import "./sessions.css";

const STATUS_OPTIONS = ["ready", "initializing", "authenticating", "disconnected", "failed"] as const;
type EngineFilter = "loaded" | "not-loaded";
type WorkspaceFilter = "selected" | "not-selected";

function statusTone(status: string): FeedbackTone {
  if (status === "ready") return "success";
  if (status === "failed" || status === "disconnected") return "danger";
  if (status === "initializing" || status === "authenticating") return "warning";
  return "neutral";
}

function statusLabel(status: string): string {
  return status.replace(/(^|[-_])(\w)/g, (_, __, letter: string) => ` ${letter.toUpperCase()}`).trim();
}

function formatDate(value: string | null): string {
  if (!value) return "Not synced";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function whatsappIdentity(session: RuntimeSession): string {
  const parts = [session.pushName?.trim(), session.phone?.trim()].filter(Boolean);
  return parts.length ? parts.join(" · ") : session.id;
}

function toggleValue<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((candidate) => candidate !== value) : [...values, value];
}

interface SessionsScreenProps {
  onOpenGroups?: () => void;
}

export function SessionsScreen({ onOpenGroups }: SessionsScreenProps) {
  const { connected, refreshSessions, selectedSessionId, selectSession } = useRuntimeConnection();
  const toast = useToast();
  if (!connected) throw new Error("SessionsScreen requires a Runtime connection");

  const [search, setSearch] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [engines, setEngines] = useState<EngineFilter[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceFilter[]>([]);
  const [reloading, setReloading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

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

  async function reloadSessions() {
    setReloading(true);
    setSessionsError(null);
    try {
      await refreshSessions();
      toast.notify({ id: "sessions-reload", title: "Sessions reloaded", tone: "success" });
    } catch (error) {
      setSessionsError(error instanceof Error ? error.message : "Could not reload sessions.");
    } finally {
      setReloading(false);
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
          <Button
            aria-label={reloading ? "Reloading sessions" : "Reload sessions"}
            aria-busy={reloading || undefined}
            icon="refresh"
            onClick={() => void reloadSessions()}
          >
            {reloading ? "Reloading…" : "Reload"}
          </Button>
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
          resultSummary={`${filteredSessions.length} of ${connected.sessions.length}${hasCriteria ? " matches" : " sessions"}`}
          searchLabel="Session search"
          searchPlaceholder="Search name, ID, or phone"
          searchValue={search}
        >{(closeFilters) => (
          <section aria-label="Session filters" className="data-filter-panel" id="session-list-filter-panel">
            <header className="data-filter-panel-header">
              <div><strong>Filter sessions</strong><span>{filterCount ? `${filterCount} applied` : "Local filters"}</span></div>
              <button aria-label="Close session filters" className="data-filter-panel-close" onClick={closeFilters} type="button"><AppIcon name="close" size="xs" /></button>
            </header>
            <div className="data-filter-panel-body">
              <fieldset><legend>Runtime status</legend><div className="data-filter-options">
                {STATUS_OPTIONS.map((status) => <label key={status}><input checked={statuses.includes(status)} onChange={() => setStatuses((current) => toggleValue(current, status))} type="checkbox" /><span aria-hidden="true" className="data-filter-check"><AppIcon name="check" size="xs" /></span><span>{statusLabel(status)}</span></label>)}
              </div></fieldset>
              <fieldset><legend>Engine</legend><div className="data-filter-options">
                {([ ["loaded", "Loaded"], ["not-loaded", "Not loaded"] ] as const).map(([value, label]) => <label key={value}><input checked={engines.includes(value)} onChange={() => setEngines((current) => toggleValue(current, value))} type="checkbox" /><span aria-hidden="true" className="data-filter-check"><AppIcon name="check" size="xs" /></span><span>{label}</span></label>)}
              </div></fieldset>
              <fieldset><legend>Workspace</legend><div className="data-filter-options">
                {([ ["selected", "Selected"], ["not-selected", "Not selected"] ] as const).map(([value, label]) => <label key={value}><input checked={workspaces.includes(value)} onChange={() => setWorkspaces((current) => toggleValue(current, value))} type="checkbox" /><span aria-hidden="true" className="data-filter-check"><AppIcon name="check" size="xs" /></span><span>{label}</span></label>)}
              </div></fieldset>
            </div>
            <div className="data-filter-summary"><div className="data-filter-chips">
              {!filterCount && <span className="data-filter-summary-empty">No filters applied</span>}
              {[...statuses.map((value) => ({ key: `status-${value}`, label: statusLabel(value), remove: () => setStatuses((current) => current.filter((item) => item !== value)) })), ...engines.map((value) => ({ key: `engine-${value}`, label: value === "loaded" ? "Loaded" : "Not loaded", remove: () => setEngines((current) => current.filter((item) => item !== value)) })), ...workspaces.map((value) => ({ key: `workspace-${value}`, label: value === "selected" ? "Selected" : "Not selected", remove: () => setWorkspaces((current) => current.filter((item) => item !== value)) }))].map((chip) => <button aria-label={`Remove ${chip.label} filter`} className="data-filter-chip" key={chip.key} onClick={chip.remove} type="button"><span>{chip.label}</span><AppIcon name="close" size="xs" /></button>)}
            </div><Button disabled={!filterCount} onClick={clearFilters} size="sm" variant="ghost">Clear all</Button></div>
          </section>
        )}</DataFilterToolbar>

        {sessionsError && <InlineAlert action={<Button onClick={() => void reloadSessions()} size="sm">Retry</Button>} className="data-table-error" title="Could not reload sessions">{sessionsError}</InlineAlert>}

        <div className="data-table-scroll sessions-table-scroll">
          <table>
            <caption>WA Runtime sessions</caption>
            <thead><tr><th scope="col">Session</th><th scope="col">Runtime status</th><th scope="col">Engine</th><th scope="col">Last data sync</th><th className="align-end" scope="col">Workspace</th></tr></thead>
            <tbody>
              {!connected.sessions.length ? <tr><td className="data-table-empty" colSpan={5}>No allowlisted sessions are available from WA Runtime.</td></tr>
                : !filteredSessions.length ? <tr><td className="data-table-empty" colSpan={5}>No sessions match this search or filters.</td></tr>
                : filteredSessions.map((session: RuntimeSession) => <tr data-selected={session.id === selectedSessionId || undefined} key={session.id}>
                  <td className="data-cell-primary"><div className="stack stack-xs"><strong className="data-primary-text" title={session.name}>{session.name}</strong><span className="data-secondary-text" title={`Session ID: ${session.id}`}>{whatsappIdentity(session)}</span></div></td>
                  <td className="data-cell-status"><Badge tone={statusTone(session.status)}>{statusLabel(session.status)}</Badge></td>
                  <td className="data-cell-status"><Badge tone={session.engineLoaded ? "success" : "warning"}>{session.engineLoaded ? "Loaded" : "Not loaded"}</Badge></td>
                  <td className="data-cell-time" title={session.syncedAt ? formatDate(session.syncedAt) : undefined}>{formatDate(session.syncedAt)}</td>
                  <td className="data-cell-action">
                    {!session.syncedAt && onOpenGroups ? (
                      <Button onClick={() => { selectSession(session.id); onOpenGroups(); }} size="sm" variant="ghost">Open Groups</Button>
                    ) : session.id === selectedSessionId ? (
                      <Badge tone="neutral">Selected</Badge>
                    ) : (
                      <Button onClick={() => selectSession(session.id)} size="sm" variant="ghost">Use session</Button>
                    )}
                  </td>
                </tr>)}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
