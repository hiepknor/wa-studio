import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { useRuntimeConnection } from "@/app/RuntimeConnectionContext";
import type {
  RuntimeGroup,
  RuntimeGroupDetail,
  RuntimeGroupMemberPage,
  RuntimeGroupPage,
  RuntimeSyncRun,
} from "@/shared/api/runtime-client";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";
import { DropdownMenu, DropdownMenuItem } from "@/shared/ui/DropdownMenu";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { PageHeader } from "@/shared/ui/PageHeader";
import { SearchField } from "@/shared/ui/SearchField";
import { Tabs } from "@/shared/ui/Tabs";
import { TablePagination } from "@/shared/ui/TablePagination";
import { useToast } from "@/shared/ui/Toast";
import { UpdateActionTrigger } from "@/shared/ui/UpdateActionTrigger";
import {
  WorkspaceDrawer,
  WorkspaceDisclosurePanel,
  WorkspaceEmptyState,
  WorkspacePanel,
  WorkspaceSectionHeader,
  WorkspaceSummaryCard,
} from "@/shared/ui/WorkspaceDrawer";
import { useSessionSync } from "@/shared/hooks/useSessionSync";
import { pollCapabilityRefresh } from "./capability-refresh";
import {
  groupListRequestKey,
  initialGroupListState,
  type GroupListRequestState,
  type GroupListState,
} from "./group-list-filters";
import {
  GroupCapabilityStatus,
  groupCapabilityIsStale,
} from "./GroupCapabilityStatus";
import { GroupSearchToolbar } from "./GroupSearchToolbar";
import { reconcileMemberDatasetRevision } from "./member-dataset";
import {
  memberDisplayName,
  memberIdentityPresentation,
} from "./member-presentation";
import "./groups.css";

const PAGE_SIZE = 20;
const MEMBER_PAGE_SIZE = 25;

function memberPageKey(
  sessionId: string,
  groupId: string,
  offset: number,
  query: string,
): string {
  return `${sessionId}\u0000${groupId}\u0000${offset}\u0000${query}`;
}

type CapabilityRefreshState =
  "idle" | "requesting" | "pending" | "completed" | "timed-out" | "failed";

type GroupListLoadReason = "automatic" | "reload" | "post-sync";
type GroupInspectorTab = "overview" | "members";
const CAPABILITY_REASON_COPY: Record<string, string> = {
  SEND_ALLOWED: "WA Runtime confirmed that this group can receive messages.",
  SEND_DENIED: "WA Runtime determined that this group cannot receive messages.",
  SEND_UNKNOWN:
    "WA Runtime could not confirm whether this group can receive messages.",
  group_is_read_only: "The group currently does not accept new messages.",
  session_is_admin: "The active session is a group administrator.",
  session_is_member: "The active session is a group member.",
  session_not_in_group: "The active session is not a member of this group.",
};

function capabilityReasonCopy(reason: string): string {
  return (
    CAPABILITY_REASON_COPY[reason] ??
    "WA Runtime returned a capability policy result."
  );
}

function accessLabel(isAdmin: boolean | null): string {
  if (isAdmin === null) return "Unknown";
  return isAdmin ? "Administrator" : "Member";
}

