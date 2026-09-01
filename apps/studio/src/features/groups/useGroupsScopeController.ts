import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  RuntimeRequestError,
  type RuntimeApi,
  type RuntimeGroupList,
  type RuntimeGroupListMembership,
} from "@/shared/api/runtime-client";
import {
  isUnknownMutationOutcome,
  unknownMutationOutcomeMessage,
} from "@/shared/api/runtime-mutation";
import { useLatestRequest } from "@/shared/hooks/useLatestRequest";
import {
  useRuntimeInvalidation,
  useRuntimeResourceRevision,
} from "@/shared/server-state/runtime-invalidation";
import { groupListErrorMessage } from "./group-list-domain";
import {
  createGroupListMetadataDraft,
  editGroupListMetadataDraft,
  groupListMetadataDirty,
  updateGroupListMetadataDraft,
  type GroupListMetadataDraft,
  type GroupListMetadataSource,
  type GroupsScope,
} from "./groups-workspace-state";
import { MAX_GROUP_SELECTION } from "./selection/group-selection";

const CATALOG_PAGE_SIZE = 50;

interface ScopeError {
  body: string;
  title: string;
}

interface GroupListCreateIntent {
  fingerprint: string;
  key: string;
  outcomeUnknown: boolean;
  payload: {
    description: string | null;
    groupIds: string[];
    name: string;
    sessionId: string;
  };
}

export interface GroupListBulkResult {
  changedCount: number;
  list: RuntimeGroupList;
  unchangedCount: number;
}

