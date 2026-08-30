import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

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
  type RuntimeCreateCampaign,
  type RuntimeCampaign,
  type RuntimeCampaignExecutionMode,
  type RuntimeCampaignPage,
  type RuntimeCampaignPreflight,
  type RuntimeCampaignRun,
  type RuntimeCampaignTarget,
  type RuntimeCampaignTargetSource,
  type RuntimeGroupList,
  type RuntimeMediaAssetPolicy,
} from "@/shared/api/runtime-client";
import {
  isUnknownMutationOutcome,
  unknownMutationOutcomeMessage,
} from "@/shared/api/runtime-mutation";
import { useLatestRequest } from "@/shared/hooks/useLatestRequest";
import { useSingleFlightOperation } from "@/shared/hooks/useSingleFlightOperation";
import { useRuntimeResourceRevision } from "@/shared/server-state/runtime-invalidation";
import { reconciledPageOffset } from "@/shared/server-state/server-page";
import { AppIcon } from "@/shared/ui/AppIcon";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";
import { DataTableFrame, MetricGrid } from "@/shared/ui/Composition";
import { DataTable, DataTableEmptyCell, DataTableScroll } from "@/shared/ui/DataTable";
import { DateTime } from "@/shared/ui/DateTime";
import { DataTablePrimaryAction } from "@/shared/ui/DataTablePrimaryAction";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/shared/ui/DropdownMenu";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { OverflowMenu } from "@/shared/ui/OverflowMenu";
import { PageHeader } from "@/shared/ui/PageHeader";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import { TablePagination } from "@/shared/ui/TablePagination";
import { TextAreaField } from "@/shared/ui/TextAreaField";
import { TextField } from "@/shared/ui/TextField";
import { useToast } from "@/shared/ui/Toast";
import { WorkspaceDialog } from "@/shared/ui/WorkspaceDialog";
import {
  WorkspaceEmptyState,
  WorkspaceFooter,
  WorkspaceSectionHeader,
} from "@/shared/ui/WorkspaceDrawer";
import { WorkflowStepper } from "@/shared/ui/WorkflowStepper";
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
import {
  formatBytes,
  uploadCampaignMedia,
  type CampaignMediaUploadProgress,
} from "./campaign-media";
import "./campaigns.css";

type EditorState =
  | { kind: "closed" }
  | { campaign: RuntimeCampaign | null; kind: "open" };
type CampaignEditorTab = "details" | "targets" | "preflight";

interface CampaignCreateIntent {
  fingerprint: string;
  form: CampaignFormValues;
  key: string;
  outcomeUnknown: boolean;
  payload: RuntimeCreateCampaign;
}

interface CampaignMediaPreview {
  assetId: string;
  url: string;
}

const PAGE_SIZE = 50;
const NON_TERMINAL_RUN_STATUSES = new Set<RuntimeCampaignRun["status"]>([
  "PREPARING",
  "BLOCKED",
  "SCHEDULED",
  "RUNNING",
  "PAUSED",
  "CANCELLING",
]);
const SCHEDULE_OPTIONS = [
  {
    description: "Eligible when a campaign run begins.",
    label: "Immediate",
    value: "IMMEDIATE",
  },
  {
    description: "Eligible at the selected date and time.",
    label: "Once",
    value: "ONCE",
  },
] as const;
const CONTENT_TYPE_OPTIONS = [
  { description: "Plain-text WhatsApp message.", label: "Text", value: "TEXT" },
  { description: "JPEG, PNG, or WebP with an optional caption.", label: "Image", value: "IMAGE" },
] as const;
const PREFLIGHT_MODE_OPTIONS = [
  {
    label: "Dry run",
    value: "DRY_RUN",
  },
  {
    label: "Live policy",
    value: "LIVE",
  },
] as const;