function booleanLabel(
  value: boolean | null,
  positive: string,
  negative: string,
): string {
  if (value === null) return "Unknown";
  return value ? positive : negative;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatCompactDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  const datePart = new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    month: "short",
  }).format(date);
  const timePart = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
  return `${datePart} · ${timePart}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function syncProgressCopy(run: RuntimeSyncRun): string {
  const start = new Date(run.startedAt ?? run.requestedAt).getTime();
  const end = run.completedAt
    ? new Date(run.completedAt).getTime()
    : Date.now();
  const elapsedSeconds = Math.max(0, Math.floor((end - start) / 1_000));
  return `${run.groupsSynced} groups · ${run.membersSynced} members · ${elapsedSeconds}s elapsed`;
}

interface GroupsScreenProps {
  navigation?: ReactNode;
}

export function GroupsScreen({ navigation }: GroupsScreenProps = {}) {
  const { connected, refreshSessions, selectedSessionId } =
    useRuntimeConnection();
  const toast = useToast();
  if (!connected) throw new Error("GroupsScreen requires a Runtime connection");

  const runtimeApi = connected.api;
  const runtimeOrigin = connected.profile.baseUrl;
  const selectedSession =
    connected.sessions.find(({ id }) => id === selectedSessionId) ?? null;
  const [page, setPage] = useState<RuntimeGroupPage | null>(null);
  const [listState, setListState] = useState<GroupListState>(() =>
    initialGroupListState(selectedSessionId),
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [listLoadReason, setListLoadReason] =
    useState<GroupListLoadReason | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [syncConfirmationOpen, setSyncConfirmationOpen] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<RuntimeGroup | null>(null);
  const [detail, setDetail] = useState<RuntimeGroupDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [capabilityRefreshState, setCapabilityRefreshState] =
    useState<CapabilityRefreshState>("idle");
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [capabilityNotice, setCapabilityNotice] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const [inspectorTab, setInspectorTab] =
    useState<GroupInspectorTab>("overview");
  const [memberPage, setMemberPage] = useState<RuntimeGroupMemberPage | null>(
    null,
  );
  const [memberFilter, setMemberFilter] = useState("");
  const [memberQuery, setMemberQuery] = useState("");
  const [memberOffset, setMemberOffset] = useState(0);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [syncedMemberTotal, setSyncedMemberTotal] = useState<number | null>(
    null,
  );
  const listRevision = useRef(0);
  const listTargetRef = useRef("");
  const listStateRef = useRef(listState);
  const detailRevision = useRef(0);
  const membersRevision = useRef(0);
  const memberDatasetRevisionRef = useRef<number | null>(null);
  const memberPageKeyRef = useRef("");
  const memberRequestKeyRef = useRef("");
  const memberTargetKeyRef = useRef("");
  const capabilityRevision = useRef(0);
  const capabilityAbortRef = useRef<AbortController | null>(null);
  const capabilityTargetRef = useRef<{
    sessionId: string;
    groupId: string;
  } | null>(null);
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null);
  capabilityTargetRef.current =
    selectedSessionId &&
    selectedGroup &&
    selectedGroup.sessionId === selectedSessionId
      ? { sessionId: selectedSessionId, groupId: selectedGroup.id }
      : null;
  listTargetRef.current = groupListRequestKey(listState);
  listStateRef.current = listState;
  memberTargetKeyRef.current =
    inspectorTab === "members" &&
    selectedSessionId &&
    selectedGroup?.sessionId === selectedSessionId
      ? memberPageKey(
          selectedSessionId,
          selectedGroup.id,
          memberOffset,
          memberQuery,
        )
      : "";
  const refreshingCapability =
    capabilityRefreshState === "requesting" ||
    capabilityRefreshState === "pending";
  const loading = listLoadReason !== null;

  const cancelCapabilityRefresh = useCallback(() => {
    capabilityRevision.current += 1;
    capabilityAbortRef.current?.abort();
    capabilityAbortRef.current = null;
  }, []);

  const capabilityFlowIsCurrent = useCallback(
    (revision: number, sessionId: string, groupId: string) => {
      const target = capabilityTargetRef.current;
      return (
        revision === capabilityRevision.current &&
        target?.sessionId === sessionId &&
        target.groupId === groupId
      );
    },
    [],
  );

  const loadGroups = useCallback(
    async (
      state: GroupListRequestState,
      reason: GroupListLoadReason = "automatic",
    ): Promise<boolean> => {
      if (!state.sessionId || state.sessionId !== selectedSessionId)
        return false;
      const revision = ++listRevision.current;
      const requestKey = groupListRequestKey(state);
      setListLoadReason(reason);
      setListError(null);
      try {
        const nextPage = await runtimeApi.listGroups({
          sessionId: state.sessionId,
          limit: PAGE_SIZE,
          offset: state.offset,
          ...(state.query ? { query: state.query } : {}),
          ...(state.capabilityStatuses.length
            ? { capabilityStatus: state.capabilityStatuses }
            : {}),
          ...(state.capabilityFreshness.length
            ? { capabilityFreshness: state.capabilityFreshness }
            : {}),
          ...(state.isActive === undefined ? {} : { isActive: state.isActive }),
        });
        if (
          revision !== listRevision.current ||
          requestKey !== listTargetRef.current
        )
          return false;

        if (
          state.offset > 0 &&
          nextPage.data.length === 0 &&
          nextPage.meta.total <= state.offset
        ) {
          const lastOffset =
            nextPage.meta.total === 0
              ? 0
              : Math.floor((nextPage.meta.total - 1) / PAGE_SIZE) * PAGE_SIZE;
          setListState((current) => ({ ...current, offset: lastOffset }));
          if (nextPage.meta.total === 0) setPage(nextPage);
          return true;
        }

        setPage(nextPage);
        return true;
      } catch (error) {
        if (
          revision === listRevision.current &&
          requestKey === listTargetRef.current
        ) {
          setListError(errorMessage(error, "Could not load groups."));
        }
        return false;
      } finally {
        if (
          revision === listRevision.current &&
          requestKey === listTargetRef.current
        ) {
          setListLoadReason(null);
        }
      }
    },
    [runtimeApi, selectedSessionId],
  );

  const sync = useSessionSync({
    runtimeApi,
    runtimeOrigin,
    sessionId: selectedSessionId,
    onCompleted: async () => {
      const warnings: string[] = [];
      try {
        await refreshSessions();
      } catch (error) {
        warnings.push(errorMessage(error, "Reload session metadata manually."));
      }
      const viewReloaded = await loadGroups(listStateRef.current, "post-sync");
      if (!viewReloaded)
        warnings.push("The current groups view could not be updated.");
      return warnings.length
        ? `Sync finished. ${warnings.join(" ")}`
        : undefined;
    },
  });
  const syncState = sync.state;
  const syncRun = sync.run;
  const syncError = sync.error;
  const syncForeground = sync.active;
  const syncActive = sync.active;

  const loadMembers = useCallback(
    async (
      sessionId: string,
      groupId: string,
      nextOffset: number,
      query: string,
    ) => {
      const revision = ++membersRevision.current;
      let requestOffset = nextOffset;
      let requestKey = memberPageKey(
        sessionId,
        groupId,
        requestOffset,
        query,
      );
      let restartAvailable = true;
      memberRequestKeyRef.current = requestKey;
      setMembersLoading(true);
      setMembersError(null);
      try {
        while (true) {
          const nextPage = await runtimeApi.listGroupMembers({
            sessionId,
            groupId,
            limit: MEMBER_PAGE_SIZE,
            offset: requestOffset,
            ...(query ? { query } : {}),
          });
          if (
            revision !== membersRevision.current ||
            requestKey !== memberTargetKeyRef.current
          )
            return;

          const datasetDecision = reconcileMemberDatasetRevision(
            memberDatasetRevisionRef.current,
            nextPage.meta.datasetRevision,
            restartAvailable,
          );
          memberDatasetRevisionRef.current = datasetDecision.revision;

          if (datasetDecision.action === "restart") {
            restartAvailable = false;
            requestOffset = 0;
            requestKey = memberPageKey(sessionId, groupId, 0, query);
            memberTargetKeyRef.current = requestKey;
            memberRequestKeyRef.current = requestKey;
            memberPageKeyRef.current = "";
            setMemberPage(null);
            setMemberOffset(0);
            setSyncedMemberTotal(null);
            continue;
          }

          if (
            requestOffset > 0 &&
            nextPage.data.length === 0 &&
            nextPage.meta.total <= requestOffset
          ) {
            const lastOffset =
              nextPage.meta.total === 0
                ? 0
                : Math.floor((nextPage.meta.total - 1) / MEMBER_PAGE_SIZE) *
                  MEMBER_PAGE_SIZE;
            memberTargetKeyRef.current = memberPageKey(
              sessionId,
              groupId,
              lastOffset,
              query,
            );
            setMemberOffset(lastOffset);
            if (nextPage.meta.total === 0) {
              setMemberPage(nextPage);
              memberPageKeyRef.current = memberTargetKeyRef.current;
            } else {
              setMemberPage(null);
              memberPageKeyRef.current = "";
            }
            return;
          }

          setMemberPage(nextPage);
          memberPageKeyRef.current = requestKey;
          if (!query) setSyncedMemberTotal(nextPage.meta.total);
          return;
        }
      } catch (error) {
        if (
          revision === membersRevision.current &&
          requestKey === memberTargetKeyRef.current
        ) {
          setMembersError(errorMessage(error, "Could not load group members."));
        }
      } finally {
        if (memberRequestKeyRef.current === requestKey)
          memberRequestKeyRef.current = "";
        if (revision === membersRevision.current) setMembersLoading(false);
      }
    },
    [runtimeApi],
  );

  useEffect(() => {
    if (listState.sessionId === selectedSessionId) return;
    listRevision.current += 1;
    detailRevision.current += 1;
    membersRevision.current += 1;
    cancelCapabilityRefresh();
    setPage(null);
    setListState(initialGroupListState(selectedSessionId));
    setFiltersOpen(false);
    setListLoadReason(null);
    setSelectedGroup(null);
    setDetail(null);
    setDetailLoading(false);
    setDetailError(null);
    setCapabilityRefreshState("idle");
    setCapabilityError(null);
    setCapabilityNotice(null);
    setCopyState("idle");
    setInspectorTab("overview");
    setMemberPage(null);
    memberDatasetRevisionRef.current = null;
    memberPageKeyRef.current = "";
    memberRequestKeyRef.current = "";
    setMemberFilter("");
    setMemberQuery("");
    setMemberOffset(0);
    setMembersLoading(false);
    setMembersError(null);
    setSyncedMemberTotal(null);
    setSyncConfirmationOpen(false);
  }, [cancelCapabilityRefresh, listState.sessionId, selectedSessionId]);

  useEffect(() => {
    const {
      sessionId,
      query,
      capabilityStatuses,
      capabilityFreshness,
      isActive,
      offset,
    } = listState;
    if (sessionId !== selectedSessionId) return;
    void loadGroups({
      sessionId,
      query,
      capabilityStatuses,
      capabilityFreshness,
      isActive,
      offset,
    });
  }, [
    listState.sessionId,
    listState.query,
    listState.capabilityStatuses,
    listState.capabilityFreshness,
    listState.isActive,
    listState.offset,
    loadGroups,
    selectedSessionId,
  ]);

  useEffect(() => () => cancelCapabilityRefresh(), [cancelCapabilityRefresh]);
  useEffect(
    () => () => {
      listRevision.current += 1;
      listTargetRef.current = "";
      membersRevision.current += 1;
      memberTargetKeyRef.current = "";
    },
    [],
  );
  useEffect(() => setSyncConfirmationOpen(false), [runtimeApi, runtimeOrigin]);

  useEffect(() => {
    const normalizedQuery = listState.inputQuery.trim();
    const timeout = window.setTimeout(() => {
      setListState((current) => {
        if (
          current.sessionId !== listState.sessionId ||
          current.inputQuery !== listState.inputQuery ||
          current.query === normalizedQuery
        )
          return current;
        return { ...current, query: normalizedQuery, offset: 0 };
      });
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [listState.inputQuery, listState.sessionId]);

  useEffect(() => {
    const normalizedQuery = memberFilter.trim();
    const timeout = window.setTimeout(() => {
      if (normalizedQuery === memberQuery) return;
      membersRevision.current += 1;
      memberRequestKeyRef.current = "";
      setMemberOffset(0);
      setMemberQuery(normalizedQuery);
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [memberFilter, memberQuery]);

  useEffect(() => {
    if (
      inspectorTab !== "members" ||
      !selectedSessionId ||
      !selectedGroup ||
      selectedGroup.sessionId !== selectedSessionId
    )
      return;
    const pageKey = memberPageKey(
      selectedSessionId,
      selectedGroup.id,
      memberOffset,
      memberQuery,
    );
    if (memberPage && memberPageKeyRef.current === pageKey) return;
    if (memberRequestKeyRef.current === pageKey) return;
    void loadMembers(
      selectedSessionId,
      selectedGroup.id,
      memberOffset,
      memberQuery,
    );
  }, [
    inspectorTab,
    loadMembers,
    memberOffset,
    memberPage,
    memberQuery,
    selectedGroup,
    selectedSessionId,
  ]);

  async function openGroup(group: RuntimeGroup, trigger: HTMLButtonElement) {
    if (!selectedSessionId) return;
    const revision = ++detailRevision.current;
    cancelCapabilityRefresh();
    membersRevision.current += 1;
    detailTriggerRef.current = trigger;
    setSelectedGroup(group);
    setDetail(null);
    setDetailLoading(true);
    setDetailError(null);
    setCapabilityRefreshState("idle");
    setCapabilityError(null);
    setCapabilityNotice(null);
    setCopyState("idle");
    setInspectorTab("overview");
    setMemberPage(null);
    memberDatasetRevisionRef.current = null;
    memberPageKeyRef.current = "";
    memberRequestKeyRef.current = "";
    setMemberFilter("");
    setMemberQuery("");
    setMemberOffset(0);
    setMembersLoading(false);
    setMembersError(null);
    setSyncedMemberTotal(null);
    try {
      const nextDetail = await runtimeApi.getGroup(selectedSessionId, group.id);
      if (revision === detailRevision.current) setDetail(nextDetail);
    } catch (error) {
      if (revision === detailRevision.current) {
        setDetailError(errorMessage(error, "Could not load group details."));
      }
    } finally {
      if (revision === detailRevision.current) setDetailLoading(false);
    }
  }

  function closeDetail() {
    detailRevision.current += 1;
    membersRevision.current += 1;
    cancelCapabilityRefresh();
    setSelectedGroup(null);
    setDetail(null);
    setDetailLoading(false);
    setDetailError(null);
    setCapabilityRefreshState("idle");
    setCapabilityError(null);
    setCapabilityNotice(null);
    setCopyState("idle");
    setInspectorTab("overview");
    setMemberPage(null);
    memberDatasetRevisionRef.current = null;
    memberPageKeyRef.current = "";
    memberRequestKeyRef.current = "";
    setMemberFilter("");
    setMemberQuery("");
    setMemberOffset(0);
    setMembersLoading(false);
    setMembersError(null);
    setSyncedMemberTotal(null);
  }

  async function refreshCapability() {
    if (
      !selectedSessionId ||
      !selectedGroup ||
      selectedGroup.sessionId !== selectedSessionId ||
      !detail ||
      refreshingCapability
    )
      return;
    cancelCapabilityRefresh();
    const revision = capabilityRevision.current;
    const controller = new AbortController();
    capabilityAbortRef.current = controller;
    const sessionId = selectedSessionId;
    const groupId = selectedGroup.id;
    const baseline = detail.sendCapability;
    setCapabilityRefreshState("requesting");
    setCapabilityError(null);
    setCapabilityNotice(null);
    try {
      await runtimeApi.requestGroupCapabilityRefresh(sessionId, groupId);
      if (!capabilityFlowIsCurrent(revision, sessionId, groupId)) return;
      setCapabilityRefreshState("pending");
      setCapabilityNotice("Waiting for WA Runtime to publish a new result…");

      const result = await pollCapabilityRefresh({
        baseline,
        signal: controller.signal,
        read: () => runtimeApi.getGroup(sessionId, groupId),
        onObservation: (nextDetail) => {
          if (capabilityFlowIsCurrent(revision, sessionId, groupId))
            setDetail(nextDetail);
        },
      });
      if (
        !capabilityFlowIsCurrent(revision, sessionId, groupId) ||
        result.status === "cancelled"
      )
        return;
      if (result.status === "completed") {
        setCapabilityRefreshState("completed");
        setCapabilityNotice("The latest capability result is now shown.");
      } else if (result.status === "failed") {
        setCapabilityRefreshState("failed");
        setCapabilityNotice(null);
        setCapabilityError("WA Runtime could not refresh this capability.");
      } else {
        setCapabilityRefreshState("timed-out");
        setCapabilityNotice("Reopen or retry shortly.");
        if (result.error) {
          setCapabilityError(
            errorMessage(
              result.error,
              "Could not read the latest capability result.",
            ),
          );
        }
      }
    } catch (error) {
      if (capabilityFlowIsCurrent(revision, sessionId, groupId)) {
        setCapabilityRefreshState("failed");
        setCapabilityError(
          errorMessage(error, "Could not refresh send capability."),
        );
      }
    } finally {
      if (capabilityFlowIsCurrent(revision, sessionId, groupId)) {
        capabilityAbortRef.current = null;
      }
    }
  }

  async function reloadGroups() {
    const reloaded = await loadGroups(listState, "reload");
    if (reloaded && listTargetRef.current === groupListRequestKey(listState)) {
      toast.notify({
        id: "groups-reload",
        title: "Groups reloaded",
        tone: "success",
      });
    }
  }

  async function startSessionSync() {
    if (!selectedSessionId || sync.active) return;
    setSyncConfirmationOpen(false);
    const result = await sync.start();
    if (result?.status !== "completed") return;
    toast.notify({
      description: result.warning ?? syncProgressCopy(result.run),
      id: "groups-sync",
      title: result.warning
        ? "Sync completed with an update warning"
        : "Sync completed",
      tone: result.warning ? "warning" : "success",
    });
  }

  const listContextIsCurrent = listState.sessionId === selectedSessionId;
  const visiblePage = listContextIsCurrent ? page : null;
  const offset = listState.offset;
  const hasListCriteria = Boolean(
    listState.query ||
    listState.capabilityStatuses.length ||
    listState.capabilityFreshness.length ||
    listState.isActive !== undefined,
  );
  const total = visiblePage?.meta.total ?? 0;
  const pageLimit = visiblePage?.meta.limit ?? PAGE_SIZE;
  const pageOffset = visiblePage?.meta.offset ?? offset;
  const firstItem = total === 0 ? 0 : offset + 1;
  const lastItem = Math.min(offset + (visiblePage?.data.length ?? 0), total);
  const memberTotal = memberPage?.meta.total ?? 0;
  const memberPageOffset = memberPage?.meta.offset ?? memberOffset;
  const memberFirstItem = memberTotal === 0 ? 0 : memberPageOffset + 1;
  const memberLastItem = Math.min(
    memberPageOffset + (memberPage?.data.length ?? 0),
    memberTotal,
  );
  const canGoToPreviousMembers = memberOffset > 0 && !membersLoading;
  const canGoToNextMembers =
    memberOffset + MEMBER_PAGE_SIZE < memberTotal && !membersLoading;
  const detailCapabilityIsStale = detail
    ? groupCapabilityIsStale(detail.sendCapability)
    : false;
  const groupsDescription =
    syncState === "requesting"
      ? "Requesting a full groups and members sync from WA Runtime…"
      : syncRun && syncState === "running"
        ? `${syncRun.status === "PENDING" ? "Sync pending" : "Sync running"} · ${syncProgressCopy(syncRun)}`
        : syncState === "updating"
          ? "Sync finished · Updating session metadata and the current groups page…"
          : `Groups synchronized for ${selectedSession?.name ?? "the active session"}.`;

  async function copyGroupId(groupId: string) {
    try {
      await navigator.clipboard.writeText(groupId);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <div aria-labelledby={navigation ? "groups-workspace-all-tab" : undefined} className="groups-screen stack stack-lg" id={navigation ? "groups-workspace-all-panel" : undefined} role={navigation ? "tabpanel" : undefined}>
      <PageHeader
        actions={
          <DropdownMenu
            ariaLabel="Group data actions"
            disabled={!selectedSessionId}
            contentClassName="update-action-menu"
            trigger={(triggerProps) => (
              <UpdateActionTrigger
                ariaLabel={
                  syncState === "updating"
                    ? "Updating groups view"
                    : syncForeground
                      ? "Syncing groups"
                      : listLoadReason === "reload"
                        ? "Reloading groups"
                        : "Update groups"
                }
                busy={syncForeground || listLoadReason === "reload"}
                label={
                  syncState === "updating"
                    ? "Updating view…"
                    : syncForeground
                      ? "Syncing…"
                      : listLoadReason === "reload"
                        ? "Reloading…"
                        : "Update"
                }
                triggerProps={triggerProps}
              />
            )}
          >
            <DropdownMenuItem
              disabled={loading}
              icon="refresh"
              onSelect={() => void reloadGroups()}
              description="Reload groups currently stored in WA Runtime."
            >
              Reload
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={syncActive}
              icon="sync"
              onSelect={() => setSyncConfirmationOpen(true)}
              description="Synchronize groups and members from OpenWA."
            >
              Sync
            </DropdownMenuItem>
          </DropdownMenu>
        }
        description={groupsDescription}
        title="Groups"
        titleId="groups-title"
      />

      {navigation}

      <ConfirmationDialog
        body={`Synchronize all groups and members for ${selectedSession?.name ?? "the active session"} from OpenWA? Large sessions may take several minutes.`}
        confirmLabel="Sync"
        onCancel={() => setSyncConfirmationOpen(false)}
        onConfirm={() => void startSessionSync()}
        open={syncConfirmationOpen}
        title="Sync groups and members?"
      />

      {syncRun && syncState === "background" && (
        <InlineAlert
          action={
            <Button onClick={() => void reloadGroups()} size="sm">
              Reload groups
            </Button>
          }
          indicator
          title="Sync continues in the background"
          tone="warning"
        >
          {syncProgressCopy(syncRun)}. Reload later to see synchronized data.
        </InlineAlert>
      )}

      {syncState === "failed" && (
        <InlineAlert
          action={
            <Button onClick={() => setSyncConfirmationOpen(true)} size="sm">
              Retry
            </Button>
          }
          indicator
          title="Sync failed"
        >
          {syncError ?? "Retry when WA Runtime is ready."}
        </InlineAlert>
      )}

      {!selectedSessionId && (
        <InlineAlert title="No active session" tone="warning">
          Select a Gateway session before loading groups.
        </InlineAlert>
      )}

      <>
        <div className="data-table-container groups-list-panel">
          <GroupSearchToolbar
            filtersOpen={filtersOpen}
            firstItem={firstItem}
            lastItem={lastItem}
            loading={loading}
            setFiltersOpen={setFiltersOpen}
            setState={setListState}
            state={listState}
            total={total}
          />

          {listError && (
            <InlineAlert
              action={
                <Button onClick={() => void loadGroups(listState)} size="sm">
                  Retry
                </Button>
              }
              className="data-table-error"
              title="Could not load groups"
            >
              {listError}
            </InlineAlert>
          )}

          <div
            aria-busy={loading}
            className="data-table-scroll groups-table-scroll"
            data-updating={(loading && Boolean(visiblePage)) || undefined}
          >
            <table>
              <caption>Groups in the active Gateway session</caption>
              <colgroup>
                <col className="groups-column-identity" />
                <col className="groups-column-participants" />
                <col className="groups-column-capability" />
                <col className="groups-column-synced" />
                <col className="groups-column-action" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Group</th>
                  <th className="data-column-number" scope="col">
                    Participants
                  </th>
                  <th scope="col">Send capability</th>
                  <th scope="col">Record synced</th>
                  <th aria-label="Actions" scope="col" />
                </tr>
              </thead>
              <tbody>
                {!visiblePage && loading ? (
                  <tr>
                    <td className="data-table-empty" colSpan={5}>
                      Loading groups…
                    </td>
                  </tr>
                ) : !visiblePage && listError ? (
                  <tr>
                    <td className="data-table-empty" colSpan={5}>
                      Groups are unavailable.
                    </td>
                  </tr>
                ) : (visiblePage?.data.length ?? 0) === 0 ? (
                  <tr>
                    <td className="data-table-empty" colSpan={5}>
                      {hasListCriteria
                        ? "No groups match this search or filters."
                        : "No groups were returned for this session."}
                    </td>
                  </tr>
                ) : (
                  visiblePage?.data.map((group) => (
                    <tr
                      data-selected={
                        group.id === selectedGroup?.id || undefined
                      }
                      key={group.id}
                    >
                      <td className="data-cell-primary">
                        <div className="stack stack-xs groups-name-cell">
                          <strong
                            className="data-primary-text"
                            title={group.name}
                          >
                            {group.name}
                          </strong>
                          <span className="data-identifier" title={group.id}>
                            {group.id}
                          </span>
                        </div>
                      </td>
                      <td className="data-cell-number">
                        {group.participantsCount ?? "—"}
                      </td>
                      <td className="data-cell-status">
                        <GroupCapabilityStatus
                          capability={group.sendCapability}
                        />
                      </td>
                      <td
                        className="data-cell-time"
                        title={formatDate(group.syncedAt)}
                      >
                        {formatDate(group.syncedAt)}
                      </td>
                      <td className="data-cell-action">
                        <Button
                          aria-label={`View ${group.name}`}
                          onClick={(event) =>
                            void openGroup(group, event.currentTarget)
                          }
                          size="sm"
                          variant="ghost"
                        >
                          View
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <TablePagination
            limit={pageLimit}
            loading={loading}
            offset={pageOffset}
            onOffsetChange={(nextOffset) => setListState((current) => ({ ...current, offset: nextOffset }))}
            total={total}
          />
        </div>

        <WorkspaceDrawer
          description={
            detail
              ? `${detail.isActive ? "Active" : "Inactive"} · ${detail.participantsCount ?? syncedMemberTotal ?? "Unknown"} participants`
              : undefined
          }
          eyebrow="Group inspector"
          navigation={detail && (
            <Tabs
              activeTab={inspectorTab}
              ariaLabel="Group inspector sections"
              idPrefix="group-inspector"
              onChange={setInspectorTab}
              tabs={[
                { id: "overview", label: "Overview" },
                {
                  badge:
                    syncedMemberTotal ??
                    detail.participantsCount ??
                    undefined,
                  id: "members",
                  label: "Members",
                  warning:
                    syncedMemberTotal !== null &&
                    detail.participantsCount !== null &&
                    syncedMemberTotal !== detail.participantsCount,
                },
              ]}
            />
          )}
          onClose={closeDetail}
          open={Boolean(
            selectedGroup && selectedGroup.sessionId === selectedSessionId,
          )}
          returnFocusRef={detailTriggerRef}
          title={detail?.name ?? selectedGroup?.name ?? "Group inspector"}
        >
          {detailLoading && (
            <WorkspaceEmptyState compact icon="refresh" loading title="Loading group details">
              Runtime is returning the latest synchronized group profile.
            </WorkspaceEmptyState>
          )}
          {detailError && (
            <InlineAlert title="Could not load group details">
              {detailError}
            </InlineAlert>
          )}
          {detail && (
            <div className="groups-inspector stack stack-lg">
              {inspectorTab === "overview" && (
                <div
                  aria-labelledby="group-inspector-overview-tab"
                  className="groups-tab-panel stack stack-lg"
                  id="group-inspector-overview-panel"
                  role="tabpanel"
                >
                  <WorkspaceSectionHeader
                    description="Review synchronized identity, messaging capability, and group configuration."
                    kicker="Overview"
                    title="Group profile"
                  />
                  <WorkspaceSummaryCard
                    description={detail.description || "No group description."}
                    label="Synchronized group"
                    metrics={[
                      { label: "Participants", value: detail.participantsCount ?? syncedMemberTotal ?? "—" },
                      { label: "Access", value: accessLabel(detail.isAdmin) },
                      {
                        label: "Synced",
                        title: formatDate(detail.syncedAt),
                        value: formatCompactDate(detail.syncedAt),
                      },
                    ]}
                    status={<Badge tone={detail.isActive ? "success" : "neutral"}>{detail.isActive ? "Active" : "Inactive"}</Badge>}
                    title={detail.name}
                    titleId="group-identity-title"
                  >
                    <footer className="workspace-summary-footer groups-identity-footer">
                      <span>Group ID · <code>{detail.id}</code></span>
                      <Button
                        aria-label={
                          copyState === "copied"
                            ? "Copied group ID"
                            : "Copy group ID"
                        }
                        icon={copyState === "copied" ? "check" : "copy"}
                        onClick={() => void copyGroupId(detail.id)}
                        size="sm"
                        variant="ghost"
                      >
                        {copyState === "copied" ? "Copied" : "Copy"}
                      </Button>
                    </footer>
                    {copyState === "failed" && (
                      <span className="groups-copy-error" role="alert">
                        Could not copy the group ID.
                      </span>
                    )}
                  </WorkspaceSummaryCard>

                  <WorkspacePanel
                    action={<GroupCapabilityStatus
                      appearance="badge"
                      capability={detail.sendCapability}
                      includeFreshness={false}
                    />}
                    className="groups-capability"
                    description={<span className="groups-capability-description"><span>{capabilityReasonCopy(detail.sendCapability.reason)}</span><code>{detail.sendCapability.reason}</code></span>}
                    title="Send readiness"
                    titleId="group-capability-title"
                    tone="accent"
                  >
                    <div className="groups-capability-body stack stack-md">
                      <dl className="groups-capability-meta">
                        <div>
                          <dt>Checked</dt>
                          <dd>{formatDate(detail.sendCapability.checkedAt)}</dd>
                        </div>
                        <div>
                          <dt>Freshness</dt>
                          <dd>
                            <Badge
                              tone={
                                detailCapabilityIsStale ? "warning" : "success"
                              }
                            >
                              {detailCapabilityIsStale ? "Stale" : "Current"}
                            </Badge>
                          </dd>
                        </div>
                      </dl>
                      <Button
                        icon="refresh"
                        loading={refreshingCapability}
                        onClick={() => void refreshCapability()}
                        size="sm"
                      >
                        {refreshingCapability
                          ? "Refreshing capability…"
                          : "Refresh capability"}
                      </Button>
                      {capabilityRefreshState === "failed" && capabilityError && (
                        <InlineAlert
                          className="groups-capability-feedback"
                          title="Capability refresh failed"
                        >
                          {capabilityError}
                        </InlineAlert>
                      )}
                      {capabilityNotice &&
                        capabilityRefreshState !== "failed" && (
                          <InlineAlert
                            className="groups-capability-feedback"
                            title={
                              capabilityRefreshState === "completed"
                                ? "Capability updated"
                                : capabilityRefreshState === "timed-out"
                                  ? "Refresh still processing"
                                  : "Refresh requested"
                            }
                            tone={
                              capabilityRefreshState === "completed"
                                ? "success"
                                : capabilityRefreshState === "timed-out"
                                  ? "warning"
                                  : "info"
                            }
                          >
                            {capabilityRefreshState === "timed-out" &&
                            capabilityError
                              ? `${capabilityNotice} Last check: ${capabilityError}`
                              : capabilityNotice}
                          </InlineAlert>
                        )}
                    </div>
                  </WorkspacePanel>

                  <WorkspacePanel
                    description="Runtime flags that govern access, posting, and settings changes."
                    flush
                    title="Group configuration"
                    titleId="group-configuration-title"
                  >
                    <dl className="groups-facts groups-facts-contained">
                      <div>
                        <dt>Session access</dt>
                        <dd>{accessLabel(detail.isAdmin)}</dd>
                      </div>
                      <div>
                        <dt>Posting</dt>
                        <dd>
                          {booleanLabel(
                            detail.isAnnounce,
                            "Admins only",
                            "All members",
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>Read only</dt>
                        <dd>{booleanLabel(detail.isReadOnly, "Yes", "No")}</dd>
                      </div>
                      <div>
                        <dt>Settings</dt>
                        <dd>
                          {booleanLabel(
                            detail.settingsLocked,
                            "Locked",
                            "Unlocked",
                          )}
                        </dd>
                      </div>
                    </dl>
                  </WorkspacePanel>

                  <WorkspaceDisclosurePanel
                    description="Synchronization history and Runtime identifiers."
                    flush
                    key={detail.id}
                    title="Sync & technical metadata"
                    titleId="group-technical-metadata-title"
                  >
                    <dl className="groups-facts groups-facts-contained">
                      <div>
                        <dt>Record synced</dt>
                        <dd>{formatDate(detail.syncedAt)}</dd>
                      </div>
                      <div>
                        <dt>Details synced</dt>
                        <dd>{formatDate(detail.detailsSyncedAt)}</dd>
                      </div>
                      <div>
                        <dt>Capability revision</dt>
                        <dd>{detail.sendCapability.revision}</dd>
                      </div>
                      {detail.sendCapability.invalidatedAt && (
                        <div>
                          <dt>Invalidated</dt>
                          <dd>
                            {formatDate(detail.sendCapability.invalidatedAt)}
                          </dd>
                        </div>
                      )}
                      {detail.ownerId && (
                        <div>
                          <dt>Owner ID</dt>
                          <dd>{detail.ownerId}</dd>
                        </div>
                      )}
                      {detail.linkedParentId && (
                        <div>
                          <dt>Linked parent</dt>
                          <dd>{detail.linkedParentId}</dd>
                        </div>
                      )}
                      <div>
                        <dt>Session ID</dt>
                        <dd>{detail.sessionId}</dd>
                      </div>
                    </dl>
                  </WorkspaceDisclosurePanel>
                </div>
              )}

              {inspectorTab === "members" && (
                <section
                  aria-labelledby="group-inspector-members-tab"
                  className="groups-members groups-tab-panel"
                  id="group-inspector-members-panel"
                  role="tabpanel"
                >
                  <WorkspaceSectionHeader
                    action={<span className="groups-member-count">
                      {memberQuery
                        ? `${memberTotal} matches`
                        : syncedMemberTotal !== null &&
                            detail.participantsCount !== null &&
                            detail.participantsCount !== syncedMemberTotal
                          ? `${syncedMemberTotal} synced of ${detail.participantsCount}`
                          : (syncedMemberTotal ?? "—")}
                    </span>}
                    description="Search the synchronized member directory and review access roles."
                    kicker="Directory"
                    title="Members"
                    titleId="group-members-title"
                  />
                  {syncedMemberTotal !== null &&
                    detail.participantsCount !== null &&
                    detail.participantsCount !== syncedMemberTotal && (
                      <InlineAlert
                        title="Member sync incomplete"
                        tone="warning"
                      >
                        {syncedMemberTotal} synchronized member records are
                        available for {detail.participantsCount} participants.
                      </InlineAlert>
                    )}
                  <SearchField
                    id="member-filter"
                    label="Search synchronized members"
                    loading={membersLoading}
                    onChange={setMemberFilter}
                    placeholder="Search all synced members"
                    value={memberFilter}
                  />
                  {membersError && (
                    <InlineAlert
                      action={
                        <Button
                          onClick={() =>
                            selectedSessionId &&
                            selectedGroup &&
                            void loadMembers(
                              selectedSessionId,
                              selectedGroup.id,
                              memberOffset,
                              memberQuery,
                            )
                          }
                          size="sm"
                        >
                          Retry
                        </Button>
                      }
                      title="Could not load members"
                    >
                      {membersError}
                    </InlineAlert>
                  )}
                  {!memberPage && membersLoading ? (
                    <WorkspaceEmptyState compact icon="refresh" loading title="Loading members">
                      Runtime is returning synchronized member records.
                    </WorkspaceEmptyState>
                  ) : !memberPage && membersError ? null : memberPage?.data
                      .length === 0 && memberQuery ? (
                    <WorkspaceEmptyState compact icon="groups" title="No matching members">
                      No synchronized members match this search.
                    </WorkspaceEmptyState>
                  ) : memberPage?.data.length === 0 ? (
                    <WorkspaceEmptyState compact icon="groups" title="No member records">
                      No member details available.
                    </WorkspaceEmptyState>
                  ) : (
                    <ul aria-busy={membersLoading || undefined}>
                      {(memberPage?.data ?? []).map((member) => {
                        const identity = memberIdentityPresentation(member);
                        return (
                          <li key={member.participantId}>
                            <span className="stack stack-xs">
                              <strong>{memberDisplayName(member)}</strong>
                              <code>{identity.label}</code>
                              {identity.resolvedPhoneNumber &&
                                identity.participantId && (
                                  <code className="groups-member-id">
                                    {identity.participantId}
                                  </code>
                                )}
                            </span>
                            <Badge
                              tone={
                                member.isAdmin || member.isSuperAdmin
                                  ? "success"
                                  : "neutral"
                              }
                            >
                              {member.isSuperAdmin
                                ? "Owner"
                                : member.isAdmin
                                  ? "Admin"
                                  : "Member"}
                            </Badge>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {memberPage && memberTotal > 0 && (
                    <div className="groups-member-pagination">
                      <span>
                        {memberFirstItem}–{memberLastItem} of {memberTotal}
                      </span>
                      <div>
                        <Button
                          aria-label="Previous member page"
                          disabled={!canGoToPreviousMembers}
                          onClick={() => {
                            membersRevision.current += 1;
                            memberRequestKeyRef.current = "";
                            setMemberOffset(
                              Math.max(0, memberOffset - MEMBER_PAGE_SIZE),
                            );
                          }}
                          size="sm"
                        >
                          Previous
                        </Button>
                        <Button
                          aria-label="Next member page"
                          disabled={!canGoToNextMembers}
                          onClick={() => {
                            membersRevision.current += 1;
                            memberRequestKeyRef.current = "";
                            setMemberOffset(memberOffset + MEMBER_PAGE_SIZE);
                          }}
                          size="sm"
                        >
                          Next
                        </Button>
                      </div>
                    </div>
                  )}
                </section>
              )}
            </div>
          )}
        </WorkspaceDrawer>
      </>
    </div>
  );
}
