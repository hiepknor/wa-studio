import { useEffect, useMemo, useRef, useState } from "react";

import {
  RuntimeRequestError,
  type RuntimeApi,
  type RuntimeGroupListGroup,
  type RuntimeSavedGroupList,
} from "@/shared/api/runtime-client";
import { Button } from "@/shared/ui/Button";
import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";
import { Drawer } from "@/shared/ui/Drawer";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { TablePagination } from "@/shared/ui/TablePagination";
import { TextAreaField } from "@/shared/ui/TextAreaField";
import { TextField } from "@/shared/ui/TextField";
import { GroupSelectionTable, type GroupSelectionRow } from "./selection/GroupSelectionTable";
import { GroupSelectionToolbar } from "./selection/GroupSelectionToolbar";
import {
  groupSelectionDiff,
  MAX_GROUP_SELECTION,
  sameGroupSelection,
} from "./selection/group-selection";
import { useGroupDirectoryQuery } from "./selection/useGroupDirectoryQuery";

interface GroupListEditorProps {
  api: RuntimeApi;
  list: RuntimeSavedGroupList | null;
  onArchived: (listId: string) => void;
  onClose: () => void;
  onSaved: (list: RuntimeSavedGroupList) => void;
  sessionId: string;
}

function errorCopy(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
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
  onArchived,
  onClose,
  onSaved,
  sessionId,
}: GroupListEditorProps) {
  const [canonical, setCanonical] = useState<RuntimeSavedGroupList | null>(list);
  const [name, setName] = useState(list?.name ?? "");
  const [description, setDescription] = useState(list?.description ?? "");
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const [stagedIds, setStagedIds] = useState<string[]>([]);
  const [membershipRows, setMembershipRows] = useState<Record<string, RuntimeGroupListGroup>>({});
  const [loadingMembership, setLoadingMembership] = useState(Boolean(list));
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorTitle, setErrorTitle] = useState("Group list update");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | undefined>>({});
  const [discardOpen, setDiscardOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
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
  const savedSet = useMemo(() => new Set(savedIds), [savedIds]);
  const rows = useMemo(() => {
    const ids = [
      ...stagedIds,
      ...savedIds.filter((id) => !selectedSet.has(id)),
      ...directory.groups.map((group) => group.id)
        .filter((id) => !selectedSet.has(id) && !savedSet.has(id)),
    ];
    return ids.flatMap<GroupSelectionRow>((id) => {
      const membership = membershipRows[id];
      if (membership) return [membership];
      const group = directory.knownGroups[id];
      return group ? [runtimeGroupRow(group)] : [];
    });
  }, [directory.groups, directory.knownGroups, membershipRows, savedIds, savedSet, selectedSet, stagedIds]);
  const pageIds = useMemo(() => directory.groups.map((group) => group.id), [directory.groups]);
  const pinnedIds = useMemo(() => {
    const currentPage = new Set(pageIds);
    return new Set([...stagedIds, ...savedIds].filter((id) => !currentPage.has(id)));
  }, [pageIds, savedIds, stagedIds]);

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
      setName(membership.list.name);
      setDescription(membership.list.description ?? "");
      setSavedIds(ids);
      if (!preserveStaged) setStagedIds(ids);
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
      let savedList: RuntimeSavedGroupList;
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
          });
          if (epoch !== epochRef.current) return;
          setCanonical(savedList);
          metadataCommitted = true;
        }
        if (membershipDirty) {
          membershipAttempted = true;
          const membership = await api.replaceGroupListGroups(canonical.id, stagedIds);
          if (epoch !== epochRef.current) return;
          if (membership.list.sessionId !== sessionId) {
            throw new Error("This group list belongs to a different Runtime session.");
          }
          savedList = membership.list;
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
        setError(metadataCommitted
          ? "List details were saved, but group membership was not updated. Runtime keeps the previous saved membership; your staged group changes remain available to retry."
          : "Group membership was not updated. Runtime keeps the previous saved membership; your staged group changes remain available to retry.");
      } else {
        setErrorTitle(canonical && metadataDirty ? "List details were not saved" : "Could not save group list");
        setError(errorCopy(nextError, "Could not save group list."));
      }
      if (canonical) await loadCanonical(true, true);
    } finally {
      if (epoch === epochRef.current) setSaving(false);
    }
  }

  async function archive() {
    if (!canonical) return;
    const epoch = epochRef.current;
    setArchiveOpen(false);
    setArchiving(true);
    setError(null);
    try {
      await api.archiveGroupList(canonical.id);
      if (epoch === epochRef.current) onArchived(canonical.id);
    } catch (nextError) {
      if (epoch === epochRef.current) {
        setErrorTitle("Could not archive group list");
        setError(errorCopy(nextError, "Could not archive group list."));
      }
    } finally {
      if (epoch === epochRef.current) setArchiving(false);
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
      : `Staged ${selectionDiff.stagedCount} groups`;
  const capacity = stagedIds.length >= MAX_GROUP_SELECTION
    ? "Limit reached"
    : stagedIds.length >= 900
      ? `${MAX_GROUP_SELECTION - stagedIds.length} remaining`
      : `${stagedIds.length} / ${MAX_GROUP_SELECTION.toLocaleString()}`;

  return (
    <>
      <Drawer
        className="group-list-editor-drawer"
        contentKey={editorKey}
        description="Reusable static group IDs for the active Runtime session."
        eyebrow="Group list"
        footer={<div className="group-list-editor-footer">
          <div className="group-list-editor-footer-danger">{canonical && <Button disabled={saving || archiving} onClick={() => setArchiveOpen(true)} variant="ghost">Archive list</Button>}</div>
          <div className="group-list-editor-footer-summary"><strong>{canonical ? "Edit group list" : "New group list"}</strong><span>{status}</span></div>
          <div className="group-list-editor-footer-actions">{canonical && <Button disabled={!dirty || saving || archiving} onClick={resetChanges}>Reset changes</Button>}<Button disabled={loadingMembership || saving || archiving || Boolean(canonical && !dirty)} loading={saving} onClick={() => void save()} variant="primary">Save list</Button></div>
        </div>}
        onClose={requestClose}
        open
        size="wide"
        title={canonical?.name ?? "New list"}
      >
        <div className="group-list-editor stack stack-lg">
          {error && <InlineAlert title={errorTitle}>{error}</InlineAlert>}
          <section aria-labelledby="group-list-details-title" className="group-list-editor-details stack stack-md">
            <div className="group-list-editor-section-heading"><h3 id="group-list-details-title">List details</h3><p>Name and describe this reusable static selection.</p></div>
            <div className="group-list-editor-metadata">
              <TextField description={fieldErrors.name && <span className="group-list-field-error">{fieldErrors.name}</span>} disabled={loadingMembership} label="Name" onChange={(event) => { setName(event.target.value); setFieldErrors((current) => ({ ...current, name: undefined })); }} value={name} />
              <TextAreaField description={fieldErrors.description && <span className="group-list-field-error">{fieldErrors.description}</span>} disabled={loadingMembership} label="Description" onChange={(event) => { setDescription(event.target.value); setFieldErrors((current) => ({ ...current, description: undefined })); }} rows={3} value={description} />
            </div>
          </section>
          <section aria-labelledby="group-list-selection-title" className="group-selection-section">
            <div className="group-selection-heading"><div><h3 id="group-list-selection-title">Groups</h3><p>Membership stays fixed until this list is edited. Inactive, denied, and unknown groups remain selectable; campaign preflight evaluates eligibility.</p></div><strong className={stagedIds.length >= 900 ? "group-list-editor-capacity-warning" : undefined}>{capacity}</strong></div>
            {fieldErrors.groupIds && <InlineAlert title="Invalid membership">{fieldErrors.groupIds}</InlineAlert>}
            <GroupSelectionToolbar filterAriaLabel="Group list filters" filterTitle="Filter groups in this list" filters={directory.filters} filtersOpen={directory.filtersOpen} idPrefix="group-list-selection" inputQuery={directory.inputQuery} loading={directory.loading} onFiltersChange={directory.setFilters} onFiltersOpenChange={directory.setFiltersOpen} onParticipantErrorsClear={() => directory.setParticipantErrors({})} onSearchChange={directory.setSearch} pageItemCount={directory.groups.length} pageOffset={directory.offset} participantErrors={directory.participantErrors} searchLabel="Find groups for this list" total={directory.total} />
            {directory.error && <InlineAlert action={<Button onClick={directory.retry} size="sm">Retry</Button>} title="Could not load groups">{directory.error}</InlineAlert>}
            <GroupSelectionTable disabled={loadingMembership || saving} emptyMessage={directory.hasCriteria ? "No synchronized groups match this search or filters." : "No synchronized groups found."} loading={directory.loading || loadingMembership} onToggle={toggle} onTogglePage={togglePage} pageIds={pageIds} pinnedIds={pinnedIds} pinnedLabel={canonical ? "Saved or staged outside current results" : "Selected outside current results"} rows={rows} selectedIds={selectedSet} />
            {!directory.loading && directory.groups.length === 0 && rows.length > 0 && <p className="group-selection-page-note">Saved and staged groups remain visible above.</p>}
            <TablePagination limit={directory.pageSize} loading={directory.loading} offset={directory.offset} onOffsetChange={directory.setOffset} total={directory.total} />
          </section>
        </div>
      </Drawer>
      <ConfirmationDialog body="Unsaved list metadata or group selections will be discarded. Runtime data is not changed." cancelLabel="Keep editing" confirmLabel="Discard changes" confirmVariant="danger" onCancel={() => setDiscardOpen(false)} onConfirm={onClose} open={discardOpen} title="Discard group list changes?" />
      <ConfirmationDialog body="Archive this reusable list? Existing campaign target snapshots are not changed." cancelLabel="Keep list" confirmLabel="Archive list" confirmVariant="danger" onCancel={() => setArchiveOpen(false)} onConfirm={() => void archive()} open={archiveOpen} title="Archive group list?" />
    </>
  );
}
