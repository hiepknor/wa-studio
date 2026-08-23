import { useEffect, useMemo, useRef, useState } from "react";

import {
  RuntimeRequestError,
  type RuntimeApi,
  type RuntimeGroupListGroup,
  type RuntimeGroupList,
} from "@/shared/api/runtime-client";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";
import { DropdownMenuItem } from "@/shared/ui/DropdownMenu";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { OverflowMenu } from "@/shared/ui/OverflowMenu";
import { TextAreaField } from "@/shared/ui/TextAreaField";
import { TextField } from "@/shared/ui/TextField";
import {
  WorkspaceDrawer,
  WorkspaceFooter,
  WorkspacePanel,
  WorkspaceSectionHeader,
  WorkspaceSummaryCard,
} from "@/shared/ui/WorkspaceDrawer";
import { GroupSelectionPanel } from "./selection/GroupSelectionPanel";
import type { GroupSelectionRow } from "./selection/GroupSelectionTable";
import {
  groupSelectionDiff,
  groupSelectionRowOrder,
  MAX_GROUP_SELECTION,
  sameGroupSelection,
} from "./selection/group-selection";
import { useGroupDirectoryQuery } from "./selection/useGroupDirectoryQuery";
import { groupListErrorMessage } from "./group-list-domain";

interface GroupListEditorProps {
  api: RuntimeApi;
  list: RuntimeGroupList | null;
  onClose: () => void;
  onRequestDelete: (list: RuntimeGroupList) => void;
  onSaved: (list: RuntimeGroupList) => void;
  sessionId: string;
}

function errorCopy(error: unknown, fallback: string): string {
  return groupListErrorMessage(error, fallback);
}

function runtimeGroupRow(group: ReturnType<typeof useGroupDirectoryQuery>["groups"][number]): GroupSelectionRow {
  return {
    groupId: group.id,
    groupName: group.name,
    isActive: group.isActive,
    participantsCount: group.participantsCount,
    sendCapability: group.sendCapability,
  };
}

