import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRuntimeConnection } from "@/app/RuntimeConnectionContext";
import type { RuntimeActivityEvent } from "@/shared/api/runtime-client";
import { userFacingErrorMessage } from "@/shared/errors/error-message";
import { useLatestRequest } from "@/shared/hooks/useLatestRequest";
import { useRuntimeResourceRevision } from "@/shared/server-state/runtime-invalidation";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { DateTime } from "@/shared/ui/DateTime";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { PageHeader } from "@/shared/ui/PageHeader";
import { WorkspaceDrawer } from "@/shared/ui/WorkspaceDrawer";
import {
  ActivityToolbar,
  initialActivityListState,
  type ActivityListState,
} from "./ActivityToolbar";
import { ActivityTable } from "./ActivityTable";
import {
  activityCategoryLabel,
  activitySeverityLabel,
  activityTitle,
  activityTone,
} from "./activity-presentation";
import "./activity.css";

interface ActivityScreenProps {
  initialEventId?: string | null;
  onEventSelectionChange?: (eventId: string | null) => void;
  onOpenRun?: (runId: string) => void;
}

export function ActivityScreen({
  initialEventId = null,
  onEventSelectionChange,
  onOpenRun,
}: ActivityScreenProps = {}) {
  const { connected, selectedSessionId } = useRuntimeConnection();
  if (!connected) throw new Error("ActivityScreen requires a Runtime connection");
  const api = connected.api;
  const activityResourceRevision = useRuntimeResourceRevision(["activity"], selectedSessionId);
  const [state, setState] = useState<ActivityListState>(initialActivityListState);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [events, setEvents] = useState<RuntimeActivityEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadedOlder, setLoadedOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(initialEventId);
  const requestRef = useRef(0);
  const activeReadRef = useRef<"append" | "background" | "foreground" | null>(null);
  const loadedOlderRef = useRef(loadedOlder);
  const observedActivityRevisionRef = useRef(activityResourceRevision);
  const sessionRef = useRef(selectedSessionId);
  const activityRead = useLatestRequest();
  loadedOlderRef.current = loadedOlder;

  const selectedEvent = useMemo(
    () => events.find((event) => event.id === selectedEventId) ?? null,
    [events, selectedEventId],
  );

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const query = state.inputQuery.trim();
      setState((current) => current.query === query ? current : { ...current, query });
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [state.inputQuery]);

  const load = useCallback(async ({
    append = false,
    background = false,
    cursor,
    preserveHistory = false,
  }: {
    append?: boolean;
    background?: boolean;
    cursor?: string;
    preserveHistory?: boolean;
  } = {}) => {
    if (!selectedSessionId) return;
    if (background && activeReadRef.current) return;
    const request = ++requestRef.current;
    const signal = activityRead.begin();
    activeReadRef.current = append ? "append" : background ? "background" : "foreground";
    if (append) setLoadingOlder(true);
    else if (!background) setLoading(true);
    setError(null);
    try {
      const result = await api.listActivity({
        sessionId: selectedSessionId,
        limit: 50,
        query: state.query,
        categories: state.categories,
        severities: state.severities,
        cursor,
      }, { signal });
      if (request !== requestRef.current || !activityRead.isCurrent(signal)) return;
      setEvents((current) => append
        ? [...current, ...result.data.filter((event) => !current.some((candidate) => candidate.id === event.id))]
        : preserveHistory
          ? [
            ...result.data,
            ...current.filter((event) => !result.data.some((candidate) => candidate.id === event.id)),
          ]
          : result.data);
      if (!preserveHistory) setNextCursor(result.meta.nextCursor);
      setRetentionDays(result.meta.retentionDays);
      if (append) setLoadedOlder(true);
    } catch (loadError) {
      if (!activityRead.isCurrent(signal)) return;
      if (request === requestRef.current) {
        setError(userFacingErrorMessage(loadError, "Could not load operational activity."));
      }
    } finally {
      const current = request === requestRef.current && activityRead.isCurrent(signal);
      if (current) activeReadRef.current = null;
      activityRead.complete(signal);
      if (current) {
        setLoading(false);
        setLoadingOlder(false);
      }
    }
  }, [activityRead, api, selectedSessionId, state.categories, state.query, state.severities]);

  useEffect(() => {
    if (sessionRef.current === selectedSessionId) return;
    sessionRef.current = selectedSessionId;
    activityRead.cancel();
    requestRef.current += 1;
    activeReadRef.current = null;
    setEvents([]);
    setSelectedEventId(null);
    setNextCursor(null);
    setRetentionDays(null);
    setLoading(false);
    setLoadingOlder(false);
    setLoadedOlder(false);
    setError(null);
    setFiltersOpen(false);
    setState(initialActivityListState());
  }, [activityRead, selectedSessionId]);

  useEffect(() => {
    setLoadedOlder(false);
    void load();
  }, [load]);

  useEffect(() => {
    if (observedActivityRevisionRef.current === activityResourceRevision) return;
    observedActivityRevisionRef.current = activityResourceRevision;
    let disposed = false;
    let timeout: number | undefined;
    const reconcile = () => {
      if (disposed) return;
      if (activeReadRef.current) {
        timeout = window.setTimeout(reconcile, 100);
        return;
      }
      void load({ background: true, preserveHistory: loadedOlderRef.current });
    };
    reconcile();
    return () => {
      disposed = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [activityResourceRevision, load]);

  useEffect(() => {
    if (initialEventId) setSelectedEventId(initialEventId);
  }, [initialEventId]);

  function selectEvent(event: RuntimeActivityEvent) {
    setSelectedEventId(event.id);
    onEventSelectionChange?.(event.id);
  }

  function closeInspector() {
    setSelectedEventId(null);
    onEventSelectionChange?.(null);
  }

  const hasCriteria = Boolean(state.query || state.categories.length || state.severities.length);
  return <div className="activity-screen stack stack-lg">
    <PageHeader description="Review retained operational changes from Studio, Runtime, and the Gateway without exposing raw logs or message bodies." title="Activity" titleId="activity-title" />
    <div className="activity-list-panel data-table-container">
      <ActivityToolbar
        count={events.length}
        filtersOpen={filtersOpen}
        loading={loading}
        setFiltersOpen={setFiltersOpen}
        setState={setState}
        state={state}
      />
      {error && <InlineAlert action={<Button onClick={() => void load()} size="sm">Retry</Button>} className="data-table-error" title="Could not load activity">{error}</InlineAlert>}
      <ActivityTable
        activeEventId={selectedEventId}
        emptyMessage={!selectedSessionId
          ? "Select a session to view activity."
          : hasCriteria
            ? "No activity matches this search or filters."
            : "No retained operational activity yet."}
        events={events}
        loading={loading}
        onInspect={selectEvent}
      />
      <div className="activity-load-more"><span>{retentionDays ? `Activity is retained for ${retentionDays} days.` : "Retention is Runtime controlled."}</span>{nextCursor && <Button disabled={loadingOlder} loading={loadingOlder} onClick={() => void load({ append: true, cursor: nextCursor })}>Load older</Button>}</div>
    </div>
    <WorkspaceDrawer
      contentKey={selectedEventId ?? "none"}
      description={selectedEvent ? activityCategoryLabel(selectedEvent.category) : "Operational event"}
      eyebrow={selectedEvent ? <DateTime value={selectedEvent.occurredAt} /> : "Activity inspector"}
      footer={selectedEvent?.related.runId && onOpenRun ? <div className="activity-inspector-footer"><span>Related durable execution</span><Button onClick={() => onOpenRun(selectedEvent.related.runId!)} variant="primary">Open run</Button></div> : undefined}
      onClose={closeInspector}
      open={Boolean(selectedEvent)}
      title={selectedEvent ? activityTitle(selectedEvent) : "Activity inspector"}
    >
      {selectedEvent && <ActivityInspector event={selectedEvent} />}
    </WorkspaceDrawer>
  </div>;
}

function ActivityInspector({ event }: { event: RuntimeActivityEvent }) {
  const metadata = Object.entries(event.metadata);
  return <div className="activity-inspector stack stack-lg">
    <section className="activity-inspector-section"><div className="activity-inspector-badges"><Badge tone="neutral">{activityCategoryLabel(event.category)}</Badge><Badge tone={activityTone(event.severity)} variant="status">{activitySeverityLabel(event.severity)}</Badge></div><p>{event.subject.labelSnapshot}</p></section>
    <section className="activity-inspector-section"><h3>Event</h3><dl className="activity-detail-list">
      <div><dt>Type</dt><dd className="data-identifier">{event.eventType}</dd></div>
      <div><dt>Occurred</dt><dd><DateTime value={event.occurredAt} /></dd></div>
      <div><dt>Origin</dt><dd>{event.origin.charAt(0) + event.origin.slice(1).toLocaleLowerCase()}</dd></div>
      <div><dt>Event ID</dt><dd className="data-identifier">{event.id}</dd></div>
      <div><dt>Correlation</dt><dd className="data-identifier">{event.correlationId ?? "Not available"}</dd></div>
    </dl></section>
    <section className="activity-inspector-section"><h3>Subject</h3><dl className="activity-detail-list">
      <div><dt>Type</dt><dd>{event.subject.type}</dd></div><div><dt>ID</dt><dd className="data-identifier">{event.subject.id}</dd></div>
      {event.related.campaignId && <div><dt>Campaign</dt><dd className="data-identifier">{event.related.campaignId}</dd></div>}
      {event.related.runId && <div><dt>Run</dt><dd className="data-identifier">{event.related.runId}</dd></div>}
      {event.related.syncRunId && <div><dt>Sync run</dt><dd className="data-identifier">{event.related.syncRunId}</dd></div>}
      {event.related.groupId && <div><dt>Group</dt><dd className="data-identifier">{event.related.groupId}</dd></div>}
    </dl></section>
    {metadata.length > 0 && <section className="activity-inspector-section"><h3>Allowlisted metadata</h3><dl className="activity-detail-list">{metadata.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd></div>)}</dl></section>}
  </div>;
}
