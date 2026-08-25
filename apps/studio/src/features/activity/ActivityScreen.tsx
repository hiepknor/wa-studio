import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRuntimeConnection } from "@/app/RuntimeConnectionContext";
import type { RuntimeActivityEvent } from "@/shared/api/runtime-client";
import { AppIcon } from "@/shared/ui/AppIcon";
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Could not load operational activity.";
}

export function ActivityScreen({
  initialEventId = null,
  onEventSelectionChange,
  onOpenRun,
}: ActivityScreenProps = {}) {
  const { connected, selectedSessionId } = useRuntimeConnection();
  if (!connected) throw new Error("ActivityScreen requires a Runtime connection");
  const api = connected.api;
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
  const sessionRef = useRef(selectedSessionId);

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
  }: { append?: boolean; background?: boolean; cursor?: string } = {}) => {
    if (!selectedSessionId) return;
    const request = ++requestRef.current;
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
      });
      if (request !== requestRef.current) return;
      setEvents((current) => append
        ? [...current, ...result.data.filter((event) => !current.some((candidate) => candidate.id === event.id))]
        : result.data);
      setNextCursor(result.meta.nextCursor);
      setRetentionDays(result.meta.retentionDays);
      if (append) setLoadedOlder(true);
    } catch (loadError) {
      if (request === requestRef.current) setError(errorMessage(loadError));
    } finally {
      if (request === requestRef.current) {
        setLoading(false);
        setLoadingOlder(false);
      }
    }
  }, [api, selectedSessionId, state.categories, state.query, state.severities]);

  useEffect(() => {
    if (sessionRef.current === selectedSessionId) return;
    sessionRef.current = selectedSessionId;
    setEvents([]);
    setSelectedEventId(null);
    setNextCursor(null);
    setLoadedOlder(false);
    setFiltersOpen(false);
    setState(initialActivityListState());
  }, [selectedSessionId]);

  useEffect(() => {
    setLoadedOlder(false);
    void load();
  }, [load]);

  useEffect(() => {
    if (loadedOlder) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void load({ background: true });
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [load, loadedOlder]);

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
        actions={<Button disabled={loading} icon="refresh" onClick={() => { setLoadedOlder(false); void load(); }} size="sm">Refresh</Button>}
        count={events.length}
        filtersOpen={filtersOpen}
        loading={loading}
        retentionDays={retentionDays}
        setFiltersOpen={setFiltersOpen}
        setState={setState}
        state={state}
      />
      {error && <InlineAlert action={<Button onClick={() => void load()} size="sm">Retry</Button>} className="data-table-error" title="Could not load activity">{error}</InlineAlert>}
      <div className="activity-table-scroll data-table-scroll"><table><caption>Retained operational activity for the active session</caption><thead><tr><th scope="col">Time</th><th scope="col">Event</th><th scope="col">Subject</th><th scope="col">Outcome</th><th aria-label="Open" className="data-column-actions" scope="col" /></tr></thead><tbody>
        {!selectedSessionId ? <tr><td className="data-table-empty" colSpan={5}>Select a session to view activity.</td></tr>
          : loading && !events.length ? <tr><td className="data-table-empty" colSpan={5}>Loading operational activity…</td></tr>
          : !events.length ? <tr><td className="data-table-empty" colSpan={5}>{hasCriteria ? "No activity matches this search or filters." : "No retained operational activity yet."}</td></tr>
          : events.map((event) => <tr data-selected={event.id === selectedEventId || undefined} key={event.id}>
            <td><DateTime value={event.occurredAt} /></td>
            <td className="data-cell-primary"><div className="stack stack-xs"><button className="data-primary-action" onClick={() => selectEvent(event)} type="button">{activityTitle(event)}</button><span className="data-identifier">{event.eventType} · v{event.eventVersion}</span></div></td>
            <td><div className="stack stack-xs"><strong>{event.subject.labelSnapshot}</strong><span className="data-identifier">{event.subject.id}</span></div></td>
            <td><Badge tone={activityTone(event.severity)}>{activitySeverityLabel(event.severity)}</Badge></td>
            <td className="data-cell-action"><button aria-label={`Inspect ${activityTitle(event)}`} className="data-row-action" onClick={() => selectEvent(event)} type="button"><AppIcon name="chevron-right" size="sm" /></button></td>
          </tr>)}
      </tbody></table></div>
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
    <section className="activity-inspector-section"><div className="activity-inspector-badges"><Badge tone="neutral">{activityCategoryLabel(event.category)}</Badge><Badge tone={activityTone(event.severity)}>{activitySeverityLabel(event.severity)}</Badge></div><p>{event.subject.labelSnapshot}</p></section>
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
