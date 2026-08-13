import { useCallback, useEffect, useRef, useState } from "react";

import { useRuntimeConnection } from "@/app/RuntimeConnectionContext";
import type {
  RuntimeGroup,
  RuntimeGroupDetail,
  RuntimeGroupMemberPage,
  RuntimeGroupPage,
} from "@/shared/api/runtime-client";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Drawer } from "@/shared/ui/Drawer";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { PageHeader } from "@/shared/ui/PageHeader";
import { TextField } from "@/shared/ui/TextField";
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
import "./groups.css";

const PAGE_SIZE = 20;
const MEMBER_PAGE_SIZE = 25;

type CapabilityRefreshState =
  | "idle"
  | "requesting"
  | "pending"
  | "completed"
  | "timed-out"
  | "failed";

const CAPABILITY_REASON_COPY: Record<string, string> = {
  SEND_ALLOWED: "WA Runtime confirmed that this group can receive messages.",
  SEND_DENIED: "WA Runtime determined that this group cannot receive messages.",
  SEND_UNKNOWN: "WA Runtime could not confirm whether this group can receive messages.",
  group_is_read_only: "The group currently does not accept new messages.",
  session_is_admin: "The active session is a group administrator.",
  session_is_member: "The active session is a group member.",
  session_not_in_group: "The active session is not a member of this group.",
};

function capabilityReasonCopy(reason: string): string {
  return CAPABILITY_REASON_COPY[reason] ?? "WA Runtime returned a capability policy result.";
}

function accessLabel(isAdmin: boolean | null): string {
  if (isAdmin === null) return "Unknown";
  return isAdmin ? "Administrator" : "Member";
}

