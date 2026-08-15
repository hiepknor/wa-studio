import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRuntimeConnection } from "@/app/RuntimeConnectionContext";
import {
  GroupSelectionTable,
  type GroupSelectionRow,
} from "@/features/groups/selection/GroupSelectionTable";
import { GroupSelectionToolbar } from "@/features/groups/selection/GroupSelectionToolbar";
import { useGroupDirectoryQuery } from "@/features/groups/selection/useGroupDirectoryQuery";
import {
  applyGroupSelectionSnapshot,
  sameGroupSelection,
} from "@/features/groups/selection/group-selection";
import {
  RuntimeRequestError,
  type RuntimeCampaign,
  type RuntimeCampaignExecutionMode,
  type RuntimeCampaignPage,
  type RuntimeCampaignPreflight,
  type RuntimeCampaignTarget,
  type RuntimeGroupListGroup,
  type RuntimeSavedGroupList,
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
import { CampaignSavedListActions } from "./CampaignSavedListActions";
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

function fieldDescription(error: string | undefined, hint?: string) {
  return error ? <span className="campaign-field-error">{error}</span> : hint;
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
  const [targetsLoading, setTargetsLoading] = useState(false);
  const [targetsSaving, setTargetsSaving] = useState(false);
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [revisionRefreshRequired, setRevisionRefreshRequired] = useState(false);
  const [appliedListRows, setAppliedListRows] = useState<Record<string, RuntimeGroupListGroup>>({});
  const [preflightMode, setPreflightMode] = useState<RuntimeCampaignExecutionMode>("DRY_RUN");
  const [preflight, setPreflight] = useState<RuntimeCampaignPreflight | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const createKeyRef = useRef<string | null>(null);
  const editorEpochRef = useRef(0);
  const listRequestRef = useRef(0);
  const listTargetRef = useRef(campaignListRequestKey(listState));
  const pageKeyRef = useRef("");
  const errorKeyRef = useRef("");
  const listStateRef = useRef(listState);
  const currentListRequestKey = campaignListRequestKey(listState);
  listTargetRef.current = currentListRequestKey;
  listStateRef.current = listState;

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
  const targetRows = useMemo(() => {
    const reviewIds = new Set(reviewTargetIds);
    const groupIds = [
      ...reviewTargetIds,
      ...groupDirectory.groups.map((group) => group.id).filter((groupId) => !reviewIds.has(groupId)),
    ];
    return groupIds.flatMap<GroupSelectionRow>((groupId) => {
      const group = groupDirectory.knownGroups[groupId];
      const applied = appliedListRows[groupId];
      const target = targetById.get(groupId);
      const sendCapability = group?.sendCapability ?? applied?.sendCapability ?? target?.sendCapability;
      if (!sendCapability) return [];
      return [{
        groupId,
        groupName: target?.groupName ?? applied?.groupName ?? group?.name ?? groupId,
        isActive: group?.isActive ?? applied?.isActive ?? target?.enabled ?? true,
        participantsCount: group?.participantsCount ?? applied?.participantsCount ?? null,
        sendCapability,
      }];
    });
  }, [appliedListRows, groupDirectory.groups, groupDirectory.knownGroups, reviewTargetIds, targetById]);
  const groupPageIds = useMemo(
    () => groupDirectory.groups.map((group) => group.id),
    [groupDirectory.groups],
  );
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
    setAppliedListRows({});
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
  }, []);

  async function loadTargets(campaignId: string, epoch: number) {
    setTargetsLoading(true);
    setTargetsError(null);
    try {
      const result = await api.listCampaignTargets(campaignId);
      if (epoch !== editorEpochRef.current) return;
      setTargets(result.data);
      setDraftTargetIds(result.data.map((target) => target.groupId));
    } catch (error) {
      if (epoch !== editorEpochRef.current) return;
      setTargetsError(campaignErrorMessage(error, "Could not load campaign targets."));
    } finally {
      if (epoch === editorEpochRef.current) setTargetsLoading(false);
    }
  }

  function openCreate() {
    editorEpochRef.current += 1;
    createKeyRef.current = null;
    setEditor({ campaign: null, kind: "open" });
    setEditorTab("details");
    setForm(emptyCampaignForm());
    setFormErrors({});
    setDetailsError(null);
    setTargets([]);
    setDraftTargetIds([]);
    setRevisionRefreshRequired(false);
    setAppliedListRows({});
    setPreflightMode("DRY_RUN");
    setPreflight(null);
    setPreflightError(null);
  }

  function openCampaign(selected: RuntimeCampaign) {
    const epoch = ++editorEpochRef.current;
    createKeyRef.current = null;
    setEditor({ campaign: selected, kind: "open" });
    setEditorTab("details");
    setForm(campaignFormFromDto(selected));
    setFormErrors({});
    setDetailsError(null);
    setTargets([]);
    setDraftTargetIds([]);
    setRevisionRefreshRequired(false);
    setPreflight(null);
    setPreflightError(null);
    setPreflightMode("DRY_RUN");
    setAppliedListRows({});
    void loadTargets(selected.id, epoch);
  }

  function closeEditor() {
    editorEpochRef.current += 1;
    createKeyRef.current = null;
    setEditor({ kind: "closed" });
    setAppliedListRows({});
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
        title: created ? "Campaign draft created." : "Campaign details saved.",
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
  }

  function applySavedGroupList(
    groupIds: string[],
    mode: "add" | "replace",
    list: RuntimeSavedGroupList,
    listGroups: RuntimeGroupListGroup[],
  ): { message: string; ok: boolean } {
    if (list.sessionId !== selectedSessionId || list.archivedAt !== null) {
      return { message: "This saved list is not available in the campaign session.", ok: false };
    }
    const outcome = applyGroupSelectionSnapshot(draftTargetIds, groupIds, mode);
    if (!outcome.ok) {
      return {
        message: `Applying ${list.name} would exceed the 1,000-group campaign target limit. The staged selection was not changed.`,
        ok: false,
      };
    }
    setAppliedListRows((current) => ({
      ...current,
      ...Object.fromEntries(listGroups.map((group) => [group.groupId, group])),
    }));
    setDraftTargetIds(outcome.nextIds);
    setTargetsError(null);
    if (mode === "replace") {
      return {
        message: outcome.nextIds.length
          ? `Staged selection replaced with ${outcome.nextIds.length} groups from ${list.name}. Save target set to persist.`
          : `Empty list ${list.name} staged an empty target set. Save target set to persist.`,
        ok: true,
      };
    }
    return {
      message: outcome.addedCount
        ? `${outcome.addedCount} group${outcome.addedCount === 1 ? "" : "s"} added from ${list.name}. Save target set to persist.`
        : `${list.name} added no new groups; the staged selection was unchanged.`,
      ok: true,
    };
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
  }

  async function saveTargets() {
    if (!campaign || !editable) return;
    const validation = validateTargetReplacement(draftTargetIds);
    if (!validation.ok) {
      setTargetsError(campaignErrorMessage({ code: validation.code }, "Invalid target set."));
      return;
    }
    const epoch = editorEpochRef.current;
    let replacementCommitted = false;
    setTargetsSaving(true);
    setTargetsError(null);
    try {
      const canonical = await api.replaceCampaignTargets(campaign.id, validation.groupIds);
      if (epoch !== editorEpochRef.current) return;
      replacementCommitted = true;
      setTargets(canonical.data);
      setDraftTargetIds(canonical.data.map((target) => target.groupId));
      setPreflight(null);
      setRevisionRefreshRequired(true);
      const refreshed = await api.getCampaign(campaign.id);
      if (epoch !== editorEpochRef.current || refreshed.sessionId !== selectedSessionId) return;
      setEditor({ campaign: refreshed, kind: "open" });
      setForm(campaignFormFromDto(refreshed));
      setRevisionRefreshRequired(false);
      void loadCampaigns(listStateRef.current);
      toast.notify({ id: `targets-saved-${campaign.id}`, title: "Target set saved.", tone: "success" });
    } catch (error) {
      if (epoch !== editorEpochRef.current) return;
      setTargetsError(replacementCommitted
        ? "Targets were replaced, but the campaign revision could not be refreshed. Reopen the campaign before preflight."
        : campaignErrorMessage(error, "Could not replace campaign targets."));
      // Keep the last authoritative target list; staged choices remain clearly unsaved.
    } finally {
      if (epoch === editorEpochRef.current) setTargetsSaving(false);
    }
  }

  async function runPreflight(executionMode: RuntimeCampaignExecutionMode) {
    if (!campaign || detailsDirty || targetsDirty || revisionRefreshRequired) return;
    const epoch = editorEpochRef.current;
    const campaignId = campaign.id;
    setPreflightLoading(true);
    setPreflightError(null);
    try {
      const report = await api.preflightCampaign(campaignId, executionMode);
      if (
        epoch !== editorEpochRef.current
        || editor.kind !== "open"
        || editor.campaign?.id !== campaignId
        || editor.campaign.sessionId !== selectedSessionId
      ) return;
      setPreflight(report);
    } catch (error) {
      if (epoch !== editorEpochRef.current) return;
      setPreflightError(campaignErrorMessage(error, "Could not run preflight."));
    } finally {
      if (epoch === editorEpochRef.current) setPreflightLoading(false);
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
          ? `${targetDiff.addedIds.length} added · ${targetDiff.removedIds.length} removed · Not saved`
          : "Saved target set";
  const targetSelectionSummary = targetsDirty
    ? `${targetDiff.selectedCount} selected · ${targetDiff.addedIds.length} added · ${targetDiff.removedIds.length} removed`
    : `${targetDiff.selectedCount} selected`;
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
    <Button disabled={!campaign || !editable || !targetsDirty || targetsLoading} loading={targetsSaving} onClick={() => void saveTargets()} variant="primary">Save target set</Button>
  ) : (
    <Button disabled={!campaign || detailsDirty || targetsDirty || revisionRefreshRequired} loading={preflightLoading} onClick={() => void runPreflight(preflightMode)} variant="primary">Run preflight</Button>
  );

  return (
    <div className="campaigns-screen stack stack-lg">
      <PageHeader
        actions={<Button disabled={!selectedSessionId} onClick={openCreate} variant="primary">New campaign</Button>}
        description="Create draft campaigns, persist group targets, and review Runtime preflight policy."
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
              <section aria-labelledby="campaign-content-title" className="campaign-form-section stack stack-md"><h4 id="campaign-content-title">Message draft</h4><TextField description={fieldDescription(formErrors.name)} disabled={!editable} label="Campaign name" onChange={(event) => updateForm("name", event.target.value)} value={form.name} /><TextAreaField description={fieldDescription(formErrors.text, "Plain text sent only by a later run milestone.")} disabled={!editable} label="Message text" onChange={(event) => updateForm("text", event.target.value)} rows={5} value={form.text} /></section>
              <section aria-labelledby="campaign-timing-title" className="campaign-form-section stack stack-md"><div className="campaign-form-section-heading"><h4 id="campaign-timing-title">Delivery timing</h4><span>Managed by Runtime</span></div><SelectMenu description="Immediate uses canonical scheduledAt = null." disabled={!editable} label="Schedule" onChange={(scheduleType) => updateForm("scheduleType", scheduleType)} options={SCHEDULE_OPTIONS} value={form.scheduleType} />{form.scheduleType === "ONCE" && <TextField description={fieldDescription(formErrors.scheduledAt, "Stored by Runtime in UTC.")} disabled={!editable} label="Scheduled date and time" min={new Date().toISOString().slice(0, 16)} onChange={(event) => updateForm("scheduledAt", event.target.value)} type="datetime-local" value={form.scheduledAt} />}</section>
            </section>}

            {editorTab === "targets" && <section aria-labelledby="campaign-editor-targets-tab" className="campaign-tab-panel stack stack-md" id="campaign-editor-targets-panel" role="tabpanel">
              <div className="campaign-section-heading"><div><span>Step 2 · Persisted set</span><h3>Audience selection</h3><p>Choose the complete group target set · maximum 1,000.</p></div></div>
              {!campaign && <InlineAlert title="Create the draft first" tone="info">Targets belong to a persisted campaign.</InlineAlert>}
              {campaign && <>
                {targetsError && <InlineAlert title="Target update">{targetsError}</InlineAlert>}
                <CampaignSavedListActions api={api} campaignId={campaign.id} disabled={!editable || targetsLoading || targetsSaving} onApply={applySavedGroupList} sessionId={campaign.sessionId} />
                <section aria-labelledby="target-groups-title" className="campaign-target-section">
                  <div className="campaign-target-section-heading"><div><h3 id="target-groups-title">Target groups</h3><p>Filters narrow available groups; selected targets remain visible.</p></div><div aria-live="polite" className="campaign-target-selection-status" data-dirty={targetsDirty || undefined}><strong>{targetSelectionSummary}</strong>{targetDiff.selectedCount >= 900 && <Badge tone={targetDiff.selectedCount >= 1_000 ? "danger" : "warning"}>{targetDiff.selectedCount > 1_000 ? `${targetDiff.selectedCount - 1_000} over limit` : targetDiff.selectedCount === 1_000 ? "Limit reached" : `${1_000 - targetDiff.selectedCount} remaining`}</Badge>}</div></div>
                  <GroupSelectionToolbar filters={groupDirectory.filters} filtersOpen={groupDirectory.filtersOpen} inputQuery={groupDirectory.inputQuery} loading={groupDirectory.loading} onFiltersChange={groupDirectory.setFilters} onFiltersOpenChange={groupDirectory.setFiltersOpen} onParticipantErrorsClear={() => groupDirectory.setParticipantErrors({})} onSearchChange={groupDirectory.setSearch} pageItemCount={groupDirectory.groups.length} pageOffset={groupDirectory.offset} participantErrors={groupDirectory.participantErrors} total={groupDirectory.total} />
                  {groupDirectory.error && <InlineAlert action={<Button onClick={groupDirectory.retry} size="sm">Retry</Button>} title="Could not load groups">{groupDirectory.error}</InlineAlert>}
                  <GroupSelectionTable caption="Groups available to the campaign target selection" disabled={!editable || targetsLoading} emptyMessage={groupDirectory.hasCriteria ? "No synchronized groups match this search or filters." : "No synchronized groups found."} loading={groupDirectory.loading || targetsLoading} onToggle={toggleTarget} onTogglePage={toggleAllPageTargets} pageIds={groupPageIds} rows={targetRows} selectedIds={draftTargetIdSet} unknownParticipantsTitle="Participant count is unavailable in the saved target snapshot." />
                  {!groupDirectory.loading && groupDirectory.groups.length === 0 && targetRows.length > 0 && <p className="campaign-target-page-note">{groupDirectory.hasCriteria ? "No additional synchronized groups match this search or filters. Selected and saved targets remain visible above." : "No additional synchronized groups are available. Selected and saved targets remain visible above."}</p>}
                  <TablePagination limit={groupDirectory.pageSize} loading={groupDirectory.loading} offset={groupDirectory.offset} onOffsetChange={groupDirectory.setOffset} total={groupDirectory.total} />
                </section>
              </>}
            </section>}

            {editorTab === "preflight" && <section aria-labelledby="campaign-editor-preflight-tab" className="campaign-tab-panel stack stack-md" id="campaign-editor-preflight-panel" role="tabpanel">
              <div className="campaign-section-heading"><div><span>Step 3 · Runtime policy</span><h3>Readiness review</h3><p>Evaluate persisted state without creating a run or sending a message.</p></div></div>
              {!campaign && <InlineAlert title="Create the draft first" tone="info">Preflight requires a persisted campaign.</InlineAlert>}
              {campaign && <>
                {(detailsDirty || targetsDirty) && <InlineAlert title="Save before preflight" tone="warning">Preflight reads persisted Runtime state, not unsaved edits.</InlineAlert>}
                {revisionRefreshRequired && <InlineAlert title="Revision refresh required" tone="warning">Reopen this campaign before running preflight.</InlineAlert>}
                <SelectMenu description="Both modes only evaluate policy. Neither creates a run or sends messages." disabled={preflightLoading} label="Preflight mode" onChange={setPreflightMode} options={PREFLIGHT_MODE_OPTIONS} value={preflightMode} />
                {preflightError && <InlineAlert title="Preflight failed">{preflightError}</InlineAlert>}
                {preflight && <PreflightReport report={preflight} stale={reportStale} />}
                {!preflight && !preflightError && <div className="campaign-empty-state"><span className="campaign-empty-state-icon"><AppIcon name="check" size="lg" /></span><strong>No preflight report</strong><p>Choose a policy mode, then run preflight against the saved campaign and target set.</p></div>}
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
    </div>
  );
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
