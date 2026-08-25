import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRuntimeConnection } from "@/app/RuntimeConnectionContext";
import {
  type GroupSelectionRow,
} from "@/features/groups/selection/GroupSelectionTable";
import { GroupSelectionPanel } from "@/features/groups/selection/GroupSelectionPanel";
import { useGroupDirectoryQuery } from "@/features/groups/selection/useGroupDirectoryQuery";
import {
  groupSelectionRowOrder,
  sameGroupSelection,
} from "@/features/groups/selection/group-selection";
import {
  RuntimeRequestError,
  type RuntimeCampaign,
  type RuntimeCampaignExecutionMode,
  type RuntimeCampaignPage,
  type RuntimeCampaignPreflight,
  type RuntimeCampaignRun,
  type RuntimeCampaignTarget,
  type RuntimeCampaignTargetSource,
  type RuntimeGroupList,
} from "@/shared/api/runtime-client";
import { AppIcon } from "@/shared/ui/AppIcon";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";
import { DateTime } from "@/shared/ui/DateTime";
import { DropdownMenuItem } from "@/shared/ui/DropdownMenu";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { OverflowMenu } from "@/shared/ui/OverflowMenu";
import { PageHeader } from "@/shared/ui/PageHeader";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import { Tabs } from "@/shared/ui/Tabs";
import { TablePagination } from "@/shared/ui/TablePagination";
import { TextAreaField } from "@/shared/ui/TextAreaField";
import { TextField } from "@/shared/ui/TextField";
import { useToast } from "@/shared/ui/Toast";
import {
  WorkspaceDrawer,
  WorkspaceEmptyState,
  WorkspaceFooter,
  WorkspaceSectionHeader,
  WorkspaceSummaryCard,
} from "@/shared/ui/WorkspaceDrawer";
import { CampaignListToolbar } from "./CampaignListToolbar";
import { CampaignGroupListActions } from "./CampaignGroupListActions";
import {
  campaignListRequestKey,
  initialCampaignListState,
  type CampaignListRequestState,
} from "./campaign-list-state";
import {
  campaignTargetDiff,
  campaignErrorMessage,
  campaignFormFromDto,
  createCampaignPayload,
  emptyCampaignForm,
  hasCampaignChanges,
  isPreflightStale,
  scheduleFieldError,
  updateCampaignPayload,
  validateCampaignForm,
  validateTargetReplacement,
  type CampaignFormErrors,
  type CampaignFormValues,
} from "./campaign-domain";
import "./campaigns.css";

type EditorState =
  | { kind: "closed" }
  | { campaign: RuntimeCampaign | null; kind: "open" };
type CampaignEditorTab = "details" | "targets" | "preflight";

const PAGE_SIZE = 50;
const NON_TERMINAL_RUN_STATUSES = new Set<RuntimeCampaignRun["status"]>([
  "PREPARING",
  "BLOCKED",
  "SCHEDULED",
  "RUNNING",
  "PAUSED",
]);
const SCHEDULE_OPTIONS = [
  {
    description: "No scheduled timestamp.",
    label: "Immediate",
    value: "IMMEDIATE",
  },
  {
    description: "Send at one scheduled time.",
    label: "Once",
    value: "ONCE",
  },
] as const;
const PREFLIGHT_MODE_OPTIONS = [
  {
    description: "Evaluate the campaign as a simulation.",
    label: "Dry run",
    value: "DRY_RUN",
  },
  {
    description: "Apply live policy without creating a run or sending messages.",
    label: "Live policy",
    value: "LIVE",
  },
] as const;

const PREFLIGHT_CHECK_LABELS: Partial<Record<RuntimeCampaignPreflight["checks"][number]["code"], string>> = {
  CONTENT_VALID: "Campaign content",
  GROUP_CAPABILITY: "Group capability",
  LIVE_SEND_ALLOWED: "Live sending policy",
  SESSION_SENDABLE: "Runtime session",
  TARGETS_VALID: "Target set",
};

const PREFLIGHT_ISSUE_LABELS: Partial<Record<RuntimeCampaignPreflight["targetIssues"][number]["reason"], string>> = {
  TARGET_CAPABILITY_DENIED: "Sending is denied",
  TARGET_CAPABILITY_STALE: "Capability data is stale",
  TARGET_CAPABILITY_UNKNOWN: "Capability is unknown",
};

function statusTone(status: "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED") {
  if (status === "DRAFT") return "neutral" as const;
  if (status === "ACTIVE") return "success" as const;
  if (status === "PAUSED") return "warning" as const;
  return "neutral" as const;
}

function statusLabel(status: "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED") {
  return status.charAt(0) + status.slice(1).toLocaleLowerCase();
}

function reportTone(status: "PASS" | "WARN" | "BLOCK") {
  if (status === "PASS") return "success" as const;
  if (status === "WARN") return "warning" as const;
  return "danger" as const;
}

function preflightStatusPresentation(status: RuntimeCampaignPreflight["status"]) {
  if (status === "PASS") return {
    description: "Runtime found no blocking policy issues for these persisted revisions.",
    icon: "check" as const,
    title: "Ready to continue",
  };
  if (status === "WARN") return {
    description: "Runtime allows this revision set, but the warnings below should be reviewed first.",
    icon: "triangle-alert" as const,
    title: "Review warnings",
  };
  return {
    description: "Runtime blocked this revision set. Resolve the blocking checks before continuing.",
    icon: "circle-alert" as const,
    title: "Action required",
  };
}

function executionModeLabel(mode: RuntimeCampaignExecutionMode): string {
  return mode === "DRY_RUN" ? "Dry run" : "Live policy";
}

function preflightCheckStatusLabel(status: RuntimeCampaignPreflight["checks"][number]["status"]): string {
  return status.charAt(0) + status.slice(1).toLocaleLowerCase();
}

function runTone(status: RuntimeCampaignRun["status"]) {
  if (status === "COMPLETED" || status === "RUNNING") return "success" as const;
  if (status === "SCHEDULED" || status === "PAUSED" || status === "PREPARING") return "warning" as const;
  if (status === "BLOCKED" || status === "PARTIAL_FAILED" || status === "FAILED") return "danger" as const;
  return "neutral" as const;
}

function campaignDeleteDisabledReason(
  campaign: RuntimeCampaign,
  knownRuns: readonly RuntimeCampaignRun[] = [],
): string | null {
  if (knownRuns.some((run) => NON_TERMINAL_RUN_STATUSES.has(run.status))) {
    return "This campaign still has an unfinished run.";
  }
  if (campaign.status === "ACTIVE" || campaign.status === "PAUSED") {
    return "Cancel the active run and archive the campaign before deleting it.";
  }
  return null;
}

