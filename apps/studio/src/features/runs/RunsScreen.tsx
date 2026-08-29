import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRuntimeConnection } from "@/app/RuntimeConnectionContext";
import type {
  RuntimeCampaignDeliveryPage,
  RuntimeCampaignDeliveryStatus,
  RuntimeCampaignRun,
  RuntimeCampaignRunSummary,
  RuntimeCampaignRunSummaryPage,
} from "@/shared/api/runtime-client";
import {
  isUnknownMutationOutcome,
  unknownMutationOutcomeMessage,
} from "@/shared/api/runtime-mutation";
import { userFacingErrorMessage } from "@/shared/errors/error-message";
import { useLatestRequest } from "@/shared/hooks/useLatestRequest";
import { useSingleFlightOperation } from "@/shared/hooks/useSingleFlightOperation";
import {
  useRuntimeInvalidation,
  useRuntimeResourceRevision,
} from "@/shared/server-state/runtime-invalidation";
import { reconciledPageOffset } from "@/shared/server-state/server-page";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";
import { DateTime } from "@/shared/ui/DateTime";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { PageHeader } from "@/shared/ui/PageHeader";
import { SearchField } from "@/shared/ui/SearchField";
import { SearchSelect } from "@/shared/ui/SearchSelect";
import { TablePagination } from "@/shared/ui/TablePagination";
import { Tabs } from "@/shared/ui/Tabs";
import { WorkspaceDrawer } from "@/shared/ui/WorkspaceDrawer";
import { RunsListToolbar } from "./RunsListToolbar";
import { RunsTable } from "./RunsTable";
import {
  deliveryTone,
  resolvedTargets,
  RUN_TERMINAL_STATUSES,
  runStatusLabel,
  runTone,
  shortId,
} from "./run-presentation";
import {
  initialRunsListState,
  RUNS_PAGE_SIZE,
  type RunsListState,
} from "./runs-list-state";
import "./runs.css";

type InspectorTab = "overview" | "deliveries";
type RunAction = "pause" | "resume" | "cancel";
type DeliveryFilter = RuntimeCampaignDeliveryStatus | "ALL";

const DELIVERY_STATUSES: RuntimeCampaignDeliveryStatus[] = [
  "PENDING", "MATERIALIZED", "PROCESSING", "DRY_RUN_COMPLETED", "ACCEPTED",
  "SENT", "DELIVERED", "READ", "FAILED", "UNKNOWN",
  "BLOCKED_CAPABILITY_CHANGED", "CANCELLED",
];

function deliveryStatusGroup(status: RuntimeCampaignDeliveryStatus): string {
  if (["PENDING", "MATERIALIZED", "PROCESSING"].includes(status)) return "Queue";
  if (["DRY_RUN_COMPLETED", "ACCEPTED", "SENT", "DELIVERED", "READ"].includes(status)) {
    return "Successful";
  }
  return "Exceptions";
}

interface RunsScreenProps {
  initialRunId?: string | null;
  onOpenCampaigns?: () => void;
  onRunSelectionChange?: (runId: string | null) => void;
}

