import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRuntimeConnection } from "@/app/RuntimeConnectionContext";
import { useWorkspaceNavigationGuard } from "@/app/WorkspaceNavigationGuard";
import type {
  RuntimeGroupDetail,
  RuntimeGroupList,
  RuntimeGroupListGroup,
  RuntimeGroupMemberPage,
  RuntimeGroupPage,
  RuntimeSyncRun,
} from "@/shared/api/runtime-client";
import { RuntimeRequestError } from "@/shared/api/runtime-client";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";
import { DateTime } from "@/shared/ui/DateTime";
import { DropdownMenu, DropdownMenuItem } from "@/shared/ui/DropdownMenu";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { PageHeader } from "@/shared/ui/PageHeader";
import { SearchField } from "@/shared/ui/SearchField";
import { SelectMenu } from "@/shared/ui/SelectMenu";
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
import { GroupListMetadataDialog } from "./GroupListMetadataDialog";
import { GroupScopeSelector } from "./GroupScopeSelector";
import { GroupsTable, type GroupsTableRow } from "./GroupsTable";
import {
  filterGroupListMembership,
  groupListCapacityLabel,
  groupListDraftDiff,
  groupListDraftRowOrder,
  type GroupMembershipFilter,
} from "./groups-workspace-state";
import { reconcileMemberDatasetRevision } from "./member-dataset";
import {
  memberDisplayName,
  memberIdentityPresentation,
} from "./member-presentation";
import { useGroupsScopeController } from "./useGroupsScopeController";
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

function groupListTableRow(
  row: RuntimeGroupListGroup,
  sessionId: string,
): GroupsTableRow {
  return {
    id: row.groupId,
    isActive: row.isActive,
    name: row.groupName,
    participantsCount: row.participantsCount,
    sendCapability: row.sendCapability,
    sessionId,
    syncedAt: row.syncedAt,
  };
}

