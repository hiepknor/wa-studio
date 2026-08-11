import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRuntimeConnection } from "@/app/RuntimeConnectionContext";
import type {
  RuntimeGroup,
  RuntimeGroupDetail,
  RuntimeGroupPage,
} from "@/shared/api/runtime-client";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Drawer } from "@/shared/ui/Drawer";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { PageHeader } from "@/shared/ui/PageHeader";
import type { StatusTone } from "@/shared/ui/StatusIndicator";
import { StatusIndicator } from "@/shared/ui/StatusIndicator";
import { TextField } from "@/shared/ui/TextField";
import "./groups.css";

const PAGE_SIZE = 20;

function capabilityTone(status: RuntimeGroup["sendCapability"]["status"]): StatusTone {
  if (status === "ALLOWED") return "success";
  if (status === "DENIED") return "danger";
  return "warning";
}

function capabilityLabel(status: RuntimeGroup["sendCapability"]["status"]): string {
  if (status === "ALLOWED") return "Allowed";
  if (status === "DENIED") return "Denied";
  return "Unknown";
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
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<RuntimeGroup | null>(null);
  const [detail, setDetail] = useState<RuntimeGroupDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [refreshingCapability, setRefreshingCapability] = useState(false);
  const [capabilityNotice, setCapabilityNotice] = useState<string | null>(null);
  const listRevision = useRef(0);
  const detailRevision = useRef(0);
  const capabilityRevision = useRef(0);
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null);

  const loadGroups = useCallback(async (nextOffset: number) => {
    if (!selectedSessionId) return;
    const revision = ++listRevision.current;
    setLoading(true);
    setListError(null);
    try {
      const nextPage = await runtimeApi.listGroups({
        sessionId: selectedSessionId,
        limit: PAGE_SIZE,
        offset: nextOffset,
      });
      if (revision !== listRevision.current) return;
      setPage(nextPage);
      setOffset(nextOffset);
    } catch (error) {
      if (revision === listRevision.current) {
        setListError(errorMessage(error, "Could not load groups."));
      }
    } finally {
      if (revision === listRevision.current) setLoading(false);
    }
  }, [runtimeApi, selectedSessionId]);

  useEffect(() => {
    listRevision.current += 1;
    detailRevision.current += 1;
    capabilityRevision.current += 1;
    setPage(null);
    setOffset(0);
    setFilter("");
    setLoading(false);
    setSelectedGroup(null);
    setDetail(null);
    setDetailLoading(false);
    setDetailError(null);
    setRefreshingCapability(false);
    setCapabilityNotice(null);
    void loadGroups(0);
  }, [loadGroups]);

  const filteredGroups = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    if (!query) return page?.data ?? [];
    return (page?.data ?? []).filter((group) =>
      [group.name, group.id, group.description]
        .filter(Boolean)
        .some((value) => value?.toLocaleLowerCase().includes(query)),
    );
  }, [filter, page]);

  async function openGroup(group: RuntimeGroup, trigger: HTMLButtonElement) {
    if (!selectedSessionId) return;
    const revision = ++detailRevision.current;
    capabilityRevision.current += 1;
    detailTriggerRef.current = trigger;
    setSelectedGroup(group);
    setDetail(null);
    setDetailLoading(true);
    setDetailError(null);
    setRefreshingCapability(false);
    setCapabilityNotice(null);
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
    capabilityRevision.current += 1;
    setSelectedGroup(null);
    setDetail(null);
    setDetailLoading(false);
    setDetailError(null);
    setRefreshingCapability(false);
    setCapabilityNotice(null);
  }

  async function refreshCapability() {
    if (!selectedSessionId || !selectedGroup || refreshingCapability) return;
    const revision = ++capabilityRevision.current;
    setRefreshingCapability(true);
    setDetailError(null);
    setCapabilityNotice(null);
    try {
      await runtimeApi.requestGroupCapabilityRefresh(selectedSessionId, selectedGroup.id);
      if (revision === capabilityRevision.current) {
        setCapabilityNotice("Refresh queued. Reopen the group shortly to read the latest result.");
      }
    } catch (error) {
      if (revision === capabilityRevision.current) {
        setDetailError(errorMessage(error, "Could not refresh send capability."));
      }
    } finally {
      if (revision === capabilityRevision.current) setRefreshingCapability(false);
    }
  }

  const total = page?.meta.total ?? 0;
  const firstItem = total === 0 ? 0 : offset + 1;
  const lastItem = Math.min(offset + (page?.data.length ?? 0), total);
  const canGoBack = offset > 0 && !loading;
  const canGoForward = offset + (page?.meta.limit ?? PAGE_SIZE) < total && !loading;

  return (
    <div className="groups-screen stack stack-lg">
      <PageHeader
        actions={(
          <Button
            aria-label={loading ? "Refreshing groups" : "Refresh groups"}
            disabled={!selectedSessionId}
            icon="refresh"
            loading={loading}
            onClick={() => void loadGroups(offset)}
          >
            Refresh
          </Button>
        )}
        description={`Read-model groups for ${selectedSession?.name ?? "the active session"}.`}
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
          <div className="data-table-toolbar groups-toolbar">
            <TextField
              containerClassName="groups-filter"
              icon="search"
              id="group-filter"
              label="Filter groups on this page"
              labelHidden
              onChange={(event) => setFilter(event.currentTarget.value)}
              placeholder="Filter this page"
              size="sm"
              type="search"
              value={filter}
            />
            <span className="groups-range" aria-live="polite">
              {firstItem}–{lastItem} of {total}
            </span>
          </div>

          {listError && (
            <InlineAlert
              action={<Button onClick={() => void loadGroups(offset)} size="sm">Retry</Button>}
              className="data-table-error"
              title="Could not load groups"
            >
              {listError}
            </InlineAlert>
          )}

          <div className="data-table-scroll groups-table-scroll">
            <table>
              <caption>Groups in the active Gateway session</caption>
              <thead>
                <tr>
                  <th scope="col">Group</th>
                  <th scope="col">Members</th>
                  <th scope="col">Send capability</th>
                  <th scope="col">Synced</th>
                  <th aria-label="Actions" scope="col" />
                </tr>
              </thead>
              <tbody>
                {!page && loading ? (
                  <tr><td className="data-table-empty" colSpan={5}>Loading groups…</td></tr>
                ) : !page && listError ? (
                  <tr><td className="data-table-empty" colSpan={5}>Groups are unavailable.</td></tr>
                ) : filteredGroups.length === 0 ? (
                  <tr>
                    <td className="data-table-empty" colSpan={5}>
                      {filter ? "No groups match this page filter." : "No groups were returned for this session."}
                    </td>
                  </tr>
                ) : filteredGroups.map((group) => (
                  <tr data-selected={group.id === selectedGroup?.id || undefined} key={group.id}>
                    <td>
                      <div className="stack stack-xs groups-name-cell">
                        <strong title={group.name}>{group.name}</strong>
                        <span className="muted-copy">{group.id}</span>
                      </div>
                    </td>
                    <td>{group.participantsCount ?? "—"}</td>
                    <td>
                      <StatusIndicator glow tone={capabilityTone(group.sendCapability.status)}>
                        {capabilityLabel(group.sendCapability.status)}
                      </StatusIndicator>
                    </td>
                    <td>{formatDate(group.syncedAt)}</td>
                    <td className="align-end">
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
            <span>Page {total === 0 ? 0 : Math.floor(offset / PAGE_SIZE) + 1}</span>
            <div>
              <Button disabled={!canGoBack} onClick={() => void loadGroups(Math.max(0, offset - PAGE_SIZE))} size="sm">
                Previous
              </Button>
              <Button disabled={!canGoForward} onClick={() => void loadGroups(offset + PAGE_SIZE)} size="sm">
                Next
              </Button>
            </div>
          </div>
        </div>

        <Drawer
          description={detail ? `${detail.participantsCount ?? detail.members.length} members` : undefined}
          eyebrow="Group inspector"
          onClose={closeDetail}
          open={Boolean(selectedGroup)}
          returnFocusRef={detailTriggerRef}
          title={detail?.name ?? selectedGroup?.name ?? "Group inspector"}
        >
            {detailLoading && <div className="groups-detail-state">Loading details…</div>}
            {detailError && (
              <InlineAlert title="Group action failed">{detailError}</InlineAlert>
            )}
            {capabilityNotice && (
              <InlineAlert title="Capability refresh" tone="success">{capabilityNotice}</InlineAlert>
            )}

            {detail && (
              <div className="stack stack-md">
                <p className="groups-description">{detail.description || "No group description."}</p>

                <dl className="groups-facts">
                  <div><dt>Status</dt><dd><Badge tone={detail.isActive ? "success" : "neutral"}>{detail.isActive ? "Active" : "Inactive"}</Badge></dd></div>
                  <div><dt>Access</dt><dd>{detail.isAdmin ? "Administrator" : "Member"}</dd></div>
                  <div><dt>Members</dt><dd>{detail.participantsCount ?? detail.members.length}</dd></div>
                  <div><dt>Details synced</dt><dd>{formatDate(detail.detailsSyncedAt)}</dd></div>
                </dl>

                <section aria-labelledby="group-capability-title" className="groups-capability">
                  <div className="groups-section-heading">
                    <div className="stack stack-xs">
                      <strong id="group-capability-title">Send capability</strong>
                      <span>{detail.sendCapability.reason}</span>
                    </div>
                    <Badge tone={capabilityTone(detail.sendCapability.status)}>
                      {capabilityLabel(detail.sendCapability.status)}
                    </Badge>
                  </div>
                  <Button
                    icon="refresh"
                    loading={refreshingCapability}
                    onClick={() => void refreshCapability()}
                    size="sm"
                  >
                    Refresh capability
                  </Button>
                </section>

                <section aria-labelledby="group-members-title" className="groups-members">
                  <div className="groups-section-heading">
                    <strong id="group-members-title">Members</strong>
                    <span>{detail.members.length}</span>
                  </div>
                  {detail.members.length === 0 ? (
                    <p className="groups-detail-state">No member details available.</p>
                  ) : (
                    <ul>
                      {detail.members.map((member) => (
                        <li key={member.participantId}>
                          <span className="stack stack-xs">
                            <strong>{member.displayName || member.phoneNumber}</strong>
                            <code>{member.phoneNumber}</code>
                          </span>
                          {(member.isAdmin || member.isSuperAdmin) && (
                            <Badge tone="success">{member.isSuperAdmin ? "Owner" : "Admin"}</Badge>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
            )}
        </Drawer>
      </>
    </div>
  );
}
