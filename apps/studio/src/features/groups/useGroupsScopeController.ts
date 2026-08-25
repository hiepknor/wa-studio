import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  RuntimeRequestError,
  type RuntimeApi,
  type RuntimeGroupList,
  type RuntimeGroupListGroup,
  type RuntimeGroupListMembership,
} from "@/shared/api/runtime-client";
import type { GroupsTableRow } from "./GroupsTable";
import {
  createGroupListDraft,
  editGroupListDraft,
  groupListDraftDiff,
  isGroupsScopeDirty,
  toggleGroupListDraftMember,
  toggleGroupListDraftPage,
  updateGroupListDraftMetadata,
  type GroupListDraft,
  type GroupsScope,
} from "./groups-workspace-state";
import { MAX_GROUP_SELECTION } from "./selection/group-selection";
import { groupListErrorMessage } from "./group-list-domain";

const CATALOG_PAGE_SIZE = 50;

type ScopeTransition =
  | { kind: "directory" }
  | { kind: "list"; list: RuntimeGroupList }
  | { kind: "metadata"; seedIds: string[] };

interface ScopeError {
  body: string;
  title: string;
}

interface UseGroupsScopeControllerInput {
  api: RuntimeApi;
  sessionId: string | null;
}

function membershipRow(row: GroupsTableRow): RuntimeGroupListGroup {
  return {
    groupId: row.id,
    groupName: row.name,
    isActive: row.isActive,
    participantsCount: row.participantsCount,
    sendCapability: row.sendCapability,
    syncedAt: row.syncedAt,
  };
}

function mergeCatalog(
  current: readonly RuntimeGroupList[],
  incoming: readonly RuntimeGroupList[],
): RuntimeGroupList[] {
  const lists = new Map(current.map((list) => [list.id, list]));
  incoming.forEach((list) => lists.set(list.id, list));
  return [...lists.values()];
}

function runtimeErrorMessage(error: unknown, fallback: string): string {
  return groupListErrorMessage(error, fallback);
}

