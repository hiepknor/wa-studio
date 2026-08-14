import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRuntimeConnection } from "@/app/RuntimeConnectionContext";
import { GroupCapabilityStatus } from "@/features/groups/GroupCapabilityStatus";
import {
  RuntimeRequestError,
  type RuntimeCampaign,
  type RuntimeCampaignExecutionMode,
  type RuntimeCampaignPage,
  type RuntimeCampaignPreflight,
  type RuntimeCampaignTarget,
  type RuntimeGroup,
} from "@/shared/api/runtime-client";
import { AppIcon } from "@/shared/ui/AppIcon";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";
import { Drawer } from "@/shared/ui/Drawer";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { PageHeader } from "@/shared/ui/PageHeader";
import { SearchField } from "@/shared/ui/SearchField";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import { Tabs } from "@/shared/ui/Tabs";
import { TablePagination } from "@/shared/ui/TablePagination";
import { TextAreaField } from "@/shared/ui/TextAreaField";
import { TextField } from "@/shared/ui/TextField";
import { useToast } from "@/shared/ui/Toast";
import { CampaignListToolbar } from "./CampaignListToolbar";
import {
  campaignListRequestKey,
  initialCampaignListState,
  type CampaignListRequestState,
} from "./campaign-list-state";
import {
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

function formatDate(value: string | null): string {
  if (!value) return "Immediate";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatDraftSchedule(value: string): string {
  if (!value) return "Date required";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date required" : formatDate(date.toISOString());
}

function statusTone(status: "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED") {
  if (status === "DRAFT") return "neutral" as const;
  if (status === "ACTIVE") return "success" as const;
  if (status === "PAUSED") return "warning" as const;
  return "neutral" as const;
}

function reportTone(status: "PASS" | "WARN" | "BLOCK") {
  if (status === "PASS") return "success" as const;
  if (status === "WARN") return "warning" as const;
  return "danger" as const;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every((id) => expected.has(id));
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
  const [groupQuery, setGroupQuery] = useState("");
  const [groups, setGroups] = useState<RuntimeGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
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
  const editable = !campaign || campaign.status === "DRAFT";
  const detailsDirty = campaign ? hasCampaignChanges(campaign, form) : true;
  const targetIds = useMemo(() => targets.map((target) => target.groupId), [targets]);
  const targetsDirty = !sameIds(targetIds, draftTargetIds);
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

  async function loadGroups(query = "") {
    if (!selectedSessionId) return;
    const epoch = editorEpochRef.current;
    setGroupsLoading(true);
    try {
      const page = await api.listGroups({
        sessionId: selectedSessionId,
        limit: PAGE_SIZE,
        offset: 0,
        query,
      });
      if (epoch === editorEpochRef.current) setGroups(page.data);
    } catch (error) {
      if (epoch === editorEpochRef.current) {
        setTargetsError(campaignErrorMessage(error, "Could not load available groups."));
      }
    } finally {
      if (epoch === editorEpochRef.current) setGroupsLoading(false);
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
    setGroupQuery("");
    void Promise.all([loadTargets(selected.id, epoch), loadGroups()]);
  }

  function closeEditor() {
    editorEpochRef.current += 1;
    createKeyRef.current = null;
    setEditor({ kind: "closed" });
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
        void Promise.all([loadTargets(saved.id, targetEpoch), loadGroups()]);
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
    setDraftTargetIds((current) => current.includes(groupId)
      ? current.filter((candidate) => candidate !== groupId)
      : [...current, groupId]);
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
      toast.notify({ id: `targets-saved-${campaign.id}`, title: "Target set replaced.", tone: "success" });
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
  const footerState = editorTab === "details"
    ? campaign
      ? detailsDirty ? "Unsaved detail changes" : "Details are up to date"
      : "Create the draft to unlock targets and preflight"
    : editorTab === "targets"
      ? targetsDirty ? `${draftTargetIds.length} targets selected · changes not saved` : "Target set is up to date"
      : reportStale ? "Run preflight again after saving changes" : preflight ? `Last result: ${preflight.status}` : "No preflight result yet";
  const editorStep = editorTab === "details" ? 1 : editorTab === "targets" ? 2 : 3;
  const editorStepLabel = editorTab === "details" ? "Details" : editorTab === "targets" ? "Targets" : "Preflight";
  const footerAction = editorTab === "details" ? (
    <Button disabled={!editable || (Boolean(campaign) && !detailsDirty)} loading={savingDetails} onClick={() => void saveDetails()} variant="primary">
      {campaign ? "Save details" : "Create draft"}
    </Button>
  ) : editorTab === "targets" ? (
    <Button disabled={!campaign || !editable || !targetsDirty || targetsLoading} loading={targetsSaving} onClick={() => void saveTargets()} variant="primary">Replace targets</Button>
  ) : (
    <><Button disabled={!campaign || detailsDirty || targetsDirty || revisionRefreshRequired} loading={preflightLoading} onClick={() => void runPreflight("DRY_RUN")}>DRY_RUN</Button><Button disabled={!campaign || detailsDirty || targetsDirty || revisionRefreshRequired} loading={preflightLoading} onClick={() => void runPreflight("LIVE")} variant="primary">LIVE</Button></>
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
                : !visiblePage?.data.length ? <tr><td className="data-table-empty" colSpan={5}>{hasListCriteria ? "No campaigns match this search or filters." : "No campaigns yet. Create a DRAFT to get started."}</td></tr>
                : visiblePage.data.map((item) => <tr key={item.id}>
                  <td className="data-cell-primary"><div className="stack stack-xs"><strong className="data-primary-text">{item.name}</strong><span className="data-secondary-text">Revision {item.revision}</span></div></td>
                  <td><Badge tone={statusTone(item.status)}>{item.status}</Badge></td>
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
        contentKey={`${campaign?.id ?? "new"}:${editorEpochRef.current}`}
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
            {campaign && campaign.status !== "DRAFT" && <InlineAlert title="Read-only campaign" tone="warning">Runtime status is {campaign.status}; only DRAFT campaigns are editable.</InlineAlert>}
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
              {campaign && <dl aria-label="Campaign metadata" className="campaign-workspace-meta">
                <div><dt>Status</dt><dd><Badge tone={statusTone(campaign.status)}>{campaign.status}</Badge></dd></div>
                <div><dt>Schedule</dt><dd>{form.scheduleType === "IMMEDIATE" ? "Immediate" : formatDraftSchedule(form.scheduledAt)}</dd></div>
                <div><dt>Targets</dt><dd>{draftTargetIds.length}</dd></div>
                <div><dt>Revision</dt><dd>r{campaign.revision} · t{campaign.targetsRevision}</dd></div>
              </dl>}
            </div>
            <div className="campaign-workspace-content">
            {editorTab === "details" && <section aria-labelledby="campaign-editor-details-tab" className="campaign-tab-panel stack stack-lg" id="campaign-editor-details-panel" role="tabpanel">
              <div className="campaign-section-heading"><div><span>Step 1 · Required</span><h3>Content &amp; schedule</h3><p>Define the message draft and when Runtime should schedule it.</p></div></div>
              {detailsError && <InlineAlert title="Could not save details">{detailsError}</InlineAlert>}
              <section aria-labelledby="campaign-content-title" className="campaign-form-section stack stack-md"><h4 id="campaign-content-title">Message draft</h4><TextField description={fieldDescription(formErrors.name)} disabled={!editable} label="Campaign name" onChange={(event) => updateForm("name", event.target.value)} value={form.name} /><TextAreaField description={fieldDescription(formErrors.text, "Plain text sent only by a later run milestone.")} disabled={!editable} label="Message text" onChange={(event) => updateForm("text", event.target.value)} rows={5} value={form.text} /></section>
              <section aria-labelledby="campaign-timing-title" className="campaign-form-section stack stack-md"><div className="campaign-form-section-heading"><h4 id="campaign-timing-title">Delivery timing</h4><span>Canonicalized by Runtime</span></div><SelectMenu description="Immediate uses canonical scheduledAt = null." disabled={!editable} label="Schedule" onChange={(scheduleType) => updateForm("scheduleType", scheduleType)} options={SCHEDULE_OPTIONS} value={form.scheduleType} />{form.scheduleType === "ONCE" && <TextField description={fieldDescription(formErrors.scheduledAt, "Stored by Runtime in UTC.")} disabled={!editable} label="Scheduled date and time" min={new Date().toISOString().slice(0, 16)} onChange={(event) => updateForm("scheduledAt", event.target.value)} type="datetime-local" value={form.scheduledAt} />}</section>
            </section>}

            {editorTab === "targets" && <section aria-labelledby="campaign-editor-targets-tab" className="campaign-tab-panel stack stack-md" id="campaign-editor-targets-panel" role="tabpanel">
              <div className="campaign-section-heading"><div><span>Step 2 · Persisted set</span><h3>Audience selection</h3><p>Choose the complete group target set · maximum 1,000.</p></div></div>
              {!campaign && <InlineAlert title="Create the draft first" tone="info">Targets belong to a persisted campaign.</InlineAlert>}
              {campaign && <>
                {targetsError && <InlineAlert title="Target update">{targetsError}</InlineAlert>}
                <dl className="campaign-target-metrics"><div><dt>Selected</dt><dd>{draftTargetIds.length}</dd></div><div><dt>Persisted</dt><dd>{targets.length}</dd></div><div><dt>Remaining capacity</dt><dd>{1000 - draftTargetIds.length}</dd></div></dl>
                <div className="campaign-workspace-section campaign-target-section"><h3>Available groups</h3><p className="campaign-target-section-copy">Capability is evaluated at preflight.</p><div className="campaign-search-row"><SearchField label="Find synchronized groups" loading={groupsLoading} onChange={setGroupQuery} placeholder="Search group name or ID" value={groupQuery} /><Button disabled={groupsLoading} onClick={() => void loadGroups(groupQuery.trim())} size="sm">Search</Button></div><div aria-busy={groupsLoading || undefined} className="campaign-choice-list">
                  {groupsLoading ? <p>Loading groups…</p> : !groups.length ? <p>No synchronized groups found.</p> : groups.map((group) => <label className="campaign-choice" key={group.id}><input checked={draftTargetIds.includes(group.id)} disabled={!editable} onChange={() => toggleTarget(group.id)} type="checkbox" /><span><strong>{group.name}</strong><small>{group.id}</small></span><span className="campaign-choice-meta"><GroupCapabilityStatus appearance="badge" capability={group.sendCapability} includeFreshness={false} />{!group.isActive && <Badge tone="neutral">Inactive</Badge>}</span></label>)}
                </div></div>
                <div className="campaign-workspace-section campaign-target-section"><h3>Persisted canonical targets</h3><p className="campaign-target-section-copy">Authoritative Runtime response.</p><div aria-busy={targetsLoading || undefined} className="campaign-choice-list">
                  {targetsLoading ? <p>Loading targets…</p> : !targets.length ? <p>No persisted targets. Saving an empty set clears all targets.</p> : targets.map((target) => <div className="campaign-choice" key={target.groupId}><span><strong>{target.groupName}</strong><small>{target.groupId}</small></span><span className="campaign-choice-meta"><GroupCapabilityStatus appearance="badge" capability={target.sendCapability} includeFreshness={false} />{!target.enabled && <Badge tone="neutral">Inactive</Badge>}</span>{editable && draftTargetIds.includes(target.groupId) && <Button aria-label={`Remove ${target.groupName}`} onClick={() => toggleTarget(target.groupId)} size="sm" variant="ghost">Remove</Button>}</div>)}
                </div></div>
              </>}
            </section>}

            {editorTab === "preflight" && <section aria-labelledby="campaign-editor-preflight-tab" className="campaign-tab-panel stack stack-md" id="campaign-editor-preflight-panel" role="tabpanel">
              <div className="campaign-section-heading"><div><span>Step 3 · Runtime policy</span><h3>Readiness review</h3><p>Evaluate persisted state without creating a run or sending a message.</p></div></div>
              {!campaign && <InlineAlert title="Create the draft first" tone="info">Preflight requires a persisted campaign.</InlineAlert>}
              {campaign && <>
                {(detailsDirty || targetsDirty) && <InlineAlert title="Save before preflight" tone="warning">Preflight reads persisted Runtime state, not unsaved edits.</InlineAlert>}
                {revisionRefreshRequired && <InlineAlert title="Revision refresh required" tone="warning">Reopen this campaign before running preflight.</InlineAlert>}
                {preflightError && <InlineAlert title="Preflight failed">{preflightError}</InlineAlert>}
                {preflight && <PreflightReport report={preflight} stale={reportStale} />}
                {!preflight && !preflightError && <div className="campaign-empty-state"><span className="campaign-empty-state-icon"><AppIcon name="check" size="lg" /></span><strong>No preflight report</strong><p>Run DRY_RUN or LIVE to evaluate the persisted campaign and target set. This does not send messages.</p></div>}
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