export function GroupsScreen() {
  const { connected, refreshSessions, selectedSessionId } =
    useRuntimeConnection();
  const toast = useToast();
  if (!connected) throw new Error("GroupsScreen requires a Runtime connection");

  const runtimeApi = connected.api;
  const runtimeOrigin = connected.profile.baseUrl;
  const selectedSession =
    connected.sessions.find(({ id }) => id === selectedSessionId) ?? null;
  const groupsScope = useGroupsScopeController({
    api: runtimeApi,
    sessionId: selectedSessionId,
  });
  useWorkspaceNavigationGuard(groupsScope.dirty);
  const [page, setPage] = useState<RuntimeGroupPage | null>(null);
  const [listState, setListState] = useState<GroupListState>(() =>
    initialGroupListState(selectedSessionId),
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [listLoadReason, setListLoadReason] =
    useState<GroupListLoadReason | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [syncConfirmationOpen, setSyncConfirmationOpen] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<GroupsTableRow | null>(null);
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
  const [membershipFilter, setMembershipFilter] =
    useState<GroupMembershipFilter>("all");
  const [draftDetailsOpen, setDraftDetailsOpen] = useState(false);
  const [deleteIntent, setDeleteIntent] = useState<RuntimeGroupList | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const scopeKey = groupsScope.scope.mode === "directory"
    ? "directory"
    : groupsScope.scope.mode === "list:view"
      ? `view:${groupsScope.scope.list.id}`
      : groupsScope.scope.mode === "list:edit"
        ? `edit:${groupsScope.scope.draft.canonical?.id ?? "unknown"}`
        : `create:${groupsScope.scope.draft.createIdempotencyKey}`;
  const scopeKeyRef = useRef(scopeKey);
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
  const groupSearchRef = useRef<HTMLInputElement | null>(null);
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
  const reloadingCurrentView = listLoadReason === "reload"
    || (groupsScope.scope.mode === "list:view" && groupsScope.membershipLoading);

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
          ...(state.minParticipants === undefined
            ? {}
            : { minParticipants: state.minParticipants }),
          ...(state.maxParticipants === undefined
            ? {}
            : { maxParticipants: state.maxParticipants }),
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
      if (groupsScope.scope.mode === "list:view") {
        groupsScope.reloadMembership();
      } else {
        const viewReloaded = await loadGroups(listStateRef.current, "post-sync");
        if (!viewReloaded)
          warnings.push("The current groups view could not be updated.");
      }
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
    setMembershipFilter("all");
    setDraftDetailsOpen(false);
    setDeleteIntent(null);
    setDeleting(false);
    setDeleteError(null);
  }, [cancelCapabilityRefresh, listState.sessionId, selectedSessionId]);

  useEffect(() => {
    if (scopeKeyRef.current === scopeKey) return;
    scopeKeyRef.current = scopeKey;
    listRevision.current += 1;
    setPage(null);
    setListState(initialGroupListState(selectedSessionId));
    setListLoadReason(null);
    setListError(null);
    setFiltersOpen(false);
    setMembershipFilter("all");
    setDraftDetailsOpen(false);
    if (groupsScope.scope.mode === "list:create") {
      window.requestAnimationFrame(() => groupSearchRef.current?.focus());
    }
  }, [groupsScope.scope.mode, scopeKey, selectedSessionId]);

  useEffect(() => {
    const {
      sessionId,
      query,
      capabilityStatuses,
      capabilityFreshness,
      isActive,
      maxParticipants,
      minParticipants,
      offset,
    } = listState;
    if (sessionId !== selectedSessionId || groupsScope.scope.mode === "list:view") return;
    void loadGroups({
      sessionId,
      query,
      capabilityStatuses,
      capabilityFreshness,
      isActive,
      maxParticipants,
      minParticipants,
      offset,
    });
  }, [
    listState.sessionId,
    listState.query,
    listState.capabilityStatuses,
    listState.capabilityFreshness,
    listState.isActive,
    listState.maxParticipants,
    listState.minParticipants,
    listState.offset,
    loadGroups,
    groupsScope.scope.mode,
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

  async function openGroup(group: GroupsTableRow, trigger: HTMLButtonElement) {
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
    if (groupsScope.scope.mode === "list:view") {
      groupsScope.reloadMembership();
      return;
    }
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

  async function saveGroupList() {
    const saved = await groupsScope.saveDraft();
    if (!saved) return;
    toast.notify({
      id: `group-list-saved-${saved.id}`,
      title: "Group list saved",
      tone: "success",
    });
  }

  async function deleteGroupList() {
    if (!deleteIntent || deleting) return;
    const snapshot = deleteIntent;
    setDeleting(true);
    setDeleteError(null);
    try {
      await runtimeApi.archiveGroupList(snapshot.id, snapshot.revision);
      setDeleteIntent(null);
      groupsScope.savedListDeleted(snapshot.id);
      toast.notify({
        description: "Existing campaigns and their current targets were not changed.",
        id: `group-list-deleted-${snapshot.id}`,
        title: "Group list deleted",
        tone: "success",
      });
    } catch (error) {
      const code = error instanceof RuntimeRequestError ? error.code : null;
      if (
        code === "GROUP_LIST_NOT_FOUND"
        || (error instanceof RuntimeRequestError && error.status === 404)
      ) {
        setDeleteIntent(null);
        groupsScope.savedListDeleted(snapshot.id);
        toast.notify({
          description: "This saved list no longer exists or is no longer available.",
          id: `group-list-unavailable-${snapshot.id}`,
          title: "Group list unavailable",
          tone: "warning",
        });
      } else if (code === "GROUP_LIST_REVISION_CONFLICT") {
        setDeleteIntent(null);
        try {
          groupsScope.savedListUpdated(await runtimeApi.getGroupList(snapshot.id));
        } catch {
          // The catalog refresh requested below can recover once Runtime is reachable.
        }
        toast.notify({
          description: "The group list changed. Review it before deleting.",
          id: `group-list-delete-conflict-${snapshot.id}`,
          title: "Delete not confirmed",
          tone: "warning",
        });
      } else {
        setDeleteError("The group list could not be deleted. Check the Runtime connection and try again.");
      }
    } finally {
      setDeleting(false);
    }
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
  const directoryRows = useMemo<GroupsTableRow[]>(
    () => visiblePage?.data ?? [],
    [visiblePage],
  );
  useEffect(() => groupsScope.rememberRows(directoryRows), [directoryRows, groupsScope.rememberRows]);

  const tableModel = useMemo(() => {
    const scope = groupsScope.scope;
    const directoryTotal = visiblePage?.meta.total ?? 0;
    const directoryLimit = visiblePage?.meta.limit ?? PAGE_SIZE;
    const directoryOffset = visiblePage?.meta.offset ?? offset;
    const criteria = {
      active: listState.isActive ?? true,
      capabilityFreshness: listState.capabilityFreshness,
      capabilityStatuses: listState.capabilityStatuses,
      query: listState.query,
    };

    if (scope.mode === "list:view") {
      const filtered = filterGroupListMembership(groupsScope.membership?.data ?? [], {
        ...criteria,
        membership: "all",
      });
      const rows = filtered
        .slice(offset, offset + PAGE_SIZE)
        .map((row) => groupListTableRow(row, scope.list.sessionId));
      return {
        caption: `Groups saved in ${scope.list.name}`,
        emptyMessage: hasListCriteria
          ? "No saved groups match this search or filters."
          : "This saved list has no groups.",
        error: Boolean(groupsScope.membershipError),
        loading: groupsScope.membershipLoading,
        pageIds: rows.map((row) => row.id),
        pageLimit: PAGE_SIZE,
        pageOffset: offset,
        pinnedIds: new Set<string>(),
        rows,
        selection: "none" as const,
        total: filtered.length,
      };
    }

    if (scope.mode === "directory") {
      return {
        caption: "Groups in the active Gateway session",
        emptyMessage: hasListCriteria
          ? "No groups match this search or filters."
          : "No groups were returned for this session.",
        error: Boolean(listError),
        loading,
        pageIds: directoryRows.map((row) => row.id),
        pageLimit: directoryLimit,
        pageOffset: directoryOffset,
        pinnedIds: new Set<string>(),
        rows: directoryRows,
        selection: "directory" as const,
        total: directoryTotal,
      };
    }

    const draft = scope.draft;
    const selectedIds = new Set(draft.memberIds);
    if (membershipFilter === "in-list") {
      const filtered = filterGroupListMembership(
        draft.memberIds.flatMap((id) => draft.membershipRows[id] ? [draft.membershipRows[id]] : []),
        { ...criteria, membership: "in-list", selectedIds },
      );
      const rows = filtered
        .slice(offset, offset + PAGE_SIZE)
        .map((row) => groupListTableRow(row, draft.sessionId));
      return {
        caption: `Groups staged for ${draft.name}`,
        emptyMessage: "No staged groups match this search or filters.",
        error: false,
        loading: false,
        pageIds: rows.map((row) => row.id),
        pageLimit: PAGE_SIZE,
        pageOffset: offset,
        pinnedIds: new Set<string>(),
        rows,
        selection: "draft" as const,
        total: filtered.length,
      };
    }

    const currentRows = membershipFilter === "not-in-list"
      ? directoryRows.filter((row) => !selectedIds.has(row.id))
      : directoryRows;
    const currentIds = currentRows.map((row) => row.id);
    const rowOrder = membershipFilter === "not-in-list"
      ? (() => {
        const current = new Set(currentIds);
        const removed = draft.baselineIds.filter((id) => !selectedIds.has(id) && !current.has(id));
        return { pinnedIds: new Set(removed), rowIds: [...removed, ...currentIds] };
      })()
      : groupListDraftRowOrder(draft, currentIds);
    const currentById = Object.fromEntries(currentRows.map((row) => [row.id, row]));
    const rows = rowOrder.rowIds.flatMap((id) => {
      if (currentById[id]) return [currentById[id]];
      const retained = draft.membershipRows[id];
      return retained ? [groupListTableRow(retained, draft.sessionId)] : [];
    });
    const selectedMatching = membershipFilter === "not-in-list"
      ? filterGroupListMembership(
        draft.memberIds.flatMap((id) => draft.membershipRows[id] ? [draft.membershipRows[id]] : []),
        { ...criteria, membership: "in-list", selectedIds },
      ).length
      : 0;
    return {
      caption: `Directory membership editor for ${draft.name}`,
      emptyMessage: membershipFilter === "not-in-list"
        ? "No unselected groups match this search or filters."
        : hasListCriteria
          ? "No groups match this search or filters."
          : "No groups were returned for this session.",
      error: Boolean(listError),
      loading,
      pageIds: currentIds,
      pageLimit: directoryLimit,
      pageOffset: directoryOffset,
      pinnedIds: rowOrder.pinnedIds,
      rows,
      selection: "draft" as const,
      total: membershipFilter === "not-in-list"
        ? Math.max(0, directoryTotal - selectedMatching)
        : directoryTotal,
    };
  }, [
    directoryRows,
    groupsScope.membership,
    groupsScope.membershipError,
    groupsScope.membershipLoading,
    groupsScope.scope,
    hasListCriteria,
    listError,
    listState.capabilityFreshness,
    listState.capabilityStatuses,
    listState.isActive,
    listState.query,
    loading,
    membershipFilter,
    offset,
    visiblePage,
  ]);
  const total = tableModel.total;
  const pageLimit = tableModel.pageLimit;
  const pageOffset = tableModel.pageOffset;
  useEffect(() => {
    const clientPaginated = groupsScope.scope.mode === "list:view"
      || ((groupsScope.scope.mode === "list:create" || groupsScope.scope.mode === "list:edit")
        && membershipFilter === "in-list");
    if (!clientPaginated || offset === 0 || tableModel.total > offset) return;
    const lastOffset = tableModel.total === 0
      ? 0
      : Math.floor((tableModel.total - 1) / PAGE_SIZE) * PAGE_SIZE;
    setListState((current) => ({ ...current, offset: lastOffset }));
  }, [groupsScope.scope.mode, membershipFilter, offset, tableModel.total]);
  const firstItem = total === 0 ? 0 : pageOffset + 1;
  const lastItem = Math.min(pageOffset + tableModel.pageIds.length, total);
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
          : groupsScope.scope.mode === "list:view"
            ? `Viewing the persisted membership of ${groupsScope.scope.list.name}.`
            : groupsScope.scope.mode === "list:create" || groupsScope.scope.mode === "list:edit"
              ? `Staging static membership for ${groupsScope.scope.draft.name}.`
              : `Groups synchronized for ${selectedSession?.name ?? "the active session"}.`;
  const activeDraft = groupsScope.scope.mode === "list:create"
    || groupsScope.scope.mode === "list:edit"
    ? groupsScope.scope.draft
    : null;
  const draftDiff = activeDraft ? groupListDraftDiff(activeDraft) : null;
  const draftCapacity = activeDraft
    ? groupListCapacityLabel(activeDraft.memberIds.length)
    : null;

  async function copyGroupId(groupId: string) {
    try {
      await navigator.clipboard.writeText(groupId);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <div className="groups-screen stack stack-lg">
      <PageHeader
        actions={
          <DropdownMenu
            ariaLabel="Group data actions"
            disabled={!selectedSessionId}
            contentClassName="action-menu"
            trigger={(triggerProps) => (
              <UpdateActionTrigger
                ariaLabel={
                  syncState === "updating"
                    ? "Updating groups view"
                    : syncForeground
                      ? "Syncing groups"
                      : reloadingCurrentView
                        ? "Reloading groups"
                        : "Update groups"
                }
                busy={syncForeground || reloadingCurrentView}
                label={
                  syncState === "updating"
                    ? "Updating view…"
                    : syncForeground
                      ? "Syncing…"
                      : reloadingCurrentView
                        ? "Reloading…"
                        : "Update"
                }
                triggerProps={triggerProps}
              />
            )}
          >
            <DropdownMenuItem
              disabled={loading || groupsScope.membershipLoading}
              icon="refresh"
              onSelect={() => void reloadGroups()}
              description={groupsScope.scope.mode === "list:view"
                ? "Reload this saved list and its persisted membership."
                : "Reload groups currently stored in WA Runtime."}
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
          {groupsScope.scope.mode === "list:view" && (
            <section className="group-list-context-bar" aria-label="Saved list context">
              <div className="group-list-context-copy">
                <span>Saved static list</span>
                <strong>{groupsScope.scope.list.name}</strong>
                <small>
                  {groupsScope.scope.list.groupCount.toLocaleString()} groups · Membership r{groupsScope.scope.list.membershipRevision} · Updated <DateTime value={groupsScope.scope.list.updatedAt} />
                </small>
              </div>
              <div className="group-list-context-actions">
                <Button
                  disabled={groupsScope.membershipLoading || !groupsScope.membership}
                  icon="edit"
                  onClick={groupsScope.startEdit}
                  size="sm"
                >
                  Edit
                </Button>
                <DropdownMenu
                  ariaLabel={`Actions for ${groupsScope.scope.list.name}`}
                  trigger={(triggerProps) => (
                    <Button {...triggerProps} aria-label={`More actions for ${groupsScope.selectedList?.name ?? "saved list"}`} icon="more" size="sm" variant="ghost" />
                  )}
                >
                  <DropdownMenuItem
                    danger
                    description="Remove this saved list. Existing campaign targets stay unchanged."
                    icon="trash"
                    onSelect={() => {
                      setDeleteError(null);
                      setDeleteIntent(groupsScope.scope.mode === "list:view" ? groupsScope.scope.list : null);
                    }}
                  >
                    Delete list
                  </DropdownMenuItem>
                </DropdownMenu>
              </div>
            </section>
          )}

          {activeDraft && draftDiff && (
            <section className="group-list-draft-bar" aria-label="Group list draft">
              <div className="group-list-context-copy">
                <span>{groupsScope.scope.mode === "list:create" ? "New list draft" : "Editing saved list"}</span>
                <strong>{activeDraft.name}</strong>
                <small>
                  {groupsScope.scope.mode === "list:edit"
                    ? `Saved ${draftDiff.savedCount.toLocaleString()} · Staged ${draftDiff.stagedCount.toLocaleString()} · +${draftDiff.addedIds.length} / −${draftDiff.removedIds.length}`
                    : `${draftDiff.stagedCount.toLocaleString()} groups staged`}
                  {draftCapacity ? ` · ${draftCapacity}` : ""}
                </small>
              </div>
              <div className="group-list-context-actions">
                <Button onClick={() => setDraftDetailsOpen(true)} size="sm" variant="ghost">Details</Button>
                <Button
                  disabled={groupsScope.saving}
                  onClick={() => groupsScope.scope.mode === "list:edit" && groupsScope.scope.draft.canonical
                    ? groupsScope.requestList(groupsScope.scope.draft.canonical)
                    : groupsScope.requestDirectory()}
                  size="sm"
                >
                  Discard
                </Button>
                <Button
                  disabled={groupsScope.saving || !activeDraft.name.trim() || (groupsScope.scope.mode === "list:edit" && !groupsScope.dirty)}
                  loading={groupsScope.saving}
                  onClick={() => void saveGroupList()}
                  size="sm"
                  variant="primary"
                >
                  Save
                </Button>
              </div>
            </section>
          )}

          <GroupSearchToolbar
            actions={activeDraft ? (
              <SelectMenu
                containerClassName="groups-membership-filter"
                label="Membership"
                labelHidden
                onChange={setMembershipFilter}
                options={[
                  { label: "All groups", value: "all" },
                  { label: "In list", value: "in-list" },
                  { label: "Not in list", value: "not-in-list" },
                ]}
                size="sm"
                value={membershipFilter}
              />
            ) : groupsScope.scope.mode === "directory" && groupsScope.directoryIds.length > 0 ? (
              <Button
                onClick={() => groupsScope.requestMetadata(groupsScope.directoryIds)}
                size="sm"
                variant="primary"
              >
                Save as list · {groupsScope.directoryIds.length.toLocaleString()}
              </Button>
            ) : undefined}
            filtersOpen={filtersOpen}
            firstItem={firstItem}
            lastItem={lastItem}
            leading={(
              <GroupScopeSelector
                disabled={!selectedSessionId || groupsScope.saving}
                directorySelected={groupsScope.scope.mode === "directory"}
                error={groupsScope.catalogError}
                hasMore={groupsScope.catalogHasMore}
                lists={groupsScope.catalogLists}
                loading={groupsScope.catalogLoading}
                onLoadMore={groupsScope.loadMoreCatalog}
                onNewList={() => groupsScope.requestMetadata([])}
                onQueryChange={groupsScope.setCatalogInputQuery}
                onSelectDirectory={groupsScope.requestDirectory}
                onSelectList={groupsScope.requestList}
                query={groupsScope.catalogInputQuery}
                selectedList={groupsScope.selectedList}
                selectedListId={groupsScope.selectedList?.id ?? null}
                valueLabel={activeDraft?.name}
              />
            )}
            loading={tableModel.loading}
            searchLabel={groupsScope.scope.mode === "list:view"
              ? `Search groups in ${groupsScope.scope.list.name}`
              : activeDraft
                ? "Search groups for this list"
                : "Search all synchronized groups"}
            searchInputRef={groupSearchRef}
            setFiltersOpen={setFiltersOpen}
            setState={setListState}
            state={listState}
            total={total}
          />

          {(groupsScope.selectionError
            || groupsScope.saveError
            || groupsScope.fieldErrors.groupIds
            || groupsScope.fieldErrors.name
            || groupsScope.fieldErrors.description) && (
            <InlineAlert
              className="data-table-error"
              title={groupsScope.saveError?.title
                ?? (groupsScope.fieldErrors.name || groupsScope.fieldErrors.description
                  ? "Invalid list details"
                  : "Group selection")}
            >
              {groupsScope.saveError?.body
                ?? groupsScope.fieldErrors.name
                ?? groupsScope.fieldErrors.description
                ?? groupsScope.fieldErrors.groupIds
                ?? groupsScope.selectionError}
            </InlineAlert>
          )}

          {(groupsScope.scope.mode === "list:view" ? groupsScope.membershipError : listError) && (
            <InlineAlert
              action={
                <Button
                  onClick={() => groupsScope.scope.mode === "list:view"
                    ? groupsScope.reloadMembership()
                    : void loadGroups(listState)}
                  size="sm"
                >
                  Retry
                </Button>
              }
              className="data-table-error"
              title={groupsScope.scope.mode === "list:view" ? "Could not load saved list" : "Could not load groups"}
            >
              {groupsScope.scope.mode === "list:view" ? groupsScope.membershipError : listError}
            </InlineAlert>
          )}

          <GroupsTable
            activeGroupId={selectedGroup?.id}
            caption={tableModel.caption}
            emptyMessage={tableModel.emptyMessage}
            error={tableModel.error}
            loading={tableModel.loading}
            onView={(group, trigger) => void openGroup(group, trigger)}
            rows={tableModel.rows}
            selection={tableModel.selection === "none" ? undefined : {
              disabled: groupsScope.saving,
              onToggle: tableModel.selection === "directory"
                ? groupsScope.toggleDirectory
                : groupsScope.toggleDraft,
              onTogglePage: () => tableModel.selection === "directory"
                ? groupsScope.toggleDirectoryPage(tableModel.pageIds)
                : groupsScope.toggleDraftPage(tableModel.pageIds),
              pageIds: tableModel.pageIds,
              pinnedIds: tableModel.pinnedIds,
              pinnedLabel: groupsScope.scope.mode === "list:edit"
                ? "Saved or staged outside current results"
                : "Selected outside current results",
              selectedIds: tableModel.selection === "directory"
                ? groupsScope.directorySelectedIds
                : activeDraft ? new Set(activeDraft.memberIds) : new Set<string>(),
            }}
          />

          <TablePagination
            limit={pageLimit}
            loading={tableModel.loading}
            offset={pageOffset}
            onOffsetChange={(nextOffset) => setListState((current) => ({ ...current, offset: nextOffset }))}
            total={total}
          />
        </div>

        <GroupListMetadataDialog
          onClose={() => groupsScope.setMetadataOpen(false)}
          onContinue={groupsScope.continueMetadata}
          open={groupsScope.metadataOpen}
          seedCount={groupsScope.metadataSeedCount}
          sessionName={selectedSession?.name ?? "Active session"}
        />

        {activeDraft && (
          <GroupListMetadataDialog
            continueLabel="Apply details"
            dialogDescription="Update the reusable list details without leaving the membership workspace."
            eyebrow="List details"
            initialDescription={activeDraft.description}
            initialName={activeDraft.name}
            notice="Details remain staged until the full list is saved."
            onClose={() => setDraftDetailsOpen(false)}
            onContinue={(metadata) => {
              groupsScope.updateDraftMetadata(metadata);
              setDraftDetailsOpen(false);
            }}
            open={draftDetailsOpen}
            seedCount={activeDraft.memberIds.length}
            sessionName={selectedSession?.name ?? "Active session"}
            title="Edit list details"
          />
        )}

        <ConfirmationDialog
          body="Unsaved list details or staged membership will be discarded. Runtime data is not changed."
          cancelLabel="Keep editing"
          confirmLabel="Discard changes"
          confirmVariant="danger"
          onCancel={groupsScope.cancelDiscard}
          onConfirm={groupsScope.confirmDiscard}
          open={groupsScope.discardConfirmationOpen}
          title="Discard group list changes?"
        />

        <ConfirmationDialog
          body={<>
            <p>Group list “{deleteIntent?.name}” will be removed from saved lists. Existing campaigns and their current targets will not be changed.</p>
            {deleteError && <InlineAlert title="Could not delete group list">{deleteError}</InlineAlert>}
          </>}
          busy={deleting}
          busyLabel="Deleting…"
          cancelLabel="Cancel"
          confirmLabel="Delete list"
          confirmVariant="danger"
          onCancel={() => {
            if (deleting) return;
            setDeleteIntent(null);
            setDeleteError(null);
          }}
          onConfirm={() => void deleteGroupList()}
          open={Boolean(deleteIntent)}
          title="Delete group list?"
        />

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
                  meta:
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
                    className="groups-identity-card"
                    description={detail.description || "No group description."}
                    label="Synchronized group"
                    metrics={[
                      { label: "Participants", value: detail.participantsCount ?? syncedMemberTotal ?? "—" },
                      { label: "Access", value: accessLabel(detail.isAdmin) },
                      {
                        label: "Synced",
                        value: <DateTime value={detail.syncedAt} />,
                      },
                    ]}
                    status={<Badge tone={detail.isActive ? "success" : "neutral"} variant="status">{detail.isActive ? "Active" : "Inactive"}</Badge>}
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
                          <dd><DateTime value={detail.sendCapability.checkedAt} /></dd>
                        </div>
                        <div>
                          <dt>Freshness</dt>
                          <dd>
                            <Badge
                              tone={
                                detailCapabilityIsStale ? "warning" : "success"
                              }
                              variant="status"
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
                        <dd><DateTime value={detail.syncedAt} /></dd>
                      </div>
                      <div>
                        <dt>Details synced</dt>
                        <dd><DateTime value={detail.detailsSyncedAt} /></dd>
                      </div>
                      <div>
                        <dt>Capability revision</dt>
                        <dd>{detail.sendCapability.revision}</dd>
                      </div>
                      {detail.sendCapability.invalidatedAt && (
                        <div>
                          <dt>Invalidated</dt>
                          <dd><DateTime value={detail.sendCapability.invalidatedAt} /></dd>
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
                                  ? "info"
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