export function RunsScreen({
  initialRunId = null,
  onOpenCampaigns,
  onRunSelectionChange,
}: RunsScreenProps = {}) {
  const { connected, selectedSessionId } = useRuntimeConnection();
  if (!connected) throw new Error("RunsScreen requires a Runtime connection");
  const api = connected.api;
  const { invalidate } = useRuntimeInvalidation();
  const runsResourceRevision = useRuntimeResourceRevision(["runs"], selectedSessionId);
  const deliveriesResourceRevision = useRuntimeResourceRevision(["deliveries"], selectedSessionId);
  const [listState, setListState] = useState<RunsListState>(initialRunsListState);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState<RuntimeCampaignRunSummaryPage | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listRefreshing, setListRefreshing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(initialRunId);
  const [run, setRun] = useState<RuntimeCampaignRun | null>(null);
  const [runLoading, setRunLoading] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("overview");
  const [mutation, setMutation] = useState<RunAction | null>(null);
  const [cancelConfirmationOpen, setCancelConfirmationOpen] = useState(false);
  const [deliveryPage, setDeliveryPage] = useState<RuntimeCampaignDeliveryPage | null>(null);
  const [deliveryInputQuery, setDeliveryInputQuery] = useState("");
  const [deliveryQuery, setDeliveryQuery] = useState("");
  const [deliveryFilter, setDeliveryFilter] = useState<DeliveryFilter>("ALL");
  const [deliveryOffset, setDeliveryOffset] = useState(0);
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);
  const [deliveriesError, setDeliveriesError] = useState<string | null>(null);
  const listRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const deliveryRequestRef = useRef(0);
  const mutationRequestRef = useRef(0);
  const mutationIdempotencyRef = useRef<{
    action: RunAction;
    key: string;
    runId: string;
  } | null>(null);
  const sessionRef = useRef(selectedSessionId);
  const selectedSessionIdRef = useRef(selectedSessionId);
  const selectedRunIdRef = useRef(selectedRunId);
  const observedRunsListRevisionRef = useRef(runsResourceRevision);
  const observedRunDetailRevisionRef = useRef(runsResourceRevision);
  const observedDeliveriesRevisionRef = useRef(deliveriesResourceRevision);
  const runsRead = useLatestRequest();
  const runDetailRead = useLatestRequest();
  const deliveriesRead = useLatestRequest();
  const mutationOperation = useSingleFlightOperation();
  selectedSessionIdRef.current = selectedSessionId;
  selectedRunIdRef.current = selectedRunId;

  const selectedSummary = useMemo(
    () => page?.data.find((candidate) => candidate.id === selectedRunId) ?? null,
    [page, selectedRunId],
  );

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const query = listState.inputQuery.trim();
      setListState((current) => current.query === query
        ? current
        : { ...current, offset: 0, query });
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [listState.inputQuery]);

  useEffect(() => {
    const query = deliveryInputQuery.trim();
    const timeout = window.setTimeout(() => {
      setDeliveryQuery(query);
      setDeliveryOffset(0);
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [deliveryInputQuery]);

  const loadRuns = useCallback(async (state: RunsListState, background = false) => {
    if (!selectedSessionId) {
      runsRead.cancel();
      listRequestRef.current += 1;
      setPage(null);
      setListLoading(false);
      setListRefreshing(false);
      setListError(null);
      return;
    }
    const request = ++listRequestRef.current;
    const signal = runsRead.begin();
    if (background) setListRefreshing(true);
    else {
      setListLoading(true);
      setListRefreshing(false);
    }
    setListError(null);
    try {
      const result = await api.listRuns({
        sessionId: selectedSessionId,
        limit: RUNS_PAGE_SIZE,
        offset: state.offset,
        query: state.query,
        statuses: state.statuses,
        executionModes: state.executionModes,
      }, { signal });
      if (request !== listRequestRef.current || !runsRead.isCurrent(signal)) return;
      const recoveredOffset = reconciledPageOffset({
        limit: RUNS_PAGE_SIZE,
        offset: state.offset,
        rowCount: result.data.length,
        total: result.meta.total,
      });
      if (recoveredOffset !== null) {
        setListState((current) => ({ ...current, offset: recoveredOffset }));
        return;
      }
      setPage(result);
    } catch (error) {
      if (!runsRead.isCurrent(signal)) return;
      if (request === listRequestRef.current) {
        setListError(userFacingErrorMessage(error, "Could not load campaign runs."));
      }
    } finally {
      const current = request === listRequestRef.current && runsRead.isCurrent(signal);
      runsRead.complete(signal);
      if (current) {
        setListLoading(false);
        setListRefreshing(false);
      }
    }
  }, [api, runsRead, selectedSessionId]);

  useEffect(() => {
    if (sessionRef.current === selectedSessionId) return;
    sessionRef.current = selectedSessionId;
    mutationOperation.cancel();
    runsRead.cancel();
    runDetailRead.cancel();
    deliveriesRead.cancel();
    listRequestRef.current += 1;
    detailRequestRef.current += 1;
    deliveryRequestRef.current += 1;
    mutationRequestRef.current += 1;
    setPage(null);
    setListLoading(false);
    setListRefreshing(false);
    setListError(null);
    setSelectedRunId(null);
    setRun(null);
    setRunLoading(false);
    setRunError(null);
    setMutation(null);
    setCancelConfirmationOpen(false);
    setDeliveryPage(null);
    setDeliveriesLoading(false);
    setDeliveriesError(null);
    setListState(initialRunsListState());
    setFiltersOpen(false);
  }, [deliveriesRead, mutationOperation, runDetailRead, runsRead, selectedSessionId]);

  useEffect(() => { void loadRuns(listState); }, [listState, loadRuns]);

  useEffect(() => {
    if (observedRunsListRevisionRef.current === runsResourceRevision) return;
    observedRunsListRevisionRef.current = runsResourceRevision;
    void loadRuns(listState, true);
  }, [listState, loadRuns, runsResourceRevision]);

  useEffect(() => () => {
    listRequestRef.current += 1;
    detailRequestRef.current += 1;
    deliveryRequestRef.current += 1;
    mutationRequestRef.current += 1;
  }, []);

  const hasActiveRun = page?.data.some(
    (candidate) => !RUN_TERMINAL_STATUSES.has(candidate.status),
  ) ?? false;
  useEffect(() => {
    if (!hasActiveRun) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadRuns(listState, true);
    }, 4_000);
    return () => window.clearInterval(interval);
  }, [hasActiveRun, listState, loadRuns]);

  useEffect(() => {
    if (!initialRunId) return;
    setSelectedRunId(initialRunId);
  }, [initialRunId]);

  const loadRun = useCallback(async (
    runId: string,
    background = false,
    preserveError = false,
  ) => {
    const request = ++detailRequestRef.current;
    const signal = runDetailRead.begin();
    if (!background) setRunLoading(true);
    if (!preserveError) setRunError(null);
    try {
      const result = await api.getCampaignRun(runId, { signal });
      if (
        request === detailRequestRef.current
        && runDetailRead.isCurrent(signal)
        && result.sessionId === selectedSessionId
      ) setRun(result);
    } catch (error) {
      if (!runDetailRead.isCurrent(signal)) return;
      if (request === detailRequestRef.current && !preserveError) {
        setRunError(userFacingErrorMessage(error, "Could not load run details."));
      }
    } finally {
      const current = request === detailRequestRef.current
        && runDetailRead.isCurrent(signal);
      runDetailRead.complete(signal);
      if (current) setRunLoading(false);
    }
  }, [api, runDetailRead, selectedSessionId]);

  useEffect(() => {
    if (!selectedRunId) {
      runDetailRead.cancel();
      setRun(null);
      return;
    }
    void loadRun(selectedRunId);
  }, [loadRun, runDetailRead, selectedRunId]);

  useEffect(() => {
    if (observedRunDetailRevisionRef.current === runsResourceRevision) return;
    observedRunDetailRevisionRef.current = runsResourceRevision;
    if (selectedRunId) void loadRun(selectedRunId, true, true);
  }, [loadRun, runsResourceRevision, selectedRunId]);

  useEffect(() => {
    if (!run || mutation || RUN_TERMINAL_STATUSES.has(run.status)) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadRun(run.id, true);
    }, 3_000);
    return () => window.clearInterval(interval);
  }, [loadRun, mutation, run]);

  const loadDeliveries = useCallback(async (background = false) => {
    if (!selectedRunId || inspectorTab !== "deliveries") {
      deliveriesRead.cancel();
      deliveryRequestRef.current += 1;
      setDeliveriesLoading(false);
      return;
    }
    const request = ++deliveryRequestRef.current;
    const signal = deliveriesRead.begin();
    if (!background) {
      setDeliveriesLoading(true);
      setDeliveriesError(null);
    }
    try {
      const result = await api.listCampaignDeliveries({
        runId: selectedRunId,
        limit: 20,
        offset: deliveryOffset,
        query: deliveryQuery,
        statuses: deliveryFilter === "ALL" ? [] : [deliveryFilter],
      }, { signal });
      if (
        request === deliveryRequestRef.current
        && deliveriesRead.isCurrent(signal)
      ) setDeliveryPage(result);
    } catch (error) {
      if (!deliveriesRead.isCurrent(signal)) return;
      if (request === deliveryRequestRef.current) {
        setDeliveriesError(userFacingErrorMessage(error, "Could not load deliveries."));
      }
    } finally {
      const current = request === deliveryRequestRef.current
        && deliveriesRead.isCurrent(signal);
      deliveriesRead.complete(signal);
      if (current) setDeliveriesLoading(false);
    }
  }, [api, deliveriesRead, deliveryFilter, deliveryOffset, deliveryQuery, inspectorTab, selectedRunId]);

  useEffect(() => { void loadDeliveries(); }, [loadDeliveries]);

  useEffect(() => {
    if (observedDeliveriesRevisionRef.current === deliveriesResourceRevision) return;
    observedDeliveriesRevisionRef.current = deliveriesResourceRevision;
    void loadDeliveries(true);
  }, [deliveriesResourceRevision, loadDeliveries]);

  function selectRun(item: RuntimeCampaignRunSummary) {
    mutationOperation.cancel();
    runDetailRead.cancel();
    deliveriesRead.cancel();
    detailRequestRef.current += 1;
    deliveryRequestRef.current += 1;
    mutationRequestRef.current += 1;
    setSelectedRunId(item.id);
    setRun(null);
    setRunLoading(false);
    setRunError(null);
    setMutation(null);
    setCancelConfirmationOpen(false);
    setInspectorTab("overview");
    setDeliveryPage(null);
    setDeliveriesLoading(false);
    setDeliveriesError(null);
    setDeliveryInputQuery("");
    setDeliveryQuery("");
    setDeliveryFilter("ALL");
    setDeliveryOffset(0);
    onRunSelectionChange?.(item.id);
  }

  function closeInspector() {
    mutationOperation.cancel();
    runDetailRead.cancel();
    deliveriesRead.cancel();
    detailRequestRef.current += 1;
    deliveryRequestRef.current += 1;
    mutationRequestRef.current += 1;
    setSelectedRunId(null);
    setRun(null);
    setRunLoading(false);
    setRunError(null);
    setMutation(null);
    setCancelConfirmationOpen(false);
    onRunSelectionChange?.(null);
  }

  function requestRunCancellation() {
    setRunError(null);
    setCancelConfirmationOpen(true);
  }

  async function changeRunState(action: RunAction) {
    if (!run) return;
    const operationToken = mutationOperation.begin();
    if (operationToken === null) return;
    const targetRun = run;
    const previousMutation = mutationIdempotencyRef.current;
    const idempotencyKey = previousMutation?.runId === targetRun.id
      && previousMutation.action === action
      ? previousMutation.key
      : crypto.randomUUID();
    mutationIdempotencyRef.current = { action, key: idempotencyKey, runId: targetRun.id };
    const request = ++mutationRequestRef.current;
    runDetailRead.cancel();
    detailRequestRef.current += 1;
    setMutation(action);
    setRunError(null);
    try {
      const updated = action === "pause"
        ? await api.pauseCampaignRun(targetRun.id, idempotencyKey)
        : action === "resume"
          ? await api.resumeCampaignRun(targetRun.id, idempotencyKey)
          : await api.cancelCampaignRun(targetRun.id, idempotencyKey);
      if (mutationIdempotencyRef.current?.key === idempotencyKey) {
        mutationIdempotencyRef.current = null;
      }
      if (
        !mutationOperation.isCurrent(operationToken)
        || request !== mutationRequestRef.current
        || selectedRunIdRef.current !== targetRun.id
        || updated.id !== targetRun.id
        || updated.sessionId !== selectedSessionIdRef.current
        || updated.campaignId !== targetRun.campaignId
      ) return;
      setRun(updated);
      setCancelConfirmationOpen(false);
      void loadRuns(listState, true);
      if (inspectorTab === "deliveries") void loadDeliveries(true);
      invalidate({ resources: ["campaigns"], sessionId: targetRun.sessionId });
    } catch (error) {
      const outcomeUnknown = isUnknownMutationOutcome(error);
      if (!outcomeUnknown && mutationIdempotencyRef.current?.key === idempotencyKey) {
        mutationIdempotencyRef.current = null;
      }
      if (
        !mutationOperation.isCurrent(operationToken)
        || request !== mutationRequestRef.current
        || selectedRunIdRef.current !== targetRun.id
      ) return;
      setRunError(outcomeUnknown
        ? unknownMutationOutcomeMessage("idempotent-retry")
        : userFacingErrorMessage(error, `Could not ${action} campaign run.`));
      void loadRun(targetRun.id, true, true);
      void loadRuns(listState, true);
    } finally {
      if (mutationOperation.complete(operationToken) && request === mutationRequestRef.current) {
        setMutation(null);
      }
    }
  }

  const total = page?.meta.total ?? 0;
  const offset = page?.meta.offset ?? listState.offset;
  const limit = page?.meta.limit ?? RUNS_PAGE_SIZE;
  const firstItem = total ? offset + 1 : 0;
  const lastItem = Math.min(offset + (page?.data.length ?? 0), total);
  const hasCriteria = Boolean(listState.query || listState.statuses.length || listState.executionModes.length);
  const currentRun = run ?? selectedSummary;
  const runs = page?.data ?? [];
  const emptyMessage = !selectedSessionId
    ? "Select a session to view runs."
    : listError && runs.length === 0
      ? "Campaign runs are unavailable."
      : hasCriteria
        ? "No runs match this search or filters."
        : "No campaign runs yet. Launch a reviewed run from Campaigns.";

  return (
    <div className="runs-screen stack stack-lg">
      <PageHeader
        description="Monitor durable campaign execution, investigate delivery outcomes, and apply Runtime lifecycle controls."
        title="Runs"
        titleId="runs-title"
      />
      <div className="data-table-container runs-list-panel">
        <RunsListToolbar
          filtersOpen={filtersOpen}
          firstItem={firstItem}
          lastItem={lastItem}
          loading={listLoading}
          setFiltersOpen={setFiltersOpen}
          setState={setListState}
          state={listState}
          total={total}
        />
        {listError && <InlineAlert action={<Button onClick={() => void loadRuns(listState)} size="sm">Retry</Button>} className="data-table-error" title="Could not load runs">{listError}</InlineAlert>}
        <RunsTable
          emptyAction={selectedSessionId && total === 0 && !listError && !hasCriteria && onOpenCampaigns
            ? <Button onClick={onOpenCampaigns} size="sm">Open Campaigns</Button>
            : undefined}
          emptyMessage={emptyMessage}
          loading={listLoading}
          onInspect={selectRun}
          runs={runs}
          selectedRunId={selectedRunId}
          updating={listRefreshing}
        />
        <TablePagination limit={limit} loading={listLoading || listRefreshing} offset={offset} onOffsetChange={(nextOffset) => setListState((current) => ({ ...current, offset: nextOffset }))} total={total} />
      </div>

      <WorkspaceDrawer
        contentKey={`${selectedRunId ?? "none"}:${inspectorTab}`}
        description={currentRun ? `Campaign ${currentRun.campaignNameSnapshot}` : "Durable campaign execution"}
        eyebrow={currentRun ? `Run ${shortId(currentRun.id)}` : "Run inspector"}
        footer={run && <RunActions mutation={mutation} onAction={(action) => action === "cancel" ? requestRunCancellation() : void changeRunState(action)} run={run} />}
        navigation={<Tabs activeTab={inspectorTab} ariaLabel="Run inspector sections" idPrefix="run-inspector" onChange={setInspectorTab} tabs={[{ id: "overview", label: "Overview" }, { id: "deliveries", label: "Deliveries", meta: currentRun?.totalTargets }]} />}
        onClose={closeInspector}
        open={Boolean(selectedRunId)}
        title={currentRun?.campaignNameSnapshot ?? "Run inspector"}
      >
        {runLoading && !run && <p className="workspace-loading">Loading run details…</p>}
        {runError && !cancelConfirmationOpen && <InlineAlert action={selectedRunId ? <Button onClick={() => void loadRun(selectedRunId)} size="sm">Retry</Button> : undefined} title="Run needs attention">{runError}</InlineAlert>}
        {run && inspectorTab === "overview" && <RunOverview run={run} />}
        {selectedRunId && inspectorTab === "deliveries" && (
          <RunDeliveries
            deliveryFilter={deliveryFilter}
            inputQuery={deliveryInputQuery}
            loading={deliveriesLoading}
            onFilterChange={(value) => { setDeliveryFilter(value); setDeliveryOffset(0); }}
            onOffsetChange={setDeliveryOffset}
            onQueryChange={setDeliveryInputQuery}
            onRetry={() => void loadDeliveries()}
            page={deliveryPage}
            error={deliveriesError}
          />
        )}
      </WorkspaceDrawer>

      <ConfirmationDialog
        body="WA Runtime will stop creating pending work for this run and cancel deliveries that have not started. Already processing sends may still finish."
        confirmLabel="Cancel run"
        confirmVariant="danger"
        busy={mutation === "cancel"}
        error={runError}
        errorTitle="Could not cancel run"
        onCancel={() => setCancelConfirmationOpen(false)}
        onConfirm={() => void changeRunState("cancel")}
        open={cancelConfirmationOpen}
        title="Cancel this campaign run?"
      />
    </div>
  );
}

