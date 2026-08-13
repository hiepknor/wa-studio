import { useEffect, useRef, useState } from "react";

import { useRuntimeConnection } from "@/app/RuntimeConnectionContext";
import type { RuntimeSyncRun } from "@/shared/api/runtime-client";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StatusIndicator, type StatusTone } from "@/shared/ui/StatusIndicator";
import { TextField } from "@/shared/ui/TextField";

function statusTone(status: string): StatusTone {
  if (status === "ready") return "success";
  if (status === "failed" || status === "disconnected") return "danger";
  if (status === "initializing" || status === "authenticating") return "warning";
  return "neutral";
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function requireConnectedRuntime(
  runtime: ReturnType<typeof useRuntimeConnection>["connected"],
): NonNullable<ReturnType<typeof useRuntimeConnection>["connected"]> {
  if (!runtime) throw new Error("SessionsScreen requires a Runtime connection");
  return runtime;
}

export function SessionsScreen() {
  const {
    connected,
    refreshSessions,
    selectedSessionId,
    selectSession,
  } = useRuntimeConnection();
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [syncRun, setSyncRun] = useState<RuntimeSyncRun | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [startingSync, setStartingSync] = useState(false);
  const syncRequestRevision = useRef(0);

  const runtime = requireConnectedRuntime(connected);
  const runtimeApi = runtime.api;
  const sessions = runtime.sessions;

  const selectedSession =
    sessions.find((session) => session.id === selectedSessionId) ?? null;
  const syncInProgress =
    startingSync || syncRun?.status === "PENDING" || syncRun?.status === "RUNNING";
  const syncButtonLabel = startingSync
    ? "Starting full sync"
    : syncInProgress
      ? "Sync in progress"
      : "Sync session";
  const filteredSessions = sessions.filter((session) => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return true;
    return [session.name, session.phone, session.pushName, session.status]
      .filter(Boolean)
      .some((value) => value?.toLocaleLowerCase().includes(query));
  });

  async function handleRefresh() {
    setRefreshing(true);
    setSessionsError(null);
    try {
      await refreshSessions();
    } catch (error) {
      setSessionsError(error instanceof Error ? error.message : "Could not reload sessions.");
    } finally {
      setRefreshing(false);
    }
  }

  async function handleSync() {
    if (!selectedSession || syncInProgress) return;
    const sessionId = selectedSession.id;
    const revision = ++syncRequestRevision.current;
    setStartingSync(true);
    setSyncError(null);
    try {
      const nextRun = await runtimeApi.requestSessionSync(sessionId);
      if (revision === syncRequestRevision.current) setSyncRun(nextRun);
    } catch (error) {
      if (revision === syncRequestRevision.current) {
        setSyncError(error instanceof Error ? error.message : "Could not start session sync.");
      }
    } finally {
      if (revision === syncRequestRevision.current) setStartingSync(false);
    }
  }

  useEffect(() => {
    syncRequestRevision.current += 1;
    setStartingSync(false);
    setSyncRun(null);
    setSyncError(null);
  }, [selectedSessionId]);

  useEffect(() => {
    if (!syncRun || (syncRun.status !== "PENDING" && syncRun.status !== "RUNNING")) return;
    let active = true;
    const timeout = window.setTimeout(async () => {
      try {
        const next = await runtimeApi.getSessionSyncRun(syncRun.sessionId, syncRun.id);
        if (!active) return;
        setSyncRun(next);
        if (next.status === "COMPLETED") {
          try {
            await refreshSessions();
          } catch (error) {
            if (active) {
              setSessionsError(
                error instanceof Error ? error.message : "Could not reload sessions.",
              );
            }
          }
        }
        if (next.status === "FAILED") setSyncError(next.error ?? "Session sync failed.");
      } catch (error) {
        if (active) setSyncError(error instanceof Error ? error.message : "Could not read sync progress.");
      }
    }, 1_000);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [refreshSessions, runtimeApi, syncRun]);

  return (
    <div className="stack stack-lg">
      <PageHeader
        actions={(
          <Button
            aria-label={syncButtonLabel}
            className="sessions-sync-button"
            disabled={!selectedSession || selectedSession.status !== "ready" || syncInProgress}
            icon="refresh"
            loading={syncInProgress}
            onClick={handleSync}
            variant="primary"
          >
            Sync session
          </Button>
        )}
        description="Select the Gateway session used by groups and campaigns."
        title="Sessions"
        titleId="sessions-title"
      />

      {syncError && (
        <InlineAlert title="Session sync failed">{syncError}</InlineAlert>
      )}
      {syncRun && !syncError && (
        <div className="stack stack-xs">
          <progress
            aria-label={`Session sync: ${syncRun.status.toLocaleLowerCase()}`}
            aria-valuenow={syncRun.status === "COMPLETED" ? 100 : undefined}
            {...(syncRun.status === "COMPLETED" ? { value: 100, max: 100 } : {})}
          />
          <span className="muted-copy">
            {syncRun.groupsSynced} groups · {syncRun.membersSynced} members
          </span>
        </div>
      )}

      <div className="data-table-container">
        <div className="data-table-toolbar">
          <TextField
            containerClassName="session-search"
            icon="search"
            id="session-search"
            label="Search sessions"
            labelHidden
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder="Search sessions"
            size="sm"
            type="search"
            value={search}
          />
          <Button
            aria-label={refreshing ? "Reloading sessions" : "Reload sessions"}
            className="sessions-refresh-button"
            icon="refresh"
            loading={refreshing}
            onClick={handleRefresh}
          >
            Reload
          </Button>
        </div>

        {sessionsError && (
          <InlineAlert
            action={<Button onClick={handleRefresh} size="sm">Retry</Button>}
            className="data-table-error"
            title="Could not reload sessions"
          >
            {sessionsError}
          </InlineAlert>
        )}

        <div className="data-table-scroll">
          <table>
            <caption>WA Runtime sessions</caption>
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Status</th>
                <th scope="col">Engine</th>
                <th scope="col">WA Runtime sync</th>
                <th className="align-end" scope="col">Active session</th>
              </tr>
            </thead>
            <tbody>
              {filteredSessions.length === 0 ? (
                <tr><td className="data-table-empty" colSpan={5}>No allowlisted sessions were returned by WA Runtime.</td></tr>
              ) : filteredSessions.map((session) => (
                <tr data-selected={session.id === selectedSessionId || undefined} key={session.id}>
                  <td className="data-cell-primary">
                    <div className="stack stack-xs">
                      <strong className="data-primary-text" title={session.name}>
                        {session.name}
                      </strong>
                      <span
                        className="data-secondary-text"
                        title={session.pushName ?? session.phone ?? "No profile"}
                      >
                        {session.pushName ?? session.phone ?? "No profile"}
                      </span>
                    </div>
                  </td>
                  <td className="data-cell-status">
                    <StatusIndicator glow tone={statusTone(session.status)}>
                      {session.status}
                    </StatusIndicator>
                  </td>
                  <td className="data-cell-status">
                    <Badge tone={session.engineLoaded ? "success" : "warning"}>
                      {session.engineLoaded ? "Loaded" : "Not loaded"}
                    </Badge>
                  </td>
                  <td
                    className="data-cell-time"
                    title={session.syncedAt ? formatDate(session.syncedAt) : undefined}
                  >
                    {formatDate(session.syncedAt)}
                  </td>
                  <td className="data-cell-action">
                    {session.id === selectedSessionId ? (
                      <Badge tone="success">Selected</Badge>
                    ) : (
                      <Button
                        onClick={() => selectSession(session.id)}
                        size="sm"
                        variant="ghost"
                      >
                        Use session
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
