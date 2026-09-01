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
import {
  ActionFooter,
  DataTableFrame,
  DescriptionList,
  EmptyState,
  MetricGrid,
} from "@/shared/ui/Composition";
import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";
import {
  DataTable,
  DataTableEmptyCell,
  DataTableScroll,
} from "@/shared/ui/DataTable";
import { DateTime } from "@/shared/ui/DateTime";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import {
  InspectorDisclosure,
  InspectorDrawer,
  InspectorSection,
} from "@/shared/ui/InspectorDrawer";
import { PageHeader } from "@/shared/ui/PageHeader";
import { SearchField } from "@/shared/ui/SearchField";
import { SearchSelect } from "@/shared/ui/SearchSelect";
import { TablePagination } from "@/shared/ui/TablePagination";
import { Tabs } from "@/shared/ui/Tabs";
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
  const detailTriggerRef = useRef<HTMLButtonElement>(null);
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

  function selectRun(item: RuntimeCampaignRunSummary, trigger: HTMLButtonElement) {
    detailTriggerRef.current = trigger;
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
    detailTriggerRef.current = null;
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
      <DataTableFrame className="data-table-container runs-list-panel" label="Campaign runs" scroll={false}>
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
        {listError && <InlineAlert action={<Button onClick={() => void loadRuns(listState)} size="sm">Retry</Button>} title="Could not load runs" variant="flush">{listError}</InlineAlert>}
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
      </DataTableFrame>

      <InspectorDrawer
        contentKey={`${selectedRunId ?? "none"}:${inspectorTab}`}
        kicker="Campaign run"
        footer={run && runHasActions(run) ? <RunActions mutation={mutation} onAction={(action) => action === "cancel" ? requestRunCancellation() : void changeRunState(action)} run={run} /> : undefined}
        meta={currentRun ? [
          `Run ${shortId(currentRun.id)}`,
          currentRun.executionMode === "LIVE" ? "Live" : "Dry run",
        ] : []}
        navigation={<Tabs activeTab={inspectorTab} ariaLabel="Run inspector sections" idPrefix="run-inspector" onChange={setInspectorTab} tabs={[{ id: "overview", label: "Overview" }, { id: "deliveries", label: "Deliveries" }]} />}
        onClose={closeInspector}
        open={Boolean(selectedRunId)}
        returnFocusRef={detailTriggerRef}
        size="wide"
        status={currentRun ? <Badge tone={runTone(currentRun.status)} variant="status">{runStatusLabel(currentRun.status)}</Badge> : undefined}
        title={currentRun?.campaignNameSnapshot ?? "Run inspector"}
      >
        {runLoading && !run && <EmptyState compact icon="refresh" loading title="Loading run details">Runtime is returning the durable execution state.</EmptyState>}
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
      </InspectorDrawer>

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
  const remaining = Math.max(0, run.totalTargets - resolved);
  const progress = run.progress;
  const successful = run.executionMode === "LIVE"
    ? progress.accepted + progress.sent + progress.delivered + progress.read
    : progress.dryRunCompleted;
  const progressRows = [
    ["Pending", progress.pending], ["Materialized", progress.materialized],
    ["Processing", progress.processing], ["Dry run complete", progress.dryRunCompleted],
    ["Accepted", progress.accepted], ["Sent", progress.sent],
    ["Delivered", progress.delivered], ["Read", progress.read],
    ["Failed", progress.failed], ["Unknown", progress.unknown],
    ["Blocked", progress.blocked], ["Cancelled", progress.cancelled],
  ] as const;
  const statusReason = run.statusReason?.replace(/_/g, " ").toLocaleLowerCase();
  const lifecycleSummary = run.completedAt
    ? <>Completed <DateTime precision="second" value={run.completedAt} /></>
    : run.startedAt
      ? <>Started <DateTime precision="second" value={run.startedAt} /></>
      : <>Scheduled <DateTime precision="second" value={run.scheduledAt} /></>;
  const audienceSource = run.targetSource
    ? `${run.targetSource.groupListNameSnapshot} membership r${run.targetSource.membershipRevision}`
    : "Custom selection";
  const launchSummary = `Campaign r${run.campaignRevision} · targets r${run.targetsRevision} · ${audienceSource}`;
  return <div aria-labelledby="run-inspector-overview-tab" className="runs-inspector" id="run-inspector-overview-panel" role="tabpanel">
    <InspectorSection
      description={statusReason ?? "Runtime-authoritative progress for this durable execution."}
      eyebrow="Execution"
      title="Run summary"
      titleId="run-execution-summary-title"
    >
      <div className="runs-progress-summary"><progress aria-label={`${resolved} of ${run.totalTargets} targets resolved`} max={Math.max(1, run.totalTargets)} value={resolved} /><strong>{resolved} of {run.totalTargets} targets resolved</strong></div>
      <MetricGrid
        ariaLabel="Key run progress"
        className="runs-key-metrics"
        items={[
          { label: "Remaining", value: remaining },
          { label: run.executionMode === "LIVE" ? "Successful" : "Simulated", value: successful },
          { label: "Failed", tone: progress.failed > 0 ? "danger" : "default", value: progress.failed },
          { label: "Blocked", tone: progress.blocked > 0 ? "warning" : "default", value: progress.blocked },
        ]}
      />
    </InspectorSection>
    <InspectorDisclosure
      className="runs-detail-disclosure"
      description={lifecycleSummary}
      title="Lifecycle"
      titleId="run-lifecycle-title"
    >
      <DescriptionList
        ariaLabel="Run lifecycle"
        className="runs-detail-list"
        items={[
          { id: "created", label: "Created", value: <DateTime precision="second" value={run.createdAt} /> },
          { id: "scheduled", label: "Scheduled", value: <DateTime precision="second" value={run.scheduledAt} /> },
          { id: "started", label: "Started", value: <DateTime fallback="Not started" precision="second" value={run.startedAt} /> },
          { id: "completed", label: "Completed", value: <DateTime fallback="Not completed" precision="second" value={run.completedAt} /> },
          { id: "updated", label: "Last change", value: <DateTime precision="second" value={run.updatedAt} /> },
        ]}
      />
    </InspectorDisclosure>
    <InspectorDisclosure
      className="runs-detail-disclosure"
      description={<span title={launchSummary}>{launchSummary}</span>}
      title="Immutable launch"
      titleId="run-launch-snapshot-title"
    >
      <DescriptionList
        ariaLabel="Immutable launch snapshot"
        className="runs-detail-list runs-launch-list"
        items={[
          { id: "run-id", label: "Run ID", value: <span title={run.id}>{run.id}</span>, valueClassName: "ui-technical-text" },
          { id: "campaign-id", label: "Campaign ID", value: <span title={run.campaignId}>{run.campaignId}</span>, valueClassName: "ui-technical-text" },
          { id: "campaign-revision", label: "Campaign revision", value: `r${run.campaignRevision}` },
          { id: "target-revision", label: "Target revision", value: `r${run.targetsRevision}` },
          { id: "audience-source", label: "Audience source", value: <span title={audienceSource}>{audienceSource}</span> },
        ]}
      />
    </InspectorDisclosure>
    <InspectorDisclosure
      className="runs-progress-disclosure"
      description="Every current delivery state reported by Runtime."
      title="Delivery state breakdown"
      titleId="run-progress-breakdown-title"
    >
      <MetricGrid
        ariaLabel="Run delivery progress"
        className="runs-progress-grid"
        items={progressRows.map(([label, value]) => ({ label, value }))}
      />
    </InspectorDisclosure>
    <RunMessageSnapshot run={run} />
  </div>;
}