export function GroupListEditor({
  api,
  list,
  onClose,
  onRequestDelete,
  onSaved,
  sessionId,
}: GroupListEditorProps) {
  const [canonical, setCanonical] = useState<RuntimeGroupList | null>(list);
  const [name, setName] = useState(list?.name ?? "");
  const [description, setDescription] = useState(list?.description ?? "");
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const [stagedIds, setStagedIds] = useState<string[]>([]);
  const [membershipRows, setMembershipRows] = useState<Record<string, RuntimeGroupListGroup>>({});
  const [loadingMembership, setLoadingMembership] = useState(Boolean(list));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorTitle, setErrorTitle] = useState("Group list update");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | undefined>>({});
  const [discardOpen, setDiscardOpen] = useState(false);
  const epochRef = useRef(0);
  const createKeyRef = useRef(crypto.randomUUID());
  const editorKey = list?.id ?? createKeyRef.current;
  const directory = useGroupDirectoryQuery({
    api,
    enabled: !loadingMembership,
    scopeKey: `group-list:${editorKey}`,
    sessionId,
  });

  const metadataDirty = canonical
    ? name !== canonical.name || description !== (canonical.description ?? "")
    : Boolean(name.trim() || description.trim());
  const membershipDirty = !sameGroupSelection(savedIds, stagedIds);
  const dirty = metadataDirty || membershipDirty;
  const selectionDiff = useMemo(
    () => groupSelectionDiff(savedIds, stagedIds),
    [savedIds, stagedIds],
  );
  const selectedSet = useMemo(() => new Set(stagedIds), [stagedIds]);
  const retainedIds = useMemo(() => [
    ...stagedIds,
    ...savedIds.filter((id) => !selectedSet.has(id)),
  ], [savedIds, selectedSet, stagedIds]);
  const pageIds = useMemo(() => directory.groups.map((group) => group.id), [directory.groups]);
  const rowOrder = useMemo(
    () => groupSelectionRowOrder(retainedIds, pageIds),
    [pageIds, retainedIds],
  );
  const rows = useMemo(() => {
    return rowOrder.rowIds.flatMap<GroupSelectionRow>((id) => {
      const membership = membershipRows[id];
      if (membership) return [membership];
      const group = directory.knownGroups[id];
      return group ? [runtimeGroupRow(group)] : [];
    });
  }, [directory.knownGroups, membershipRows, rowOrder]);
  const pinnedIds = rowOrder.pinnedIds;

  async function loadCanonical(preserveStaged = false, preserveError = false) {
    if (!list) return;
    const epoch = epochRef.current;
    setLoadingMembership(true);
    if (!preserveError) setError(null);
    try {
      const membership = await api.getGroupListMembership(list.id);
      if (epoch !== epochRef.current) return;
      if (membership.list.sessionId !== sessionId) {
        setErrorTitle("Could not load group list");
        setError("This group list belongs to a different Runtime session.");
        return;
      }
      if (membership.list.archivedAt !== null) {
        setErrorTitle("Could not load group list");
        setError("This group list is archived and can no longer be edited.");
        return;
      }
      const ids = membership.data.map((group) => group.groupId);
      setCanonical(membership.list);
      setSavedIds(ids);
      if (!preserveStaged) {
        setName(membership.list.name);
        setDescription(membership.list.description ?? "");
        setStagedIds(ids);
      }
      setMembershipRows(Object.fromEntries(membership.data.map((group) => [group.groupId, group])));
    } catch (nextError) {
      if (epoch === epochRef.current) {
        setErrorTitle("Could not load group list");
        setError(errorCopy(nextError, "Could not load group list."));
      }
    } finally {
      if (epoch === epochRef.current) setLoadingMembership(false);
    }
  }

  useEffect(() => {
    const epoch = ++epochRef.current;
    if (!list) {
      setLoadingMembership(false);
      return () => { epochRef.current += 1; };
    }
    void loadCanonical();
    return () => { if (epoch === epochRef.current) epochRef.current += 1; };
    // The editor is keyed by list identity; loading must run once per intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list?.id, sessionId]);

  function toggle(groupId: string) {
    setStagedIds((current) => {
      if (current.includes(groupId)) return current.filter((id) => id !== groupId);
      if (current.length >= MAX_GROUP_SELECTION) {
        setErrorTitle("Group limit reached");
        setError("Group lists are limited to 1,000 unique groups.");
        return current;
      }
      setError(null);
      return [...current, groupId];
    });
  }

  function togglePage() {
    const allSelected = pageIds.length > 0 && pageIds.every((id) => selectedSet.has(id));
    if (allSelected) {
      const pageSet = new Set(pageIds);
      setStagedIds((current) => current.filter((id) => !pageSet.has(id)));
      return;
    }
    const next = [...stagedIds];
    pageIds.forEach((id) => { if (!next.includes(id)) next.push(id); });
    if (next.length > MAX_GROUP_SELECTION) {
      setErrorTitle("Group limit reached");
      setError("Selecting this page would exceed the 1,000-group limit.");
      return;
    }
    setStagedIds(next);
    setError(null);
  }

  async function save() {
    const normalizedName = name.trim();
    if (!normalizedName) {
      setFieldErrors({ name: "Name is required." });
      return;
    }
    const epoch = epochRef.current;
    setSaving(true);
    setError(null);
    setFieldErrors({});
    let metadataCommitted = false;
    let membershipAttempted = false;
    try {
      let savedList: RuntimeGroupList;
      if (!canonical) {
        savedList = await api.createGroupList({
          sessionId,
          name: normalizedName,
          description: description.trim() || null,
          groupIds: stagedIds,
        }, createKeyRef.current);
      } else {
        savedList = canonical;
        if (metadataDirty) {
          savedList = await api.updateGroupList(canonical.id, {
            name: normalizedName,
            description: description.trim() || null,
            expectedRevision: canonical.revision,
          });
          if (epoch !== epochRef.current) return;
          setCanonical(savedList);
          metadataCommitted = true;
        }
        if (membershipDirty) {
          membershipAttempted = true;
          const membership = await api.replaceGroupListGroups(
            canonical.id,
            stagedIds,
            savedList.membershipRevision,
          );
          if (epoch !== epochRef.current) return;
          if (membership.list.sessionId !== sessionId) {
            throw new Error("This group list belongs to a different Runtime session.");
          }
          savedList = membership.list;
          setCanonical(membership.list);
          setMembershipRows(Object.fromEntries(membership.data.map((group) => [group.groupId, group])));
          setSavedIds(membership.data.map((group) => group.groupId));
          setStagedIds(membership.data.map((group) => group.groupId));
        }
      }
      if (epoch !== epochRef.current || savedList.sessionId !== sessionId) return;
      if (!canonical) {
        const membership = await api.getGroupListMembership(savedList.id);
        if (epoch !== epochRef.current) return;
        if (membership.list.sessionId !== sessionId) {
          throw new Error("This group list belongs to a different Runtime session.");
        }
        savedList = membership.list;
      }
      onSaved(savedList);
    } catch (nextError) {
      if (epoch !== epochRef.current) return;
      if (nextError instanceof RuntimeRequestError) {
        setFieldErrors({
          name: nextError.fieldErrors.name?.[0],
          description: nextError.fieldErrors.description?.[0],
          groupIds: nextError.fieldErrors.groupIds?.[0],
        });
      }
      if (membershipAttempted) {
        setErrorTitle("Group selection was not saved");
        if (
          nextError instanceof RuntimeRequestError
          && nextError.code === "GROUP_LIST_REVISION_CONFLICT"
        ) {
          setError(metadataCommitted
            ? "List details were saved, but membership changed concurrently. Runtime's canonical membership was reloaded; your staged group changes remain available for review."
            : "Membership changed concurrently in Runtime. The canonical membership was reloaded; your staged group changes remain available for review.");
        } else {
          setError(metadataCommitted
            ? "List details were saved, but group membership was not updated. Runtime keeps the previous saved membership; your staged group changes remain available to retry."
            : "Group membership was not updated. Runtime keeps the previous saved membership; your staged group changes remain available to retry.");
        }
      } else {
        setErrorTitle(canonical && metadataDirty ? "List details were not saved" : "Could not save group list");
        setError(errorCopy(nextError, "Could not save group list."));
      }
      if (canonical) await loadCanonical(true, true);
    } finally {
      if (epoch === epochRef.current) setSaving(false);
    }
  }

  function requestClose() {
    if (dirty) setDiscardOpen(true);
    else onClose();
  }

  function resetChanges() {
    if (!canonical) return;
    setName(canonical.name);
    setDescription(canonical.description ?? "");
    setStagedIds(savedIds);
    setFieldErrors({});
    setError(null);
  }

  const status = loadingMembership
    ? "Loading complete membership…"
    : canonical
      ? `Saved ${selectionDiff.savedCount} · Staged ${selectionDiff.stagedCount} · +${selectionDiff.addedIds.length} / −${selectionDiff.removedIds.length}${metadataDirty ? " · Details changed" : ""}`
      : name.trim()
        ? `Staged ${selectionDiff.stagedCount} groups`
        : "Add a name to save this list";
  const saveDisabled = loadingMembership
    || saving
    || !name.trim()
    || Boolean(canonical && !dirty);
  const capacity = stagedIds.length >= MAX_GROUP_SELECTION
    ? "Limit reached"
    : stagedIds.length >= 900
      ? `${MAX_GROUP_SELECTION - stagedIds.length} remaining`
      : `${stagedIds.length} / ${MAX_GROUP_SELECTION.toLocaleString()}`;

  return (
    <>
      <WorkspaceDrawer
        contentKey={editorKey}
        description="Reusable static group IDs for the active Runtime session."
        eyebrow="Group list"
        footer={<WorkspaceFooter
          actions={<>{canonical && <Button disabled={!dirty || saving} onClick={resetChanges}>Reset changes</Button>}<Button disabled={saveDisabled} loading={saving} onClick={() => void save()} variant="primary">Save list</Button></>}
          description={status}
          leading={canonical ? (
            <OverflowMenu
              ariaLabel={`Actions for ${canonical.name}`}
              triggerLabel={`More actions for ${canonical.name}`}
            >
              <DropdownMenuItem
                danger
                description="Remove this list from saved lists. Existing campaign targets stay unchanged."
                icon="trash"
                onSelect={() => onRequestDelete(canonical)}
              >
                Delete list
              </DropdownMenuItem>
            </OverflowMenu>
          ) : undefined}
          title={canonical ? "Edit group list" : "New group list"}
        />}
        onClose={requestClose}
        open
        size="wide"
        title={canonical?.name ?? "New list"}
      >
        <div className="group-list-editor stack stack-lg">
          <WorkspaceSectionHeader description="Define reusable metadata, then stage the complete static group membership." kicker="Reusable selection" title="List configuration & membership" />
          {error && <InlineAlert title={errorTitle}>{error}</InlineAlert>}
          <WorkspaceSummaryCard
            description={canonical ? "Metadata and membership persisted by Runtime." : "Complete the required details and choose groups before saving."}
            dirty={Boolean(canonical && dirty)}
            icon="groups"
            label="List snapshot"
            metrics={[
              { label: "Saved", value: selectionDiff.savedCount },
              { label: "Staged", value: selectionDiff.stagedCount },
              { label: "Membership", value: canonical ? `r${canonical.membershipRevision}` : "—" },
            ]}
            status={!canonical ? <Badge>New draft</Badge> : dirty ? <Badge tone="warning">Unsaved changes</Badge> : <Badge tone="success">Saved</Badge>}
            title={canonical ? "Persisted group list" : "New group list draft"}
            titleId="group-list-summary-title"
          />
          <WorkspacePanel description="Name and describe this reusable static selection." title="List details" titleId="group-list-details-title">
            <div className="group-list-editor-metadata">
              <TextField disabled={loadingMembership} error={fieldErrors.name} label="Name" onChange={(event) => { setName(event.target.value); setFieldErrors((current) => ({ ...current, name: undefined })); }} value={name} />
              <TextAreaField disabled={loadingMembership} error={fieldErrors.description} label="Description" onChange={(event) => { setDescription(event.target.value); setFieldErrors((current) => ({ ...current, description: undefined })); }} rows={3} value={description} />
            </div>
          </WorkspacePanel>
          <GroupSelectionPanel
            afterToolbar={directory.error && <InlineAlert action={<Button onClick={directory.retry} size="sm">Retry</Button>} title="Could not load groups">{directory.error}</InlineAlert>}
            beforeToolbar={fieldErrors.groupIds && <InlineAlert title="Invalid membership">{fieldErrors.groupIds}</InlineAlert>}
            description="Membership stays fixed until this list is edited. Inactive, denied, and unknown groups remain selectable; campaign preflight evaluates eligibility."
            pageNote={!directory.loading && directory.groups.length === 0 && rows.length > 0 ? "Saved and staged groups remain visible above." : undefined}
            pagination={{ limit: directory.pageSize, loading: directory.loading, offset: directory.offset, onOffsetChange: directory.setOffset, total: directory.total }}
            summary={(
              <Badge
                tone={stagedIds.length >= MAX_GROUP_SELECTION
                  ? "danger"
                  : stagedIds.length >= 900
                    ? "warning"
                    : "neutral"}
              >
                {capacity}
              </Badge>
            )}
            table={{ disabled: loadingMembership || saving, emptyMessage: directory.hasCriteria ? "No synchronized groups match this search or filters." : "No synchronized groups found.", loading: directory.loading || loadingMembership, onToggle: toggle, onTogglePage: togglePage, pageIds, pinnedIds, pinnedLabel: canonical ? "Saved or staged outside current results" : "Selected outside current results", rows, selectedIds: selectedSet }}
            title="Groups"
            titleId="group-list-selection-title"
            toolbar={{ filterAriaLabel: "Group list filters", filterTitle: "Filter groups in this list", filters: directory.filters, filtersOpen: directory.filtersOpen, idPrefix: "group-list-selection", inputQuery: directory.inputQuery, loading: directory.loading, onFiltersChange: directory.setFilters, onFiltersOpenChange: directory.setFiltersOpen, onParticipantErrorsClear: () => directory.setParticipantErrors({}), onSearchChange: directory.setSearch, pageItemCount: directory.groups.length, pageOffset: directory.offset, participantErrors: directory.participantErrors, searchLabel: "Find groups for this list", total: directory.total }}
          />
        </div>
      </WorkspaceDrawer>
      <ConfirmationDialog body="Unsaved list metadata or group selections will be discarded. Runtime data is not changed." cancelLabel="Keep editing" confirmLabel="Discard changes" confirmVariant="danger" onCancel={() => setDiscardOpen(false)} onConfirm={onClose} open={discardOpen} title="Discard group list changes?" />
    </>
  );
}
