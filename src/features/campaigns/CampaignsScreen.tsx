import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRuntimeConnection } from "@/app/RuntimeConnectionContext";
import {
  GroupSelectionTable,
  type GroupSelectionRow,
} from "@/features/groups/selection/GroupSelectionTable";
import { GroupSelectionToolbar } from "@/features/groups/selection/GroupSelectionToolbar";
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
import { Drawer } from "@/shared/ui/Drawer";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { PageHeader } from "@/shared/ui/PageHeader";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import { Tabs } from "@/shared/ui/Tabs";
import { TablePagination } from "@/shared/ui/TablePagination";
import { TextAreaField } from "@/shared/ui/TextAreaField";
import { TextField } from "@/shared/ui/TextField";
import { useToast } from "@/shared/ui/Toast";
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

function formatDate(value: string | null): string {
  if (!value) return "Immediate";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

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

function runTone(status: RuntimeCampaignRun["status"]) {
  if (status === "COMPLETED" || status === "RUNNING") return "success" as const;
  if (status === "SCHEDULED" || status === "PAUSED" || status === "PREPARING") return "warning" as const;
  if (status === "BLOCKED" || status === "PARTIAL_FAILED" || status === "FAILED") return "danger" as const;
  return "neutral" as const;
}

export function CampaignsScreen() {
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
  const createKeyRef = useRef<string | null>(null);
  const launchKeyRef = useRef<{ key: string; mode: RuntimeCampaignExecutionMode } | null>(null);
  const editorEpochRef = useRef(0);
  const targetRequestRef = useRef(0);
  const runRequestRef = useRef(0);
  const targetsRevisionRef = useRef<number | null>(null);
  const listRequestRef = useRef(0);
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
      if (code === "CAMPAIGN_RUN_REVISION_CONFLICT") {
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
          ? `Saved ${targetDiff.savedCount} · Staged ${targetDiff.selectedCount} · +${targetDiff.addedIds.length} / −${targetDiff.removedIds.length}`
          : "Saved target set";
  const targetSelectionSummary = `Saved ${targetDiff.savedCount} · Staged ${targetDiff.selectedCount} · +${targetDiff.addedIds.length} / −${targetDiff.removedIds.length}`;
  const footerState = editorTab === "details"
    ? campaign
      ? detailsDirty ? "Unsaved detail changes" : "Details are up to date"
      : "Create the draft to unlock targets and preflight"
    : editorTab === "targets"
      ? targetChangeState
      : reportStale ? "Run preflight again after saving changes" : preflight ? `Last result: ${preflight.status}` : "No preflight result yet";
  const editorStep = editorTab === "details" ? 1 : editorTab === "targets" ? 2 : 3;
  const editorStepLabel = editorTab === "details" ? "Details" : editorTab === "targets" ? "Targets" : "Preflight";
  const footerAction = editorTab === "details" ? (
    <Button disabled={!editable || (Boolean(campaign) && !detailsDirty)} loading={savingDetails} onClick={() => void saveDetails()} variant="primary">
      {campaign ? "Save details" : "Create draft"}
    </Button>
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
            <thead><tr><th scope="col">Campaign</th><th scope="col">Status</th><th scope="col">Schedule</th><th scope="col">Targets</th><th className="align-end" scope="col">Action</th></tr></thead>
            <tbody>
              {!selectedSessionId ? <tr><td className="data-table-empty" colSpan={5}>Select a session to view campaigns.</td></tr>
                : !visiblePage && listPending ? <tr><td className="data-table-empty" colSpan={5}>Loading campaigns…</td></tr>
                : !visiblePage && visibleListError ? <tr><td className="data-table-empty" colSpan={5}>Campaigns are unavailable.</td></tr>
                : !visiblePage?.data.length ? <tr><td className="data-table-empty" colSpan={5}>{hasListCriteria ? "No campaigns match this search or filters." : "No campaigns yet. Create a draft to get started."}</td></tr>
                : visiblePage.data.map((item) => <tr key={item.id}>
                  <td className="data-cell-primary"><div className="stack stack-xs"><strong className="data-primary-text">{item.name}</strong><span className="data-identifier">{item.id}</span></div></td>
                  <td><Badge tone={statusTone(item.status)}>{statusLabel(item.status)}</Badge></td>
                  <td>{item.scheduleType === "IMMEDIATE" ? "Immediate" : formatDate(item.scheduledAt)}</td>
                  <td>{item.targetCount}</td>
                  <td className="data-cell-action"><Button onClick={() => openCampaign(item)} size="sm" variant="ghost">{item.status === "DRAFT" ? "Edit" : "Review"}</Button></td>
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

      <Drawer
        className="campaign-editor-drawer"
        contentKey={`${campaign?.id ?? "new"}:${editorEpochRef.current}:${editorTab}`}
        description={campaign
          ? "Edit persisted details, targets, and Runtime readiness in sequence."
          : "Step 1 of 3 · Define content and delivery timing."}
        eyebrow="Campaign workspace"
        footer={editor.kind === "open" && <div className="campaign-workspace-footer"><div className="campaign-workspace-footer-copy"><strong>Step {editorStep} of 3 · {editorStepLabel}</strong><span>{footerState}</span></div><div className="campaign-workspace-footer-actions">{footerAction}</div></div>}
        onClose={requestCloseEditor}
        open={editor.kind === "open"}
        size="wide"
        title={campaign?.name ?? "New campaign draft"}
      >
        {editor.kind === "open" && (
          <div className="campaign-editor">
            {campaign && campaign.status !== "DRAFT" && <InlineAlert title="Read-only campaign" tone="warning">Runtime status is {statusLabel(campaign.status)}; only draft campaigns are editable.</InlineAlert>}
            <div className="campaign-workspace-navigation">
              <Tabs
                activeTab={editorTab}
                appearance="steps"
                ariaLabel="Campaign editor sections"
                idPrefix="campaign-editor"
                onChange={setEditorTab}
                tabs={[
                  { id: "details", label: "Details", step: 1, warning: Boolean(campaign && detailsDirty) },
                  { badge: campaign ? draftTargetIds.length : undefined, disabled: !campaign, id: "targets", label: "Targets", step: 2, warning: Boolean(campaign && targetsDirty) },
                  { badge: preflight?.status, disabled: !campaign, id: "preflight", label: "Preflight", step: 3, warning: reportStale },
                ]}
              />
            </div>
            <div className="campaign-workspace-content">
            {editorTab === "details" && <section aria-labelledby="campaign-editor-details-tab" className="campaign-tab-panel stack stack-lg" id="campaign-editor-details-panel" role="tabpanel">
              <div className="campaign-section-heading"><div><span>Step 1 · Required</span><h3>Content &amp; schedule</h3><p>Define the message draft and when Runtime should schedule it.</p></div></div>
              {detailsError && <InlineAlert title="Could not save details">{detailsError}</InlineAlert>}
              <section aria-labelledby="campaign-content-title" className="campaign-form-section stack stack-md"><h4 id="campaign-content-title">Message draft</h4><TextField error={formErrors.name} disabled={!editable} label="Campaign name" onChange={(event) => updateForm("name", event.target.value)} value={form.name} /><TextAreaField description="Plain text sent only by a later run milestone." disabled={!editable} error={formErrors.text} label="Message text" onChange={(event) => updateForm("text", event.target.value)} rows={5} value={form.text} /></section>
              <section aria-labelledby="campaign-timing-title" className="campaign-form-section stack stack-md"><div className="campaign-form-section-heading"><h4 id="campaign-timing-title">Delivery timing</h4><span>Managed by Runtime</span></div><SelectMenu description="Immediate uses canonical scheduledAt = null." disabled={!editable} label="Schedule" onChange={(scheduleType) => updateForm("scheduleType", scheduleType)} options={SCHEDULE_OPTIONS} value={form.scheduleType} />{form.scheduleType === "ONCE" && <TextField description="Stored by Runtime in UTC." disabled={!editable} error={formErrors.scheduledAt} label="Scheduled date and time" min={new Date().toISOString().slice(0, 16)} onChange={(event) => updateForm("scheduledAt", event.target.value)} type="datetime-local" value={form.scheduledAt} />}</section>
            </section>}

            {editorTab === "targets" && <section aria-labelledby="campaign-editor-targets-tab" className="campaign-tab-panel stack stack-md" id="campaign-editor-targets-panel" role="tabpanel">
              <div className="campaign-section-heading"><div><span>Step 2 · Persisted set</span><h3>Target groups</h3><p>Build the complete group target set · maximum 1,000.</p></div></div>
              {!campaign && <InlineAlert title="Create the draft first" tone="info">Targets belong to a persisted campaign.</InlineAlert>}
              {campaign && <>
                {targetsError && <InlineAlert title="Target update">{targetsError}</InlineAlert>}
                {targetSource && <div className="campaign-target-source">
                  <div><span>Source</span><strong>From saved list: {targetSource.groupListNameSnapshot}</strong></div>
                  <div><span>Membership revision</span><strong>{targetSource.membershipRevision}</strong></div>
                  <div><span>Applied at</span><strong>{formatDate(targetSource.appliedAt)}</strong></div>
                  <p>This is audit provenance for a materialized snapshot, not a live link.</p>
                </div>}
                {!targetSource && !targetsLoading && targetsRevision !== null && <div className="campaign-target-source campaign-target-source-custom">
                  <div><span>Source</span><strong>Custom selection</strong></div>
                  <p>{targets.length === 0 ? "This campaign currently has an empty target set." : "Targets were selected manually and are not linked to a group list."}</p>
                </div>}
                {targetSource && targetsDirty && <InlineAlert title="Manual changes clear provenance" tone="warning">Saving this manually edited target set will return source null. The group list itself is not changed.</InlineAlert>}
                <section aria-label="Target group selection" className="group-selection-section">
                  <div className="group-selection-heading"><div><h4>Group selection</h4><p>Filters narrow current results; saved and selected targets remain visible.</p></div><div aria-live="polite" className="group-selection-status" data-dirty={targetsDirty || undefined}><strong>{targetSelectionSummary}</strong>{targetDiff.selectedCount >= 900 && <Badge tone={targetDiff.selectedCount >= 1_000 ? "danger" : "warning"}>{targetDiff.selectedCount > 1_000 ? `${targetDiff.selectedCount - 1_000} over limit` : targetDiff.selectedCount === 1_000 ? "Limit reached" : `${1_000 - targetDiff.selectedCount} remaining`}</Badge>}</div></div>
                  <GroupSelectionToolbar actions={<CampaignGroupListActions api={api} campaignId={campaign.id} disabled={!editable || targetsLoading || targetsSaving || targetsDirty} onApply={applyGroupList} sessionId={campaign.sessionId} />} filterAriaLabel="Target group filters" filterTitle="Filter target groups" filters={groupDirectory.filters} filtersOpen={groupDirectory.filtersOpen} idPrefix="campaign-target" inputQuery={groupDirectory.inputQuery} loading={groupDirectory.loading} onFiltersChange={groupDirectory.setFilters} onFiltersOpenChange={groupDirectory.setFiltersOpen} onParticipantErrorsClear={() => groupDirectory.setParticipantErrors({})} onSearchChange={groupDirectory.setSearch} pageItemCount={groupDirectory.groups.length} pageOffset={groupDirectory.offset} participantErrors={groupDirectory.participantErrors} total={groupDirectory.total} />
                  {targetsDirty && <p className="group-selection-page-note">Save or reset manual target changes before applying a group list.</p>}
                  {targetNotice && <InlineAlert title="Persisted target snapshot" tone="success">{targetNotice}</InlineAlert>}
                  {groupDirectory.error && <InlineAlert action={<Button onClick={groupDirectory.retry} size="sm">Retry</Button>} title="Could not load groups">{groupDirectory.error}</InlineAlert>}
                  <GroupSelectionTable caption="Groups available to the campaign target selection" disabled={!editable || targetsLoading || targetsSaving} emptyMessage={groupDirectory.hasCriteria ? "No synchronized groups match this search or filters." : "No synchronized groups found."} loading={groupDirectory.loading || targetsLoading} onToggle={toggleTarget} onTogglePage={toggleAllPageTargets} pageIds={groupPageIds} pinnedIds={pinnedTargetIds} rows={targetRows} selectedIds={draftTargetIdSet} unknownParticipantsTitle="Participant count is unavailable in the saved target snapshot." />
                  {!groupDirectory.loading && groupDirectory.groups.length === 0 && targetRows.length > 0 && <p className="group-selection-page-note">{groupDirectory.hasCriteria ? "No additional synchronized groups match this search or filters. Selected and saved targets remain visible above." : "No additional synchronized groups are available. Selected and saved targets remain visible above."}</p>}
                  <TablePagination limit={groupDirectory.pageSize} loading={groupDirectory.loading} offset={groupDirectory.offset} onOffsetChange={groupDirectory.setOffset} total={groupDirectory.total} />
                </section>
              </>}
            </section>}

            {editorTab === "preflight" && <section aria-labelledby="campaign-editor-preflight-tab" className="campaign-tab-panel stack stack-md" id="campaign-editor-preflight-panel" role="tabpanel">
              <div className="campaign-section-heading"><div><span>Step 3 · Review &amp; launch</span><h3>Readiness review</h3><p>Evaluate persisted revisions, then explicitly create a dry or live run.</p></div></div>
              {!campaign && <InlineAlert title="Create the draft first" tone="info">Preflight requires a persisted campaign.</InlineAlert>}
              {campaign && <>
                {(detailsDirty || targetsDirty) && <InlineAlert title="Save before preflight" tone="warning">Preflight reads persisted Runtime state, not unsaved edits.</InlineAlert>}
                {revisionRefreshRequired && <InlineAlert title="Revision refresh required" tone="warning">Reopen this campaign before running preflight.</InlineAlert>}
                <SelectMenu description="Both modes only evaluate policy. Neither creates a run or sends messages." disabled={preflightLoading || Boolean(runMutation)} label="Preflight mode" onChange={changePreflightMode} options={PREFLIGHT_MODE_OPTIONS} value={preflightMode} />
                {preflightError && <InlineAlert title="Preflight failed">{preflightError}</InlineAlert>}
                {preflight && <PreflightReport report={preflight} stale={reportStale} />}
                {!preflight && !preflightError && <div className="campaign-empty-state"><span className="campaign-empty-state-icon"><AppIcon name="check" size="lg" /></span><strong>No preflight report</strong><p>Choose a policy mode, then run preflight against the saved campaign and target set.</p></div>}
                {runError && <InlineAlert title="Campaign run update">{runError}</InlineAlert>}
                {campaign.status === "DRAFT" && preflight && !reportStale && preflight.status !== "BLOCK" && <section className="campaign-launch-panel">
                  <div><strong>Launch reviewed revisions</strong><p>Campaign r{preflight.campaignRevision} · targets r{preflight.targetsRevision}. Runtime rechecks these preconditions authoritatively.</p></div>
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
                  runs={runs}
                />
              </>}
            </section>}
            </div>
          </div>
        )}
      </Drawer>
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
    </div>
  );
}

function CampaignRunsPanel({
  campaignStatus,
  loading,
  mutation,
  onAction,
  onReload,
  runs,
}: {
  campaignStatus: RuntimeCampaign["status"];
  loading: boolean;
  mutation: string | null;
  onAction: (run: RuntimeCampaignRun, action: "pause" | "resume" | "cancel") => void;
  onReload: () => void;
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
        <span>{formatDate(run.createdAt)} · {run.id}</span>
        {run.targetSource && <small>From saved list: {run.targetSource.groupListNameSnapshot} · membership r{run.targetSource.membershipRevision} · applied {formatDate(run.targetSource.appliedAt)}</small>}
        {run.statusReason && <small>{run.statusReason}</small>}
      </div>
      <div className="campaign-run-card-actions">
        {(run.status === "RUNNING" || run.status === "SCHEDULED") && <Button disabled={Boolean(mutation)} loading={mutation === `pause:${run.id}`} onClick={() => onAction(run, "pause")} size="sm">Pause</Button>}
        {(run.status === "PAUSED" || run.status === "BLOCKED") && <Button disabled={Boolean(mutation)} loading={mutation === `resume:${run.id}`} onClick={() => onAction(run, "resume")} size="sm">Resume</Button>}
        {!terminal.has(run.status) && <Button disabled={Boolean(mutation)} loading={mutation === `cancel:${run.id}`} onClick={() => onAction(run, "cancel")} size="sm" variant="ghost">Cancel</Button>}
      </div>
    </article>)}
  </section>;
}

function PreflightReport({ report, stale }: { report: RuntimeCampaignPreflight; stale: boolean }) {
  return (
    <div className="preflight-report" data-stale={stale || undefined}>
      {stale && <InlineAlert title="Preflight result is stale" tone="warning">Campaign details or targets changed. Run preflight again.</InlineAlert>}
      <div className="preflight-summary">
        <Badge tone={reportTone(report.status)}>{report.status}</Badge>
        <strong>{report.executionMode}</strong>
        <span>Policy v{report.policyVersion}</span>
        <span>{formatDate(report.checkedAt)}</span>
      </div>
      <dl className="preflight-metrics">
        <div><dt>Total</dt><dd>{report.totalTargets}</dd></div>
        <div><dt>Allowed</dt><dd>{report.allowedTargets}</dd></div>
        <div><dt>Denied</dt><dd>{report.deniedTargets}</dd></div>
        <div><dt>Unknown</dt><dd>{report.unknownTargets}</dd></div>
      </dl>
      <p className="campaign-revisions">Campaign revision {report.campaignRevision} · target revision {report.targetsRevision}</p>
      <div className="preflight-columns">
        <div><h3>Checks</h3><ul>{report.checks.map((check) => <li key={check.code}><Badge tone={reportTone(check.status)}>{check.status}</Badge><span><code>{check.code}</code><small>{check.message}</small></span></li>)}</ul></div>
        <div><h3>Target issues</h3>{!report.targetIssues.length ? <p>No target issues.</p> : <ul>{report.targetIssues.map((issue) => <li key={`${issue.groupId}-${issue.reason}`}><Badge tone={issue.capability === "DENIED" ? "danger" : "warning"}>{issue.capability}</Badge><span><strong>{issue.groupName}</strong><code>{issue.reason}</code></span></li>)}</ul>}</div>
      </div>
    </div>
  );
}