function booleanLabel(value: boolean | null, positive: string, negative: string): string {
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

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function GroupsScreen() {
  const { connected, selectedSessionId } = useRuntimeConnection();
  if (!connected) throw new Error("GroupsScreen requires a Runtime connection");

  const runtimeApi = connected.api;
  const selectedSession = connected.sessions.find(({ id }) => id === selectedSessionId) ?? null;
  const [page, setPage] = useState<RuntimeGroupPage | null>(null);
  const [listState, setListState] = useState<GroupListState>(() =>
    initialGroupListState(selectedSessionId)
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<RuntimeGroup | null>(null);
  const [detail, setDetail] = useState<RuntimeGroupDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [capabilityRefreshState, setCapabilityRefreshState] =
    useState<CapabilityRefreshState>("idle");
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [capabilityNotice, setCapabilityNotice] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [memberPage, setMemberPage] = useState<RuntimeGroupMemberPage | null>(null);
  const [memberFilter, setMemberFilter] = useState("");
  const [memberQuery, setMemberQuery] = useState("");
  const [memberOffset, setMemberOffset] = useState(0);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [syncedMemberTotal, setSyncedMemberTotal] = useState<number | null>(null);
  const listRevision = useRef(0);
  const listTargetRef = useRef("");
  const detailRevision = useRef(0);
  const membersRevision = useRef(0);
  const capabilityRevision = useRef(0);
  const capabilityAbortRef = useRef<AbortController | null>(null);
  const capabilityTargetRef = useRef<{ sessionId: string; groupId: string } | null>(null);
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null);
  capabilityTargetRef.current = selectedSessionId
    && selectedGroup
    && selectedGroup.sessionId === selectedSessionId
    ? { sessionId: selectedSessionId, groupId: selectedGroup.id }
    : null;
  listTargetRef.current = groupListRequestKey(listState);
  const refreshingCapability = capabilityRefreshState === "requesting"
    || capabilityRefreshState === "pending";

  const cancelCapabilityRefresh = useCallback(() => {
    capabilityRevision.current += 1;
    capabilityAbortRef.current?.abort();
    capabilityAbortRef.current = null;
  }, []);

  const capabilityFlowIsCurrent = useCallback((
    revision: number,
    sessionId: string,
    groupId: string,
  ) => {
    const target = capabilityTargetRef.current;
    return revision === capabilityRevision.current
      && target?.sessionId === sessionId
      && target.groupId === groupId;
  }, []);

  const loadGroups = useCallback(async (state: GroupListRequestState) => {
    if (!state.sessionId || state.sessionId !== selectedSessionId) return;
    const revision = ++listRevision.current;
    const requestKey = groupListRequestKey(state);
    setLoading(true);
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
      if (revision !== listRevision.current || requestKey !== listTargetRef.current) return;

      if (state.offset > 0 && nextPage.data.length === 0 && nextPage.meta.total <= state.offset) {
        const lastOffset = nextPage.meta.total === 0
          ? 0
          : Math.floor((nextPage.meta.total - 1) / PAGE_SIZE) * PAGE_SIZE;
        setListState((current) => ({ ...current, offset: lastOffset }));
        if (nextPage.meta.total === 0) setPage(nextPage);
        return;
      }

      setPage(nextPage);
    } catch (error) {
      if (revision === listRevision.current && requestKey === listTargetRef.current) {
        setListError(errorMessage(error, "Could not load groups."));
      }
    } finally {
      if (revision === listRevision.current && requestKey === listTargetRef.current) {
        setLoading(false);
      }
    }
  }, [runtimeApi, selectedSessionId]);

  const loadMembers = useCallback(async (
    sessionId: string,
    groupId: string,
    nextOffset: number,
    query: string,
  ) => {
    const revision = ++membersRevision.current;
    setMembersLoading(true);
    setMembersError(null);
    try {
      const nextPage = await runtimeApi.listGroupMembers({
        sessionId,
        groupId,
        limit: MEMBER_PAGE_SIZE,
        offset: nextOffset,
        ...(query ? { query } : {}),
      });
      if (revision !== membersRevision.current) return;

      if (nextOffset > 0 && nextPage.data.length === 0 && nextPage.meta.total <= nextOffset) {
        const lastOffset = nextPage.meta.total === 0
          ? 0
          : Math.floor((nextPage.meta.total - 1) / MEMBER_PAGE_SIZE) * MEMBER_PAGE_SIZE;
        setMemberOffset(lastOffset);
        if (nextPage.meta.total === 0) setMemberPage(nextPage);
        return;
      }

      setMemberPage(nextPage);
      if (!query) setSyncedMemberTotal(nextPage.meta.total);
    } catch (error) {
      if (revision === membersRevision.current) {
        setMembersError(errorMessage(error, "Could not load group members."));
      }
    } finally {
      if (revision === membersRevision.current) setMembersLoading(false);
    }
  }, [runtimeApi]);

  useEffect(() => {
    if (listState.sessionId === selectedSessionId) return;
    listRevision.current += 1;
    detailRevision.current += 1;
    membersRevision.current += 1;
    cancelCapabilityRefresh();
    setPage(null);
    setListState(initialGroupListState(selectedSessionId));
    setFiltersOpen(false);
    setLoading(false);
    setSelectedGroup(null);
    setDetail(null);
    setDetailLoading(false);
    setDetailError(null);
    setCapabilityRefreshState("idle");
    setCapabilityError(null);
    setCapabilityNotice(null);
    setCopyState("idle");
    setMemberPage(null);
    setMemberFilter("");
    setMemberQuery("");
    setMemberOffset(0);
    setMembersLoading(false);
    setMembersError(null);
    setSyncedMemberTotal(null);
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

  useEffect(() => {
    const normalizedQuery = listState.inputQuery.trim();
    const timeout = window.setTimeout(() => {
      setListState((current) => {
        if (
          current.sessionId !== listState.sessionId
          || current.inputQuery !== listState.inputQuery
          || current.query === normalizedQuery
        ) return current;
        return { ...current, query: normalizedQuery, offset: 0 };
      });
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [listState.inputQuery, listState.sessionId]);

  useEffect(() => {
    const normalizedQuery = memberFilter.trim();
    const timeout = window.setTimeout(() => {
      setMemberOffset(0);
      setMemberQuery(normalizedQuery);
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [memberFilter]);

  useEffect(() => {
    if (!selectedSessionId || !selectedGroup || selectedGroup.sessionId !== selectedSessionId) return;
    void loadMembers(selectedSessionId, selectedGroup.id, memberOffset, memberQuery);
  }, [loadMembers, memberOffset, memberQuery, selectedGroup, selectedSessionId]);

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
    setMemberPage(null);
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
    setMemberPage(null);
    setMemberFilter("");
    setMemberQuery("");
    setMemberOffset(0);
    setMembersLoading(false);
    setMembersError(null);
    setSyncedMemberTotal(null);
  }

  async function refreshCapability() {
    if (
      !selectedSessionId
      || !selectedGroup
      || selectedGroup.sessionId !== selectedSessionId
      || !detail
      || refreshingCapability
    ) return;
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
          if (capabilityFlowIsCurrent(revision, sessionId, groupId)) setDetail(nextDetail);
        },
      });
      if (
        !capabilityFlowIsCurrent(revision, sessionId, groupId)
        || result.status === "cancelled"
      ) return;
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
          setCapabilityError(errorMessage(
            result.error,
            "Could not read the latest capability result.",
          ));
        }
      }
    } catch (error) {
      if (capabilityFlowIsCurrent(revision, sessionId, groupId)) {
        setCapabilityRefreshState("failed");
        setCapabilityError(errorMessage(error, "Could not refresh send capability."));
      }
    } finally {
      if (capabilityFlowIsCurrent(revision, sessionId, groupId)) {
        capabilityAbortRef.current = null;
      }
    }
  }

  const listContextIsCurrent = listState.sessionId === selectedSessionId;
  const visiblePage = listContextIsCurrent ? page : null;
  const offset = listState.offset;
  const hasListCriteria = Boolean(
    listState.query
    || listState.capabilityStatuses.length
    || listState.capabilityFreshness.length
    || listState.isActive !== undefined
  );
  const total = visiblePage?.meta.total ?? 0;
  const pageLimit = visiblePage?.meta.limit ?? PAGE_SIZE;
  const pageOffset = visiblePage?.meta.offset ?? offset;
  const pageCount = total === 0 ? 0 : Math.ceil(total / pageLimit);
  const pageNumber = total === 0 ? 0 : Math.floor(pageOffset / pageLimit) + 1;
  const firstItem = total === 0 ? 0 : offset + 1;
  const lastItem = Math.min(offset + (visiblePage?.data.length ?? 0), total);
  const canGoBack = offset > 0 && !loading;
  const canGoForward = offset + (visiblePage?.meta.limit ?? PAGE_SIZE) < total && !loading;
  const memberTotal = memberPage?.meta.total ?? 0;
  const memberPageOffset = memberPage?.meta.offset ?? memberOffset;
  const memberFirstItem = memberTotal === 0 ? 0 : memberPageOffset + 1;
  const memberLastItem = Math.min(
    memberPageOffset + (memberPage?.data.length ?? 0),
    memberTotal,
  );
  const canGoToPreviousMembers = memberOffset > 0 && !membersLoading;
  const canGoToNextMembers = memberOffset + MEMBER_PAGE_SIZE < memberTotal && !membersLoading;
  const detailCapabilityIsStale = detail
    ? groupCapabilityIsStale(detail.sendCapability)
    : false;

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
        actions={(
          <Button
            aria-label={loading ? "Reloading groups" : "Reload groups"}
            disabled={!selectedSessionId}
            icon="refresh"
            loading={loading}
            onClick={() => void loadGroups(listState)}
          >
            Reload groups
          </Button>
        )}
        description={`Groups synchronized for ${selectedSession?.name ?? "the active session"}.`}
        title="Groups"
        titleId="groups-title"
      />

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
              action={<Button onClick={() => void loadGroups(listState)} size="sm">Retry</Button>}
              className="data-table-error"
              title="Could not load groups"
            >
              {listError}
            </InlineAlert>
          )}

          <div
            aria-busy={loading}
            className="data-table-scroll groups-table-scroll"
            data-updating={loading && Boolean(visiblePage) || undefined}
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
                  <th className="data-column-number" scope="col">Participants</th>
                  <th scope="col">Send capability</th>
                  <th scope="col">Record synced</th>
                  <th aria-label="Actions" scope="col" />
                </tr>
              </thead>
              <tbody>
                {!visiblePage && loading ? (
                  <tr><td className="data-table-empty" colSpan={5}>Loading groups…</td></tr>
                ) : !visiblePage && listError ? (
                  <tr><td className="data-table-empty" colSpan={5}>Groups are unavailable.</td></tr>
                ) : (visiblePage?.data.length ?? 0) === 0 ? (
                  <tr>
                    <td className="data-table-empty" colSpan={5}>
                      {hasListCriteria
                        ? "No groups match this search or filters."
                        : "No groups were returned for this session."}
                    </td>
                  </tr>
                ) : visiblePage?.data.map((group) => (
                  <tr data-selected={group.id === selectedGroup?.id || undefined} key={group.id}>
                    <td className="data-cell-primary">
                      <div className="stack stack-xs groups-name-cell">
                        <strong className="data-primary-text" title={group.name}>{group.name}</strong>
                        <span className="data-identifier" title={group.id}>{group.id}</span>
                      </div>
                    </td>
                    <td className="data-cell-number">{group.participantsCount ?? "—"}</td>
                    <td className="data-cell-status">
                      <GroupCapabilityStatus capability={group.sendCapability} />
                    </td>
                    <td className="data-cell-time" title={formatDate(group.syncedAt)}>
                      {formatDate(group.syncedAt)}
                    </td>
                    <td className="data-cell-action">
                      <Button
                        aria-label={`View ${group.name}`}
                        onClick={(event) => void openGroup(group, event.currentTarget)}
                        size="sm"
                        variant="ghost"
                      >
                        View
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="groups-pagination">
            <span>Page {pageNumber} of {pageCount}</span>
            <div>
              <Button disabled={!canGoBack} onClick={() => setListState((current) => ({
                ...current,
                offset: Math.max(0, current.offset - PAGE_SIZE),
              }))} size="sm">
                Previous
              </Button>
              <Button disabled={!canGoForward} onClick={() => setListState((current) => ({
                ...current,
                offset: current.offset + PAGE_SIZE,
              }))} size="sm">
                Next
              </Button>
            </div>
          </div>
        </div>

        <Drawer
          description={detail
            ? `${detail.isActive ? "Active" : "Inactive"} · ${detail.participantsCount ?? syncedMemberTotal ?? "Unknown"} participants`
            : undefined}
          eyebrow="Group inspector"
          onClose={closeDetail}
          open={Boolean(selectedGroup && selectedGroup.sessionId === selectedSessionId)}
          returnFocusRef={detailTriggerRef}
          title={detail?.name ?? selectedGroup?.name ?? "Group inspector"}
        >
            {detailLoading && <div className="groups-detail-state">Loading details…</div>}
            {detailError && (
              <InlineAlert title="Could not load group details">{detailError}</InlineAlert>
            )}
            {detail && (
              <div className="groups-inspector stack stack-lg">
                <section aria-labelledby="group-identity-title" className="groups-inspector-section groups-identity">
                  <h3 id="group-identity-title">Group identity</h3>
                  <p className="groups-description">{detail.description || "No group description."}</p>
                  <div className="groups-identity-id">
                    <div>
                      <span>Group ID</span>
                      <code>{detail.id}</code>
                    </div>
                    <Button
                      aria-label={copyState === "copied" ? "Copied group ID" : "Copy group ID"}
                      icon={copyState === "copied" ? "check" : "copy"}
                      onClick={() => void copyGroupId(detail.id)}
                      size="sm"
                      variant="ghost"
                    >
                      {copyState === "copied" ? "Copied" : "Copy"}
                    </Button>
                  </div>
                  {copyState === "failed" && (
                    <span className="groups-copy-error" role="alert">Could not copy the group ID.</span>
                  )}
                </section>

                <section aria-labelledby="group-capability-title" className="groups-capability">
                  <div className="groups-section-heading">
                    <div className="stack stack-xs">
                      <h3 id="group-capability-title">Send readiness</h3>
                      <p>{capabilityReasonCopy(detail.sendCapability.reason)}</p>
                      <code>{detail.sendCapability.reason}</code>
                    </div>
                    <GroupCapabilityStatus
                      appearance="badge"
                      capability={detail.sendCapability}
                      includeFreshness={false}
                    />
                  </div>
                  <dl className="groups-capability-meta">
                    <div><dt>Checked</dt><dd>{formatDate(detail.sendCapability.checkedAt)}</dd></div>
                    <div>
                      <dt>Freshness</dt>
                      <dd>
                        <Badge tone={detailCapabilityIsStale ? "warning" : "success"}>
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
                    {refreshingCapability ? "Refreshing capability…" : "Refresh capability"}
                  </Button>
                  {capabilityRefreshState === "failed" && capabilityError && (
                    <InlineAlert
                      className="groups-capability-feedback"
                      title="Capability refresh failed"
                    >
                      {capabilityError}
                    </InlineAlert>
                  )}
                  {capabilityNotice && capabilityRefreshState !== "failed" && (
                    <InlineAlert
                      className="groups-capability-feedback"
                      title={capabilityRefreshState === "completed"
                        ? "Capability updated"
                        : capabilityRefreshState === "timed-out"
                          ? "Refresh still processing"
                          : "Refresh requested"}
                      tone={capabilityRefreshState === "completed"
                        ? "success"
                        : capabilityRefreshState === "timed-out"
                          ? "warning"
                          : "info"}
                    >
                      {capabilityRefreshState === "timed-out" && capabilityError
                        ? `${capabilityNotice} Last check: ${capabilityError}`
                        : capabilityNotice}
                    </InlineAlert>
                  )}
                </section>

                <section aria-labelledby="group-configuration-title" className="groups-inspector-section">
                  <h3 id="group-configuration-title">Group configuration</h3>
                  <dl className="groups-facts">
                    <div><dt>Session access</dt><dd>{accessLabel(detail.isAdmin)}</dd></div>
                    <div><dt>Posting</dt><dd>{booleanLabel(detail.isAnnounce, "Admins only", "All members")}</dd></div>
                    <div><dt>Read only</dt><dd>{booleanLabel(detail.isReadOnly, "Yes", "No")}</dd></div>
                    <div><dt>Settings</dt><dd>{booleanLabel(detail.settingsLocked, "Locked", "Unlocked")}</dd></div>
                  </dl>
                </section>

                <section aria-labelledby="group-members-title" className="groups-members">
                  <div className="groups-section-heading">
                    <h3 id="group-members-title">Members</h3>
                    <span>
                      {memberQuery
                        ? `${memberTotal} matches`
                        : syncedMemberTotal !== null
                          && detail.participantsCount !== null
                          && detail.participantsCount !== syncedMemberTotal
                          ? `${syncedMemberTotal} synced of ${detail.participantsCount}`
                          : syncedMemberTotal ?? "—"}
                    </span>
                  </div>
                  {syncedMemberTotal !== null
                    && detail.participantsCount !== null
                    && detail.participantsCount !== syncedMemberTotal && (
                    <InlineAlert title="Member sync incomplete" tone="warning">
                      {syncedMemberTotal} synchronized member records are available for {detail.participantsCount} participants.
                    </InlineAlert>
                  )}
                  <TextField
                    icon="search"
                    id="member-filter"
                    label="Search synchronized members"
                    labelHidden
                    onChange={(event) => setMemberFilter(event.currentTarget.value)}
                    placeholder="Search all synced members"
                    size="sm"
                    type="search"
                    value={memberFilter}
                  />
                  {membersError && (
                    <InlineAlert
                      action={(
                        <Button
                          onClick={() => selectedSessionId && selectedGroup
                            && void loadMembers(
                              selectedSessionId,
                              selectedGroup.id,
                              memberOffset,
                              memberQuery,
                            )}
                          size="sm"
                        >
                          Retry
                        </Button>
                      )}
                      title="Could not load members"
                    >
                      {membersError}
                    </InlineAlert>
                  )}
                  {!memberPage && membersLoading ? (
                    <p className="groups-detail-state">Loading members…</p>
                  ) : !memberPage && membersError ? null : memberPage?.data.length === 0 && memberQuery ? (
                    <p className="groups-detail-state">No synchronized members match this search.</p>
                  ) : memberPage?.data.length === 0 ? (
                    <p className="groups-detail-state">No member details available.</p>
                  ) : (
                    <ul aria-busy={membersLoading || undefined}>
                      {(memberPage?.data ?? []).map((member) => (
                        <li key={member.participantId}>
                          <span className="stack stack-xs">
                            <strong>{member.displayName || member.phoneNumber}</strong>
                            <code>{member.phoneNumber}</code>
                            {member.participantId !== member.phoneNumber && (
                              <code className="groups-member-id">{member.participantId}</code>
                            )}
                          </span>
                          <Badge tone={member.isAdmin || member.isSuperAdmin ? "success" : "neutral"}>
                            {member.isSuperAdmin ? "Owner" : member.isAdmin ? "Admin" : "Member"}
                          </Badge>
                        </li>
                      ))}
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
                          onClick={() => setMemberOffset(Math.max(0, memberOffset - MEMBER_PAGE_SIZE))}
                          size="sm"
                        >
                          Previous
                        </Button>
                        <Button
                          aria-label="Next member page"
                          disabled={!canGoToNextMembers}
                          onClick={() => setMemberOffset(memberOffset + MEMBER_PAGE_SIZE)}
                          size="sm"
                        >
                          Next
                        </Button>
                      </div>
                    </div>
                  )}
                </section>

                <details className="groups-technical" key={detail.id}>
                  <summary>Sync &amp; technical metadata</summary>
                  <dl className="groups-facts">
                    <div><dt>Record synced</dt><dd>{formatDate(detail.syncedAt)}</dd></div>
                    <div><dt>Details synced</dt><dd>{formatDate(detail.detailsSyncedAt)}</dd></div>
                    <div><dt>Capability revision</dt><dd>{detail.sendCapability.revision}</dd></div>
                    {detail.sendCapability.invalidatedAt && (
                      <div><dt>Invalidated</dt><dd>{formatDate(detail.sendCapability.invalidatedAt)}</dd></div>
                    )}
                    {detail.ownerId && <div><dt>Owner ID</dt><dd>{detail.ownerId}</dd></div>}
                    {detail.linkedParentId && <div><dt>Linked parent</dt><dd>{detail.linkedParentId}</dd></div>}
                    <div><dt>Session ID</dt><dd>{detail.sessionId}</dd></div>
                  </dl>
                </details>
              </div>
            )}
        </Drawer>
      </>
    </div>
  );
}