function RunOverview({ run }: { run: RuntimeCampaignRun }) {
  const resolved = resolvedTargets(run);
  const progress = run.progress;
  const progressRows = [
    ["Pending", progress.pending], ["Materialized", progress.materialized],
    ["Processing", progress.processing], ["Dry run complete", progress.dryRunCompleted],
    ["Accepted", progress.accepted], ["Sent", progress.sent],
    ["Delivered", progress.delivered], ["Read", progress.read],
    ["Failed", progress.failed], ["Unknown", progress.unknown],
    ["Blocked", progress.blocked], ["Cancelled", progress.cancelled],
  ] as const;
  return <div aria-labelledby="run-inspector-overview-tab" className="runs-inspector stack stack-lg" id="run-inspector-overview-panel" role="tabpanel">
    <section className="runs-inspector-section">
      <div className="runs-inspector-status"><Badge tone={runTone(run.status)} variant="status">{runStatusLabel(run.status)}</Badge><Badge tone="neutral">{run.executionMode === "LIVE" ? "Live" : "Dry run"}</Badge></div>
      {run.statusReason && <p>{run.statusReason.replace(/_/g, " ").toLocaleLowerCase()}</p>}
      <div className="runs-progress-summary"><progress max={Math.max(1, run.totalTargets)} value={resolved} /><strong>{resolved} of {run.totalTargets} targets resolved</strong></div>
      <dl className="runs-progress-grid">{progressRows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    </section>
    <section className="runs-inspector-section"><h3>Lifecycle</h3><dl className="runs-detail-list">
      <div><dt>Created</dt><dd><DateTime value={run.createdAt} /></dd></div>
      <div><dt>Scheduled</dt><dd><DateTime value={run.scheduledAt} /></dd></div>
      <div><dt>Started</dt><dd><DateTime fallback="Not started" value={run.startedAt} /></dd></div>
      <div><dt>Completed</dt><dd><DateTime fallback="Not completed" value={run.completedAt} /></dd></div>
      <div><dt>Last change</dt><dd><DateTime value={run.updatedAt} /></dd></div>
    </dl></section>
    <section className="runs-inspector-section"><h3>Immutable launch snapshot</h3><dl className="runs-detail-list">
      <div><dt>Run ID</dt><dd className="data-identifier">{run.id}</dd></div>
      <div><dt>Campaign ID</dt><dd className="data-identifier">{run.campaignId}</dd></div>
      <div><dt>Campaign revision</dt><dd>r{run.campaignRevision}</dd></div>
      <div><dt>Target revision</dt><dd>r{run.targetsRevision}</dd></div>
      <div><dt>Audience source</dt><dd>{run.targetSource ? `${run.targetSource.groupListNameSnapshot} · membership r${run.targetSource.membershipRevision}` : "Custom selection"}</dd></div>
    </dl></section>
    <RunMessageSnapshot run={run} />
  </div>;
}

function RunMessageSnapshot({ run }: { run: RuntimeCampaignRun }) {
  const content = run.content ?? { type: "TEXT" as const, text: run.text };
  return <details className="runs-message-snapshot">
    <summary>Message snapshot</summary>
    {content.type === "TEXT" ? <p>{content.text}</p> : <>
      <dl className="runs-detail-list runs-message-metadata">
        <div><dt>Type</dt><dd>Image</dd></div>
        <div><dt>File</dt><dd>{content.filename}</dd></div>
        <div><dt>Format</dt><dd>{content.mimeType} · {formatRunBytes(content.byteSize)}</dd></div>
        <div><dt>Integrity</dt><dd className="data-identifier">SHA-256 {content.sha256.slice(0, 12)}…</dd></div>
      </dl>
      <p>{content.caption || "No caption"}</p>
    </>}
  </details>;
}

function formatRunBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/u, "")} MB`;
}

function RunActions({ mutation, onAction, run }: {
  mutation: RunAction | null;
  onAction: (action: RunAction) => void;
  run: RuntimeCampaignRun;
}) {
  const terminal = RUN_TERMINAL_STATUSES.has(run.status);
  return <div className="runs-inspector-actions">
    <span>{mutation ? `${mutation.charAt(0).toLocaleUpperCase()}${mutation.slice(1)} in progress…` : `${runStatusLabel(run.status)} · Runtime authoritative`}</span>
    <div>
      {(run.status === "RUNNING" || run.status === "SCHEDULED") && <Button disabled={Boolean(mutation)} loading={mutation === "pause"} onClick={() => onAction("pause")}>Pause</Button>}
      {(run.status === "PAUSED" || run.status === "BLOCKED") && <Button disabled={Boolean(mutation)} loading={mutation === "resume"} onClick={() => onAction("resume")} variant="primary">Resume</Button>}
      {!terminal && <Button disabled={Boolean(mutation)} onClick={() => onAction("cancel")} variant="danger">Cancel</Button>}
    </div>
  </div>;
}

function RunDeliveries({
  deliveryFilter,
  error,
  inputQuery,
  loading,
  onFilterChange,
  onOffsetChange,
  onQueryChange,
  onRetry,
  page,
}: {
  deliveryFilter: DeliveryFilter;
  error: string | null;
  inputQuery: string;
  loading: boolean;
  onFilterChange: (value: DeliveryFilter) => void;
  onOffsetChange: (offset: number) => void;
  onQueryChange: (value: string) => void;
  onRetry: () => void;
  page: RuntimeCampaignDeliveryPage | null;
}) {
  const total = page?.meta.total ?? 0;
  return <div aria-labelledby="run-inspector-deliveries-tab" className="run-deliveries stack stack-md" id="run-inspector-deliveries-panel" role="tabpanel">
    <div className="run-deliveries-toolbar">
      <SearchField label="Search deliveries" loading={loading} onChange={onQueryChange} placeholder="Search group name or ID" value={inputQuery} variant="toolbar" />
      <SearchSelect
        id="run-delivery-status"
        label="Delivery status"
        labelHidden
        onChange={onFilterChange}
        options={[
          { label: "All statuses", value: "ALL" },
          ...DELIVERY_STATUSES.map((status) => ({
            group: deliveryStatusGroup(status),
            keywords: status,
            label: runStatusLabel(status),
            value: status,
          })),
        ]}
        searchLabel="Search delivery statuses"
        searchPlaceholder="Search statuses"
        value={deliveryFilter}
      />
    </div>
    {error && <InlineAlert action={<Button onClick={onRetry} size="sm">Retry</Button>} title="Could not load deliveries">{error}</InlineAlert>}
    <div
      aria-busy={loading}
      aria-label="Per-group deliveries for this run"
      aria-live={page?.data.length ? undefined : "polite"}
      className="run-delivery-list"
      data-updating={(loading && Boolean(page?.data.length)) || undefined}
      role={page?.data.length ? "list" : "status"}
    >
      {!page && loading ? <div className="run-delivery-state">Loading deliveries…</div>
        : error && !page?.data.length ? <div className="run-delivery-state">Deliveries are unavailable.</div>
          : !page?.data.length ? <div className="run-delivery-state">{inputQuery || deliveryFilter !== "ALL" ? "No deliveries match these criteria." : "No deliveries have been materialized yet."}</div>
            : page.data.map((delivery) => <div className="run-delivery-block" key={delivery.id} role="listitem"><span><strong title={delivery.groupName}>{delivery.groupName}</strong><small className="data-identifier" title={delivery.groupId}>{delivery.groupId}</small>{delivery.failureReason && <small className="runs-delivery-failure" title={delivery.failureReason}>{delivery.failureReason}</small>}</span><Badge tone={deliveryTone(delivery.status)} variant="status">{runStatusLabel(delivery.status)}</Badge></div>)}
    </div>
    {total > 0 && <TablePagination label={`${total} ${total === 1 ? "delivery" : "deliveries"}`} limit={page?.meta.limit ?? 20} loading={loading} offset={page?.meta.offset ?? 0} onOffsetChange={onOffsetChange} total={total} />}
  </div>;
}
