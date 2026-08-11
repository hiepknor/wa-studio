import {
  Alert,
  Badge,
  Button,
  DataTable,
  DataTableToolbar,
  Inline,
  Progress,
  Stack,
  StatusMark,
  type DataTableColumn,
} from "@hiepknor/ink-react";
import { useEffect, useMemo, useState } from "react";

import { useRuntimeConnection } from "@/app/RuntimeConnectionContext";
import type { RuntimeSession, RuntimeSyncRun } from "@/shared/api/runtime-client";

function statusTone(status: string): "ok" | "warning" | "danger" | "neutral" {
  if (status === "ready") return "ok";
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

  const runtime = requireConnectedRuntime(connected);
  const runtimeApi = runtime.api;
  const sessions = runtime.sessions;

  const selectedSession =
    sessions.find((session) => session.id === selectedSessionId) ?? null;
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
      setSessionsError(error instanceof Error ? error.message : "Could not refresh sessions.");
    } finally {
      setRefreshing(false);
    }
  }

  async function handleSync() {
    if (!selectedSession) return;
    setStartingSync(true);
    setSyncError(null);
    try {
      setSyncRun(await runtimeApi.requestSessionSync(selectedSession.id));
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "Could not start session sync.");
    } finally {
      setStartingSync(false);
    }
  }

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
                error instanceof Error ? error.message : "Could not refresh sessions.",
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

  const columns = useMemo<DataTableColumn<RuntimeSession>[]>(
    () => [
      {
        id: "session",
        header: "Session",
        cell: (session) => (
          <Stack gap="xs">
            <strong>{session.name}</strong>
            <span className="muted-copy">{session.pushName ?? session.phone ?? "No profile"}</span>
          </Stack>
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: (session) => (
          <StatusMark label={session.status} tone={statusTone(session.status)} />
        ),
      },
      {
        id: "engine",
        header: "Engine",
        cell: (session) => (
          <Badge tone={session.engineLoaded ? "ok" : "warning"}>
            {session.engineLoaded ? "Loaded" : "Not loaded"}
          </Badge>
        ),
      },
      {
        id: "synced",
        header: "Runtime sync",
        cell: (session) => formatDate(session.syncedAt),
      },
      {
        id: "action",
        header: "Active session",
        align: "end",
        cell: (session) =>
          session.id === selectedSessionId ? (
            <Badge tone="ok">Selected</Badge>
          ) : (
            <Button onClick={() => selectSession(session.id)} variant="quiet">
              Use session
            </Button>
          ),
      },
    ],
    [selectSession, selectedSessionId],
  );

  return (
    <Stack gap="lg">
      <Inline align="center" justify="between" wrap>
        <div>
          <h2 className="workspace-page-title" id="sessions-title">Sessions</h2>
          <p className="muted-copy">Select the Gateway session used by groups and campaigns.</p>
        </div>
        <Button
          disabled={!selectedSession || selectedSession.status !== "ready"}
          loading={startingSync}
          loadingLabel="Starting full sync"
          onClick={handleSync}
          variant="primary"
        >
          Sync session
        </Button>
      </Inline>

      {syncError && <Alert live="assertive" title="Session sync failed" tone="danger">{syncError}</Alert>}
      {syncRun && !syncError && (
        <Stack gap="xs">
          <Progress
            label={`Session sync: ${syncRun.status.toLocaleLowerCase()}`}
            value={syncRun.status === "COMPLETED" ? 100 : undefined}
          />
          <span className="muted-copy">
            {syncRun.groupsSynced} groups · {syncRun.membersSynced} members
          </span>
        </Stack>
      )}

      <DataTable
        caption="Automation Runtime sessions"
        columns={columns}
        empty="No allowlisted sessions were returned by Runtime."
        error={sessionsError ?? undefined}
        errorActions={<Button onClick={handleRefresh}>Retry</Button>}
        errorMode="stale"
        errorTitle="Could not refresh sessions"
        getRowId={(session) => session.id}
        rows={filteredSessions}
        toolbar={
          <DataTableToolbar
            actions={
              <Button loading={refreshing} loadingLabel="Refreshing sessions" onClick={handleRefresh}>
                Refresh
              </Button>
            }
            onSearchChange={setSearch}
            searchLabel="Search sessions"
            searchPlaceholder="Search sessions"
            searchValue={search}
          />
        }
      />
    </Stack>
  );
}