function CampaignActionsMenu({
  campaign,
  disabledReason,
  onDelete,
  onOpen,
}: {
  campaign: RuntimeCampaign;
  disabledReason: string | null;
  onDelete: (campaign: RuntimeCampaign) => void;
  onOpen?: (campaign: RuntimeCampaign) => void;
}) {
  const openLabel = campaign.status === "DRAFT" ? "Edit campaign" : "Review campaign";
  return (
    <OverflowMenu
      ariaLabel={`Actions for ${campaign.name}`}
      triggerLabel={`More actions for ${campaign.name}`}
    >
      {onOpen && (
        <DropdownMenuItem
          description={campaign.status === "DRAFT"
            ? "Edit campaign details, targets, and preflight."
            : "Review campaign details, targets, runs, and preflight."}
          icon={campaign.status === "DRAFT" ? "edit" : "view"}
          onSelect={() => onOpen(campaign)}
        >
          {openLabel}
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        danger
        description={disabledReason ?? "Remove this campaign from the workspace. Run and delivery history will be retained."}
        disabled={Boolean(disabledReason)}
        icon="trash"
        onSelect={() => onDelete(campaign)}
      >
        Delete campaign
      </DropdownMenuItem>
    </OverflowMenu>
  );
}

export function CampaignsScreen({ onOpenRun }: { onOpenRun?: (runId: string) => void } = {}) {
  const { connected, selectedSessionId } = useRuntimeConnection();
  const toast = useToast();
  if (!connected) throw new Error("CampaignsScreen requires a Runtime connection");

  const api = connected.api;
  const [campaignPage, setCampaignPage] = useState<RuntimeCampaignPage | null>(null);
  const [listState, setListState] = useState(() => initialCampaignListState(selectedSessionId));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>({ kind: "closed" });
  const [editorTab, setEditorTab] = useState<CampaignEditorTab>("details");
  const [discardConfirmationOpen, setDiscardConfirmationOpen] = useState(false);
  const [form, setForm] = useState<CampaignFormValues>(emptyCampaignForm);
  const [formErrors, setFormErrors] = useState<CampaignFormErrors>({});
  const [savingDetails, setSavingDetails] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [targets, setTargets] = useState<RuntimeCampaignTarget[]>([]);
  const [draftTargetIds, setDraftTargetIds] = useState<string[]>([]);
  const [targetsRevision, setTargetsRevision] = useState<number | null>(null);
  const [targetSource, setTargetSource] = useState<RuntimeCampaignTargetSource | null>(null);
  const [targetsLoading, setTargetsLoading] = useState(false);
  const [targetsSaving, setTargetsSaving] = useState(false);
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [targetNotice, setTargetNotice] = useState<string | null>(null);
  const [revisionRefreshRequired, setRevisionRefreshRequired] = useState(false);
  const [preflightMode, setPreflightMode] = useState<RuntimeCampaignExecutionMode>("DRY_RUN");
  const [preflight, setPreflight] = useState<RuntimeCampaignPreflight | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RuntimeCampaignRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runMutation, setRunMutation] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [liveLaunchConfirmationOpen, setLiveLaunchConfirmationOpen] = useState(false);
  const [deleteIntent, setDeleteIntent] = useState<RuntimeCampaign | null>(null);
  const [deletingCampaign, setDeletingCampaign] = useState(false);
  const [campaignDeleteError, setCampaignDeleteError] = useState<string | null>(null);
  const createKeyRef = useRef<string | null>(null);
  const launchKeyRef = useRef<{ key: string; mode: RuntimeCampaignExecutionMode } | null>(null);
  const editorEpochRef = useRef(0);
  const targetRequestRef = useRef(0);
  const runRequestRef = useRef(0);
  const targetsRevisionRef = useRef<number | null>(null);
  const listRequestRef = useRef(0);
  const deleteRequestRef = useRef(0);
  const listTargetRef = useRef(campaignListRequestKey(listState));
  const pageKeyRef = useRef("");
  const errorKeyRef = useRef("");
  const listStateRef = useRef(listState);
  const currentListRequestKey = campaignListRequestKey(listState);
  listTargetRef.current = currentListRequestKey;
  listStateRef.current = listState;
  targetsRevisionRef.current = targetsRevision;

  const campaign = editor.kind === "open" ? editor.campaign : null;
  const campaignId = campaign?.id ?? null;
  const editable = !campaign || campaign.status === "DRAFT";
  const detailsDirty = campaign ? hasCampaignChanges(campaign, form) : true;
  const groupDirectory = useGroupDirectoryQuery({
    api,
    enabled: Boolean(campaignId),
    scopeKey: campaignId ? `${campaignId}:${editorEpochRef.current}` : "closed",
    sessionId: selectedSessionId,
  });
  const targetIds = useMemo(() => targets.map((target) => target.groupId), [targets]);
  const targetDiff = useMemo(
    () => campaignTargetDiff(targetIds, draftTargetIds),
    [draftTargetIds, targetIds],
  );
  const targetById = useMemo(
    () => new Map(targets.map((target) => [target.groupId, target])),
    [targets],
  );
  const draftTargetIdSet = useMemo(() => new Set(draftTargetIds), [draftTargetIds]);
  const reviewTargetIds = useMemo(() => [
    ...draftTargetIds,
    ...targetIds.filter((groupId) => !draftTargetIdSet.has(groupId)),
  ], [draftTargetIdSet, draftTargetIds, targetIds]);
  const groupPageIds = useMemo(
    () => groupDirectory.groups.map((group) => group.id),
    [groupDirectory.groups],
  );
  const targetRowOrder = useMemo(
    () => groupSelectionRowOrder(reviewTargetIds, groupPageIds),
    [groupPageIds, reviewTargetIds],
  );
  const targetRows = useMemo(() => {
    return targetRowOrder.rowIds.flatMap<GroupSelectionRow>((groupId) => {
      const group = groupDirectory.knownGroups[groupId];
      const target = targetById.get(groupId);
      const sendCapability = group?.sendCapability ?? target?.sendCapability;
      if (!sendCapability) return [];
      return [{
        groupId,
        groupName: target?.groupName ?? group?.name ?? groupId,
        isActive: group?.isActive ?? target?.enabled ?? true,
        participantsCount: group?.participantsCount ?? null,
        sendCapability,
      }];
    });
  }, [groupDirectory.knownGroups, targetById, targetRowOrder]);
  const pinnedTargetIds = targetRowOrder.pinnedIds;
  const targetsDirty = !sameGroupSelection(targetIds, draftTargetIds);
  const reportStale = Boolean(
    preflight
    && campaign
    && (detailsDirty || targetsDirty || revisionRefreshRequired || isPreflightStale(preflight, campaign)),
  );
  const hasEditorChanges = campaign
    ? detailsDirty || targetsDirty
    : Boolean(form.name || form.text || form.scheduledAt || form.scheduleType !== "IMMEDIATE");

  const loadCampaigns = useCallback(async (state: CampaignListRequestState) => {
    if (!state.sessionId) return;
    const request = ++listRequestRef.current;
    const requestKey = campaignListRequestKey(state);
    setListLoading(true);
    setListError(null);
    try {
      const page = await api.listCampaigns({
        sessionId: state.sessionId,
        limit: PAGE_SIZE,
        offset: state.offset,
        ...(state.query ? { query: state.query } : {}),
        ...(state.statuses.length ? { statuses: state.statuses } : {}),
        ...(state.scheduleTypes.length ? { scheduleTypes: state.scheduleTypes } : {}),
      });
      if (request !== listRequestRef.current || requestKey !== listTargetRef.current) return;
      if (state.offset > 0 && page.data.length === 0 && page.meta.total <= state.offset) {
        const lastOffset = page.meta.total === 0
          ? 0
          : Math.floor((page.meta.total - 1) / PAGE_SIZE) * PAGE_SIZE;
        if (page.meta.total === 0) {
          setCampaignPage({ data: [...page.data], meta: { ...page.meta } });
          pageKeyRef.current = requestKey;
        }
        setListState((current) => campaignListRequestKey(current) === requestKey
          ? { ...current, offset: lastOffset }
          : current);
        return;
      }
      setCampaignPage({ data: [...page.data], meta: { ...page.meta } });
      pageKeyRef.current = requestKey;
    } catch (error) {
      if (request !== listRequestRef.current || requestKey !== listTargetRef.current) return;
      errorKeyRef.current = requestKey;
      setListError(campaignErrorMessage(error, "Could not load campaigns."));
    } finally {
      if (request === listRequestRef.current && requestKey === listTargetRef.current) {
        setListLoading(false);
      }
    }
  }, [api]);

  useEffect(() => {
    if (listState.sessionId === selectedSessionId) return;
    listRequestRef.current += 1;
    editorEpochRef.current += 1;
    pageKeyRef.current = "";
    errorKeyRef.current = "";
    setEditor({ kind: "closed" });
    setDiscardConfirmationOpen(false);
    setCampaignPage(null);
    setListState(initialCampaignListState(selectedSessionId));
    setFiltersOpen(false);
    setListLoading(false);
    setListError(null);
    targetRequestRef.current += 1;
    runRequestRef.current += 1;
    launchKeyRef.current = null;
    setTargetsLoading(false);
    setTargetsSaving(false);
    setRunsLoading(false);
    setRunMutation(null);
    setLiveLaunchConfirmationOpen(false);
    deleteRequestRef.current += 1;
    setDeleteIntent(null);
    setDeletingCampaign(false);
    setCampaignDeleteError(null);
    setPreflight(null);
  }, [listState.sessionId, selectedSessionId]);

  useEffect(() => {
    if (listState.sessionId !== selectedSessionId || !listState.sessionId) return;
    void loadCampaigns(listStateRef.current);
  }, [currentListRequestKey, listState.sessionId, loadCampaigns, selectedSessionId]);

  useEffect(() => {
    const normalizedQuery = listState.inputQuery.trim();
    const timeout = window.setTimeout(() => {
      setListState((current) => current.inputQuery === listState.inputQuery
        && current.query !== normalizedQuery
        ? { ...current, offset: 0, query: normalizedQuery }
        : current);
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [listState.inputQuery]);

  useEffect(() => () => {
    listRequestRef.current += 1;
    listTargetRef.current = "";
    editorEpochRef.current += 1;
    targetRequestRef.current += 1;
    runRequestRef.current += 1;
    deleteRequestRef.current += 1;
  }, []);

  async function loadTargets(campaignId: string, epoch: number, preserveError = false) {
    const request = ++targetRequestRef.current;
    setTargetsLoading(true);
    if (!preserveError) setTargetsError(null);
    try {
      const result = await api.listCampaignTargets(campaignId);
      if (epoch !== editorEpochRef.current || request !== targetRequestRef.current) return;
      setTargets(result.data);
      setDraftTargetIds(result.data.map((target) => target.groupId));
      setTargetsRevision(result.targetsRevision);
      setTargetSource(result.source);
    } catch (error) {
      if (epoch !== editorEpochRef.current || request !== targetRequestRef.current) return;
      setTargetsError(campaignErrorMessage(error, "Could not load campaign targets."));
    } finally {
      if (epoch === editorEpochRef.current && request === targetRequestRef.current) setTargetsLoading(false);
    }
  }

  async function loadRuns(campaignId: string, epoch: number, refreshCampaign = false) {
    const request = ++runRequestRef.current;
    setRunsLoading(true);
    setRunError(null);
    try {
      const page = await api.listCampaignRuns(campaignId, 20, 0);
      if (epoch !== editorEpochRef.current || request !== runRequestRef.current) return;
      setRuns(page.data);
      if (refreshCampaign) {
        const refreshed = await api.getCampaign(campaignId);
        if (
          epoch !== editorEpochRef.current
          || request !== runRequestRef.current
          || refreshed.sessionId !== selectedSessionId
        ) return;
        setEditor({ campaign: refreshed, kind: "open" });
        setForm(campaignFormFromDto(refreshed));
        if (targetsRevisionRef.current !== refreshed.targetsRevision) {
          void loadTargets(campaignId, epoch);
        }
        void loadCampaigns(listStateRef.current);
      }
    } catch (error) {
      if (epoch !== editorEpochRef.current || request !== runRequestRef.current) return;
      setRunError(campaignErrorMessage(error, "Could not load campaign runs."));
    } finally {
      if (epoch === editorEpochRef.current && request === runRequestRef.current) setRunsLoading(false);
    }
  }

  function openCreate() {
    editorEpochRef.current += 1;
    createKeyRef.current = null;
    launchKeyRef.current = null;
    setEditor({ campaign: null, kind: "open" });
    setEditorTab("details");
    setForm(emptyCampaignForm());
    setFormErrors({});
    setDetailsError(null);
    setTargets([]);
    setDraftTargetIds([]);
    setTargetsRevision(null);
    setTargetSource(null);
    setTargetNotice(null);
    setRevisionRefreshRequired(false);
    setTargetsLoading(false);
    setTargetsSaving(false);
    setRuns([]);
    setRunsLoading(false);
    setRunMutation(null);
    setRunError(null);
    setLiveLaunchConfirmationOpen(false);
    setPreflightMode("DRY_RUN");
    setPreflight(null);
    setPreflightError(null);
    setDeleteIntent(null);
    setDeletingCampaign(false);
    setCampaignDeleteError(null);
  }

  function openCampaign(selected: RuntimeCampaign) {
    const epoch = ++editorEpochRef.current;
    createKeyRef.current = null;
    launchKeyRef.current = null;
    setEditor({ campaign: selected, kind: "open" });
    setEditorTab("details");
    setForm(campaignFormFromDto(selected));
    setFormErrors({});
    setDetailsError(null);
    setTargets([]);
    setDraftTargetIds([]);
    setTargetsRevision(selected.targetsRevision);
    setTargetSource(null);
    setTargetNotice(null);
    setRevisionRefreshRequired(false);
    setTargetsLoading(false);
    setTargetsSaving(false);
    setPreflight(null);
    setPreflightError(null);
    setPreflightMode("DRY_RUN");
    setRuns([]);
    setRunsLoading(false);
    setRunMutation(null);
    setRunError(null);
    setLiveLaunchConfirmationOpen(false);
    setDeleteIntent(null);
    setDeletingCampaign(false);
    setCampaignDeleteError(null);
    void loadTargets(selected.id, epoch);
    void loadRuns(selected.id, epoch);
  }

  function closeEditor() {
    editorEpochRef.current += 1;
    targetRequestRef.current += 1;
    runRequestRef.current += 1;
    createKeyRef.current = null;
    launchKeyRef.current = null;
    setEditor({ kind: "closed" });
    setTargetsRevision(null);
    setTargetSource(null);
    setRuns([]);
    setRunsLoading(false);
    setRunMutation(null);
    setRunError(null);
    setLiveLaunchConfirmationOpen(false);
    setTargetsLoading(false);
    setTargetsSaving(false);
    setPreflight(null);
    setDiscardConfirmationOpen(false);
    setDeleteIntent(null);
    setDeletingCampaign(false);
    setCampaignDeleteError(null);
  }

  function removeCampaignFromPage(campaignId: string) {
    setCampaignPage((current) => {
      if (!current) return current;
      const data = current.data.filter((item) => item.id !== campaignId);
      const removed = data.length !== current.data.length;
      return {
        data,
        meta: { ...current.meta, total: Math.max(0, current.meta.total - (removed ? 1 : 0)) },
      };
    });
  }

  function requestCampaignDelete(snapshot: RuntimeCampaign) {
    const knownRuns = campaign?.id === snapshot.id ? runs : [];
    if (campaignDeleteDisabledReason(snapshot, knownRuns)) return;
    setDeleteIntent(snapshot);
    setCampaignDeleteError(null);
  }

  async function refreshCampaignDeleteContext(campaignId: string): Promise<RuntimeCampaign | null> {
    const detailOpen = editor.kind === "open" && editor.campaign?.id === campaignId;
    const epoch = editorEpochRef.current;
    const request = ++runRequestRef.current;
    if (detailOpen) setRunsLoading(true);
    try {
      const [refreshed, runPage] = await Promise.all([
        api.getCampaign(campaignId),
        api.listCampaignRuns(campaignId, 20, 0),
      ]);
      if (
        epoch !== editorEpochRef.current
        || request !== runRequestRef.current
        || refreshed.sessionId !== selectedSessionId
      ) return null;
      if (detailOpen && editor.kind === "open" && editor.campaign?.id === campaignId) {
        setEditor({ campaign: refreshed, kind: "open" });
        setForm(campaignFormFromDto(refreshed));
        setRuns(runPage.data);
        setPreflight((current) => current && isPreflightStale(current, refreshed) ? null : current);
        if (targetsRevisionRef.current !== refreshed.targetsRevision) {
          void loadTargets(campaignId, epoch);
        }
      }
      void loadCampaigns(listStateRef.current);
      return refreshed;
    } catch {
      if (epoch === editorEpochRef.current) void loadCampaigns(listStateRef.current);
      return null;
    } finally {
      if (detailOpen && epoch === editorEpochRef.current && request === runRequestRef.current) {
        setRunsLoading(false);
      }
    }
  }

  async function deleteCampaign() {
    if (!deleteIntent || deletingCampaign) return;
    const snapshot = deleteIntent;
    const knownRuns = campaign?.id === snapshot.id ? runs : [];
    if (campaignDeleteDisabledReason(snapshot, knownRuns)) return;
    const request = ++deleteRequestRef.current;
    setDeletingCampaign(true);
    setCampaignDeleteError(null);
    try {
      await api.deleteCampaign(snapshot.id, snapshot.revision, snapshot.targetsRevision);
      if (request !== deleteRequestRef.current) return;
      setDeleteIntent(null);
      if (campaign?.id === snapshot.id) closeEditor();
      removeCampaignFromPage(snapshot.id);
      void loadCampaigns(listStateRef.current);
      toast.notify({
        description: "Message delivery history was retained.",
        id: `campaign-deleted-${snapshot.id}`,
        title: "Campaign deleted",
        tone: "success",
      });
    } catch (error) {
      if (request !== deleteRequestRef.current) return;
      const requestError = error instanceof RuntimeRequestError ? error : null;
      const code = requestError?.code;
      if (code === "CAMPAIGN_NOT_FOUND" || requestError?.status === 404) {
        setDeleteIntent(null);
        if (campaign?.id === snapshot.id) closeEditor();
        removeCampaignFromPage(snapshot.id);
        void loadCampaigns(listStateRef.current);
        toast.notify({
          description: "This item no longer exists or is no longer available.",
          id: `campaign-unavailable-${snapshot.id}`,
          title: "Campaign unavailable",
          tone: "warning",
        });
      } else if (code === "CAMPAIGN_REVISION_CONFLICT") {
        setDeleteIntent(null);
        await refreshCampaignDeleteContext(snapshot.id);
        toast.notify({
          description: "The campaign changed. Review it before deleting.",
          id: `campaign-delete-revision-${snapshot.id}`,
          title: "Delete not confirmed",
          tone: "warning",
        });
      } else if (code === "CAMPAIGN_DELETE_STATE_CONFLICT") {
        setDeleteIntent(null);
        await refreshCampaignDeleteContext(snapshot.id);
        toast.notify({
          description: "Cancel the active run and archive the campaign before deleting it.",
          id: `campaign-delete-state-${snapshot.id}`,
          title: "Campaign cannot be deleted",
          tone: "warning",
        });
      } else if (code === "CAMPAIGN_DELETE_RUN_CONFLICT") {
        setDeleteIntent(null);
        const refreshed = await refreshCampaignDeleteContext(snapshot.id);
        const detailWasOpen = campaign?.id === snapshot.id;
        toast.notify({
          action: refreshed
            ? <Button onClick={() => {
                if (!detailWasOpen) openCampaign(refreshed);
                setEditorTab("preflight");
              }} size="sm">View runs</Button>
            : undefined,
          description: "This campaign still has an unfinished run. Cancel it or wait for it to finish.",
          id: `campaign-delete-run-${snapshot.id}`,
          title: "Campaign cannot be deleted",
          tone: "warning",
        });
      } else {
        setCampaignDeleteError("The campaign could not be deleted. Check the Runtime connection and try again.");
      }
    } finally {
      if (request === deleteRequestRef.current) setDeletingCampaign(false);
    }
  }

  function cancelCampaignDelete() {
    if (deletingCampaign) return;
    setDeleteIntent(null);
    setCampaignDeleteError(null);
  }

  function requestCloseEditor() {
    if (hasEditorChanges) setDiscardConfirmationOpen(true);
    else closeEditor();
  }

  function updateForm<K extends keyof CampaignFormValues>(
    field: K,
    value: CampaignFormValues[K],
  ) {
    setForm((current) => ({ ...current, [field]: value }));
    setFormErrors((current) => ({ ...current, [field]: undefined }));
  }

  function resetDetailsToSaved() {
    if (!campaign) return;
    setForm(campaignFormFromDto(campaign));
    setFormErrors({});
    setDetailsError(null);
  }

  async function saveDetails() {
    if (!selectedSessionId || !editable) return;
    const validation = validateCampaignForm(form);
    setFormErrors(validation);
    if (Object.keys(validation).length) return;

    const epoch = editorEpochRef.current;
    setSavingDetails(true);
    setDetailsError(null);
    try {
      let saved: RuntimeCampaign;
      if (!campaign) {
        createKeyRef.current ??= crypto.randomUUID();
        saved = await api.createCampaign(
          createCampaignPayload(selectedSessionId, form),
          createKeyRef.current,
        );
      } else {
        const payload = updateCampaignPayload(campaign, form);
        if (!Object.keys(payload).length) return;
        saved = await api.updateCampaign(campaign.id, payload);
      }
      if (epoch !== editorEpochRef.current || saved.sessionId !== selectedSessionId) return;
      const created = !campaign;
      setEditor({ campaign: saved, kind: "open" });
      setForm(campaignFormFromDto(saved));
      setPreflight(null);
      createKeyRef.current = null;
      void loadCampaigns(listStateRef.current);
      if (created) {
        const targetEpoch = editorEpochRef.current;
        void loadTargets(saved.id, targetEpoch);
        setEditorTab("targets");
      }
      toast.notify({
        id: `campaign-saved-${saved.id}`,
        title: created ? "Campaign draft created" : "Campaign details saved",
        tone: "success",
      });
    } catch (error) {
      if (epoch !== editorEpochRef.current) return;
      const scheduledAt = scheduleFieldError(error);
      if (error instanceof RuntimeRequestError) {
        setFormErrors((current) => ({
          ...current,
          name: error.fieldErrors.name?.[0] ?? current.name,
          scheduledAt: scheduledAt ?? current.scheduledAt,
          text: error.fieldErrors.text?.[0] ?? current.text,
        }));
      } else if (scheduledAt) {
        setFormErrors((current) => ({ ...current, scheduledAt }));
      }
      setDetailsError(campaignErrorMessage(error, "Could not save campaign details."));
    } finally {
      if (epoch === editorEpochRef.current) setSavingDetails(false);
    }
  }

  function toggleTarget(groupId: string) {
    if (!draftTargetIdSet.has(groupId) && draftTargetIds.length >= 1_000) {
      setTargetsError(campaignErrorMessage(
        { code: "CAMPAIGN_TARGET_LIMIT_EXCEEDED" },
        "Campaign targets are limited to 1,000 unique groups.",
      ));
      return;
    }
    setDraftTargetIds((current) => current.includes(groupId)
      ? current.filter((candidate) => candidate !== groupId)
      : [...current, groupId]);
    setTargetsError(null);
    setTargetNotice(null);
  }

  async function applyGroupList(list: RuntimeGroupList): Promise<{
    message: string;
    ok: boolean;
    reloadLists?: boolean;
  }> {
    setTargetNotice(null);
    if (
      !campaign
      || targetsRevision === null
      || list.sessionId !== campaign.sessionId
      || list.archivedAt !== null
    ) {
      return { message: "This group list is not available in the campaign session.", ok: false };
    }
    const epoch = editorEpochRef.current;
    const request = ++targetRequestRef.current;
    const identity = {
      campaignId: campaign.id,
      campaignRevision: campaign.revision,
      groupListId: list.id,
      membershipRevision: list.membershipRevision,
      sessionId: campaign.sessionId,
      targetsRevision,
    };
    setTargetsSaving(true);
    setTargetsError(null);
    try {
      const canonical = await api.applyGroupListToCampaignTargets(campaign.id, {
        groupListId: list.id,
        expectedMembershipRevision: list.membershipRevision,
        expectedTargetsRevision: targetsRevision,
      });
      if (
        epoch !== editorEpochRef.current
        || request !== targetRequestRef.current
        || editor.kind !== "open"
        || editor.campaign?.id !== identity.campaignId
        || editor.campaign.sessionId !== identity.sessionId
        || editor.campaign.revision !== identity.campaignRevision
        || targetsRevisionRef.current !== identity.targetsRevision
        || canonical.source?.groupListId !== identity.groupListId
        || canonical.source.membershipRevision !== identity.membershipRevision
      ) return { message: "The editor changed while the list was applying. Reload targets before continuing.", ok: false };
      setTargets(canonical.data);
      setDraftTargetIds(canonical.data.map((target) => target.groupId));
      setTargetsRevision(canonical.targetsRevision);
      setTargetSource(canonical.source);
      setEditor({ campaign: {
        ...campaign,
        targetCount: canonical.data.length,
        targetsRevision: canonical.targetsRevision,
      }, kind: "open" });
      setPreflight(null);
      setRevisionRefreshRequired(false);
      setTargetNotice(`${canonical.source.groupListNameSnapshot} membership revision ${canonical.source.membershipRevision} was applied as the persisted target snapshot.`);
      void loadCampaigns(listStateRef.current);
      return { message: "Group list applied.", ok: true };
    } catch (error) {
      if (epoch !== editorEpochRef.current || request !== targetRequestRef.current) {
        return { message: "The editor changed while the list was applying.", ok: false };
      }
      const code = error instanceof RuntimeRequestError ? error.code : null;
      const message = campaignErrorMessage(error, "Could not apply the group list.");
      setTargetsError(message);
      if (code === "CAMPAIGN_TARGETS_REVISION_CONFLICT") {
        setTargetsSaving(false);
        void loadTargets(campaign.id, epoch, true);
      }
      return {
        message,
        ok: false,
        reloadLists: code === "CAMPAIGN_TARGET_SOURCE_REVISION_CONFLICT",
      };
    } finally {
      if (epoch === editorEpochRef.current && request === targetRequestRef.current) {
        setTargetsSaving(false);
      }
    }
  }

  function toggleAllPageTargets() {
    const selecting = !groupPageIds.every((groupId) => draftTargetIdSet.has(groupId));
    if (selecting && new Set([...draftTargetIds, ...groupPageIds]).size > 1_000) {
      setTargetsError(campaignErrorMessage(
        { code: "CAMPAIGN_TARGET_LIMIT_EXCEEDED" },
        "Campaign targets are limited to 1,000 unique groups.",
      ));
      return;
    }
    setDraftTargetIds((current) => {
      const pageIds = new Set(groupPageIds);
      if (groupPageIds.every((groupId) => current.includes(groupId))) {
        return current.filter((groupId) => !pageIds.has(groupId));
      }
      const next = [...current];
      groupPageIds.forEach((groupId) => {
        if (!next.includes(groupId)) next.push(groupId);
      });
      return next;
    });
    setTargetsError(null);
    setTargetNotice(null);
  }

  function resetTargetsToSaved() {
    setDraftTargetIds(targetIds);
    setTargetsError(null);
    setTargetNotice("Staged selection reset to the saved target set.");
  }

  async function saveTargets() {
    if (!campaign || !editable || targetsRevision === null) return;
    const validation = validateTargetReplacement(draftTargetIds);
    if (!validation.ok) {
      setTargetsError(campaignErrorMessage({ code: validation.code }, "Invalid target set."));
      return;
    }
    const epoch = editorEpochRef.current;
    const request = ++targetRequestRef.current;
    const expectedRevision = targetsRevision;
    setTargetsSaving(true);
    setTargetsError(null);
    try {
      const canonical = await api.replaceCampaignTargets(
        campaign.id,
        validation.groupIds,
        expectedRevision,
      );
      if (
        epoch !== editorEpochRef.current
        || request !== targetRequestRef.current
        || targetsRevisionRef.current !== expectedRevision
      ) return;
      setTargets(canonical.data);
      setDraftTargetIds(canonical.data.map((target) => target.groupId));
      setTargetsRevision(canonical.targetsRevision);
      setTargetSource(canonical.source);
      setTargetNotice(null);
      setPreflight(null);
      setEditor({ campaign: {
        ...campaign,
        targetCount: canonical.data.length,
        targetsRevision: canonical.targetsRevision,
      }, kind: "open" });
      setRevisionRefreshRequired(false);
      void loadCampaigns(listStateRef.current);
      toast.notify({ id: `targets-saved-${campaign.id}`, title: "Target set saved", tone: "success" });
    } catch (error) {
      if (epoch !== editorEpochRef.current || request !== targetRequestRef.current) return;
      setTargetsError(campaignErrorMessage(error, "Could not replace campaign targets."));
      if (error instanceof RuntimeRequestError && error.code === "CAMPAIGN_TARGETS_REVISION_CONFLICT") {
        setTargetsSaving(false);
        void loadTargets(campaign.id, epoch, true);
      }
    } finally {
      if (epoch === editorEpochRef.current && request === targetRequestRef.current) {
        setTargetsSaving(false);
      }
    }
  }

  async function runPreflight(executionMode: RuntimeCampaignExecutionMode) {
    if (!campaign || targetsRevision === null || detailsDirty || targetsDirty || revisionRefreshRequired) return;
    const epoch = editorEpochRef.current;
    const campaignId = campaign.id;
    const campaignRevision = campaign.revision;
    const expectedTargetsRevision = targetsRevision;
    launchKeyRef.current = null;
    setPreflightLoading(true);
    setPreflightError(null);
    try {
      const report = await api.preflightCampaign(campaignId, executionMode);
      if (
        epoch !== editorEpochRef.current
        || editor.kind !== "open"
        || editor.campaign?.id !== campaignId
        || editor.campaign.sessionId !== selectedSessionId
        || report.campaignRevision !== campaignRevision
        || report.targetsRevision !== expectedTargetsRevision
      ) return;
      setPreflight(report);
    } catch (error) {
      if (epoch !== editorEpochRef.current) return;
      setPreflightError(campaignErrorMessage(error, "Could not run preflight."));
    } finally {
      if (epoch === editorEpochRef.current) setPreflightLoading(false);
    }
  }

  function changePreflightMode(executionMode: RuntimeCampaignExecutionMode) {
    setPreflightMode(executionMode);
    if (preflight?.executionMode !== executionMode) setPreflight(null);
    launchKeyRef.current = null;
    setPreflightError(null);
  }

  async function refreshCampaignAfterRun(campaignId: string, epoch: number, request: number) {
    const refreshed = await api.getCampaign(campaignId);
    if (
      epoch !== editorEpochRef.current
      || request !== runRequestRef.current
      || refreshed.sessionId !== selectedSessionId
    ) return;
    setEditor({ campaign: refreshed, kind: "open" });
    setForm(campaignFormFromDto(refreshed));
    setPreflight((current) => current && isPreflightStale(current, refreshed) ? null : current);
    void loadTargets(campaignId, epoch);
    void loadCampaigns(listStateRef.current);
  }

  async function launchRun(executionMode: RuntimeCampaignExecutionMode) {
    if (
      !campaign
      || targetsRevision === null
      || !preflight
      || reportStale
      || preflight.status === "BLOCK"
      || preflight.executionMode !== executionMode
      || (executionMode === "LIVE" && !preflight.liveLaunchToken)
    ) return;
    const epoch = editorEpochRef.current;
    const request = ++runRequestRef.current;
    const identity = {
      campaignId: campaign.id,
      campaignRevision: campaign.revision,
      sessionId: campaign.sessionId,
      targetsRevision,
    };
    if (!launchKeyRef.current || launchKeyRef.current.mode !== executionMode) {
      launchKeyRef.current = { key: crypto.randomUUID(), mode: executionMode };
    }
    const key = launchKeyRef.current.key;
    setLiveLaunchConfirmationOpen(false);
    setRunMutation(`launch:${executionMode}`);
    setRunError(null);
    try {
      const run = await api.createCampaignRun(campaign.id, {
        executionMode,
        expectedCampaignRevision: campaign.revision,
        expectedTargetsRevision: targetsRevision,
        ...(executionMode === "LIVE" ? { preflightToken: preflight.liveLaunchToken! } : {}),
      }, key);
      if (
        epoch !== editorEpochRef.current
        || request !== runRequestRef.current
        || editor.kind !== "open"
        || editor.campaign?.id !== identity.campaignId
        || editor.campaign.sessionId !== identity.sessionId
        || editor.campaign.revision !== identity.campaignRevision
        || targetsRevisionRef.current !== identity.targetsRevision
      ) return;
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      launchKeyRef.current = null;
      if (executionMode === "LIVE") {
        await refreshCampaignAfterRun(campaign.id, epoch, request);
      }
      toast.notify({
        id: `campaign-run-${run.id}`,
        title: executionMode === "LIVE" ? "Live campaign launched" : "Dry run created",
        tone: "success",
      });
    } catch (error) {
      if (epoch !== editorEpochRef.current || request !== runRequestRef.current) return;
      const code = error instanceof RuntimeRequestError ? error.code : null;
      setRunError(campaignErrorMessage(error, "Could not create campaign run."));
      if (
        code === "CAMPAIGN_RUN_REVISION_CONFLICT"
        || code === "CAMPAIGN_RUN_PREFLIGHT_REQUIRED"
        || code === "CAMPAIGN_RUN_PREFLIGHT_INVALID"
      ) {
        launchKeyRef.current = null;
        setPreflight(null);
        await refreshCampaignAfterRun(campaign.id, epoch, request);
      } else if (code === "CAMPAIGN_RUN_LAUNCH_CONFLICT") {
        await refreshCampaignAfterRun(campaign.id, epoch, request);
        setRunMutation(null);
        void loadRuns(campaign.id, epoch);
      }
    } finally {
      if (epoch === editorEpochRef.current && request === runRequestRef.current) setRunMutation(null);
    }
  }

  async function changeRunState(run: RuntimeCampaignRun, action: "pause" | "resume" | "cancel") {
    if (!campaign) return;
    const epoch = editorEpochRef.current;
    const request = ++runRequestRef.current;
    const campaignId = campaign.id;
    setRunMutation(`${action}:${run.id}`);
    setRunError(null);
    try {
      const updated = action === "pause"
        ? await api.pauseCampaignRun(run.id)
        : action === "resume"
          ? await api.resumeCampaignRun(run.id)
          : await api.cancelCampaignRun(run.id);
      if (
        epoch !== editorEpochRef.current
        || request !== runRequestRef.current
        || updated.campaignId !== campaignId
      ) return;
      setRuns((current) => current.map((item) => item.id === updated.id ? updated : item));
      await refreshCampaignAfterRun(campaignId, epoch, request);
    } catch (error) {
      if (epoch !== editorEpochRef.current || request !== runRequestRef.current) return;
      setRunError(campaignErrorMessage(error, `Could not ${action} campaign run.`));
      if (error instanceof RuntimeRequestError && error.code === "CAMPAIGN_RUN_STATE_CONFLICT") {
        try {
          const canonical = await api.getCampaignRun(run.id);
          if (epoch === editorEpochRef.current && request === runRequestRef.current) {
            setRuns((current) => current.map((item) => item.id === canonical.id ? canonical : item));
            await refreshCampaignAfterRun(campaignId, epoch, request);
          }
        } catch {
          // Preserve the typed conflict; a manual retry can reload the run list.
        }
      }
    } finally {
      if (epoch === editorEpochRef.current && request === runRequestRef.current) setRunMutation(null);
    }
  }

  const visiblePage = pageKeyRef.current === currentListRequestKey ? campaignPage : null;
  const visibleListError = errorKeyRef.current === currentListRequestKey ? listError : null;
  const listPending = listLoading || Boolean(selectedSessionId && !visiblePage && !visibleListError);
  const total = visiblePage?.meta.total ?? 0;
  const pageOffset = visiblePage?.meta.offset ?? listState.offset;
  const pageLimit = visiblePage?.meta.limit ?? PAGE_SIZE;
  const firstItem = total === 0 ? 0 : pageOffset + 1;
  const lastItem = Math.min(pageOffset + (visiblePage?.data.length ?? 0), total);
  const hasListCriteria = Boolean(
    listState.query || listState.statuses.length || listState.scheduleTypes.length,
  );
  const targetChangeState = targetsLoading
    ? "Loading saved targets…"
    : targetsSaving
      ? "Saving complete target set…"
      : targetsError && targetsDirty
        ? `Changes not saved · ${targetDiff.savedCount} saved targets retained`
        : targetsDirty
          ? `${targetDiff.savedCount} saved → ${targetDiff.selectedCount} staged · +${targetDiff.addedIds.length} / −${targetDiff.removedIds.length}`
          : targetDiff.savedCount === 0
            ? "Empty target set · No unsaved changes"
            : `${targetDiff.savedCount} saved target${targetDiff.savedCount === 1 ? "" : "s"} · No unsaved changes`;
  const footerState = editorTab === "details"
    ? campaign
      ? detailsDirty
        ? `Campaign r${campaign.revision} · Unsaved changes`
        : `Campaign r${campaign.revision} · All changes saved`
      : "Create the draft to unlock targets and preflight"
    : editorTab === "targets"
      ? targetChangeState
      : reportStale ? "Run preflight again after saving changes" : preflight ? `Last result: ${preflight.status}` : "No preflight result yet";
  const editorStep = editorTab === "details" ? 1 : editorTab === "targets" ? 2 : 3;
  const editorStepLabel = editorTab === "details" ? "Details" : editorTab === "targets" ? "Targets" : "Preflight";
  const detailDeleteReason = campaign ? campaignDeleteDisabledReason(campaign, runs) : null;
  const deleteIntentDisabledReason = deleteIntent
    ? campaignDeleteDisabledReason(deleteIntent, campaign?.id === deleteIntent.id ? runs : [])
    : null;
  const footerAction = editorTab === "details" ? (
    <>
      {campaign && <Button disabled={!editable || !detailsDirty || savingDetails} onClick={resetDetailsToSaved} variant="ghost">Reset to saved</Button>}
      <Button disabled={!editable || savingDetails || (Boolean(campaign) && !detailsDirty)} loading={savingDetails} onClick={() => void saveDetails()} variant="primary">
        {campaign ? "Save details" : "Create draft"}
      </Button>
    </>
  ) : editorTab === "targets" ? (
    <><Button disabled={!campaign || !editable || !targetsDirty || targetsLoading || targetsSaving} onClick={resetTargetsToSaved} variant="ghost">Reset to saved</Button><Button disabled={!campaign || !editable || !targetsDirty || targetsLoading} loading={targetsSaving} onClick={() => void saveTargets()} variant="primary">Save target set</Button></>
  ) : (
    <Button disabled={!campaign || detailsDirty || targetsDirty || revisionRefreshRequired || Boolean(runMutation)} loading={preflightLoading} onClick={() => void runPreflight(preflightMode)} variant="primary">Run preflight</Button>
  );

  return (
    <div className="campaigns-screen stack stack-lg">
      <PageHeader
        actions={<Button disabled={!selectedSessionId} onClick={openCreate} variant="primary">New campaign</Button>}
        description="Create campaign drafts, materialize target snapshots, review policy, and manage Runtime launch lifecycle."
        title="Campaigns"
        titleId="campaigns-title"
      />
      <div className="data-table-container campaign-list-panel">
        <CampaignListToolbar
          filtersOpen={filtersOpen}
          firstItem={firstItem}
          lastItem={lastItem}
          loading={listPending}
          setFiltersOpen={setFiltersOpen}
          setState={setListState}
          state={listState}
          total={total}
        />
        {visibleListError && <InlineAlert action={<Button onClick={() => void loadCampaigns(listStateRef.current)} size="sm">Retry</Button>} className="data-table-error" title="Could not load campaigns">{visibleListError}</InlineAlert>}
        <div className="data-table-scroll">
          <table>
            <caption>Campaigns for the active session</caption>
            <thead><tr><th scope="col">Campaign</th><th scope="col">Status</th><th scope="col">Schedule</th><th scope="col">Targets</th><th aria-label="Actions" className="data-column-actions" scope="col" /></tr></thead>
            <tbody>
              {!selectedSessionId ? <tr><td className="data-table-empty" colSpan={5}>Select a session to view campaigns.</td></tr>
                : !visiblePage && listPending ? <tr><td className="data-table-empty" colSpan={5}>Loading campaigns…</td></tr>
                : !visiblePage && visibleListError ? <tr><td className="data-table-empty" colSpan={5}>Campaigns are unavailable.</td></tr>
                : !visiblePage?.data.length ? <tr><td className="data-table-empty" colSpan={5}>{hasListCriteria ? "No campaigns match this search or filters." : "No campaigns yet. Create a draft to get started."}</td></tr>
                : visiblePage.data.map((item) => <tr key={item.id}>
                  <td className="data-cell-primary"><div className="stack stack-xs"><button className="data-primary-action" onClick={() => openCampaign(item)} title={`Open ${item.name}`} type="button">{item.name}</button><span className="data-identifier">{item.id}</span></div></td>
                  <td><Badge tone={statusTone(item.status)}>{statusLabel(item.status)}</Badge></td>
                  <td>{item.scheduleType === "IMMEDIATE" ? "Immediate" : <DateTime value={item.scheduledAt} />}</td>
                  <td>{item.targetCount}</td>
                  <td className="data-cell-action"><CampaignActionsMenu campaign={item} disabledReason={campaignDeleteDisabledReason(item)} onDelete={requestCampaignDelete} onOpen={openCampaign} /></td>
                </tr>)}
            </tbody>
          </table>
        </div>
        <TablePagination
          limit={pageLimit}
          loading={listPending}
          offset={pageOffset}
          onOffsetChange={(nextOffset) => setListState((current) => ({ ...current, offset: nextOffset }))}
          total={total}
        />
      </div>

      <WorkspaceDrawer
        contentKey={`${campaign?.id ?? "new"}:${editorEpochRef.current}:${editorTab}`}
        description={campaign
          ? "Edit persisted details, targets, and Runtime readiness in sequence."
          : "Step 1 of 3 · Define content and delivery timing."}
        eyebrow="Campaign workspace"
        footer={editor.kind === "open" && <WorkspaceFooter actions={footerAction} description={footerState} leading={campaign ? <CampaignActionsMenu campaign={campaign} disabledReason={detailDeleteReason} onDelete={requestCampaignDelete} /> : undefined} title={`Step ${editorStep} of 3 · ${editorStepLabel}`} />}
        navigation={editor.kind === "open" && (
          <Tabs
            activeTab={editorTab}
            appearance="steps"
            ariaLabel="Campaign editor sections"
            idPrefix="campaign-editor"
            onChange={setEditorTab}
            tabs={[
              { id: "details", label: "Details", step: 1, warning: Boolean(campaign && detailsDirty) },
              { disabled: !campaign, id: "targets", label: "Targets", meta: campaign ? draftTargetIds.length : undefined, step: 2, warning: Boolean(campaign && targetsDirty) },
              { disabled: !campaign, id: "preflight", label: "Preflight", meta: preflight?.status, step: 3, warning: reportStale },
            ]}
          />
        )}
        notice={editor.kind === "open" && campaign && campaign.status !== "DRAFT"
          ? <InlineAlert title="Read-only campaign" tone="warning">Runtime status is {statusLabel(campaign.status)}; only draft campaigns are editable.</InlineAlert>
          : undefined}
        onClose={requestCloseEditor}
        open={editor.kind === "open"}
        size="wide"
        title={campaign?.name ?? "New campaign draft"}
      >
        {editor.kind === "open" && (
          <div className="campaign-editor">
            {editorTab === "details" && <section aria-labelledby="campaign-editor-details-tab" className="campaign-tab-panel stack stack-lg" id="campaign-editor-details-panel" role="tabpanel">
              <WorkspaceSectionHeader description="Define the message draft and when Runtime should schedule it." kicker="Step 1 · Required" title="Content & schedule" />
              {detailsError && <InlineAlert title="Could not save details">{detailsError}</InlineAlert>}
              <WorkspaceSummaryCard
                description={campaign ? "Content and timing stored by Runtime." : "Complete the required fields to create this draft."}
                dirty={Boolean(campaign && detailsDirty)}
                icon="campaigns"
                label="Campaign configuration"
                metrics={[
                  { label: "Revision", value: campaign ? `r${campaign.revision}` : "—" },
                  { label: "Schedule", value: form.scheduleType === "IMMEDIATE" ? "Immediate" : "Once" },
                  { label: "Message", value: `${form.text.length} chars` },
                ]}
                status={!campaign ? <Badge>New draft</Badge> : detailsDirty ? <Badge tone="warning">Unsaved changes</Badge> : <Badge tone="success">Saved</Badge>}
                title={campaign ? "Persisted details" : "New campaign draft"}
                titleId="campaign-details-card-title"
              >
                <section aria-labelledby="campaign-content-title" className="workspace-summary-section stack stack-md">
                  <div className="campaign-form-section-heading"><div><h4 id="campaign-content-title">Message content</h4><p>Name this campaign and prepare the plain-text message used by future runs.</p></div></div>
                  <TextField error={formErrors.name} disabled={!editable} label="Campaign name" onChange={(event) => updateForm("name", event.target.value)} value={form.name} />
                  <TextAreaField description={<span className="campaign-message-description"><span>Plain-text message used by future campaign runs.</span><span>{form.text.length} characters</span></span>} disabled={!editable} error={formErrors.text} label="Message text" onChange={(event) => updateForm("text", event.target.value)} rows={5} value={form.text} />
                </section>
                <section aria-labelledby="campaign-timing-title" className="workspace-summary-section stack stack-md">
                  <div className="campaign-form-section-heading"><div><h4 id="campaign-timing-title">Delivery timing</h4><p>Choose when Runtime should make this campaign eligible to run.</p></div><span>Managed by Runtime</span></div>
                  <div className="campaign-details-timing-grid">
                    <SelectMenu description={form.scheduleType === "IMMEDIATE" ? "Send when a campaign run begins." : "Send at the scheduled date and time."} disabled={!editable} label="Schedule" onChange={(scheduleType) => updateForm("scheduleType", scheduleType)} options={SCHEDULE_OPTIONS} value={form.scheduleType} />
                    {form.scheduleType === "ONCE" && <TextField description="Displayed in your local time and stored by Runtime in UTC." disabled={!editable} error={formErrors.scheduledAt} label="Scheduled date and time" min={new Date().toISOString().slice(0, 16)} onChange={(event) => updateForm("scheduledAt", event.target.value)} type="datetime-local" value={form.scheduledAt} />}
                  </div>
                </section>
              </WorkspaceSummaryCard>
            </section>}

            {editorTab === "targets" && <section aria-labelledby="campaign-editor-targets-tab" className="campaign-tab-panel stack stack-md" id="campaign-editor-targets-panel" role="tabpanel">
              <WorkspaceSectionHeader description="Build the complete group target set · maximum 1,000." kicker="Step 2 · Persisted set" title="Target groups" />
              {!campaign && <InlineAlert title="Create the draft first" tone="info">Targets belong to a persisted campaign.</InlineAlert>}
              {campaign && <>
                {targetsError && <InlineAlert title="Target update">{targetsError}</InlineAlert>}
                {!targetsLoading && targetsRevision !== null && <WorkspaceSummaryCard
                  description={targetSource ? "Materialized from a saved list; this is not a live link." : "Maintained directly for this campaign."}
                  dirty={targetsDirty}
                  icon="groups"
                  label="Target snapshot"
                  metrics={[
                    { label: "Saved", value: targetDiff.savedCount },
                    { label: "Staged", value: targetDiff.selectedCount },
                    { label: "Revision", value: `r${targetsRevision}` },
                  ]}
                  status={targetsDirty ? <Badge tone="warning">Unsaved changes</Badge> : undefined}
                  title={targetSource ? `From group list: ${targetSource.groupListNameSnapshot}` : "Custom selection"}
                  titleId="campaign-target-snapshot-title"
                >
                  <footer className="workspace-summary-footer">
                    <span>{targetSource
                      ? <>Membership r{targetSource.membershipRevision} · Applied <DateTime value={targetSource.appliedAt} /></>
                      : targets.length === 0
                        ? "No groups are currently persisted."
                        : "Manual target replacement keeps this snapshot custom."}</span>
                    <strong>{targetsDirty ? `+${targetDiff.addedIds.length} added · −${targetDiff.removedIds.length} removed` : "No unsaved changes"}</strong>
                  </footer>
                  {targetSource && targetsDirty && <div className="campaign-target-provenance-warning"><AppIcon name="triangle-alert" size="xs" /><span><strong>Saving creates a custom selection.</strong> The source group list remains unchanged.</span></div>}
                </WorkspaceSummaryCard>}
                <section aria-labelledby="campaign-group-list-action-title" className="campaign-target-source-action">
                  <div><h4 id="campaign-group-list-action-title">Apply a group list</h4><p>Replace the saved target set immediately with a reusable list snapshot.</p>{targetsDirty && <small>Save or reset manual changes before applying a list.</small>}</div>
                  <CampaignGroupListActions api={api} campaignId={campaign.id} disabled={!editable || targetsLoading || targetsSaving || targetsDirty} onApply={applyGroupList} sessionId={campaign.sessionId} />
                </section>
                <GroupSelectionPanel
                  afterToolbar={<>{targetNotice && <InlineAlert title="Persisted target snapshot" tone="success">{targetNotice}</InlineAlert>}{groupDirectory.error && <InlineAlert action={<Button onClick={groupDirectory.retry} size="sm">Retry</Button>} title="Could not load groups">{groupDirectory.error}</InlineAlert>}</>}
                  description="Search and filter the Runtime directory. Saved and selected groups remain visible."
                  headingLevel="h4"
                  pageNote={!groupDirectory.loading && groupDirectory.groups.length === 0 && targetRows.length > 0 ? groupDirectory.hasCriteria ? "No additional synchronized groups match this search or filters. Selected and saved targets remain visible above." : "No additional synchronized groups are available. Selected and saved targets remain visible above." : undefined}
                  pagination={{ limit: groupDirectory.pageSize, loading: groupDirectory.loading, offset: groupDirectory.offset, onOffsetChange: groupDirectory.setOffset, total: groupDirectory.total }}
                  summary={targetDiff.selectedCount >= 900 ? <Badge tone={targetDiff.selectedCount >= 1_000 ? "danger" : "warning"}>{targetDiff.selectedCount > 1_000 ? `${targetDiff.selectedCount - 1_000} over limit` : targetDiff.selectedCount === 1_000 ? "Limit reached" : `${1_000 - targetDiff.selectedCount} remaining`}</Badge> : undefined}
                  table={{ caption: "Groups available to the campaign target selection", disabled: !editable || targetsLoading || targetsSaving, emptyMessage: groupDirectory.hasCriteria ? "No synchronized groups match this search or filters." : "No synchronized groups found.", loading: groupDirectory.loading || targetsLoading, onToggle: toggleTarget, onTogglePage: toggleAllPageTargets, pageIds: groupPageIds, pinnedIds: pinnedTargetIds, rows: targetRows, selectedIds: draftTargetIdSet, unknownParticipantsTitle: "Participant count is unavailable in the saved target snapshot." }}
                  title="Browse groups"
                  titleId="campaign-target-group-directory-title"
                  toolbar={{ filterAriaLabel: "Target group filters", filterTitle: "Filter target groups", filters: groupDirectory.filters, filtersOpen: groupDirectory.filtersOpen, idPrefix: "campaign-target", inputQuery: groupDirectory.inputQuery, loading: groupDirectory.loading, onFiltersChange: groupDirectory.setFilters, onFiltersOpenChange: groupDirectory.setFiltersOpen, onParticipantErrorsClear: () => groupDirectory.setParticipantErrors({}), onSearchChange: groupDirectory.setSearch, pageItemCount: groupDirectory.groups.length, pageOffset: groupDirectory.offset, participantErrors: groupDirectory.participantErrors, total: groupDirectory.total }}
                />
              </>}
            </section>}

            {editorTab === "preflight" && <section aria-labelledby="campaign-editor-preflight-tab" className="campaign-tab-panel stack stack-md" id="campaign-editor-preflight-panel" role="tabpanel">
              <WorkspaceSectionHeader description="Evaluate persisted revisions, then explicitly create a dry or live run." kicker="Step 3 · Review & launch" title="Readiness review" />
              {!campaign && <InlineAlert title="Create the draft first" tone="info">Preflight requires a persisted campaign.</InlineAlert>}
              {campaign && <>
                {(detailsDirty || targetsDirty) && <InlineAlert title="Save before preflight" tone="warning">Preflight reads persisted Runtime state, not unsaved edits.</InlineAlert>}
                {revisionRefreshRequired && <InlineAlert title="Revision refresh required" tone="warning">Reopen this campaign before running preflight.</InlineAlert>}
                <section aria-labelledby="preflight-configuration-title" className="campaign-preflight-setup">
                  <div className="campaign-preflight-setup-heading">
                    <span className="campaign-preflight-setup-icon"><AppIcon name="settings" size="sm" /></span>
                    <div><h4 id="preflight-configuration-title">Review configuration</h4><p>Choose the Runtime policy context for this persisted campaign snapshot.</p></div>
                  </div>
                  <div className="campaign-preflight-mode"><SelectMenu description="This evaluates policy only. It does not create a run or send messages." disabled={preflightLoading || Boolean(runMutation)} label="Preflight mode" onChange={changePreflightMode} options={PREFLIGHT_MODE_OPTIONS} value={preflightMode} /></div>
                  <div className="campaign-preflight-basis" aria-label="Persisted revisions under review"><span>Review basis</span><strong>Campaign r{campaign.revision} · targets r{targetsRevision ?? campaign.targetsRevision}</strong></div>
                </section>
                {preflightError && <InlineAlert title="Preflight failed">{preflightError}</InlineAlert>}
                {preflight && <PreflightReport report={preflight} stale={reportStale} />}
                {!preflight && !preflightError && <WorkspaceEmptyState className="campaign-preflight-empty" icon="activity" title="Ready for evaluation">Run preflight to receive Runtime's authoritative readiness decision for the persisted revisions above.</WorkspaceEmptyState>}
                {runError && <InlineAlert title="Campaign run update">{runError}</InlineAlert>}
                {campaign.status === "DRAFT" && preflight && !reportStale && preflight.status !== "BLOCK" && <section className="campaign-launch-panel">
                  <span className="campaign-launch-icon"><AppIcon name="runs" size="md" /></span><div><strong>{preflight.executionMode === "DRY_RUN" ? "Create a dry run" : "Launch this campaign"}</strong><p>Use campaign r{preflight.campaignRevision} and targets r{preflight.targetsRevision}. Runtime verifies both revisions again.</p></div>
                  {preflight.executionMode === "DRY_RUN"
                    ? <Button disabled={Boolean(runMutation)} loading={runMutation === "launch:DRY_RUN"} onClick={() => void launchRun("DRY_RUN")} variant="primary">Create dry run</Button>
                    : <Button disabled={Boolean(runMutation)} loading={runMutation === "launch:LIVE"} onClick={() => setLiveLaunchConfirmationOpen(true)} variant="primary">Launch live campaign</Button>}
                </section>}
                <CampaignRunsPanel
                  campaignStatus={campaign.status}
                  loading={runsLoading}
                  mutation={runMutation}
                  onAction={changeRunState}
                  onReload={() => void loadRuns(campaign.id, editorEpochRef.current, true)}
                  onOpenRun={onOpenRun}
                  runs={runs}
                />
              </>}
            </section>}
          </div>
        )}
      </WorkspaceDrawer>
      <ConfirmationDialog
        body="Unsaved campaign details or target selections will be discarded. Persisted Runtime data is not changed."
        cancelLabel="Keep editing"
        confirmLabel="Discard changes"
        confirmVariant="danger"
        onCancel={() => setDiscardConfirmationOpen(false)}
        onConfirm={closeEditor}
        open={discardConfirmationOpen}
        title="Discard campaign changes?"
      />
      <ConfirmationDialog
        body="Create the single LIVE run for these reviewed campaign and target revisions? Runtime may begin or schedule real message delivery, and the campaign will become read-only."
        cancelLabel="Keep reviewing"
        confirmLabel="Launch live campaign"
        onCancel={() => setLiveLaunchConfirmationOpen(false)}
        onConfirm={() => void launchRun("LIVE")}
        open={liveLaunchConfirmationOpen}
        title="Launch LIVE campaign?"
      />
      <ConfirmationDialog
        body={<><p>Campaign “{deleteIntent?.name}” will be removed from the workspace. Run and message delivery history will remain available for audit. You cannot undo this action in WA Studio.</p>{campaignDeleteError && <InlineAlert title="Could not delete campaign">{campaignDeleteError}</InlineAlert>}</>}
        busy={deletingCampaign}
        busyLabel="Deleting…"
        cancelLabel="Cancel"
        confirmDisabled={Boolean(deleteIntentDisabledReason)}
        confirmLabel="Delete campaign"
        confirmVariant="danger"
        onCancel={cancelCampaignDelete}
        onConfirm={() => void deleteCampaign()}
        open={Boolean(deleteIntent)}
        title="Delete campaign?"
      />
    </div>
  );
}

function CampaignRunsPanel({
  campaignStatus,
  loading,
  mutation,
  onAction,
  onReload,
  onOpenRun,
  runs,
}: {
  campaignStatus: RuntimeCampaign["status"];
  loading: boolean;
  mutation: string | null;
  onAction: (run: RuntimeCampaignRun, action: "pause" | "resume" | "cancel") => void;
  onReload: () => void;
  onOpenRun?: (runId: string) => void;
  runs: RuntimeCampaignRun[];
}) {
  const terminal = new Set<RuntimeCampaignRun["status"]>([
    "COMPLETED",
    "PARTIAL_FAILED",
    "CANCELLED",
    "FAILED",
  ]);
  return <section className="campaign-runs-panel stack stack-sm" aria-label="Campaign runs">
    <header><div><h3>Campaign runs</h3><p>Campaign lifecycle: {statusLabel(campaignStatus)}. Run status remains an independent execution state.</p></div><Button disabled={loading || Boolean(mutation)} loading={loading} onClick={onReload} size="sm" variant="ghost">Reload runs</Button></header>
    {!loading && !runs.length && <p className="campaign-run-empty">No campaign runs yet.</p>}
    {runs.map((run) => <article className="campaign-run-card" key={run.id}>
      <div className="campaign-run-card-main">
        <div><Badge tone={runTone(run.status)}>{run.status}</Badge><Badge tone="neutral">{run.executionMode}</Badge></div>
        <strong>{run.totalTargets} target snapshot</strong>
        <span><DateTime value={run.createdAt} /> · {run.id}</span>
        {run.targetSource && <small>From saved list: {run.targetSource.groupListNameSnapshot} · membership r{run.targetSource.membershipRevision} · applied <DateTime value={run.targetSource.appliedAt} /></small>}
        {run.statusReason && <small>{run.statusReason}</small>}
      </div>
      <div className="campaign-run-card-actions">
        {onOpenRun && <Button disabled={Boolean(mutation)} onClick={() => onOpenRun(run.id)} size="sm" variant="ghost">Open in Runs</Button>}
        {(run.status === "RUNNING" || run.status === "SCHEDULED") && <Button disabled={Boolean(mutation)} loading={mutation === `pause:${run.id}`} onClick={() => onAction(run, "pause")} size="sm">Pause</Button>}
        {(run.status === "PAUSED" || run.status === "BLOCKED") && <Button disabled={Boolean(mutation)} loading={mutation === `resume:${run.id}`} onClick={() => onAction(run, "resume")} size="sm">Resume</Button>}
        {!terminal.has(run.status) && <Button disabled={Boolean(mutation)} loading={mutation === `cancel:${run.id}`} onClick={() => onAction(run, "cancel")} size="sm" variant="ghost">Cancel</Button>}
      </div>
    </article>)}
  </section>;
}

function PreflightReport({ report, stale }: { report: RuntimeCampaignPreflight; stale: boolean }) {
  const presentation = preflightStatusPresentation(report.status);
  return (
    <section aria-label="Preflight result" className="preflight-report" data-status={report.status.toLocaleLowerCase()} data-stale={stale || undefined}>
      {stale && <InlineAlert title="Preflight result is stale" tone="warning">Campaign details or targets changed. Run preflight again.</InlineAlert>}
      <header className="preflight-result-header">
        <span className="preflight-result-icon"><AppIcon name={presentation.icon} size="lg" /></span>
        <div className="preflight-result-copy"><span>Runtime decision</span><div><h4>{presentation.title}</h4><Badge tone={reportTone(report.status)}>{report.status}</Badge></div><p>{presentation.description}</p></div>
      </header>
      <dl className="preflight-context">
        <div><dt>Mode</dt><dd>{executionModeLabel(report.executionMode)}</dd></div>
        <div><dt>Policy</dt><dd>Policy v{report.policyVersion}</dd></div>
        <div><dt>Checked</dt><dd><DateTime value={report.checkedAt} /></dd></div>
        <div><dt>Revisions</dt><dd>Campaign r{report.campaignRevision} · targets r{report.targetsRevision}</dd></div>
      </dl>
      <section aria-labelledby="preflight-target-assessment-title" className="preflight-evidence-panel">
        <header><div><h4 id="preflight-target-assessment-title">Target assessment</h4><p>Authoritative counters returned by Runtime.</p></div><Badge tone="neutral">{report.totalTargets} total</Badge></header>
        <dl className="preflight-metrics">
          <div><dt>Total</dt><dd>{report.totalTargets}</dd></div>
          <div data-tone="success"><dt>Allowed</dt><dd>{report.allowedTargets}</dd></div>
          <div data-tone="danger"><dt>Denied</dt><dd>{report.deniedTargets}</dd></div>
          <div data-tone="warning"><dt>Unknown</dt><dd>{report.unknownTargets}</dd></div>
        </dl>
      </section>
      <div className="preflight-columns">
        <section className="preflight-evidence-panel"><header><div><h4>Policy checks</h4><p>Each check contributes to Runtime's decision.</p></div><Badge tone="neutral">{report.checks.length}</Badge></header><ul>{report.checks.map((check) => <li key={check.code}><Badge className="preflight-check-status" tone={reportTone(check.status)}>{preflightCheckStatusLabel(check.status)}</Badge><span className="preflight-evidence-copy"><strong>{PREFLIGHT_CHECK_LABELS[check.code] ?? "Runtime policy check"}</strong><code>{check.code}</code><small>{check.message}</small></span></li>)}</ul></section>
        <section className="preflight-evidence-panel"><header><div><h4>Target issues</h4><p>Groups that require operator attention.</p></div><Badge tone={report.targetIssues.length ? "warning" : "success"}>{report.targetIssues.length}</Badge></header>{!report.targetIssues.length ? <div className="preflight-no-issues"><AppIcon name="check" size="sm" /><span>No target issues reported.</span></div> : <ul>{report.targetIssues.map((issue) => <li key={`${issue.groupId}-${issue.reason}`}><Badge tone={issue.capability === "DENIED" ? "danger" : "warning"}>{issue.capability}</Badge><span className="preflight-evidence-copy"><strong>{issue.groupName}</strong><small>{PREFLIGHT_ISSUE_LABELS[issue.reason] ?? "Runtime reported a target issue"}</small><code>{issue.reason}</code></span></li>)}</ul>}</section>
      </div>
    </section>
  );
}