interface UseGroupsScopeControllerInput {
  api: RuntimeApi;
  sessionId: string | null;
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

function revisionConflict(error: unknown): boolean {
  return error instanceof RuntimeRequestError
    && error.code === "GROUP_LIST_REVISION_CONFLICT";
}

function assertMembershipAvailable(
  membership: RuntimeGroupListMembership,
  sessionId: string,
): void {
  if (
    membership.list.sessionId !== sessionId
    || membership.list.archivedAt !== null
  ) {
    throw new Error("This saved list is not available in the active session.");
  }
}

export function useGroupsScopeController({
  api,
  sessionId,
}: UseGroupsScopeControllerInput) {
  const { invalidate } = useRuntimeInvalidation();
  const groupsResourceRevision = useRuntimeResourceRevision(["groups"], sessionId);
  const groupListsResourceRevision = useRuntimeResourceRevision(["groupLists"], sessionId);
  const [scope, setScope] = useState<GroupsScope>({ mode: "directory" });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [metadataDraft, setMetadataDraft] = useState<GroupListMetadataDraft | null>(null);
  const [metadataDiscardOpen, setMetadataDiscardOpen] = useState(false);
  const [destinationOpen, setDestinationOpen] = useState(false);
  const [membership, setMembership] = useState<RuntimeGroupListMembership | null>(null);
  const [membershipLoading, setMembershipLoading] = useState(false);
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const [membershipRevision, setMembershipRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [saveError, setSaveError] = useState<ScopeError | null>(null);
  const [bulkError, setBulkError] = useState<ScopeError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | undefined>>({});
  const [catalogInputQuery, setCatalogInputQuery] = useState("");
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogOffset, setCatalogOffset] = useState(0);
  const [catalogLists, setCatalogLists] = useState<RuntimeGroupList[]>([]);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [catalogUnfilteredTotal, setCatalogUnfilteredTotal] = useState<number | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const membershipRequestRef = useRef(0);
  const catalogRequestRef = useRef(0);
  const metadataRequestRef = useRef(0);
  const metadataActiveRequestRef = useRef<number | null>(null);
  const bulkRequestRef = useRef(0);
  const bulkActiveRequestRef = useRef<number | null>(null);
  const createIntentRef = useRef<GroupListCreateIntent | null>(null);
  const sessionRef = useRef(sessionId);
  const catalogRead = useLatestRequest();
  const membershipRead = useLatestRequest();

  const selectedList = scope.mode === "list:view" ? scope.list : null;
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const dirty = metadataDraft ? groupListMetadataDirty(metadataDraft) : false;

  const resetTransientState = useCallback(() => {
    metadataRequestRef.current += 1;
    metadataActiveRequestRef.current = null;
    bulkRequestRef.current += 1;
    bulkActiveRequestRef.current = null;
    createIntentRef.current = null;
    setSelectedIds([]);
    setSelectionError(null);
    setMetadataDraft(null);
    setMetadataDiscardOpen(false);
    setDestinationOpen(false);
    setSaving(false);
    setBulkSaving(false);
    setSaveError(null);
    setBulkError(null);
    setFieldErrors({});
  }, []);

  useEffect(() => {
    if (sessionRef.current === sessionId) return;
    sessionRef.current = sessionId;
    catalogRead.cancel();
    membershipRead.cancel();
    membershipRequestRef.current += 1;
    catalogRequestRef.current += 1;
    resetTransientState();
    setScope({ mode: "directory" });
    setMembership(null);
    setMembershipLoading(false);
    setMembershipError(null);
    setMembershipRevision(0);
    setCatalogInputQuery("");
    setCatalogQuery("");
    setCatalogOffset(0);
    setCatalogLists([]);
    setCatalogTotal(0);
    setCatalogUnfilteredTotal(null);
    setCatalogLoading(false);
    setCatalogError(null);
  }, [catalogRead, membershipRead, resetTransientState, sessionId]);

  useEffect(() => () => {
    metadataRequestRef.current += 1;
    metadataActiveRequestRef.current = null;
    bulkRequestRef.current += 1;
    bulkActiveRequestRef.current = null;
    createIntentRef.current = null;
    membershipRequestRef.current += 1;
    catalogRequestRef.current += 1;
  }, []);

  useEffect(() => {
    catalogRead.cancel();
    const normalized = catalogInputQuery.trim();
    const timeout = window.setTimeout(() => {
      setCatalogQuery((current) => {
        if (current === normalized) return current;
        setCatalogOffset(0);
        return normalized;
      });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [catalogInputQuery, catalogRead]);

  useEffect(() => {
    if (!sessionId) {
      setCatalogLists([]);
      setCatalogTotal(0);
      setCatalogUnfilteredTotal(null);
      return;
    }
    if (typeof api.listGroupLists !== "function") {
      setCatalogLists([]);
      setCatalogTotal(0);
      setCatalogUnfilteredTotal(null);
      setCatalogLoading(false);
      setCatalogError(null);
      return;
    }
    const request = ++catalogRequestRef.current;
    const signal = catalogRead.begin();
    setCatalogLoading(true);
    setCatalogError(null);
    void api.listGroupLists({
      sessionId,
      limit: CATALOG_PAGE_SIZE,
      offset: catalogOffset,
      ...(catalogQuery ? { query: catalogQuery } : {}),
    }, { signal }).then((page) => {
      if (
        !catalogRead.isCurrent(signal)
        || request !== catalogRequestRef.current
        || sessionRef.current !== sessionId
      ) return;
      if (page.data.some((list) => list.sessionId !== sessionId)) {
        throw new Error("Runtime returned group lists outside the active session.");
      }
      setCatalogLists((current) => catalogOffset === 0
        ? [...page.data]
        : mergeCatalog(current, page.data));
      setCatalogTotal(page.meta.total);
      if (!catalogQuery) setCatalogUnfilteredTotal(page.meta.total);
    }).catch((error: unknown) => {
      if (!catalogRead.isCurrent(signal)) return;
      if (request === catalogRequestRef.current) {
        setCatalogError(runtimeErrorMessage(error, "Could not load saved lists."));
      }
    }).finally(() => {
      const current = catalogRead.isCurrent(signal);
      catalogRead.complete(signal);
      if (current && request === catalogRequestRef.current) setCatalogLoading(false);
    });
    return () => catalogRead.cancel();
  }, [
    api,
    catalogOffset,
    catalogQuery,
    catalogRead,
    catalogRevision,
    groupListsResourceRevision,
    sessionId,
  ]);

  useEffect(() => {
    if (scope.mode !== "list:view") return;
    const list = scope.list;
    const request = ++membershipRequestRef.current;
    const signal = membershipRead.begin();
    setMembership(null);
    setMembershipLoading(true);
    setMembershipError(null);
    void api.getGroupListMembership(list.id, { signal }).then((next) => {
      if (
        !membershipRead.isCurrent(signal)
        || request !== membershipRequestRef.current
        || sessionRef.current !== sessionId
      ) return;
      if (!sessionId) return;
      assertMembershipAvailable(next, sessionId);
      setMembership(next);
      setSelectedIds((current) => {
        const available = new Set(next.data.map((row) => row.groupId));
        return current.filter((id) => available.has(id));
      });
      setScope((current) => current.mode === "list:view" && current.list.id === list.id
        ? { list: next.list, mode: "list:view" }
        : current);
    }).catch((error: unknown) => {
      if (!membershipRead.isCurrent(signal)) return;
      if (request === membershipRequestRef.current) {
        setMembershipError(runtimeErrorMessage(error, "Could not load saved list membership."));
      }
    }).finally(() => {
      const current = membershipRead.isCurrent(signal);
      membershipRead.complete(signal);
      if (current && request === membershipRequestRef.current) setMembershipLoading(false);
    });
    return () => membershipRead.cancel();
  }, [
    api,
    groupsResourceRevision,
    membershipRead,
    membershipRevision,
    scope.mode === "list:view" ? scope.list.id : null,
    sessionId,
  ]);

  function clearSelection() {
    setSelectedIds([]);
    setSelectionError(null);
    setBulkError(null);
  }

  function toggleSelection(groupId: string) {
    setSelectedIds((current) => {
      if (current.includes(groupId)) return current.filter((id) => id !== groupId);
      if (current.length >= MAX_GROUP_SELECTION) {
        setSelectionError("Group lists are limited to 1,000 unique groups.");
        return current;
      }
      setSelectionError(null);
      return [...current, groupId];
    });
  }

  function toggleSelectionPage(pageIds: readonly string[]) {
    setSelectedIds((current) => {
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

  function resetCatalogSearch() {
    setCatalogInputQuery("");
    setCatalogQuery("");
    setCatalogOffset(0);
  }

  function changeScope(next: GroupsScope) {
    if (selectedIds.length || saving || bulkSaving) return;
    membershipRead.cancel();
    membershipRequestRef.current += 1;
    setMembership(null);
    setMembershipLoading(false);
    setMembershipError(null);
    setBulkError(null);
    resetCatalogSearch();
    setScope(next);
  }

  function requestCreate(source: GroupListMetadataSource = "scope") {
    if (!sessionId || saving || bulkSaving) return;
    const memberIds = source === "selection" ? selectedIds : [];
    if (source === "selection" && memberIds.length === 0) return;
    createIntentRef.current = null;
    setMetadataDraft(createGroupListMetadataDraft({
      idempotencyKey: crypto.randomUUID(),
      memberIds,
      sessionId,
      source,
    }));
    setMetadataDiscardOpen(false);
    setSaveError(null);
    setFieldErrors({});
    setDestinationOpen(false);
    resetCatalogSearch();
  }

  function startEdit() {
    if (!selectedList || saving || bulkSaving) return;
    createIntentRef.current = null;
    setMetadataDraft(editGroupListMetadataDraft(selectedList));
    setMetadataDiscardOpen(false);
    setSaveError(null);
    setFieldErrors({});
  }

  function updateMetadata(metadata: { description: string; name: string }) {
    setMetadataDraft((current) => current
      ? updateGroupListMetadataDraft(current, metadata)
      : current);
    setFieldErrors((current) => ({
      ...current,
      description: undefined,
      name: undefined,
    }));
  }

  function closeMetadata() {
    metadataRequestRef.current += 1;
    metadataActiveRequestRef.current = null;
    createIntentRef.current = null;
    setMetadataDraft(null);
    setMetadataDiscardOpen(false);
    setSaving(false);
    setSaveError(null);
    setFieldErrors({});
  }

  function requestCloseMetadata() {
    if (!metadataDraft || saving) return;
    if (groupListMetadataDirty(metadataDraft)) {
      setMetadataDiscardOpen(true);
      return;
    }
    closeMetadata();
  }

  function commitList(list: RuntimeGroupList) {
    setCatalogLists((current) => mergeCatalog(current, [list]));
    setCatalogRevision((revision) => revision + 1);
    invalidate({ resources: ["groupLists"], sessionId: list.sessionId });
  }

  async function saveMetadata(): Promise<RuntimeGroupList | null> {
    if (!metadataDraft || metadataActiveRequestRef.current !== null) return null;
    const draft = metadataDraft;
    const targetSessionId = sessionId;
    if (!targetSessionId || draft.sessionId !== targetSessionId) return null;
    const name = draft.name.trim();
    if (!name) {
      setFieldErrors({ name: "Name is required." });
      return null;
    }
    if (draft.mode === "edit" && !groupListMetadataDirty(draft)) return null;

    const request = ++metadataRequestRef.current;
    const requestIsCurrent = () => request === metadataRequestRef.current
      && sessionRef.current === targetSessionId;
    let createIntent: GroupListCreateIntent | null = null;
    if (draft.mode === "create") {
      const payload = {
        sessionId: draft.sessionId,
        name,
        description: draft.description.trim() || null,
        groupIds: [...draft.memberIds],
      };
      const fingerprint = JSON.stringify(payload);
      const existing = createIntentRef.current;
      if (existing?.outcomeUnknown && existing.fingerprint !== fingerprint) {
        setSaveError({
          title: "Create result not confirmed",
          body: "Restore the exact unconfirmed request before retrying it, or cancel this dialog. Changing its request key could create a duplicate group list.",
        });
        return null;
      }
      createIntent = existing && existing.fingerprint === fingerprint
        ? existing
        : {
          fingerprint,
          key: draft.createIdempotencyKey,
          outcomeUnknown: false,
          payload,
        };
      createIntentRef.current = createIntent;
    }

    metadataActiveRequestRef.current = request;
    setSaving(true);
    setSaveError(null);
    setFieldErrors({});
    try {
      const saved = draft.mode === "create"
        ? await api.createGroupList(createIntent!.payload, createIntent!.key)
        : await api.updateGroupList(draft.canonical.id, {
          name,
          description: draft.description.trim() || null,
          expectedRevision: draft.canonical.revision,
        });
      if (!requestIsCurrent()) return null;
      if (saved.sessionId !== targetSessionId || saved.archivedAt !== null) {
        throw new Error("This saved list is not available in the active session.");
      }
      commitList(saved);
      if (draft.mode === "edit") {
        setScope((current) => current.mode === "list:view" && current.list.id === saved.id
          ? { list: saved, mode: "list:view" }
          : current);
        setMembership((current) => current?.list.id === saved.id
          ? { ...current, list: saved }
          : current);
      } else if (draft.source === "scope") {
        setScope({ list: saved, mode: "list:view" });
      } else {
        clearSelection();
      }
      createIntentRef.current = null;
      setMetadataDraft(null);
      return saved;
    } catch (error) {
      if (!requestIsCurrent()) return null;
      const outcomeUnknown = isUnknownMutationOutcome(error);
      if (createIntent && outcomeUnknown) {
        createIntentRef.current = { ...createIntent, outcomeUnknown: true };
      }
      if (error instanceof RuntimeRequestError) {
        setFieldErrors({
          description: error.fieldErrors.description?.[0],
          groupIds: error.fieldErrors.groupIds?.[0],
          name: error.fieldErrors.name?.[0],
        });
      }
      if (draft.mode === "edit" && outcomeUnknown) {
        try {
          const canonical = await api.getGroupList(draft.canonical.id);
          if (!requestIsCurrent()) return null;
          const intendedDescription = draft.description.trim() || null;
          if (canonical.name === name && canonical.description === intendedDescription) {
            commitList(canonical);
            setScope({ list: canonical, mode: "list:view" });
            setMembership((current) => current?.list.id === canonical.id
              ? { ...current, list: canonical }
              : current);
            setMetadataDraft(null);
            return canonical;
          }
          setMetadataDraft({
            ...draft,
            baselineDescription: canonical.description ?? "",
            baselineName: canonical.name,
            canonical,
          });
        } catch {
          // Keep the intended edit visible; the mutation error remains primary.
        }
      }
      setSaveError({
        title: draft.mode === "create" ? "Could not create group list" : "Could not save list details",
        body: outcomeUnknown
          ? unknownMutationOutcomeMessage(draft.mode === "create" ? "idempotent-retry" : "canonical-reload")
          : runtimeErrorMessage(error, "Could not save group list details."),
      });
      return null;
    } finally {
      if (metadataActiveRequestRef.current === request) {
        metadataActiveRequestRef.current = null;
      }
      if (requestIsCurrent()) setSaving(false);
    }
  }

  async function mutateMembership(
    list: RuntimeGroupList,
    ids: readonly string[],
    mode: "add" | "remove",
  ): Promise<{ membership: RuntimeGroupListMembership; changedCount: number; unchangedCount: number }> {
    if (!sessionId || list.sessionId !== sessionId) {
      throw new Error("Choose a group list from the active session.");
    }
    const snapshot = [...new Set(ids)];
    let lastConflict: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const canonical = await api.getGroupListMembership(list.id);
      assertMembershipAvailable(canonical, sessionId);
      const currentIds = canonical.data.map((row) => row.groupId);
      const current = new Set(currentIds);
      const selected = new Set(snapshot);
      const nextIds = mode === "add"
        ? [...currentIds, ...snapshot.filter((id) => !current.has(id))]
        : currentIds.filter((id) => !selected.has(id));
      const changedCount = mode === "add"
        ? nextIds.length - currentIds.length
        : currentIds.length - nextIds.length;
      const unchangedCount = snapshot.length - changedCount;
      if (nextIds.length > MAX_GROUP_SELECTION) {
        throw new Error(
          `Adding these groups would exceed the ${MAX_GROUP_SELECTION.toLocaleString()}-group list limit.`,
        );
      }
      if (changedCount === 0) {
        return { membership: canonical, changedCount, unchangedCount };
      }
      try {
        const updated = await api.replaceGroupListGroups(
          list.id,
          nextIds,
          canonical.list.membershipRevision,
        );
        assertMembershipAvailable(updated, sessionId);
        return { membership: updated, changedCount, unchangedCount };
      } catch (error) {
        if (revisionConflict(error) && attempt === 0) {
          lastConflict = error;
          continue;
        }
        if (isUnknownMutationOutcome(error)) {
          try {
            const reconciled = await api.getGroupListMembership(list.id);
            assertMembershipAvailable(reconciled, sessionId);
            const reconciledIds = new Set(reconciled.data.map((row) => row.groupId));
            const applied = mode === "add"
              ? snapshot.every((id) => reconciledIds.has(id))
              : snapshot.every((id) => !reconciledIds.has(id));
            if (applied) return { membership: reconciled, changedCount, unchangedCount };
          } catch {
            // Preserve the unknown-outcome message below.
          }
          throw new Error(
            "Runtime did not confirm the membership result. Reload the list before retrying.",
          );
        }
        throw error;
      }
    }
    throw lastConflict ?? new Error("The group list changed while membership was being updated.");
  }

  async function addSelectionToList(list: RuntimeGroupList): Promise<GroupListBulkResult | null> {
    if (
      scope.mode !== "directory"
      || selectedIds.length === 0
      || bulkActiveRequestRef.current !== null
      || !sessionId
    ) return null;
    const snapshot = [...selectedIds];
    const request = ++bulkRequestRef.current;
    const targetSessionId = sessionId;
    const requestIsCurrent = () => request === bulkRequestRef.current
      && sessionRef.current === targetSessionId;
    bulkActiveRequestRef.current = request;
    setBulkSaving(true);
    setBulkError(null);
    try {
      const result = await mutateMembership(list, snapshot, "add");
      if (!requestIsCurrent()) return null;
      setCatalogLists((current) => mergeCatalog(current, [result.membership.list]));
      setCatalogRevision((revision) => revision + 1);
      invalidate({ resources: ["groupLists"], sessionId: targetSessionId });
      setSelectedIds([]);
      setDestinationOpen(false);
      resetCatalogSearch();
      return {
        changedCount: result.changedCount,
        list: result.membership.list,
        unchangedCount: result.unchangedCount,
      };
    } catch (error) {
      if (requestIsCurrent()) {
        setBulkError({
          title: "Could not add groups",
          body: runtimeErrorMessage(error, "The selected groups were not added to this list."),
        });
      }
      return null;
    } finally {
      if (bulkActiveRequestRef.current === request) bulkActiveRequestRef.current = null;
      if (requestIsCurrent()) setBulkSaving(false);
    }
  }

  async function removeSelectionFromList(): Promise<GroupListBulkResult | null> {
    if (
      scope.mode !== "list:view"
      || selectedIds.length === 0
      || bulkActiveRequestRef.current !== null
      || !sessionId
    ) return null;
    const list = scope.list;
    const snapshot = [...selectedIds];
    const request = ++bulkRequestRef.current;
    const targetSessionId = sessionId;
    const requestIsCurrent = () => request === bulkRequestRef.current
      && sessionRef.current === targetSessionId;
    bulkActiveRequestRef.current = request;
    setBulkSaving(true);
    setBulkError(null);
    try {
      const result = await mutateMembership(list, snapshot, "remove");
      if (!requestIsCurrent()) return null;
      setMembership(result.membership);
      setScope({ list: result.membership.list, mode: "list:view" });
      setCatalogLists((current) => mergeCatalog(current, [result.membership.list]));
      setCatalogRevision((revision) => revision + 1);
      invalidate({ resources: ["groupLists"], sessionId: targetSessionId });
      setSelectedIds([]);
      return {
        changedCount: result.changedCount,
        list: result.membership.list,
        unchangedCount: result.unchangedCount,
      };
    } catch (error) {
      if (requestIsCurrent()) {
        setBulkError({
          title: "Could not remove groups",
          body: runtimeErrorMessage(error, "The selected groups were not removed from this list."),
        });
      }
      return null;
    } finally {
      if (bulkActiveRequestRef.current === request) bulkActiveRequestRef.current = null;
      if (requestIsCurrent()) setBulkSaving(false);
    }
  }

  function savedListUpdated(list: RuntimeGroupList) {
    setCatalogLists((current) => mergeCatalog(current, [list]));
    setCatalogRevision((revision) => revision + 1);
  }

  function savedListDeleted(listId: string) {
    setCatalogLists((current) => current.filter((list) => list.id !== listId));
    setCatalogTotal((current) => Math.max(0, current - 1));
    setCatalogUnfilteredTotal((current) => current === null
      ? current
      : Math.max(0, current - 1));
    if (selectedList?.id === listId) {
      clearSelection();
      setScope({ mode: "directory" });
      setMembership(null);
    }
    setCatalogRevision((revision) => revision + 1);
  }

  function restoreUnconfirmedCreateIntent() {
    const intent = createIntentRef.current;
    if (!intent?.outcomeUnknown) return;
    setMetadataDraft((current) => current?.mode === "create"
      && current.createIdempotencyKey === intent.key
      ? {
        ...current,
        description: intent.payload.description ?? "",
        memberIds: [...intent.payload.groupIds],
        name: intent.payload.name,
      }
      : current);
    setFieldErrors({});
    setSaveError({
      title: "Create result not confirmed",
      body: unknownMutationOutcomeMessage("idempotent-retry"),
    });
  }

  return {
    addSelectionToList,
    bulkError,
    bulkSaving,
    cancelDiscard: () => setMetadataDiscardOpen(false),
    catalogError,
    catalogAvailability: catalogUnfilteredTotal !== null
      ? catalogUnfilteredTotal > 0 ? "available" as const : "empty" as const
      : catalogError ? "unavailable" as const : "loading" as const,
    catalogHasMore: catalogLists.length < catalogTotal,
    catalogInputQuery,
    catalogLists,
    catalogLoading,
    clearBulkError: () => setBulkError(null),
    clearSelection,
    closeDestination: () => {
      if (!bulkSaving) {
        setDestinationOpen(false);
        setBulkError(null);
        resetCatalogSearch();
      }
    },
    confirmDiscard: closeMetadata,
    destinationOpen,
    dirty,
    discardConfirmationOpen: metadataDiscardOpen,
    fieldErrors,
    hasUnconfirmedCreateIntent: Boolean(createIntentRef.current?.outcomeUnknown),
    loadMoreCatalog: () => {
      if (!catalogLoading && catalogLists.length < catalogTotal) {
        setCatalogOffset((current) => current + CATALOG_PAGE_SIZE);
      }
    },
    membership,
    membershipError,
    membershipLoading,
    metadataDraft,
    reloadMembership: () => setMembershipRevision((revision) => revision + 1),
    removeSelectionFromList,
    requestAddDestination: () => {
      if (scope.mode === "directory" && selectedIds.length > 0 && !bulkSaving) {
        setBulkError(null);
        resetCatalogSearch();
        setDestinationOpen(true);
      }
    },
    requestCloseMetadata,
    requestCreate,
    requestDirectory: () => changeScope({ mode: "directory" }),
    requestList: (list: RuntimeGroupList) => changeScope({ list, mode: "list:view" }),
    restoreUnconfirmedCreateIntent,
    saveError,
    saveMetadata,
    savedListDeleted,
    savedListUpdated,
    saving,
    scope,
    selectedIds,
    selectedIdSet,
    selectedList,
    selectionError,
    selectionLocked: selectedIds.length > 0,
    setCatalogInputQuery,
    startEdit,
    toggleSelection,
    toggleSelectionPage,
    updateMetadata,
  };
}
