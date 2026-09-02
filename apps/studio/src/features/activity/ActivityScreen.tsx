import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRuntimeConnection } from "@/app/RuntimeConnectionContext";
import type { RuntimeActivityEvent } from "@/shared/api/runtime-client";
import { userFacingErrorMessage } from "@/shared/errors/error-message";
import { useLatestRequest } from "@/shared/hooks/useLatestRequest";
import { useRuntimeResourceRevision } from "@/shared/server-state/runtime-invalidation";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { DataTableFrame, DescriptionList, EmptyState } from "@/shared/ui/Composition";
import { DateTime } from "@/shared/ui/DateTime";
import {
  InspectorDisclosure,
  InspectorDrawer,
  InspectorSection,
} from "@/shared/ui/InspectorDrawer";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { PageHeader } from "@/shared/ui/PageHeader";
import {
  ActivityToolbar,
  activityTimeRangeStart,
  initialActivityListState,
  type ActivityListState,
} from "./ActivityToolbar";
import { ActivityTable } from "./ActivityTable";
import {
  activityCategoryLabel,
  activityMetadataLabel,
  activityMetadataValue,
  activityOriginLabel,
  activitySeverityLabel,
  activitySubjectTypeLabel,
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
  const [selectedEventSnapshot, setSelectedEventSnapshot] = useState<RuntimeActivityEvent | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const detailTriggerRef = useRef<HTMLButtonElement>(null);
  const initialEventIdRef = useRef(initialEventId);
  const activeReadRef = useRef<"append" | "background" | "foreground" | null>(null);
  const loadedOlderRef = useRef(loadedOlder);
  const observedActivityRevisionRef = useRef(activityResourceRevision);
  const sessionRef = useRef(selectedSessionId);
  const activityRead = useLatestRequest();
  const activityDetailRead = useLatestRequest();
  loadedOlderRef.current = loadedOlder;

  const selectedEvent = useMemo(
    () => events.find((event) => event.id === selectedEventId)
      ?? (selectedEventSnapshot?.id === selectedEventId ? selectedEventSnapshot : null),
    [events, selectedEventId, selectedEventSnapshot],
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
      const from = activityTimeRangeStart(state.timeRange);
      const result = await api.listActivity({
        sessionId: selectedSessionId,
        limit: 50,
        query: state.query,
        categories: state.categories,
        severities: state.severities,
        ...(from ? { from } : {}),
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
  }, [activityRead, api, selectedSessionId, state.categories, state.query, state.severities, state.timeRange]);

  const loadSelectedEvent = useCallback(async (eventId: string) => {
    if (!selectedSessionId) return;
    const signal = activityDetailRead.begin();
    setDetailLoading(true);
    setDetailError(null);
    try {
      const event = await api.getActivityEvent(selectedSessionId, eventId, { signal });
      if (!activityDetailRead.isCurrent(signal)) return;
      setSelectedEventSnapshot(event);
    } catch (loadError) {
      if (!activityDetailRead.isCurrent(signal)) return;
      setDetailError(userFacingErrorMessage(loadError, "Could not load this activity event."));
    } finally {
      const current = activityDetailRead.isCurrent(signal);
      activityDetailRead.complete(signal);
      if (current) setDetailLoading(false);
    }
  }, [activityDetailRead, api, selectedSessionId]);

  useEffect(() => {
    if (sessionRef.current === selectedSessionId) return;
    sessionRef.current = selectedSessionId;
    activityRead.cancel();
    activityDetailRead.cancel();
    requestRef.current += 1;
    activeReadRef.current = null;
    setEvents([]);
    setSelectedEventId(null);
    setSelectedEventSnapshot(null);
    setDetailLoading(false);
    setDetailError(null);
    setNextCursor(null);
    setRetentionDays(null);
    setLoading(false);
    setLoadingOlder(false);
    setLoadedOlder(false);
    setError(null);
    setFiltersOpen(false);
    setState(initialActivityListState());
    onEventSelectionChange?.(null);
  }, [activityDetailRead, activityRead, onEventSelectionChange, selectedSessionId]);

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
    if (initialEventIdRef.current === initialEventId) return;
    initialEventIdRef.current = initialEventId;
    activityDetailRead.cancel();
    setSelectedEventId(initialEventId);
    setSelectedEventSnapshot((current) => current?.id === initialEventId ? current : null);
    setDetailLoading(false);
    setDetailError(null);
  }, [activityDetailRead, initialEventId]);

  useEffect(() => {
    if (!selectedEventId || selectedEvent || detailLoading || detailError) return;
    void loadSelectedEvent(selectedEventId);
  }, [detailError, detailLoading, loadSelectedEvent, selectedEvent, selectedEventId]);

  function selectEvent(event: RuntimeActivityEvent, trigger: HTMLButtonElement) {
    activityDetailRead.cancel();
    detailTriggerRef.current = trigger;
    setSelectedEventId(event.id);
    setSelectedEventSnapshot(event);
    setDetailLoading(false);
    setDetailError(null);
    onEventSelectionChange?.(event.id);
  }

  function closeInspector() {
    activityDetailRead.cancel();
    setSelectedEventId(null);
    setSelectedEventSnapshot(null);
    setDetailLoading(false);
    setDetailError(null);
    onEventSelectionChange?.(null);
    detailTriggerRef.current = null;
  }

  const hasCriteria = Boolean(
    state.query
      || state.categories.length
      || state.severities.length
      || state.timeRange !== "ALL",
  );
  return <div className="activity-screen stack stack-lg">
    <PageHeader description="Review retained operational changes from Studio, Runtime, and the Gateway without exposing raw logs or message bodies." title="Activity" titleId="activity-title" />
    <DataTableFrame className="activity-list-panel data-table-container" label="Operational activity" scroll={false}>
      <ActivityToolbar
        count={events.length}
        filtersOpen={filtersOpen}
        loading={loading}
        setFiltersOpen={setFiltersOpen}
        setState={setState}
        state={state}
      />
      {error && <InlineAlert action={<Button onClick={() => void load()} size="sm">Retry</Button>} title="Could not load activity" variant="flush">{error}</InlineAlert>}
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
    </DataTableFrame>
    <InspectorDrawer
      contentKey={selectedEventId ?? "none"}
      kicker="Activity event"
      meta={selectedEvent ? [
        activityCategoryLabel(selectedEvent.category),
        <DateTime key="occurred" value={selectedEvent.occurredAt} />,
      ] : []}
      onClose={closeInspector}
      open={Boolean(selectedEventId)}
      returnFocusRef={detailTriggerRef}
      size="compact"
      status={selectedEvent ? (
        <Badge tone={activityTone(selectedEvent.severity)} variant="status">
          {activitySeverityLabel(selectedEvent.severity)}
        </Badge>
      ) : undefined}
      title={selectedEvent
        ? activityTitle(selectedEvent)
        : detailError
          ? "Activity event unavailable"
          : "Loading activity event"}
    >
      {selectedEvent
        ? <ActivityInspector event={selectedEvent} onOpenRun={onOpenRun} />
        : detailError
          ? <InlineAlert
              action={selectedEventId ? <Button onClick={() => void loadSelectedEvent(selectedEventId)} size="sm">Retry</Button> : undefined}
              title="Could not load activity event"
            >
              {detailError}
            </InlineAlert>
          : <EmptyState compact icon="refresh" loading title="Loading activity event">
              Reading the retained event from WA Runtime.
            </EmptyState>}
    </InspectorDrawer>
  </div>;
}