export function useGroupsScopeController({
  api,
  sessionId,
}: UseGroupsScopeControllerInput) {
  const [scope, setScope] = useState<GroupsScope>({ mode: "directory" });
  const [directoryIds, setDirectoryIds] = useState<string[]>([]);
  const [knownRows, setKnownRows] = useState<Record<string, RuntimeGroupListGroup>>({});
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [metadataSeedIds, setMetadataSeedIds] = useState<string[]>([]);
  const [pendingTransition, setPendingTransition] = useState<ScopeTransition | null>(null);
  const [membership, setMembership] = useState<RuntimeGroupListMembership | null>(null);
  const [membershipLoading, setMembershipLoading] = useState(false);
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const [membershipRevision, setMembershipRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ScopeError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | undefined>>({});
  const [catalogInputQuery, setCatalogInputQuery] = useState("");
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogOffset, setCatalogOffset] = useState(0);
  const [catalogLists, setCatalogLists] = useState<RuntimeGroupList[]>([]);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const membershipRequestRef = useRef(0);
  const catalogRequestRef = useRef(0);
  const sessionRef = useRef(sessionId);

  const selectedList = scope.mode === "list:view"
    ? scope.list
    : scope.mode === "list:edit"
      ? scope.draft.canonical
      : null;
  const directorySelectedIds = useMemo(() => new Set(directoryIds), [directoryIds]);
  const dirty = isGroupsScopeDirty(scope);

  useEffect(() => {
    if (sessionRef.current === sessionId) return;
    sessionRef.current = sessionId;
    membershipRequestRef.current += 1;
    catalogRequestRef.current += 1;
    setScope({ mode: "directory" });
    setDirectoryIds([]);
    setKnownRows({});
    setSelectionError(null);
    setMetadataOpen(false);
    setMetadataSeedIds([]);
    setPendingTransition(null);
    setMembership(null);
    setMembershipLoading(false);
    setMembershipError(null);
    setMembershipRevision(0);
    setSaving(false);
    setSaveError(null);
    setFieldErrors({});
    setCatalogInputQuery("");
    setCatalogQuery("");
    setCatalogOffset(0);
    setCatalogLists([]);
    setCatalogTotal(0);
    setCatalogLoading(false);
    setCatalogError(null);
  }, [sessionId]);

  useEffect(() => {
    const normalized = catalogInputQuery.trim();
    const timeout = window.setTimeout(() => {
      setCatalogQuery((current) => {
        if (current === normalized) return current;
        setCatalogOffset(0);
        return normalized;
      });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [catalogInputQuery]);

  useEffect(() => {
    if (!sessionId) {
      setCatalogLists([]);
      setCatalogTotal(0);
      return;
    }
    if (typeof api.listGroupLists !== "function") {
      setCatalogLists([]);
      setCatalogTotal(0);
      setCatalogLoading(false);
      setCatalogError(null);
      return;
    }
    const request = ++catalogRequestRef.current;
    setCatalogLoading(true);
    setCatalogError(null);
    void api.listGroupLists({
      sessionId,
      limit: CATALOG_PAGE_SIZE,
      offset: catalogOffset,
      ...(catalogQuery ? { query: catalogQuery } : {}),
    }).then((page) => {
      if (request !== catalogRequestRef.current || sessionRef.current !== sessionId) return;
      if (page.data.some((list) => list.sessionId !== sessionId)) {
        throw new Error("Runtime returned group lists outside the active session.");
      }
      setCatalogLists((current) => catalogOffset === 0
        ? [...page.data]
        : mergeCatalog(current, page.data));
      setCatalogTotal(page.meta.total);
    }).catch((error: unknown) => {
      if (request !== catalogRequestRef.current) return;
      setCatalogError(runtimeErrorMessage(error, "Could not load saved lists."));
    }).finally(() => {
      if (request === catalogRequestRef.current) setCatalogLoading(false);
    });
  }, [api, catalogOffset, catalogQuery, catalogRevision, sessionId]);

  useEffect(() => {
    if (scope.mode !== "list:view") return;
    const list = scope.list;
    const request = ++membershipRequestRef.current;
    setMembership(null);
    setMembershipLoading(true);
    setMembershipError(null);
    void api.getGroupListMembership(list.id).then((next) => {
      if (request !== membershipRequestRef.current || sessionRef.current !== sessionId) return;
      if (next.list.sessionId !== sessionId || next.list.archivedAt !== null) {
        throw new Error("This saved list is not available in the active session.");
      }
      setMembership(next);
      setKnownRows((current) => ({
        ...current,
        ...Object.fromEntries(next.data.map((row) => [row.groupId, row])),
      }));
      setScope((current) => current.mode === "list:view" && current.list.id === list.id
        ? { list: next.list, mode: "list:view" }
        : current);
    }).catch((error: unknown) => {
      if (request === membershipRequestRef.current) {
        setMembershipError(runtimeErrorMessage(error, "Could not load saved list membership."));
      }
    }).finally(() => {
      if (request === membershipRequestRef.current) setMembershipLoading(false);
    });
  }, [api, membershipRevision, scope.mode === "list:view" ? scope.list.id : null, sessionId]);

  useEffect(() => () => {
    membershipRequestRef.current += 1;
    catalogRequestRef.current += 1;
  }, []);

  const applyTransition = useCallback((transition: ScopeTransition) => {
    setSelectionError(null);
    setSaveError(null);
    setFieldErrors({});
    if (transition.kind === "directory") {
      membershipRequestRef.current += 1;
      setMembership(null);
      setMembershipError(null);
      setScope({ mode: "directory" });
      return;
    }
    if (transition.kind === "list") {
      setScope({ list: transition.list, mode: "list:view" });
      return;
    }
    setMetadataSeedIds([...transition.seedIds]);
    setMetadataOpen(true);
  }, []);

  const requestTransition = useCallback((transition: ScopeTransition) => {
    if (isGroupsScopeDirty(scope)) {
      setPendingTransition(transition);
      return;
    }
    applyTransition(transition);
  }, [applyTransition, scope]);

  const rememberRows = useCallback((rows: readonly GroupsTableRow[]) => {
    if (!rows.length) return;
    const incoming = Object.fromEntries(rows.map((row) => [row.id, membershipRow(row)]));
    setKnownRows((current) => ({ ...current, ...incoming }));
    setScope((current) => {
      if (current.mode !== "list:create" && current.mode !== "list:edit") return current;
      const retained = new Set([...current.draft.memberIds, ...current.draft.baselineIds]);
      const additions = Object.fromEntries(
        Object.entries(incoming).filter(([id]) => retained.has(id)),
      );
      if (!Object.keys(additions).length) return current;
      return {
        ...current,
        draft: {
          ...current.draft,
          membershipRows: { ...current.draft.membershipRows, ...additions },
        },
      };
    });
  }, []);

  function toggleDirectory(groupId: string) {
    setDirectoryIds((current) => {
      if (current.includes(groupId)) return current.filter((id) => id !== groupId);
      if (current.length >= MAX_GROUP_SELECTION) {
        setSelectionError("Group lists are limited to 1,000 unique groups.");
        return current;
      }
      setSelectionError(null);
      return [...current, groupId];
    });
  }

  function toggleDirectoryPage(pageIds: readonly string[]) {
    setDirectoryIds((current) => {
      const page = [...new Set(pageIds)];
      const selected = new Set(current);
      if (page.length > 0 && page.every((id) => selected.has(id))) {
        const pageSet = new Set(page);
        return current.filter((id) => !pageSet.has(id));
      }
      const next = [...current, ...page.filter((id) => !selected.has(id))];
      if (next.length > MAX_GROUP_SELECTION) {
        setSelectionError("Selecting this page would exceed the 1,000-group limit.");
        return current;
      }
      setSelectionError(null);
      return next;
    });
  }

  function continueMetadata(metadata: { description: string; name: string }) {
    if (!sessionId) return;
    const draft = createGroupListDraft({
      ...metadata,
      idempotencyKey: crypto.randomUUID(),
      memberIds: metadataSeedIds,
      sessionId,
    });
    draft.membershipRows = Object.fromEntries(
      metadataSeedIds.flatMap((id) => knownRows[id] ? [[id, knownRows[id]]] : []),
    );
    setMetadataOpen(false);
    setScope({ draft, mode: "list:create" });
  }

  function startEdit() {
    if (!membership || !selectedList) return;
    setScope({
      draft: editGroupListDraft(membership, crypto.randomUUID()),
      mode: "list:edit",
    });
    setSaveError(null);
    setFieldErrors({});
  }

  function updateDraftMetadata(metadata: { description: string; name: string }) {
    setScope((current) => current.mode === "list:create" || current.mode === "list:edit"
      ? { ...current, draft: updateGroupListDraftMetadata(current.draft, metadata) }
      : current);
    setFieldErrors((current) => ({ ...current, name: undefined, description: undefined }));
  }

  function applyDraftSelection(
    update: (draft: GroupListDraft) => { draft: GroupListDraft; ok: boolean },
  ) {
    setScope((current) => {
      if (current.mode !== "list:create" && current.mode !== "list:edit") return current;
      const result = update(current.draft);
      if (!result.ok) {
        setSelectionError("Group lists are limited to 1,000 unique groups.");
        return current;
      }
      const membershipRows = { ...result.draft.membershipRows };
      result.draft.memberIds.forEach((id) => {
        if (knownRows[id]) membershipRows[id] = knownRows[id];
      });
      setSelectionError(null);
      return { ...current, draft: { ...result.draft, membershipRows } };
    });
  }

  function toggleDraft(groupId: string) {
    applyDraftSelection((draft) => toggleGroupListDraftMember(draft, groupId));
  }

  function toggleDraftPage(pageIds: readonly string[]) {
    applyDraftSelection((draft) => toggleGroupListDraftPage(draft, pageIds));
  }

  async function reloadCanonicalPreservingDraft(draft: GroupListDraft) {
    if (!draft.canonical) return;
    try {
      const latest = await api.getGroupListMembership(draft.canonical.id);
      if (latest.list.sessionId !== sessionId) return;
      const canonicalDraft = editGroupListDraft(latest, draft.createIdempotencyKey);
      setKnownRows((current) => ({
        ...current,
        ...Object.fromEntries(latest.data.map((row) => [row.groupId, row])),
      }));
      setScope((current) => current.mode === "list:edit" && current.draft.canonical?.id === draft.canonical?.id
        ? {
          mode: "list:edit",
          draft: {
            ...canonicalDraft,
            description: draft.description,
            memberIds: draft.memberIds,
            membershipRows: { ...canonicalDraft.membershipRows, ...draft.membershipRows },
            name: draft.name,
          },
        }
        : current);
    } catch {
      // The actionable mutation error remains primary; retry can reload again.
    }
  }

  async function saveDraft(): Promise<RuntimeGroupList | null> {
    if ((scope.mode !== "list:create" && scope.mode !== "list:edit") || saving) return null;
    const draft = scope.draft;
    const name = draft.name.trim();
    if (!name) {
      setFieldErrors({ name: "Name is required." });
      return null;
    }
    const diff = groupListDraftDiff(draft);
    setSaving(true);
    setSaveError(null);
    setFieldErrors({});
    let metadataCommitted = false;
    let membershipAttempted = false;
    try {
      let savedList: RuntimeGroupList;
      let savedMembership: RuntimeGroupListMembership;
      if (!draft.canonical) {
        savedList = await api.createGroupList({
          sessionId: draft.sessionId,
          name,
          description: draft.description.trim() || null,
          groupIds: draft.memberIds,
        }, draft.createIdempotencyKey);
        savedMembership = await api.getGroupListMembership(savedList.id);
      } else {
        savedList = draft.canonical;
        if (diff.metadataDirty) {
          savedList = await api.updateGroupList(savedList.id, {
            name,
            description: draft.description.trim() || null,
            expectedRevision: savedList.revision,
          });
          metadataCommitted = true;
        }
        if (diff.membershipDirty) {
          membershipAttempted = true;
          savedMembership = await api.replaceGroupListGroups(
            savedList.id,
            draft.memberIds,
            savedList.membershipRevision,
          );
          savedList = savedMembership.list;
        } else {
          savedMembership = await api.getGroupListMembership(savedList.id);
          savedList = savedMembership.list;
        }
      }
      if (savedList.sessionId !== sessionId || savedMembership.list.sessionId !== sessionId) {
        throw new Error("This saved list belongs to a different Runtime session.");
      }
      setMembership(savedMembership);
      setKnownRows((current) => ({
        ...current,
        ...Object.fromEntries(savedMembership.data.map((row) => [row.groupId, row])),
      }));
      setScope({ list: savedMembership.list, mode: "list:view" });
      setCatalogLists((current) => mergeCatalog(current, [savedMembership.list]));
      setCatalogRevision((revision) => revision + 1);
      return savedMembership.list;
    } catch (error) {
      if (error instanceof RuntimeRequestError) {
        setFieldErrors({
          description: error.fieldErrors.description?.[0],
          groupIds: error.fieldErrors.groupIds?.[0],
          name: error.fieldErrors.name?.[0],
        });
      }
      if (membershipAttempted) {
        const conflict = error instanceof RuntimeRequestError
          && error.code === "GROUP_LIST_REVISION_CONFLICT";
        setSaveError({
          title: "Group selection was not saved",
          body: conflict
            ? `${metadataCommitted ? "List details were saved, but membership" : "Membership"} changed concurrently. Runtime's canonical membership was reloaded; your staged changes remain available for review.`
            : `${metadataCommitted ? "List details were saved, but group membership" : "Group membership"} was not updated. Runtime keeps the previous saved membership; your staged changes remain available to retry.`,
        });
      } else {
        setSaveError({
          title: draft.canonical && diff.metadataDirty
            ? "List details were not saved"
            : "Could not save group list",
          body: runtimeErrorMessage(error, "Could not save group list."),
        });
      }
      if (draft.canonical) await reloadCanonicalPreservingDraft(draft);
      return null;
    } finally {
      setSaving(false);
    }
  }

  function savedListUpdated(list: RuntimeGroupList) {
    setCatalogLists((current) => mergeCatalog(current, [list]));
    setCatalogRevision((revision) => revision + 1);
  }

  function savedListDeleted(listId: string) {
    setCatalogLists((current) => current.filter((list) => list.id !== listId));
    setCatalogTotal((current) => Math.max(0, current - 1));
    if (selectedList?.id === listId) applyTransition({ kind: "directory" });
    setCatalogRevision((revision) => revision + 1);
  }

  return {
    cancelDiscard: () => setPendingTransition(null),
    catalogError,
    catalogHasMore: catalogLists.length < catalogTotal,
    catalogInputQuery,
    catalogLists,
    catalogLoading,
    confirmDiscard: () => {
      if (pendingTransition) applyTransition(pendingTransition);
      setPendingTransition(null);
    },
    continueMetadata,
    directoryIds,
    directorySelectedIds,
    dirty,
    discardConfirmationOpen: Boolean(pendingTransition),
    fieldErrors,
    membership,
    membershipError,
    membershipLoading,
    metadataOpen,
    metadataSeedCount: metadataSeedIds.length,
    rememberRows,
    requestDirectory: () => requestTransition({ kind: "directory" }),
    requestList: (list: RuntimeGroupList) => requestTransition({ kind: "list", list }),
    requestMetadata: (seedIds: readonly string[] = []) => requestTransition({
      kind: "metadata",
      seedIds: [...seedIds],
    }),
    saveDraft,
    saveError,
    savedListDeleted,
    savedListUpdated,
    saving,
    scope,
    selectedList,
    selectionError,
    setCatalogInputQuery,
    setMetadataOpen,
    reloadMembership: () => setMembershipRevision((revision) => revision + 1),
    startEdit,
    toggleDirectory,
    toggleDirectoryPage,
    toggleDraft,
    toggleDraftPage,
    updateDraftMetadata,
    loadMoreCatalog: () => {
      if (!catalogLoading && catalogLists.length < catalogTotal) {
        setCatalogOffset((current) => current + CATALOG_PAGE_SIZE);
      }
    },
  };
}
