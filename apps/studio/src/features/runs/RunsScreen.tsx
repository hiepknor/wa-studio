import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRuntimeConnection } from "@/app/RuntimeConnectionContext";
import type {
  RuntimeCampaignDeliveryPage,
  RuntimeCampaignDeliveryStatus,
  RuntimeCampaignRun,
  RuntimeCampaignRunSummary,
  RuntimeCampaignRunSummaryPage,
} from "@/shared/api/runtime-client";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";
import { DateTime } from "@/shared/ui/DateTime";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { PageHeader } from "@/shared/ui/PageHeader";
import { SearchField } from "@/shared/ui/SearchField";
import { SelectMenu } from "@/shared/ui/SelectMenu";
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

interface RunsScreenProps {
  initialRunId?: string | null;
  onRunSelectionChange?: (runId: string | null) => void;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function RunsScreen({
  initialRunId = null,
  onRunSelectionChange,
}: RunsScreenProps = {}) {
  const { connected, selectedSessionId } = useRuntimeConnection();
  if (!connected) throw new Error("RunsScreen requires a Runtime connection");
  const api = connected.api;
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
  const sessionRef = useRef(selectedSessionId);

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
      setPage(null);
      setListLoading(false);
      setListRefreshing(false);
      return;
    }
    const request = ++listRequestRef.current;
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
      });
      if (request !== listRequestRef.current) return;
      if (state.offset > 0 && result.meta.total <= state.offset) {
        setListState((current) => ({ ...current, offset: Math.max(0, result.meta.total - RUNS_PAGE_SIZE) }));
        return;
      }
      setPage(result);
    } catch (error) {
      if (request === listRequestRef.current) {
        setListError(errorMessage(error, "Could not load campaign runs."));
      }
    } finally {
      if (request === listRequestRef.current) {
        setListLoading(false);
        setListRefreshing(false);
      }
    }
  }, [api, selectedSessionId]);

  useEffect(() => {
    if (sessionRef.current === selectedSessionId) return;
    sessionRef.current = selectedSessionId;
    setPage(null);
    setSelectedRunId(null);
    setRun(null);
    setListState(initialRunsListState());
    setFiltersOpen(false);
  }, [selectedSessionId]);

  useEffect(() => { void loadRuns(listState); }, [listState, loadRuns]);

  const hasActiveRun = page?.data.some((candidate) => !RUN_TERMINAL_STATUSES.has(candidate.status)) ?? false;
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

  const loadRun = useCallback(async (runId: string, background = false) => {
    const request = ++detailRequestRef.current;
    if (!background) setRunLoading(true);
    setRunError(null);
    try {
      const result = await api.getCampaignRun(runId);
      if (request === detailRequestRef.current && result.sessionId === selectedSessionId) setRun(result);
    } catch (error) {
      if (request === detailRequestRef.current) {
        setRunError(errorMessage(error, "Could not load run details."));
      }
    } finally {
      if (request === detailRequestRef.current && !background) setRunLoading(false);
    }
  }, [api, selectedSessionId]);

  useEffect(() => {
    if (!selectedRunId) {
      setRun(null);
      return;
    }
    void loadRun(selectedRunId);
  }, [loadRun, selectedRunId]);

  useEffect(() => {
    if (!run || RUN_TERMINAL_STATUSES.has(run.status)) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadRun(run.id, true);
    }, 3_000);
    return () => window.clearInterval(interval);
  }, [loadRun, run]);

  const loadDeliveries = useCallback(async () => {
    if (!selectedRunId || inspectorTab !== "deliveries") return;
    const request = ++deliveryRequestRef.current;
    setDeliveriesLoading(true);
    setDeliveriesError(null);
    try {
      const result = await api.listCampaignDeliveries({
        runId: selectedRunId,
        limit: 20,
        offset: deliveryOffset,
        query: deliveryQuery,
        statuses: deliveryFilter === "ALL" ? [] : [deliveryFilter],
      });
      if (request === deliveryRequestRef.current) setDeliveryPage(result);
    } catch (error) {
      if (request === deliveryRequestRef.current) {
        setDeliveriesError(errorMessage(error, "Could not load deliveries."));
      }
    } finally {
      if (request === deliveryRequestRef.current) setDeliveriesLoading(false);
    }
  }, [api, deliveryFilter, deliveryOffset, deliveryQuery, inspectorTab, selectedRunId]);

  useEffect(() => { void loadDeliveries(); }, [loadDeliveries]);

  function selectRun(item: RuntimeCampaignRunSummary) {
    setSelectedRunId(item.id);
    setInspectorTab("overview");
    setDeliveryPage(null);
    setDeliveryInputQuery("");
    setDeliveryQuery("");
    setDeliveryFilter("ALL");
    setDeliveryOffset(0);
    onRunSelectionChange?.(item.id);
  }

  function closeInspector() {
    detailRequestRef.current += 1;
    deliveryRequestRef.current += 1;
    setSelectedRunId(null);
    setRun(null);
    setRunError(null);
    setCancelConfirmationOpen(false);
    onRunSelectionChange?.(null);
  }

  async function changeRunState(action: RunAction) {
    if (!run) return;
    setMutation(action);
    setRunError(null);
    try {
      const updated = action === "pause"
        ? await api.pauseCampaignRun(run.id)
        : action === "resume"
          ? await api.resumeCampaignRun(run.id)
          : await api.cancelCampaignRun(run.id);
      setRun(updated);
      setCancelConfirmationOpen(false);
      void loadRuns(listState, true);
      if (inspectorTab === "deliveries") void loadDeliveries();
    } catch (error) {
      setRunError(errorMessage(error, `Could not ${action} campaign run.`));
      void loadRun(run.id, true);
      void loadRuns(listState, true);
    } finally {
      setMutation(null);
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
          emptyMessage={emptyMessage}
          loading={listLoading}
          onInspect={selectRun}
          runs={runs}
          selectedRunId={selectedRunId}
          updating={listRefreshing}
        />
        {total > 0 && <TablePagination label={`${total} durable ${total === 1 ? "run" : "runs"}`} limit={limit} loading={listLoading || listRefreshing} offset={offset} onOffsetChange={(nextOffset) => setListState((current) => ({ ...current, offset: nextOffset }))} total={total} />}
      </div>

      <WorkspaceDrawer
        contentKey={`${selectedRunId ?? "none"}:${inspectorTab}`}
        description={currentRun ? `Campaign ${currentRun.campaignNameSnapshot}` : "Durable campaign execution"}
        eyebrow={currentRun ? `Run ${shortId(currentRun.id)}` : "Run inspector"}
        footer={run && <RunActions mutation={mutation} onAction={(action) => action === "cancel" ? setCancelConfirmationOpen(true) : void changeRunState(action)} run={run} />}
        navigation={<Tabs activeTab={inspectorTab} ariaLabel="Run inspector sections" idPrefix="run-inspector" onChange={setInspectorTab} tabs={[{ id: "overview", label: "Overview" }, { id: "deliveries", label: "Deliveries", meta: currentRun?.totalTargets }]} />}
        onClose={closeInspector}
        open={Boolean(selectedRunId)}
        title={currentRun?.campaignNameSnapshot ?? "Run inspector"}
      >
        {runLoading && !run && <p className="workspace-loading">Loading run details…</p>}
        {runError && <InlineAlert action={selectedRunId ? <Button onClick={() => void loadRun(selectedRunId)} size="sm">Retry</Button> : undefined} title="Run needs attention">{runError}</InlineAlert>}
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
    <details className="runs-message-snapshot"><summary>Message snapshot</summary><p>{run.text}</p></details>
  </div>;
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
      <SelectMenu
        id="run-delivery-status"
        label="Delivery status"
        onChange={onFilterChange}
        options={[{ label: "All statuses", value: "ALL" }, ...DELIVERY_STATUSES.map((status) => ({ label: runStatusLabel(status), value: status }))]}
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