function RunMessageSnapshot({ run }: { run: RuntimeCampaignRun }) {
  const content = run.content ?? { type: "TEXT" as const, text: run.text };
  return <InspectorDisclosure
    className="runs-message-snapshot"
    description="Immutable content copied into this run."
    title="Message snapshot"
    titleId="run-message-snapshot-title"
  >
    {content.type === "TEXT" ? <p>{content.text}</p> : <>
      <DescriptionList
        ariaLabel="Message metadata"
        className="runs-detail-list runs-message-metadata"
        items={[
          { id: "type", label: "Type", value: "Image" },
          { id: "file", label: "File", value: content.filename },
          { id: "format", label: "Format", value: `${content.mimeType} · ${formatRunBytes(content.byteSize)}` },
          { id: "integrity", label: "Integrity", value: `SHA-256 ${content.sha256.slice(0, 12)}…`, valueClassName: "ui-technical-text" },
          { id: "caption", label: "Caption", value: content.caption || "No caption" },
        ]}
      />
    </>}
  </InspectorDisclosure>;
}

function formatRunBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/u, "")} MB`;
}

function runHasActions(run: RuntimeCampaignRun): boolean {
  const terminal = RUN_TERMINAL_STATUSES.has(run.status);
  return !terminal && run.status !== "CANCELLING";
}

function RunActions({ mutation, onAction, run }: {
  mutation: RunAction | null;
  onAction: (action: RunAction) => void;
  run: RuntimeCampaignRun;
}) {
  return <div className="runs-action-footer">
    <ActionFooter
      actions={<>
        {(run.status === "RUNNING" || run.status === "SCHEDULED") && <Button disabled={Boolean(mutation)} loading={mutation === "pause"} onClick={() => onAction("pause")}>Pause</Button>}
        {(run.status === "PAUSED" || run.status === "BLOCKED") && <Button disabled={Boolean(mutation)} loading={mutation === "resume"} onClick={() => onAction("resume")} variant="primary">Resume</Button>}
        <Button disabled={Boolean(mutation)} onClick={() => onAction("cancel")} variant="danger">Cancel</Button>
      </>}
      description={mutation ? "Runtime is applying the requested state change." : "Actions affect pending Runtime work."}
      title={mutation ? `${mutation.charAt(0).toLocaleUpperCase()}${mutation.slice(1)} in progress…` : `${runStatusLabel(run.status)} · Runtime authoritative`}
    />
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
  const limit = page?.meta.limit ?? 20;
  const offset = page?.meta.offset ?? 0;
  const firstItem = total === 0 ? 0 : offset + 1;
  const lastItem = Math.min(offset + limit, total);
  const paginationLabel = total === 1
    ? "1 delivery"
    : `${firstItem}–${lastItem} of ${total.toLocaleString()} deliveries`;
  const unavailable = Boolean(error && !page?.data.length);
  return <div aria-labelledby="run-inspector-deliveries-tab" className="run-deliveries" id="run-inspector-deliveries-panel" role="tabpanel">
    <InspectorSection
      description="Inspect the current Runtime state for every target group."
      eyebrow="Targets"
      title="Per-group deliveries"
      titleId="run-deliveries-title"
    >
      <DataTableFrame
        className="run-deliveries-table-frame"
        footer={total > 0 ? <TablePagination label={paginationLabel} limit={limit} loading={loading} offset={offset} onOffsetChange={onOffsetChange} total={total} /> : undefined}
        label="Per-group delivery states"
        scroll={false}
        toolbar={<div className="run-deliveries-toolbar">
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
        </div>}
      >
        {error && <InlineAlert action={<Button onClick={onRetry} size="sm">Retry</Button>} title="Could not load deliveries">{error}</InlineAlert>}
        {!unavailable && <DataTableScroll
          busy={loading}
          updating={loading && Boolean(page?.data.length)}
        >
          <DataTable caption="Per-group deliveries for this run" className="run-deliveries-table">
            <colgroup>
              <col />
              <col className="run-delivery-state-column" />
              <col className="run-delivery-updated-column" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Group</th>
                <th scope="col">State</th>
                <th className="data-column-time" scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {!page && loading ? <tr><DataTableEmptyCell colSpan={3}><EmptyState compact icon="refresh" loading title="Loading deliveries">Runtime is returning per-group delivery state.</EmptyState></DataTableEmptyCell></tr>
                : !page?.data.length ? <tr><DataTableEmptyCell colSpan={3}><EmptyState compact icon="runs" title={inputQuery || deliveryFilter !== "ALL" ? "No matching deliveries" : "No deliveries yet"}>{inputQuery || deliveryFilter !== "ALL" ? "No deliveries match these criteria." : "No deliveries have been materialized yet."}</EmptyState></DataTableEmptyCell></tr>
                  : page.data.map((delivery) => <tr key={delivery.id}>
                    <td className="data-cell-primary">
                      <div className="stack stack-xs run-delivery-identity">
                        <strong className="data-primary-text" title={delivery.groupName}>{delivery.groupName}</strong>
                        <span className="data-secondary-text" title={delivery.groupId}>{delivery.groupId}</span>
                        {delivery.failureReason && <span className="runs-delivery-failure" title={delivery.failureReason}>{delivery.failureReason}</span>}
                      </div>
                    </td>
                    <td className="data-cell-status">
                      <div className="run-delivery-state">
                        <Badge tone={deliveryTone(delivery.status)} variant="status">{runStatusLabel(delivery.status)}</Badge>
                      </div>
                    </td>
                    <td className="data-cell-time"><DateTime relativeStyle="compact" value={delivery.updatedAt} variant="relative" /></td>
                  </tr>)}
            </tbody>
          </DataTable>
        </DataTableScroll>}
      </DataTableFrame>
    </InspectorSection>
  </div>;
}