const PREFLIGHT_CHECK_LABELS: Partial<Record<RuntimeCampaignPreflight["checks"][number]["code"], string>> = {
  CONTENT_VALID: "Campaign content",
  MEDIA_READY: "Media asset",
  GROUP_CAPABILITY: "Group capability",
  LIVE_SEND_ALLOWED: "Live sending policy",
  SESSION_SENDABLE: "Runtime session",
  SAFETY_READY: "OpenWA safety",
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

function statusLabel(status: string) {
  return status.split("_").map((part) => (
    part.charAt(0) + part.slice(1).toLocaleLowerCase()
  )).join(" ");
}

function reportTone(status: "PASS" | "WARN" | "BLOCK") {
  if (status === "PASS") return "success" as const;
  if (status === "WARN") return "warning" as const;
  return "danger" as const;
}

function preflightStatusPresentation(
  status: RuntimeCampaignPreflight["status"],
  executionMode: RuntimeCampaignExecutionMode,
) {
  if (status === "PASS") return {
    description: "Runtime found no blocking policy issues for these persisted revisions.",
    icon: "check" as const,
    title: "Ready to continue",
  };
  if (status === "WARN") return {
    description: executionMode === "LIVE"
      ? "Runtime reported warnings and did not issue live launch proof. Resolve them before launching."
      : "Runtime allows this dry-run simulation, but the warnings below should be reviewed first.",
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
  if (status === "SCHEDULED" || status === "PAUSED" || status === "PREPARING" || status === "CANCELLING") return "warning" as const;
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
        <>
          <DropdownMenuItem
            description={campaign.status === "DRAFT"
              ? "Change content, targets, and launch checks."
              : "Inspect content, targets, runs, and launch checks."}
            icon={campaign.status === "DRAFT" ? "edit" : "view"}
            onSelect={() => onOpen(campaign)}
          >
            {openLabel}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuItem
        danger
        description={disabledReason ?? "Remove the campaign. Run and delivery history stays available."}
        disabled={Boolean(disabledReason)}
        icon="trash"
        onSelect={() => onDelete(campaign)}
      >
        Delete campaign
      </DropdownMenuItem>
    </OverflowMenu>
  );
}

function CampaignMessagePreview({
  form,
  mediaPreview,
  mediaPreviewError,
  mediaPreviewLoading,
  onRetryPreview,
}: {
  form: CampaignFormValues;
  mediaPreview: CampaignMediaPreview | null;
  mediaPreviewError: string | null;
  mediaPreviewLoading: boolean;
  onRetryPreview: () => void;
}) {
  const message = form.text.trim();
  const characterLimit = form.contentType === "TEXT" ? 4_096 : 1_024;
  const previewUrl = form.mediaAsset && mediaPreview?.assetId === form.mediaAsset.id
    ? mediaPreview.url
    : null;

  return (
    <section
      aria-labelledby="campaign-message-preview-title"
      className="campaign-message-preview-panel"
    >
      <div className="campaign-message-preview-sticky">
        <header className="campaign-form-section-heading">
          <div>
            <span>Draft preview</span>
            <h4 id="campaign-message-preview-title">Message preview</h4>
            <p>Reflects the message payload currently staged in this editor.</p>
          </div>
        </header>
        <div className="campaign-message-preview-surface" data-content-type={form.contentType.toLocaleLowerCase()}>
          <div className="campaign-message-preview-canvas">
            {form.contentType === "TEXT" ? (
              message ? (
                <p className="campaign-message-preview-text">{message}</p>
              ) : (
                <div className="campaign-message-preview-empty">
                  <AppIcon name="campaigns" size="lg" />
                  <strong>No message text yet</strong>
                  <span>Enter message text to preview the outgoing payload.</span>
                </div>
              )
            ) : previewUrl && form.mediaAsset ? (
              <figure className="campaign-message-preview-media">
                <img alt={`Message preview: ${form.mediaAsset.filename}`} src={previewUrl} />
                <figcaption data-empty={!message || undefined}>
                  {message || "No caption"}
                </figcaption>
              </figure>
            ) : (
              <div
                className="campaign-message-preview-empty"
                data-tone={mediaPreviewError ? "danger" : undefined}
              >
                <AppIcon name={mediaPreviewError ? "triangle-alert" : "campaigns"} size="lg" />
                <strong>
                  {mediaPreviewLoading
                    ? "Loading image preview"
                    : mediaPreviewError
                      ? "Preview unavailable"
                      : form.mediaAsset
                        ? "Preparing image preview"
                        : "No image selected"}
                </strong>
                <span>
                  {mediaPreviewError
                    ?? (form.mediaAsset
                      ? "The verified image will appear here."
                      : "Choose an image to preview the outgoing payload.")}
                </span>
                {mediaPreviewError && <Button onClick={onRetryPreview} size="sm" variant="secondary">Retry preview</Button>}
              </div>
            )}
          </div>
          <footer className="campaign-message-preview-meta">
            <span>
              {form.contentType === "TEXT"
                ? "Text message"
                : form.mediaAsset
                  ? `Image · ${formatBytes(form.mediaAsset.byteSize)}`
                  : "Image message"}
            </span>
            <span>{form.text.length.toLocaleString("en-US")} / {characterLimit.toLocaleString("en-US")}</span>
          </footer>
        </div>
      </div>
    </section>
  );
}

export function CampaignsScreen({ onOpenRun }: { onOpenRun?: (runId: string) => void } = {}) {
  const { connected, selectedSessionId } = useRuntimeConnection();
  const toast = useToast();
  if (!connected) throw new Error("CampaignsScreen requires a Runtime connection");

  const api = connected.api;
  const campaignsResourceRevision = useRuntimeResourceRevision(["campaigns"], selectedSessionId);
  const runsResourceRevision = useRuntimeResourceRevision(["runs"], selectedSessionId);
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
  const [mediaPolicy, setMediaPolicy] = useState<RuntimeMediaAssetPolicy | null>(null);
  const [mediaPolicyLoading, setMediaPolicyLoading] = useState(false);
  const [mediaPolicyRequest, setMediaPolicyRequest] = useState(0);
  const [mediaUploadProgress, setMediaUploadProgress] = useState<CampaignMediaUploadProgress | null>(null);
  const [mediaUploadError, setMediaUploadError] = useState<string | null>(null);
  const [mediaPreview, setMediaPreview] = useState<CampaignMediaPreview | null>(null);
  const [mediaPreviewLoading, setMediaPreviewLoading] = useState(false);
  const [mediaPreviewError, setMediaPreviewError] = useState<string | null>(null);
  const [mediaPreviewRequest, setMediaPreviewRequest] = useState(0);
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
  const createIntentRef = useRef<CampaignCreateIntent | null>(null);
  const launchKeyRef = useRef<{ key: string; mode: RuntimeCampaignExecutionMode } | null>(null);
  const runActionKeyRef = useRef<{
    action: "pause" | "resume" | "cancel";
    key: string;
    runId: string;
  } | null>(null);
  const editorEpochRef = useRef(0);
  const targetRequestRef = useRef(0);
  const runRequestRef = useRef(0);
  const targetsRevisionRef = useRef<number | null>(null);
  const listRequestRef = useRef(0);
  const deleteRequestRef = useRef(0);
  const mediaFileInputRef = useRef<HTMLInputElement>(null);
  const mediaUploadAbortRef = useRef<AbortController | null>(null);
  const mediaPreviewRequestRef = useRef(0);
  const listTargetRef = useRef(campaignListRequestKey(listState));
  const pageKeyRef = useRef("");
  const errorKeyRef = useRef("");
  const listStateRef = useRef(listState);
  const editorRef = useRef(editor);
  const selectedSessionIdRef = useRef(selectedSessionId);
  const observedCampaignsRevisionRef = useRef(campaignsResourceRevision);
  const observedRunsRevisionRef = useRef(runsResourceRevision);
  const campaignsRead = useLatestRequest();
  const targetsRead = useLatestRequest();
  const runsRead = useLatestRequest();
  const mutationOperation = useSingleFlightOperation();
  const preflightOperation = useSingleFlightOperation();
  const currentListRequestKey = campaignListRequestKey(listState);
  listTargetRef.current = currentListRequestKey;
  listStateRef.current = listState;
  editorRef.current = editor;
  selectedSessionIdRef.current = selectedSessionId;
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
  const targetIdSet = useMemo(() => new Set(targetIds), [targetIds]);
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
        participantsCount: group?.participantsCount ?? target?.participantsCount ?? null,
        sendCapability,
      }];
    });
  }, [groupDirectory.knownGroups, targetById, targetRowOrder]);
  const outsideTargetResultIds = targetRowOrder.outsidePageIds;
  const targetsDirty = !sameGroupSelection(targetIds, draftTargetIds);
  const reportStale = Boolean(
    preflight
    && campaign
    && (detailsDirty || targetsDirty || revisionRefreshRequired || isPreflightStale(preflight, campaign)),
  );
  const hasEditorChanges = campaign
    ? detailsDirty || targetsDirty
    : Boolean(
      form.name
      || form.text
      || form.mediaAsset
      || form.contentType !== "TEXT"
      || form.scheduledAt
      || form.scheduleType !== "IMMEDIATE",
    );

  const loadCampaigns = useCallback(async (state: CampaignListRequestState, background = false) => {
    if (!state.sessionId) return;
    const request = ++listRequestRef.current;
    const signal = campaignsRead.begin();
    const requestKey = campaignListRequestKey(state);
    if (!background) setListLoading(true);
    setListError(null);
    try {
      const page = await api.listCampaigns({
        sessionId: state.sessionId,
        limit: PAGE_SIZE,
        offset: state.offset,
        ...(state.query ? { query: state.query } : {}),
        ...(state.statuses.length ? { statuses: state.statuses } : {}),
        ...(state.scheduleTypes.length ? { scheduleTypes: state.scheduleTypes } : {}),
      }, { signal });
      if (request !== listRequestRef.current || requestKey !== listTargetRef.current) return;
      const recoveredOffset = reconciledPageOffset({
        limit: PAGE_SIZE,
        offset: state.offset,
        rowCount: page.data.length,
        total: page.meta.total,
      });
      if (recoveredOffset !== null) {
        if (page.meta.total === 0) {
          setCampaignPage({ data: [...page.data], meta: { ...page.meta } });
          pageKeyRef.current = requestKey;
        }
        setListState((current) => campaignListRequestKey(current) === requestKey
          ? { ...current, offset: recoveredOffset }
          : current);
        return;
      }
      setCampaignPage({ data: [...page.data], meta: { ...page.meta } });
      pageKeyRef.current = requestKey;
    } catch (error) {
      if (signal.aborted) return;
      if (request !== listRequestRef.current || requestKey !== listTargetRef.current) return;
      errorKeyRef.current = requestKey;
      setListError(campaignErrorMessage(error, "Could not load campaigns."));
    } finally {
      campaignsRead.complete(signal);
      if (request === listRequestRef.current && requestKey === listTargetRef.current) {
        setListLoading(false);
      }
    }
  }, [api, campaignsRead]);

  useEffect(() => {
    if (listState.sessionId === selectedSessionId) return;
    mutationOperation.cancel();
    preflightOperation.cancel();
    campaignsRead.cancel();
    targetsRead.cancel();
    runsRead.cancel();
    listRequestRef.current += 1;
    editorEpochRef.current += 1;
    pageKeyRef.current = "";
    errorKeyRef.current = "";
    mediaUploadAbortRef.current?.abort();
    mediaUploadAbortRef.current = null;
    setMediaUploadProgress(null);
    setMediaUploadError(null);
    mediaPreviewRequestRef.current += 1;
    setMediaPreview(null);
    setMediaPreviewLoading(false);
    setMediaPreviewError(null);
    setEditor({ kind: "closed" });
    setDiscardConfirmationOpen(false);
    setCampaignPage(null);
    setListState(initialCampaignListState(selectedSessionId));
    setFiltersOpen(false);
    setListLoading(false);
    setListError(null);
    setSavingDetails(false);
    targetRequestRef.current += 1;
    runRequestRef.current += 1;
    createIntentRef.current = null;
    launchKeyRef.current = null;
    setTargetsLoading(false);
    setTargetsSaving(false);
    setPreflightLoading(false);
    setRunsLoading(false);
    setRunMutation(null);
    setLiveLaunchConfirmationOpen(false);
    deleteRequestRef.current += 1;
    setDeleteIntent(null);
    setDeletingCampaign(false);
    setCampaignDeleteError(null);
    setPreflight(null);
  }, [
    campaignsRead,
    listState.sessionId,
    mutationOperation,
    preflightOperation,
    runsRead,
    selectedSessionId,
    targetsRead,
  ]);

  useEffect(() => {
    if (listState.sessionId !== selectedSessionId || !listState.sessionId) return;
    void loadCampaigns(listStateRef.current);
  }, [currentListRequestKey, listState.sessionId, loadCampaigns, selectedSessionId]);

  useEffect(() => {
    if (observedCampaignsRevisionRef.current === campaignsResourceRevision) return;
    observedCampaignsRevisionRef.current = campaignsResourceRevision;
    if (listStateRef.current.sessionId === selectedSessionId) {
      void loadCampaigns(listStateRef.current, true);
    }
  }, [campaignsResourceRevision, loadCampaigns, selectedSessionId]);

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

  useEffect(() => {
    if (editor.kind !== "open" || form.contentType === "TEXT" || mediaPolicy) return;
    const controller = new AbortController();
    setMediaPolicyLoading(true);
    setMediaUploadError(null);
    void api.getCampaignMediaPolicy({ signal: controller.signal })
      .then(setMediaPolicy)
      .catch((error) => {
        if (!controller.signal.aborted) {
          setMediaUploadError(campaignErrorMessage(error, "Could not load media upload policy."));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setMediaPolicyLoading(false);
      });
    return () => controller.abort();
  }, [api, editor.kind, form.contentType, mediaPolicy, mediaPolicyRequest]);

  useEffect(() => () => {
    if (mediaPreview?.url) URL.revokeObjectURL(mediaPreview.url);
  }, [mediaPreview?.url]);

  useEffect(() => {
    const asset = form.mediaAsset;
    if (
      editor.kind !== "open"
      || !asset
      || asset.kind !== "IMAGE"
      || mediaPreview?.assetId === asset.id
    ) {
      setMediaPreviewLoading(false);
      if (!asset || mediaPreview?.assetId === asset.id) setMediaPreviewError(null);
      return;
    }

    const request = ++mediaPreviewRequestRef.current;
    const epoch = editorEpochRef.current;
    const controller = new AbortController();
    setMediaPreviewLoading(true);
    setMediaPreviewError(null);
    void api.getCampaignMediaContent(asset.id, { signal: controller.signal })
      .then((blob) => {
        if (
          controller.signal.aborted
          || request !== mediaPreviewRequestRef.current
          || epoch !== editorEpochRef.current
        ) return;
        const mimeType = blob.type.split(";", 1)[0]?.trim().toLocaleLowerCase();
        if (blob.size !== asset.byteSize || mimeType !== asset.mimeType.toLocaleLowerCase()) {
          throw new Error("Stored image response did not match its verified metadata.");
        }
        setMediaPreview({ assetId: asset.id, url: URL.createObjectURL(blob) });
      })
      .catch((error) => {
        if (
          controller.signal.aborted
          || request !== mediaPreviewRequestRef.current
          || epoch !== editorEpochRef.current
        ) return;
        setMediaPreviewError(campaignErrorMessage(error, "Could not load the saved image preview."));
      })
      .finally(() => {
        if (
          !controller.signal.aborted
          && request === mediaPreviewRequestRef.current
          && epoch === editorEpochRef.current
        ) setMediaPreviewLoading(false);
      });
    return () => controller.abort();
  }, [api, editor.kind, form.mediaAsset, mediaPreview?.assetId, mediaPreviewRequest]);

  useEffect(() => () => {
    mediaUploadAbortRef.current?.abort();
    listRequestRef.current += 1;
    listTargetRef.current = "";
    editorEpochRef.current += 1;
    targetRequestRef.current += 1;
    runRequestRef.current += 1;
    deleteRequestRef.current += 1;
    createIntentRef.current = null;
    launchKeyRef.current = null;
  }, []);

  useEffect(() => {
    if (!detailsDirty && !targetsDirty && !revisionRefreshRequired) return;
    preflightOperation.cancel();
    launchKeyRef.current = null;
    setPreflightLoading(false);
  }, [detailsDirty, preflightOperation, revisionRefreshRequired, targetsDirty]);

  async function loadTargets(campaignId: string, epoch: number, preserveError = false) {
    const request = ++targetRequestRef.current;
    const signal = targetsRead.begin();
    setTargetsLoading(true);
    if (!preserveError) setTargetsError(null);
    try {
      const result = await api.listCampaignTargets(campaignId, { signal });
      if (epoch !== editorEpochRef.current || request !== targetRequestRef.current) return;
      setTargets(result.data);
      setDraftTargetIds(result.data.map((target) => target.groupId));
      setTargetsRevision(result.targetsRevision);
      setTargetSource(result.source);
    } catch (error) {
      if (signal.aborted) return;
      if (epoch !== editorEpochRef.current || request !== targetRequestRef.current) return;
      setTargetsError(campaignErrorMessage(error, "Could not load campaign targets."));
    } finally {
      targetsRead.complete(signal);
      if (epoch === editorEpochRef.current && request === targetRequestRef.current) setTargetsLoading(false);
    }
  }

  async function reconcileTargetsAfterUnknownOutcome(
    campaignId: string,
    epoch: number,
    request: number,
  ) {
    try {
      const canonical = await api.listCampaignTargets(campaignId);
      if (
        epoch !== editorEpochRef.current
        || request !== targetRequestRef.current
      ) return;
      setTargets(canonical.data);
      setTargetsRevision(canonical.targetsRevision);
      setTargetSource(canonical.source);
      setEditor((current) => current.kind === "open" && current.campaign?.id === campaignId
        ? {
          campaign: {
            ...current.campaign,
            targetCount: canonical.data.length,
            targetsRevision: canonical.targetsRevision,
          },
          kind: "open",
        }
        : current);
      setPreflight(null);
      setRevisionRefreshRequired(false);
      void loadCampaigns(listStateRef.current);
    } catch {
      // Keep the unknown-outcome warning primary; the operator can reload later.
    }
  }

  async function loadRuns(
    campaignId: string,
    epoch: number,
    refreshCampaign = false,
    background = false,
  ) {
    const request = ++runRequestRef.current;
    const signal = runsRead.begin();
    if (!background) setRunsLoading(true);
    setRunError(null);
    try {
      const page = await api.listCampaignRuns(campaignId, 20, 0, { signal });
      if (epoch !== editorEpochRef.current || request !== runRequestRef.current) return;
      setRuns(page.data);
      if (refreshCampaign) {
        const refreshed = await api.getCampaign(campaignId, { signal });
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
      if (signal.aborted) return;
      if (epoch !== editorEpochRef.current || request !== runRequestRef.current) return;
      setRunError(campaignErrorMessage(error, "Could not load campaign runs."));
    } finally {
      runsRead.complete(signal);
      if (epoch === editorEpochRef.current && request === runRequestRef.current) {
        setRunsLoading(false);
      }
    }
  }

  useEffect(() => {
    if (observedRunsRevisionRef.current === runsResourceRevision) return;
    observedRunsRevisionRef.current = runsResourceRevision;
    const current = editorRef.current;
    if (current.kind === "open" && current.campaign) {
      void loadRuns(current.campaign.id, editorEpochRef.current, false, true);
    }
  }, [runsResourceRevision]);

  function resetMediaEditorState() {
    mediaUploadAbortRef.current?.abort();
    mediaUploadAbortRef.current = null;
    setMediaUploadProgress(null);
    setMediaUploadError(null);
    mediaPreviewRequestRef.current += 1;
    setMediaPreview(null);
    setMediaPreviewLoading(false);
    setMediaPreviewError(null);
    if (mediaFileInputRef.current) mediaFileInputRef.current.value = "";
  }

  function openCreate() {
    mutationOperation.cancel();
    preflightOperation.cancel();
    targetsRead.cancel();
    runsRead.cancel();
    editorEpochRef.current += 1;
    createIntentRef.current = null;
    launchKeyRef.current = null;
    setEditor({ campaign: null, kind: "open" });
    setEditorTab("details");
    setForm(emptyCampaignForm());
    setFormErrors({});
    setSavingDetails(false);
    setDetailsError(null);
    resetMediaEditorState();
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
    setPreflightLoading(false);
    setPreflightError(null);
    setDeleteIntent(null);
    setDeletingCampaign(false);
    setCampaignDeleteError(null);
  }

  function openCampaign(selected: RuntimeCampaign) {
    mutationOperation.cancel();
    preflightOperation.cancel();
    const epoch = ++editorEpochRef.current;
    createIntentRef.current = null;
    launchKeyRef.current = null;
    setEditor({ campaign: selected, kind: "open" });
    setEditorTab("details");
    setForm(campaignFormFromDto(selected));
    setFormErrors({});
    setSavingDetails(false);
    setDetailsError(null);
    resetMediaEditorState();
    setTargets([]);
    setDraftTargetIds([]);
    setTargetsRevision(selected.targetsRevision);
    setTargetSource(null);
    setTargetNotice(null);
    setRevisionRefreshRequired(false);
    setTargetsLoading(false);
    setTargetsSaving(false);
    setPreflight(null);
    setPreflightLoading(false);
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
    mutationOperation.cancel();
    preflightOperation.cancel();
    targetsRead.cancel();
    runsRead.cancel();
    editorEpochRef.current += 1;
    targetRequestRef.current += 1;
    runRequestRef.current += 1;
    createIntentRef.current = null;
    launchKeyRef.current = null;
    setEditor({ kind: "closed" });
    resetMediaEditorState();
    setSavingDetails(false);
    setTargetsRevision(null);
    setTargetSource(null);
    setRuns([]);
    setRunsLoading(false);
    setRunMutation(null);
    setRunError(null);
    setLiveLaunchConfirmationOpen(false);
    setTargetsLoading(false);
    setTargetsSaving(false);
    setPreflightLoading(false);
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
    const signal = runsRead.begin();
    if (detailOpen) setRunsLoading(true);
    try {
      const [refreshed, runPage] = await Promise.all([
        api.getCampaign(campaignId, { signal }),
        api.listCampaignRuns(campaignId, 20, 0, { signal }),
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
      if (signal.aborted) return null;
      if (epoch === editorEpochRef.current) void loadCampaigns(listStateRef.current);
      return null;
    } finally {
      runsRead.complete(signal);
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
    const operationToken = mutationOperation.begin();
    if (operationToken === null) return;
    const request = ++deleteRequestRef.current;
    setDeletingCampaign(true);
    setCampaignDeleteError(null);
    try {
      await api.deleteCampaign(snapshot.id, snapshot.revision, snapshot.targetsRevision);
      if (
        !mutationOperation.isCurrent(operationToken)
        || request !== deleteRequestRef.current
        || snapshot.sessionId !== selectedSessionIdRef.current
      ) return;
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
      if (!mutationOperation.isCurrent(operationToken) || request !== deleteRequestRef.current) return;
      const requestError = error instanceof RuntimeRequestError ? error : null;
      const code = requestError?.code;
      if (isUnknownMutationOutcome(error)) {
        try {
          const canonical = await api.getCampaign(snapshot.id);
          if (
            !mutationOperation.isCurrent(operationToken)
            || request !== deleteRequestRef.current
          ) return;
          setDeleteIntent(null);
          if (campaign?.id === canonical.id) {
            setEditor({ campaign: canonical, kind: "open" });
            setPreflight((current) => current && isPreflightStale(current, canonical)
              ? null
              : current);
          }
          void loadCampaigns(listStateRef.current);
          toast.notify({
            description: unknownMutationOutcomeMessage("canonical-reload"),
            id: `campaign-delete-unknown-${snapshot.id}`,
            title: "Delete result not confirmed",
            tone: "warning",
          });
        } catch (reconcileError) {
          if (
            !mutationOperation.isCurrent(operationToken)
            || request !== deleteRequestRef.current
          ) return;
          const missing = reconcileError instanceof RuntimeRequestError
            && (reconcileError.code === "CAMPAIGN_NOT_FOUND" || reconcileError.status === 404);
          if (missing) {
            setDeleteIntent(null);
            if (campaign?.id === snapshot.id) closeEditor();
            removeCampaignFromPage(snapshot.id);
            void loadCampaigns(listStateRef.current);
            toast.notify({
              description: "Runtime confirmed that the campaign is no longer available.",
              id: `campaign-delete-reconciled-${snapshot.id}`,
              title: "Campaign deleted",
              tone: "success",
            });
          } else {
            setCampaignDeleteError(
              "WA Runtime did not confirm the delete result, and its latest state could not be reloaded. Reconnect and review the campaign before retrying.",
            );
          }
        }
      } else if (code === "CAMPAIGN_NOT_FOUND" || requestError?.status === 404) {
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
        if (!mutationOperation.isCurrent(operationToken) || request !== deleteRequestRef.current) return;
        toast.notify({
          description: "The campaign changed. Review it before deleting.",
          id: `campaign-delete-revision-${snapshot.id}`,
          title: "Delete not confirmed",
          tone: "warning",
        });
      } else if (code === "CAMPAIGN_DELETE_STATE_CONFLICT") {
        setDeleteIntent(null);
        await refreshCampaignDeleteContext(snapshot.id);
        if (!mutationOperation.isCurrent(operationToken) || request !== deleteRequestRef.current) return;
        toast.notify({
          description: "Cancel the active run and archive the campaign before deleting it.",
          id: `campaign-delete-state-${snapshot.id}`,
          title: "Campaign cannot be deleted",
          tone: "warning",
        });
      } else if (code === "CAMPAIGN_DELETE_RUN_CONFLICT") {
        setDeleteIntent(null);
        const refreshed = await refreshCampaignDeleteContext(snapshot.id);
        if (!mutationOperation.isCurrent(operationToken) || request !== deleteRequestRef.current) return;
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
      if (mutationOperation.complete(operationToken) && request === deleteRequestRef.current) {
        setDeletingCampaign(false);
      }
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

  function updateContentType(contentType: CampaignFormValues["contentType"]) {
    mediaUploadAbortRef.current?.abort();
    mediaUploadAbortRef.current = null;
    setMediaUploadProgress(null);
    setMediaUploadError(null);
    mediaPreviewRequestRef.current += 1;
    setMediaPreview(null);
    setMediaPreviewLoading(false);
    setMediaPreviewError(null);
    if (mediaFileInputRef.current) mediaFileInputRef.current.value = "";
    setForm((current) => ({
      ...current,
      contentType,
      mediaAsset: current.mediaAsset?.kind === contentType ? current.mediaAsset : null,
    }));
    setFormErrors((current) => ({ ...current, mediaAsset: undefined, text: undefined }));
  }

  async function selectMediaFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !selectedSessionId || !mediaPolicy || form.contentType === "TEXT") return;
    const expectedType = form.contentType;
    const epoch = editorEpochRef.current;
    mediaUploadAbortRef.current?.abort();
    const controller = new AbortController();
    mediaUploadAbortRef.current = controller;
    setMediaUploadError(null);
    setFormErrors((current) => ({ ...current, mediaAsset: undefined }));
    try {
      const { asset, optimization, uploadedFile } = await uploadCampaignMedia({
        api,
        file,
        policy: mediaPolicy,
        sessionId: selectedSessionId,
        signal: controller.signal,
        onProgress: setMediaUploadProgress,
      });
      if (
        controller.signal.aborted
        || epoch !== editorEpochRef.current
        || selectedSessionId !== selectedSessionIdRef.current
        || asset.kind !== expectedType
      ) return;
      setForm((current) => current.contentType === expectedType
        ? {
          ...current,
          mediaAsset: {
            id: asset.id,
            kind: asset.kind,
            filename: asset.filename,
            mimeType: asset.mimeType,
            byteSize: asset.byteSize,
            sha256: asset.sha256,
          },
        }
        : current);
      if (asset.kind === "IMAGE") {
        setMediaPreview({ assetId: asset.id, url: URL.createObjectURL(uploadedFile) });
      }
      if (optimization.applied) {
        toast.notify({
          description: `${formatBytes(optimization.originalByteSize)} → ${formatBytes(optimization.uploadedByteSize)} · dimensions and pixels verified`,
          id: `campaign-image-optimized-${asset.id}`,
          title: "Image optimized without quality loss",
          tone: "success",
        });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setMediaUploadError(campaignErrorMessage(error, "Could not upload campaign media."));
      }
    } finally {
      if (mediaUploadAbortRef.current === controller) {
        mediaUploadAbortRef.current = null;
        setMediaUploadProgress(null);
      }
    }
  }

  function removeMediaAsset() {
    mediaUploadAbortRef.current?.abort();
    mediaUploadAbortRef.current = null;
    setMediaUploadProgress(null);
    setMediaUploadError(null);
    mediaPreviewRequestRef.current += 1;
    setMediaPreview(null);
    setMediaPreviewLoading(false);
    setMediaPreviewError(null);
    setForm((current) => ({ ...current, mediaAsset: null }));
    setFormErrors((current) => ({ ...current, mediaAsset: undefined }));
  }

  function resetDetailsToSaved() {
    if (!campaign) return;
    setForm(campaignFormFromDto(campaign));
    resetMediaEditorState();
    setFormErrors({});
    setDetailsError(null);
  }

  function restoreUnconfirmedCreateIntent() {
    const intent = createIntentRef.current;
    if (campaign || !intent?.outcomeUnknown) return;
    setForm({ ...intent.form });
    setFormErrors({});
    setDetailsError(unknownMutationOutcomeMessage("idempotent-retry"));
  }

  async function saveDetails() {
    if (!selectedSessionId || !editable) return;
    const validation = validateCampaignForm(form);
    setFormErrors(validation);
    if (Object.keys(validation).length) return;

    let createIntent: CampaignCreateIntent | null = null;
    if (!campaign) {
      const payload = createCampaignPayload(selectedSessionId, form);
      const fingerprint = JSON.stringify(payload);
      const existing = createIntentRef.current;
      if (existing?.outcomeUnknown && existing.fingerprint !== fingerprint) {
        setDetailsError(
          "An earlier create result is still unconfirmed. Restore that exact request and retry it, or discard this draft; changing its request key could create a duplicate campaign.",
        );
        return;
      }
      createIntent = existing && existing.fingerprint === fingerprint
        ? existing
        : {
          fingerprint,
          form: {
            ...form,
            mediaAsset: form.mediaAsset ? { ...form.mediaAsset } : null,
            name: payload.name,
          },
          key: crypto.randomUUID(),
          outcomeUnknown: false,
          payload,
        };
      createIntentRef.current = createIntent;
    }

    const operationToken = mutationOperation.begin();
    if (operationToken === null) return;
    const epoch = editorEpochRef.current;
    setSavingDetails(true);
    setDetailsError(null);
    try {
      let saved: RuntimeCampaign;
      if (createIntent) {
        saved = await api.createCampaign(
          createIntent.payload,
          createIntent.key,
        );
      } else if (campaign) {
        const payload = updateCampaignPayload(campaign, form);
        if (!Object.keys(payload).length) return;
        saved = await api.updateCampaign(campaign.id, payload);
      } else {
        return;
      }
      if (
        !mutationOperation.isCurrent(operationToken)
        || epoch !== editorEpochRef.current
        || saved.sessionId !== selectedSessionIdRef.current
      ) return;
      const created = !campaign;
      setEditor({ campaign: saved, kind: "open" });
      setForm(campaignFormFromDto(saved));
      setPreflight(null);
      createIntentRef.current = null;
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
      if (!mutationOperation.isCurrent(operationToken) || epoch !== editorEpochRef.current) return;
      const outcomeUnknown = isUnknownMutationOutcome(error);
      if (createIntent && outcomeUnknown) {
        createIntentRef.current = { ...createIntent, outcomeUnknown: true };
      }
      const scheduledAt = scheduleFieldError(error);
      if (error instanceof RuntimeRequestError) {
        setFormErrors((current) => ({
          ...current,
          name: error.fieldErrors.name?.[0] ?? current.name,
          scheduledAt: scheduledAt ?? current.scheduledAt,
          mediaAsset: error.fieldErrors.content?.[0] ?? current.mediaAsset,
          text: error.fieldErrors.text?.[0] ?? current.text,
        }));
      } else if (scheduledAt) {
        setFormErrors((current) => ({ ...current, scheduledAt }));
      }
      setDetailsError(outcomeUnknown
        ? unknownMutationOutcomeMessage(campaign ? "canonical-reload" : "idempotent-retry")
        : campaignErrorMessage(error, "Could not save campaign details."));
      if (outcomeUnknown && campaign) {
        try {
          const canonical = await api.getCampaign(campaign.id);
          if (
            mutationOperation.isCurrent(operationToken)
            && epoch === editorEpochRef.current
            && canonical.sessionId === selectedSessionIdRef.current
          ) {
            setEditor({ campaign: canonical, kind: "open" });
            setPreflight((current) => current && isPreflightStale(current, canonical)
              ? null
              : current);
            void loadCampaigns(listStateRef.current);
          }
        } catch {
          // Preserve the staged form and unknown-outcome warning.
        }
      }
    } finally {
      if (mutationOperation.complete(operationToken) && epoch === editorEpochRef.current) {
        setSavingDetails(false);
      }
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
    const operationToken = mutationOperation.begin();
    if (operationToken === null) {
      return { message: "Another campaign change is already in progress.", ok: false };
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
        !mutationOperation.isCurrent(operationToken)
        || epoch !== editorEpochRef.current
        || request !== targetRequestRef.current
        || editorRef.current.kind !== "open"
        || editorRef.current.campaign?.id !== identity.campaignId
        || editorRef.current.campaign.sessionId !== identity.sessionId
        || editorRef.current.campaign.revision !== identity.campaignRevision
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
      if (
        !mutationOperation.isCurrent(operationToken)
        || epoch !== editorEpochRef.current
        || request !== targetRequestRef.current
      ) {
        return { message: "The editor changed while the list was applying.", ok: false };
      }
      const code = error instanceof RuntimeRequestError ? error.code : null;
      const outcomeUnknown = isUnknownMutationOutcome(error);
      const message = outcomeUnknown
        ? unknownMutationOutcomeMessage("canonical-reload")
        : campaignErrorMessage(error, "Could not apply the group list.");
      setTargetsError(message);
      if (outcomeUnknown) {
        await reconcileTargetsAfterUnknownOutcome(campaign.id, epoch, request);
      } else if (code === "CAMPAIGN_TARGETS_REVISION_CONFLICT") {
        setTargetsSaving(false);
        void loadTargets(campaign.id, epoch, true);
      }
      return {
        message,
        ok: false,
        reloadLists: code === "CAMPAIGN_TARGET_SOURCE_REVISION_CONFLICT",
      };
    } finally {
      if (mutationOperation.complete(operationToken) && epoch === editorEpochRef.current) {
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
    const operationToken = mutationOperation.begin();
    if (operationToken === null) return;
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
        !mutationOperation.isCurrent(operationToken)
        || epoch !== editorEpochRef.current
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
      if (
        !mutationOperation.isCurrent(operationToken)
        || epoch !== editorEpochRef.current
        || request !== targetRequestRef.current
      ) return;
      const outcomeUnknown = isUnknownMutationOutcome(error);
      setTargetsError(outcomeUnknown
        ? unknownMutationOutcomeMessage("canonical-reload")
        : campaignErrorMessage(error, "Could not replace campaign targets."));
      if (outcomeUnknown) {
        await reconcileTargetsAfterUnknownOutcome(campaign.id, epoch, request);
      } else if (error instanceof RuntimeRequestError && error.code === "CAMPAIGN_TARGETS_REVISION_CONFLICT") {
        setTargetsSaving(false);
        void loadTargets(campaign.id, epoch, true);
      }
    } finally {
      if (mutationOperation.complete(operationToken) && epoch === editorEpochRef.current) {
        setTargetsSaving(false);
      }
    }
  }

  async function runPreflight(executionMode: RuntimeCampaignExecutionMode) {
    if (!campaign || targetsRevision === null || detailsDirty || targetsDirty || revisionRefreshRequired) return;
    const operationToken = preflightOperation.begin();
    if (operationToken === null) return;
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
        !preflightOperation.isCurrent(operationToken)
        || epoch !== editorEpochRef.current
        || editorRef.current.kind !== "open"
        || editorRef.current.campaign?.id !== campaignId
        || editorRef.current.campaign.sessionId !== selectedSessionIdRef.current
        || editorRef.current.campaign.revision !== campaignRevision
        || targetsRevisionRef.current !== expectedTargetsRevision
        || report.campaignRevision !== campaignRevision
        || report.targetsRevision !== expectedTargetsRevision
        || report.executionMode !== executionMode
      ) return;
      setPreflight(report);
    } catch (error) {
      if (!preflightOperation.isCurrent(operationToken) || epoch !== editorEpochRef.current) return;
      setPreflightError(campaignErrorMessage(error, "Could not run preflight."));
    } finally {
      if (preflightOperation.complete(operationToken) && epoch === editorEpochRef.current) {
        setPreflightLoading(false);
      }
    }
  }

  function changePreflightMode(executionMode: RuntimeCampaignExecutionMode) {
    preflightOperation.cancel();
    setPreflightLoading(false);
    setPreflightMode(executionMode);
    if (preflight?.executionMode !== executionMode) setPreflight(null);
    launchKeyRef.current = null;
    setPreflightError(null);
  }

  async function refreshCampaignAfterRun(campaignId: string, epoch: number, request: number) {
    try {
      const refreshed = await api.getCampaign(campaignId);
      if (
        epoch !== editorEpochRef.current
        || request !== runRequestRef.current
        || refreshed.sessionId !== selectedSessionIdRef.current
      ) return false;
      setEditor({ campaign: refreshed, kind: "open" });
      setForm(campaignFormFromDto(refreshed));
      setPreflight((current) => current && isPreflightStale(current, refreshed) ? null : current);
      void loadTargets(campaignId, epoch);
      void loadCampaigns(listStateRef.current);
      return true;
    } catch {
      return false;
    }
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
    const operationToken = mutationOperation.begin();
    if (operationToken === null) return;
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
        !mutationOperation.isCurrent(operationToken)
        || epoch !== editorEpochRef.current
        || request !== runRequestRef.current
        || editorRef.current.kind !== "open"
        || editorRef.current.campaign?.id !== identity.campaignId
        || editorRef.current.campaign.sessionId !== identity.sessionId
        || editorRef.current.campaign.revision !== identity.campaignRevision
        || targetsRevisionRef.current !== identity.targetsRevision
      ) return;
      if (executionMode === "LIVE") setLiveLaunchConfirmationOpen(false);
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      launchKeyRef.current = null;
      if (executionMode === "LIVE") {
        const refreshed = await refreshCampaignAfterRun(campaign.id, epoch, request);
        if (!mutationOperation.isCurrent(operationToken)) return;
        if (!refreshed) {
          setRunError(
            "The live run was created, but the latest Campaign state could not be refreshed. Reload runs before taking another action.",
          );
        }
      }
      toast.notify({
        id: `campaign-run-${run.id}`,
        title: executionMode === "LIVE" ? "Live campaign launched" : "Dry run created",
        tone: "success",
      });
    } catch (error) {
      if (
        !mutationOperation.isCurrent(operationToken)
        || epoch !== editorEpochRef.current
        || request !== runRequestRef.current
      ) return;
      const code = error instanceof RuntimeRequestError ? error.code : null;
      setRunError(isUnknownMutationOutcome(error)
        ? unknownMutationOutcomeMessage("idempotent-retry")
        : campaignErrorMessage(error, "Could not create campaign run."));
      if (
        code === "CAMPAIGN_RUN_REVISION_CONFLICT"
        || code === "CAMPAIGN_RUN_PREFLIGHT_REQUIRED"
        || code === "CAMPAIGN_RUN_PREFLIGHT_INVALID"
      ) {
        setLiveLaunchConfirmationOpen(false);
        launchKeyRef.current = null;
        setPreflight(null);
        await refreshCampaignAfterRun(campaign.id, epoch, request);
      } else if (code === "CAMPAIGN_RUN_LAUNCH_CONFLICT") {
        setLiveLaunchConfirmationOpen(false);
        await refreshCampaignAfterRun(campaign.id, epoch, request);
        setRunMutation(null);
        void loadRuns(campaign.id, epoch);
      }
    } finally {
      if (mutationOperation.complete(operationToken) && epoch === editorEpochRef.current) {
        setRunMutation(null);
      }
    }
  }

  async function changeRunState(run: RuntimeCampaignRun, action: "pause" | "resume" | "cancel") {
    if (!campaign) return;
    const operationToken = mutationOperation.begin();
    if (operationToken === null) return;
    const epoch = editorEpochRef.current;
    const request = ++runRequestRef.current;
    const campaignId = campaign.id;
    const previousAction = runActionKeyRef.current;
    const idempotencyKey = previousAction?.runId === run.id
      && previousAction.action === action
      ? previousAction.key
      : crypto.randomUUID();
    runActionKeyRef.current = { action, key: idempotencyKey, runId: run.id };
    setRunMutation(`${action}:${run.id}`);
    setRunError(null);
    try {
      const updated = action === "pause"
        ? await api.pauseCampaignRun(run.id, idempotencyKey)
        : action === "resume"
          ? await api.resumeCampaignRun(run.id, idempotencyKey)
          : await api.cancelCampaignRun(run.id, idempotencyKey);
      if (runActionKeyRef.current?.key === idempotencyKey) {
        runActionKeyRef.current = null;
      }
      if (
        !mutationOperation.isCurrent(operationToken)
        || epoch !== editorEpochRef.current
        || request !== runRequestRef.current
        || updated.campaignId !== campaignId
      ) return;
      setRuns((current) => current.map((item) => item.id === updated.id ? updated : item));
      const refreshed = await refreshCampaignAfterRun(campaignId, epoch, request);
      if (mutationOperation.isCurrent(operationToken) && !refreshed) {
        setRunError(
          `Runtime accepted the ${action} action, but the latest Campaign state could not be refreshed. Reload runs before taking another action.`,
        );
      }
    } catch (error) {
      const outcomeUnknown = isUnknownMutationOutcome(error);
      if (!outcomeUnknown && runActionKeyRef.current?.key === idempotencyKey) {
        runActionKeyRef.current = null;
      }
      if (
        !mutationOperation.isCurrent(operationToken)
        || epoch !== editorEpochRef.current
        || request !== runRequestRef.current
      ) return;
      setRunError(outcomeUnknown
        ? unknownMutationOutcomeMessage("idempotent-retry")
        : campaignErrorMessage(error, `Could not ${action} campaign run.`));
      if (
        outcomeUnknown
        || (error instanceof RuntimeRequestError && error.code === "CAMPAIGN_RUN_STATE_CONFLICT")
      ) {
        try {
          const canonical = await api.getCampaignRun(run.id);
          if (
            mutationOperation.isCurrent(operationToken)
            && epoch === editorEpochRef.current
            && request === runRequestRef.current
          ) {
            setRuns((current) => current.map((item) => item.id === canonical.id ? canonical : item));
            await refreshCampaignAfterRun(campaignId, epoch, request);
          }
        } catch {
          // Preserve the typed conflict; a manual retry can reload the run list.
        }
      }
    } finally {
      if (mutationOperation.complete(operationToken) && epoch === editorEpochRef.current) {
        setRunMutation(null);
      }
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
  const reviewFooterState = reportStale
    ? "Run preflight again after saving changes"
    : preflight
      ? <>{preflight.status} · {preflight.allowedTargets.toLocaleString()}/{preflight.totalTargets.toLocaleString()} eligible · Checked <DateTime value={preflight.checkedAt} /></>
      : "No preflight result yet";
  const footerState = editorTab === "details"
    ? campaign
      ? detailsDirty
        ? `Campaign r${campaign.revision} · Unsaved changes`
        : `Campaign r${campaign.revision} · All changes saved`
      : "Create the draft to unlock targets and preflight"
    : editorTab === "targets"
      ? targetChangeState
      : reviewFooterState;
  const editorStep = editorTab === "details" ? 1 : editorTab === "targets" ? 2 : 3;
  const editorStepLabel = editorTab === "details" ? "Content" : editorTab === "targets" ? "Targets" : "Review & launch";
  const detailDeleteReason = campaign ? campaignDeleteDisabledReason(campaign, runs) : null;
  const deleteIntentDisabledReason = deleteIntent
    ? campaignDeleteDisabledReason(deleteIntent, campaign?.id === deleteIntent.id ? runs : [])
    : null;
  const campaignMutationBusy = savingDetails
    || Boolean(mediaUploadProgress)
    || targetsSaving
    || Boolean(runMutation)
    || deletingCampaign;
  const canLaunchReviewedRun = Boolean(
    campaign
    && campaign.status === "DRAFT"
    && preflight
    && !reportStale
    && preflight.status !== "BLOCK"
    && (
      preflight.executionMode === "DRY_RUN"
      || (preflight.status === "PASS" && Boolean(preflight.liveLaunchToken))
    ),
  );
  const reviewGate = preflightLoading
    ? {
        badge: "Checking",
        description: "Runtime is evaluating the saved campaign and target revisions.",
        icon: "activity" as const,
        title: "Evaluation in progress",
        tone: "neutral" as const,
      }
    : revisionRefreshRequired
      ? {
          badge: "Refresh required",
          description: "Reopen this campaign to load the current Runtime revisions before evaluating it.",
          icon: "triangle-alert" as const,
          title: "Snapshot is out of date",
          tone: "warning" as const,
        }
      : reportStale
        ? {
            badge: "Stale",
            description: "The campaign or target set changed after this decision. Save changes and run preflight again.",
            icon: "triangle-alert" as const,
            title: "Decision is no longer current",
            tone: "warning" as const,
          }
        : !preflight && preflightError
          ? {
              badge: "Failed",
              description: "Runtime could not complete the safety evaluation. Retry before creating a run.",
              icon: "circle-alert" as const,
              title: "Evaluation unavailable",
              tone: "danger" as const,
            }
          : preflight?.status === "BLOCK"
            ? {
                badge: "Blocked",
                description: "Resolve the blocking policy checks and run preflight again.",
                icon: "circle-alert" as const,
                title: "Launch is blocked",
                tone: "danger" as const,
              }
            : preflight?.executionMode === "LIVE" && preflight.status === "WARN"
              ? {
                  badge: "Warnings",
                  description: "Runtime requires a passing LIVE decision. Resolve the warnings or switch to Dry run for a simulation.",
                  icon: "triangle-alert" as const,
                  title: "Live launch needs a pass",
                  tone: "warning" as const,
                }
              : preflight?.executionMode === "LIVE" && preflight.status === "PASS" && !preflight.liveLaunchToken
                ? {
                    badge: "Recheck required",
                    description: "Runtime did not return launch proof for this decision. Run LIVE preflight again before continuing.",
                    icon: "triangle-alert" as const,
                    title: "Live launch proof unavailable",
                    tone: "warning" as const,
                  }
                : canLaunchReviewedRun && preflight
                  ? {
                      badge: preflight.status === "WARN" ? "Warnings" : "Ready",
                      description: preflight.status === "WARN"
                        ? "Runtime allows this snapshot, but the reported warnings should be reviewed before continuing."
                        : `Runtime will verify campaign r${preflight.campaignRevision} and targets r${preflight.targetsRevision} again when the run is created.`,
                      icon: preflight.status === "WARN" ? "triangle-alert" as const : "check" as const,
                      title: preflight.status === "WARN"
                        ? "Eligible with warnings"
                        : preflight.executionMode === "DRY_RUN"
                          ? "Eligible for a dry run"
                          : "Ready for live confirmation",
                      tone: preflight.status === "WARN" ? "warning" as const : "success" as const,
                    }
                  : detailsDirty || targetsDirty
                    ? {
                        badge: "Save required",
                        description: "Preflight reads persisted Runtime state. Save campaign details and targets first.",
                        icon: "triangle-alert" as const,
                        title: "Unsaved changes are excluded",
                        tone: "warning" as const,
                      }
                    : {
                        badge: "Not checked",
                        description: "Run preflight to receive Runtime's authoritative decision for this saved snapshot.",
                        icon: "runs" as const,
                        title: "Awaiting Runtime decision",
                        tone: "neutral" as const,
                      };
  const reviewPrimaryAction = canLaunchReviewedRun && preflight ? (
    preflight.executionMode === "DRY_RUN"
      ? <Button disabled={campaignMutationBusy || preflightLoading} loading={runMutation === "launch:DRY_RUN"} onClick={() => void launchRun("DRY_RUN")} variant="primary">Create dry run</Button>
      : <Button disabled={campaignMutationBusy || preflightLoading} loading={runMutation === "launch:LIVE"} onClick={() => { setRunError(null); setLiveLaunchConfirmationOpen(true); }} variant="primary">Launch live campaign</Button>
  ) : (
    <Button disabled={!campaign || detailsDirty || targetsDirty || revisionRefreshRequired || campaignMutationBusy || preflightLoading} loading={preflightLoading} onClick={() => void runPreflight(preflightMode)} variant="primary">{reportStale || preflight ? "Run preflight again" : "Run preflight"}</Button>
  );
  const footerAction = editorTab === "details" ? (
    <>
      {campaign && <Button disabled={!editable || !detailsDirty || campaignMutationBusy} onClick={resetDetailsToSaved} variant="ghost">Reset to saved</Button>}
      {!campaign && createIntentRef.current?.outcomeUnknown && <Button disabled={campaignMutationBusy} onClick={restoreUnconfirmedCreateIntent} variant="ghost">Restore unconfirmed request</Button>}
      <Button disabled={!editable || campaignMutationBusy || (Boolean(campaign) && !detailsDirty)} loading={savingDetails} onClick={() => void saveDetails()} variant="primary">
        {campaign ? "Save details" : "Create draft"}
      </Button>
    </>
  ) : editorTab === "targets" ? (
    <><Button onClick={() => setEditorTab("details")}>Back</Button><Button disabled={!campaign || !editable || !targetsDirty || targetsLoading || campaignMutationBusy} onClick={resetTargetsToSaved} variant="ghost">Reset to saved</Button><Button disabled={!campaign || !editable || !targetsDirty || targetsLoading || campaignMutationBusy} loading={targetsSaving} onClick={() => void saveTargets()} variant="primary">Save target set</Button></>
  ) : (
    <><Button onClick={() => setEditorTab("targets")}>Back</Button>{reviewPrimaryAction}</>
  );

  return (
    <div className="campaigns-screen stack stack-lg">
      <PageHeader
        actions={<Button disabled={!selectedSessionId} onClick={openCreate} variant="primary">New campaign</Button>}
        description="Create campaign drafts, materialize target snapshots, review policy, and manage Runtime launch lifecycle."
        title="Campaigns"
        titleId="campaigns-title"
      />
      <DataTableFrame className="data-table-container campaign-list-panel" label="Campaigns" scroll={false}>
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
        {visibleListError && <InlineAlert action={<Button onClick={() => void loadCampaigns(listStateRef.current)} size="sm">Retry</Button>} title="Could not load campaigns" variant="flush">{visibleListError}</InlineAlert>}
        <DataTableScroll busy={listPending} updating={listPending && Boolean(visiblePage?.data.length)}>
          <DataTable caption="Campaigns for the active session">
            <thead><tr><th scope="col">Campaign</th><th scope="col">Status</th><th className="data-column-time" scope="col">Schedule</th><th className="data-column-number" scope="col">Targets</th><th className="data-column-actions" scope="col"><span className="ui-data-table-visually-hidden">Actions</span></th></tr></thead>
            <tbody>
              {!selectedSessionId ? <tr><DataTableEmptyCell colSpan={5}>Select a session to view campaigns.</DataTableEmptyCell></tr>
                : !visiblePage && listPending ? <tr><DataTableEmptyCell colSpan={5}>Loading campaigns…</DataTableEmptyCell></tr>
                : !visiblePage && visibleListError ? <tr><DataTableEmptyCell colSpan={5}>Campaigns are unavailable.</DataTableEmptyCell></tr>
                : !visiblePage?.data.length ? <tr><DataTableEmptyCell colSpan={5}>{hasListCriteria ? "No campaigns match this search or filters." : "No campaigns yet. Create a draft to get started."}</DataTableEmptyCell></tr>
                : visiblePage.data.map((item) => <tr key={item.id}>
                  <td className="data-cell-primary"><div className="stack stack-xs"><DataTablePrimaryAction onClick={() => openCampaign(item)} title={`Open ${item.name}`}>{item.name}</DataTablePrimaryAction><span className="data-identifier">{item.id}</span></div></td>
                  <td><Badge tone={statusTone(item.status)} variant="status">{statusLabel(item.status)}</Badge></td>
                  <td className="data-cell-time">{item.scheduleType === "IMMEDIATE" ? "Immediate" : <DateTime value={item.scheduledAt} />}</td>
                  <td className="data-cell-number">{item.targetCount}</td>
                  <td className="data-cell-action focus-overflow-owner"><CampaignActionsMenu campaign={item} disabledReason={campaignDeleteDisabledReason(item)} onDelete={requestCampaignDelete} onOpen={openCampaign} /></td>
                </tr>)}
            </tbody>
          </DataTable>
        </DataTableScroll>
        <TablePagination
          limit={pageLimit}
          loading={listPending}
          offset={pageOffset}
          onOffsetChange={(nextOffset) => setListState((current) => ({ ...current, offset: nextOffset }))}
          total={total}
        />
      </DataTableFrame>

      <WorkspaceDialog
        contentKey={`${campaign?.id ?? "new"}:${editorEpochRef.current}:${editorTab}`}
        description={campaign
          ? `${statusLabel(campaign.status)} · ${selectedSessionId} · Campaign r${campaign.revision}`
          : `New draft · ${selectedSessionId ?? "No active session"}`}
        eyebrow="Campaign workspace"
        footer={editor.kind === "open" && <WorkspaceFooter actions={footerAction} description={footerState} title={`Step ${editorStep} of 3 · ${editorStepLabel}`} />}
        headerActions={campaign ? <CampaignActionsMenu campaign={campaign} disabledReason={detailDeleteReason} onDelete={requestCampaignDelete} /> : undefined}
        navigation={editor.kind === "open" && (
          <WorkflowStepper
            activeStep={editorTab}
            ariaLabel="Campaign editor sections"
            idPrefix="campaign-editor"
            onChange={setEditorTab}
            steps={[
              { id: "details", label: "Content", step: 1, warning: Boolean(campaign && detailsDirty) },
              { disabled: !campaign, id: "targets", label: "Targets", step: 2, warning: Boolean(campaign && targetsDirty) },
              { disabled: !campaign, id: "preflight", label: "Review & launch", step: 3, warning: reportStale },
            ]}
          />
        )}
        notice={editor.kind === "open" && campaign && campaign.status !== "DRAFT"
          ? <InlineAlert title="Read-only campaign" tone="warning">Runtime status is {statusLabel(campaign.status)}; only draft campaigns are editable.</InlineAlert>
          : undefined}
        onClose={requestCloseEditor}
        open={editor.kind === "open"}
        title={campaign?.name ?? "New campaign draft"}
      >
        {editor.kind === "open" && (
          <div className="campaign-editor">
            {editorTab === "details" && <section aria-labelledby="campaign-editor-details-tab" className="campaign-step-panel campaign-tab-panel" id="campaign-editor-details-panel" role="tabpanel">
              <WorkspaceSectionHeader
                action={!campaign
                  ? <Badge variant="status">New draft</Badge>
                  : detailsDirty
                    ? <Badge tone="warning" variant="status">Unsaved changes</Badge>
                    : <Badge tone="success" variant="status">Saved</Badge>}
                description="Define the immutable message snapshot and when Runtime should make it eligible to run."
                kicker="Campaign draft"
                title="Content & schedule"
              />
              {detailsError && <InlineAlert title="Could not save details">{detailsError}</InlineAlert>}
              <div className="campaign-details-grid">
                <div className="campaign-content-layout campaign-workspace-section">
                  <div className="campaign-content-editor">
                    <section aria-labelledby="campaign-content-title" className="campaign-composer-panel stack stack-md">
                    <header className="campaign-form-section-heading">
                      <div><span>Message</span><h4 id="campaign-content-title">Message content</h4><p>Name this campaign and define the content copied into future runs.</p></div>
                    </header>
                    <div className="campaign-content-identity-grid">
                      <TextField error={formErrors.name} disabled={!editable} label="Campaign name" onChange={(event) => updateForm("name", event.target.value)} value={form.name} />
                      <SegmentedControl
                        disabled={!editable || Boolean(mediaUploadProgress)}
                        label="Message type"
                        onChange={updateContentType}
                        options={CONTENT_TYPE_OPTIONS}
                        value={form.contentType}
                      />
                    </div>
                    {form.contentType === "TEXT" ? (
                      <TextAreaField description={<span className="campaign-message-description"><span>Plain-text message used by future campaign runs.</span><span>{form.text.length} / 4,096</span></span>} disabled={!editable} error={formErrors.text} label="Message text" maxLength={4_096} onChange={(event) => updateForm("text", event.target.value)} rows={5} value={form.text} />
                    ) : (
                      <div className="campaign-media-field stack stack-sm">
                        <div className="campaign-media-label-row">
                          <span className="text-field-label">Image</span>
                          {mediaPolicy && <span>Maximum {formatBytes(mediaPolicy.imageMaxBytes)} after lossless optimization</span>}
                        </div>
                        <input
                          accept="image/jpeg,image/png,image/webp"
                          aria-label="Choose an image"
                          className="campaign-media-input"
                          disabled={!editable || !mediaPolicy || Boolean(mediaUploadProgress)}
                          onChange={(event) => void selectMediaFile(event)}
                          ref={mediaFileInputRef}
                          type="file"
                        />
                        {form.mediaAsset ? (
                          <div className="campaign-media-asset">
                            {mediaPreview?.assetId === form.mediaAsset.id
                              ? <img alt={`Preview of ${form.mediaAsset.filename}`} src={mediaPreview.url} />
                              : <div aria-hidden="true" className="campaign-media-file-icon"><AppIcon name="campaigns" size="lg" /></div>}
                            <div className="campaign-media-asset-copy">
                              <strong>{form.mediaAsset.filename}</strong>
                              <span>{form.mediaAsset.mimeType} · {formatBytes(form.mediaAsset.byteSize)}</span>
                              <span
                                className={mediaPreviewError ? "campaign-media-preview-error" : undefined}
                                title={mediaPreviewError ?? undefined}
                              >
                                {mediaPreviewLoading
                                  ? "Loading preview…"
                                  : mediaPreviewError
                                    ? "Preview unavailable"
                                    : `Verified · ${form.mediaAsset.sha256.slice(0, 12)}…`}
                              </span>
                            </div>
                            <Button disabled={!editable || Boolean(mediaUploadProgress)} onClick={removeMediaAsset} size="sm" variant="ghost">Remove</Button>
                          </div>
                        ) : (
                          <div className={`campaign-media-dropzone ${formErrors.mediaAsset ? "campaign-media-dropzone-error" : ""}`.trim()}>
                            <div>
                              <strong>No image uploaded</strong>
                              <span>The file is verified and stored by WA Runtime before this draft can be saved.</span>
                            </div>
                            <Button
                              disabled={!editable || !mediaPolicy || Boolean(mediaUploadProgress)}
                              loading={mediaPolicyLoading}
                              onClick={() => mediaFileInputRef.current?.click()}
                              size="sm"
                            >Choose file</Button>
                          </div>
                        )}
                        {mediaUploadProgress && (
                          <div className="campaign-media-progress" role="status">
                            <div><span>{mediaUploadProgress.phase === "optimizing" ? "Optimizing without quality loss" : mediaUploadProgress.phase === "hashing" ? "Preparing file" : mediaUploadProgress.phase === "verifying" ? "Verifying upload" : "Uploading"}</span>{mediaUploadProgress.phase !== "optimizing" && <span>{Math.round((mediaUploadProgress.bytesCompleted / mediaUploadProgress.bytesTotal) * 100)}%</span>}</div>
                            <progress max={mediaUploadProgress.bytesTotal} value={mediaUploadProgress.phase === "optimizing" ? undefined : mediaUploadProgress.bytesCompleted} />
                            <Button onClick={() => mediaUploadAbortRef.current?.abort()} size="sm" variant="ghost">Cancel upload</Button>
                          </div>
                        )}
                        {formErrors.mediaAsset && <span className="text-field-error campaign-media-error" role="alert">{formErrors.mediaAsset}</span>}
                        {mediaUploadError && <InlineAlert action={!mediaPolicy && !mediaPolicyLoading ? <Button onClick={() => setMediaPolicyRequest((value) => value + 1)} size="sm">Retry</Button> : undefined} title="Image upload failed">{mediaUploadError}</InlineAlert>}
                        <TextAreaField description={<span className="campaign-message-description"><span>Optional text shown with the attachment.</span><span>{form.text.length} / 1,024</span></span>} disabled={!editable} error={formErrors.text} label="Caption · Optional" maxLength={1_024} onChange={(event) => updateForm("text", event.target.value)} rows={3} value={form.text} />
                      </div>
                    )}
                    </section>
                    <section aria-labelledby="campaign-timing-title" className="campaign-delivery-panel campaign-workspace-section">
                      <div className="campaign-delivery-layout">
                        <header className="campaign-form-section-heading">
                          <div>
                            <span>Delivery</span>
                            <h4 id="campaign-timing-title">Delivery timing</h4>
                            <p>Choose when Runtime may begin this campaign.</p>
                          </div>
                        </header>
                        <SegmentedControl disabled={!editable} label="Schedule" onChange={(scheduleType) => updateForm("scheduleType", scheduleType)} options={SCHEDULE_OPTIONS} value={form.scheduleType} />
                        {form.scheduleType === "ONCE" && <TextField description="Shown in local time and stored by Runtime in UTC." disabled={!editable} error={formErrors.scheduledAt} label="Run at" min={new Date().toISOString().slice(0, 16)} onChange={(event) => updateForm("scheduledAt", event.target.value)} type="datetime-local" value={form.scheduledAt} />}
                      </div>
                    </section>
                  </div>
                  <CampaignMessagePreview
                    form={form}
                    mediaPreview={mediaPreview}
                    mediaPreviewError={mediaPreviewError}
                    mediaPreviewLoading={mediaPreviewLoading}
                    onRetryPreview={() => setMediaPreviewRequest((value) => value + 1)}
                  />
                </div>
              </div>
            </section>}

            {editorTab === "targets" && <section aria-labelledby="campaign-editor-targets-tab" className="campaign-step-panel campaign-tab-panel" id="campaign-editor-targets-panel" role="tabpanel">
              <WorkspaceSectionHeader
                action={campaign && <Badge tone={targetsDirty ? "warning" : "neutral"} variant="status">{targetsDirty ? "Unsaved changes" : `${targetDiff.selectedCount} selected`}</Badge>}
                description="Build the complete persisted group set used by preflight and future runs · maximum 1,000."
                kicker="Audience"
                title="Target groups"
              />
              {!campaign && <InlineAlert title="Create the draft first" tone="info">Targets belong to a persisted campaign.</InlineAlert>}
              {campaign && <>
                {targetsError && <InlineAlert title="Target update">{targetsError}</InlineAlert>}
                {!targetsLoading && targetsRevision !== null && <section aria-labelledby="campaign-target-snapshot-title" className="campaign-target-overview campaign-workspace-section">
                  <header className="campaign-target-overview-header">
                    <div className="campaign-target-overview-copy">
                      <span>Target source</span>
                      <h3 id="campaign-target-snapshot-title">{targetSource ? `From group list: ${targetSource.groupListNameSnapshot}` : "Custom selection"}</h3>
                      <p>{targetSource ? "Materialized from a saved list; this is not a live link." : "Maintained directly for this campaign."}</p>
                    </div>
                    <div className="campaign-target-overview-actions">
                      <CampaignGroupListActions api={api} campaignId={campaign.id} disabled={!editable || targetsLoading || campaignMutationBusy || targetsDirty} onApply={applyGroupList} sessionId={campaign.sessionId} />
                    </div>
                  </header>
                  <MetricGrid ariaLabel="Campaign target snapshot" className="campaign-target-metrics" items={[
                    { label: "Saved", value: targetDiff.savedCount },
                    { label: "Staged", value: targetDiff.selectedCount },
                    { label: "Change", value: targetsDirty ? `+${targetDiff.addedIds.length} / −${targetDiff.removedIds.length}` : "None" },
                    { label: "Revision", value: `r${targetsRevision}` },
                  ]} />
                  <footer className="campaign-target-overview-footer">
                    <span>{targetSource
                      ? <>Membership r{targetSource.membershipRevision} · Applied <DateTime value={targetSource.appliedAt} /></>
                      : targets.length === 0
                        ? "No groups are currently persisted."
                        : "Manual target replacement keeps this snapshot custom."}</span>
                    <strong>{targetsDirty ? `+${targetDiff.addedIds.length} added · −${targetDiff.removedIds.length} removed` : "No unsaved changes"}</strong>
                  </footer>
                  {targetSource && targetsDirty && <div className="campaign-target-provenance-warning"><AppIcon name="triangle-alert" size="xs" /><span><strong>Saving creates a custom selection.</strong> The source group list remains unchanged.</span></div>}
                </section>}
                <GroupSelectionPanel
                  key={campaign.id}
                  afterToolbar={<>{targetNotice && <InlineAlert title="Persisted target snapshot" tone="success" variant="flush">{targetNotice}</InlineAlert>}{groupDirectory.error && <InlineAlert action={<Button onClick={groupDirectory.retry} size="sm">Retry</Button>} title="Could not load groups" variant="flush">{groupDirectory.error}</InlineAlert>}</>}
                  description="Search and filter the Runtime directory. Saved and selected groups remain visible."
                  headingLevel="h4"
                  pageNote={!groupDirectory.loading && groupDirectory.groups.length === 0 && targetRows.length > 0 ? groupDirectory.hasCriteria ? "No additional synchronized groups match this search or filters. Selected and saved targets remain visible above." : "No additional synchronized groups are available. Selected and saved targets remain visible above." : undefined}
                  pagination={{ limit: groupDirectory.pageSize, loading: groupDirectory.loading, offset: groupDirectory.offset, onOffsetChange: groupDirectory.setOffset, total: groupDirectory.total }}
                  summary={targetDiff.selectedCount >= 900 ? <Badge tone={targetDiff.selectedCount >= 1_000 ? "danger" : "warning"} variant="status">{targetDiff.selectedCount > 1_000 ? `${targetDiff.selectedCount - 1_000} over limit` : targetDiff.selectedCount === 1_000 ? "Limit reached" : `${1_000 - targetDiff.selectedCount} remaining`}</Badge> : undefined}
                  table={{ caption: "Groups available to the campaign target selection", disabled: !editable || targetsLoading || campaignMutationBusy, emptyMessage: groupDirectory.hasCriteria ? "No synchronized groups match this search or filters." : "No synchronized groups found.", loading: groupDirectory.loading || targetsLoading, onToggle: toggleTarget, onTogglePage: toggleAllPageTargets, outsideResultIds: outsideTargetResultIds, pageIds: groupPageIds, rows: targetRows, savedIds: targetIdSet, selectedIds: draftTargetIdSet, unknownParticipantsTitle: "Participant count is unavailable in the saved target snapshot." }}
                  title="Browse groups"
                  titleId="campaign-target-group-directory-title"
                  toolbar={{ filterAriaLabel: "Target group filters", filterTitle: "Filter target groups", filters: groupDirectory.filters, filtersOpen: groupDirectory.filtersOpen, idPrefix: "campaign-target", inputQuery: groupDirectory.inputQuery, loading: groupDirectory.loading, onFiltersChange: groupDirectory.setFilters, onFiltersOpenChange: groupDirectory.setFiltersOpen, onParticipantErrorsClear: () => groupDirectory.setParticipantErrors({}), onSearchChange: groupDirectory.setSearch, pageItemCount: groupDirectory.groups.length, pageOffset: groupDirectory.offset, participantErrors: groupDirectory.participantErrors, total: groupDirectory.total }}
                />
              </>}
            </section>}

            {editorTab === "preflight" && <section aria-labelledby="campaign-editor-preflight-tab" className="campaign-step-panel campaign-tab-panel" id="campaign-editor-preflight-panel" role="tabpanel">
              <WorkspaceSectionHeader
                description="Evaluate saved revisions, inspect Runtime evidence, then explicitly create a dry or live run."
                kicker="Safety gate"
                title="Review & launch"
              />
              {!campaign && <InlineAlert title="Create the draft first" tone="info">Preflight requires a persisted campaign.</InlineAlert>}
              {campaign && <>
                {(detailsDirty || targetsDirty) && <InlineAlert title="Save before preflight" tone="warning">Preflight reads persisted Runtime state, not unsaved edits.</InlineAlert>}
                {revisionRefreshRequired && <InlineAlert title="Revision refresh required" tone="warning">Reopen this campaign before running preflight.</InlineAlert>}
                {runError && !liveLaunchConfirmationOpen && <InlineAlert title="Campaign run update">{runError}</InlineAlert>}
                <div className="campaign-review-flow">
                  <section aria-labelledby="campaign-review-snapshot-title" className="campaign-review-plan">
                    <div className="campaign-review-plan-copy">
                      <span className="campaign-review-eyebrow">Saved snapshot</span>
                      <h4 id="campaign-review-snapshot-title">Campaign r{campaign.revision} · targets r{targetsRevision ?? campaign.targetsRevision}</h4>
                      <p>{targetIds.length.toLocaleString()} saved {targetIds.length === 1 ? "target" : "targets"} · {statusLabel(campaign.status)}</p>
                    </div>
                    <div className="campaign-review-mode">
                      <span className="campaign-review-eyebrow">Execution mode</span>
                      <SegmentedControl disabled={preflightLoading || campaignMutationBusy} label="Execution mode" labelHidden onChange={changePreflightMode} options={PREFLIGHT_MODE_OPTIONS} value={preflightMode} />
                    </div>
                    <div className="campaign-review-gate" data-tone={reviewGate.tone}>
                      <header>
                        <div className="campaign-review-gate-heading">
                          <div className="campaign-review-gate-label"><AppIcon className="campaign-review-gate-icon" name={reviewGate.icon} size="sm" /><span className="campaign-review-eyebrow">Safety gate</span></div>
                          <h4>{reviewGate.title}</h4>
                        </div>
                        <Badge tone={reviewGate.tone} variant="status">{reviewGate.badge}</Badge>
                      </header>
                      <p>{reviewGate.description}</p>
                    </div>
                  </section>
                  <div className="campaign-review-report stack stack-md">
                    {preflightError && <InlineAlert title="Preflight failed">{preflightError}</InlineAlert>}
                    {preflight && <PreflightReport report={preflight} stale={reportStale} />}
                    {!preflight && !preflightError && <WorkspaceEmptyState className="campaign-preflight-empty" icon="activity" title="No Runtime decision yet">Choose an execution mode, then run preflight against the saved snapshot.</WorkspaceEmptyState>}
                  </div>
                </div>
                <CampaignRunsPanel
                  campaignStatus={campaign.status}
                  loading={runsLoading}
                  mutation={runMutation ?? (campaignMutationBusy ? "campaign" : null)}
                  onAction={changeRunState}
                  onReload={() => void loadRuns(campaign.id, editorEpochRef.current, true)}
                  onOpenRun={onOpenRun}
                  runs={runs}
                />
              </>}
            </section>}
          </div>
        )}
      </WorkspaceDialog>
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
        busy={runMutation === "launch:LIVE"}
        busyLabel="Launching…"
        cancelLabel="Keep reviewing"
        confirmLabel="Launch live campaign"
        error={runError}
        errorTitle="Could not launch campaign"
        onCancel={() => setLiveLaunchConfirmationOpen(false)}
        onConfirm={() => void launchRun("LIVE")}
        open={liveLaunchConfirmationOpen}
        title="Launch LIVE campaign?"
      />
      <ConfirmationDialog
        body={<p>Campaign “{deleteIntent?.name}” will be removed from the workspace. Run and message delivery history will remain available for audit. You cannot undo this action in WA Studio.</p>}
        busy={deletingCampaign}
        busyLabel="Deleting…"
        cancelLabel="Cancel"
        confirmDisabled={Boolean(deleteIntentDisabledReason) || (campaignMutationBusy && !deletingCampaign)}
        confirmLabel="Delete campaign"
        confirmVariant="danger"
        error={campaignDeleteError}
        errorTitle="Could not delete campaign"
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
  return <section className="campaign-runs-panel" aria-label="Campaign runs">
    <header><div><h3>Campaign runs</h3><p>Campaign lifecycle: {statusLabel(campaignStatus)}. Run status remains an independent execution state.</p></div><Button disabled={loading || Boolean(mutation)} loading={loading} onClick={onReload} size="sm" variant="ghost">Reload runs</Button></header>
    {!loading && !runs.length && <p className="campaign-run-empty">No campaign runs yet.</p>}
    {runs.map((run) => <article className="campaign-run-card" key={run.id}>
      <div className="campaign-run-card-main">
        <div><Badge tone={runTone(run.status)} variant="status">{statusLabel(run.status)}</Badge><Badge tone="neutral">{executionModeLabel(run.executionMode)}</Badge></div>
        <strong>{run.totalTargets} target snapshot</strong>
        <span><DateTime value={run.createdAt} /> · {run.id}</span>
        {run.targetSource && <small>From saved list: {run.targetSource.groupListNameSnapshot} · membership r{run.targetSource.membershipRevision} · applied <DateTime value={run.targetSource.appliedAt} /></small>}
        {run.statusReason && <small>{run.statusReason}</small>}
      </div>
      <div className="campaign-run-card-actions">
        {onOpenRun && <Button disabled={Boolean(mutation)} onClick={() => onOpenRun(run.id)} size="sm" variant="ghost">Open in Runs</Button>}
        {(run.status === "RUNNING" || run.status === "SCHEDULED") && <Button disabled={Boolean(mutation)} loading={mutation === `pause:${run.id}`} onClick={() => onAction(run, "pause")} size="sm">Pause</Button>}
        {(run.status === "PAUSED" || run.status === "BLOCKED") && <Button disabled={Boolean(mutation)} loading={mutation === `resume:${run.id}`} onClick={() => onAction(run, "resume")} size="sm">Resume</Button>}
        {!terminal.has(run.status) && run.status !== "CANCELLING" && <Button disabled={Boolean(mutation)} loading={mutation === `cancel:${run.id}`} onClick={() => onAction(run, "cancel")} size="sm" variant="ghost">Cancel</Button>}
      </div>
    </article>)}
  </section>;
}

function PreflightReport({ report, stale }: { report: RuntimeCampaignPreflight; stale: boolean }) {
  const presentation = preflightStatusPresentation(report.status, report.executionMode);
  return (
    <section aria-label="Preflight result" className="preflight-report" data-status={report.status.toLocaleLowerCase()} data-stale={stale || undefined}>
      {stale && <InlineAlert title="Preflight result is stale" tone="warning">Campaign details or targets changed. Run preflight again.</InlineAlert>}
      <header className="preflight-result-header">
        <span className="preflight-result-icon"><AppIcon name={presentation.icon} size="lg" /></span>
        <div className="preflight-result-copy"><span>Runtime decision</span><div><h4>{presentation.title}</h4><Badge tone={reportTone(report.status)} variant="status">{statusLabel(report.status)}</Badge></div><p>{presentation.description}</p></div>
      </header>
      <section aria-labelledby="preflight-target-readiness-title" className="preflight-target-summary">
        <header><div><span>Target readiness</span><h4 id="preflight-target-readiness-title">Runtime target assessment</h4></div><p>Capability state captured by this decision.</p></header>
        <MetricGrid ariaLabel="Target readiness" className="preflight-metrics" items={[
          { label: "Total", value: report.totalTargets },
          { label: "Allowed", tone: "success", value: report.allowedTargets },
          { label: "Denied", tone: "danger", value: report.deniedTargets },
          { label: "Unknown", tone: "warning", value: report.unknownTargets },
        ]} />
      </section>
      <MetricGrid ariaLabel="Preflight context" className="preflight-context" items={[
        { label: "Mode", value: executionModeLabel(report.executionMode) },
        { label: "Policy", value: `Policy v${report.policyVersion}` },
        { label: "Checked", value: <DateTime value={report.checkedAt} /> },
        { label: "Snapshot", value: `Campaign r${report.campaignRevision} · targets r${report.targetsRevision}` },
      ]} />
      <div className="preflight-evidence" data-has-target-issues={report.targetIssues.length > 0 || undefined}>
        {report.targetIssues.length > 0 ? (
          <section className="preflight-evidence-panel preflight-target-issues">
            <header>
              <div><h4>Target issues</h4><p>Groups that require operator attention.</p></div>
              <Badge tone="warning">{report.targetIssues.length}</Badge>
            </header>
            <ul className="preflight-evidence-list">
              {report.targetIssues.map((issue) => (
                <li key={`${issue.groupId}-${issue.reason}`}>
                  <Badge tone={issue.capability === "DENIED" ? "danger" : "warning"} variant="status">{statusLabel(issue.capability)}</Badge>
                  <span className="preflight-evidence-copy">
                    <strong>{issue.groupName}</strong>
                    <small>{PREFLIGHT_ISSUE_LABELS[issue.reason] ?? "Runtime reported a target issue"}</small>
                    <code>{issue.reason}</code>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <InlineAlert indicator title="No target issues" tone="success">
            Runtime found no groups that require operator attention.
          </InlineAlert>
        )}
        <section className="preflight-evidence-panel preflight-policy-checks">
          <header>
            <div><h4>Policy checks</h4><p>Checks contributing to Runtime's decision.</p></div>
            <Badge tone="neutral">{report.checks.length}</Badge>
          </header>
          <ul className="preflight-evidence-list">
            {report.checks.map((check) => (
              <li key={check.code}>
                <Badge className="preflight-check-status" tone={reportTone(check.status)} variant="status">{preflightCheckStatusLabel(check.status)}</Badge>
                <span className="preflight-evidence-copy">
                  <strong>{PREFLIGHT_CHECK_LABELS[check.code] ?? "Runtime policy check"}</strong>
                  <small>{check.message}</small>
                  <code>{check.code}</code>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </section>
  );
}