function ActivityInspector({
  event,
  onOpenRun,
}: {
  event: RuntimeActivityEvent;
  onOpenRun?: (runId: string) => void;
}) {
  const metadata = Object.entries(event.metadata).sort(([left], [right]) => left.localeCompare(right));
  const related = [
    event.related.campaignId && { id: event.related.campaignId, label: "Campaign", type: "campaign" },
    event.related.runId && { id: event.related.runId, label: "Run", type: "run" },
    event.related.syncRunId && { id: event.related.syncRunId, label: "Sync run", type: "sync-run" },
    event.related.groupId && { id: event.related.groupId, label: "Group", type: "group" },
  ].filter((item): item is { id: string; label: string; type: string } => Boolean(item));

  return <div className="activity-inspector">
    <InspectorSection
      description={activitySubjectTypeLabel(event.subject.type)}
      eyebrow="Subject"
      title={event.subject.labelSnapshot}
      titleId="activity-subject-title"
    >
      <DescriptionList
        ariaLabel="Event subject"
        className="activity-detail-list"
        items={[
          {
            id: "subject-id",
            label: "Subject ID",
            value: <span className="activity-detail-value" title={event.subject.id}>{event.subject.id}</span>,
            valueClassName: "ui-technical-text",
          },
        ]}
      />
    </InspectorSection>
    <InspectorSection
      eyebrow="Evidence"
      title="Event details"
      titleId="activity-event-details-title"
    >
      <DescriptionList
        ariaLabel="Event details"
        className="activity-detail-list"
        items={[
          { id: "type", label: "Type", value: <span className="activity-detail-value" title={event.eventType}>{event.eventType}</span>, valueClassName: "ui-technical-text" },
          { id: "version", label: "Version", value: `v${event.eventVersion}`, valueClassName: "ui-technical-text" },
          { id: "origin", label: "Source", value: activityOriginLabel(event.origin) },
        ]}
      />
    </InspectorSection>
    {related.length > 0 && (
      <InspectorSection
        eyebrow="Context"
        title="Related resources"
        titleId="activity-related-title"
      >
        <ul aria-label="Related resources" className="activity-related-list">
          {related.map((item) => (
            <li key={item.type}>
              <span>
                <strong>{item.label}</strong>
                <code title={item.id}>{item.id}</code>
              </span>
              {item.type === "run" && onOpenRun && (
                <Button onClick={() => onOpenRun(item.id)} size="sm" variant="secondary">
                  Open run
                </Button>
              )}
            </li>
          ))}
        </ul>
      </InspectorSection>
    )}
    <InspectorDisclosure
      description="Event and correlation identifiers."
      title="Technical identifiers"
      titleId="activity-technical-title"
    >
      <DescriptionList
        ariaLabel="Technical event identifiers"
        className="activity-detail-list"
        items={[
          { id: "event-id", label: "Event ID", value: <span className="activity-detail-value" title={event.id}>{event.id}</span>, valueClassName: "ui-technical-text" },
          { id: "correlation", label: "Correlation", value: <span className="activity-detail-value" title={event.correlationId ?? undefined}>{event.correlationId ?? "Not available"}</span>, valueClassName: "ui-technical-text" },
        ]}
      />
    </InspectorDisclosure>
    {metadata.length > 0 && (
      <InspectorDisclosure
        description="Retained non-sensitive operational context."
        title="Allowlisted metadata"
        titleId="activity-metadata-title"
      >
        <DescriptionList
          ariaLabel="Allowlisted metadata"
          className="activity-detail-list"
          items={metadata.map(([key, value]) => ({
            id: key,
            label: <span title={key}>{activityMetadataLabel(key)}</span>,
            value: <span className="activity-detail-value" title={activityMetadataValue(value)}>{activityMetadataValue(value)}</span>,
            valueClassName: "ui-technical-text",
          }))}
        />
      </InspectorDisclosure>
    )}
  </div>;
}
