import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  RuntimeRequestError,
  type RuntimeApi,
  type RuntimeGroup,
  type RuntimeGroupPage,
} from "@/shared/api/runtime-client";
import { useLatestRequest } from "@/shared/hooks/useLatestRequest";
import { useRuntimeResourceRevision } from "@/shared/server-state/runtime-invalidation";
import { reconciledPageOffset } from "@/shared/server-state/server-page";
import {
  activeGroupSelectionFilterCount,
  emptyGroupSelectionFilters,
  type GroupSelectionFilters,
  type ParticipantFilterErrors,
} from "./GroupSelectionToolbar";

interface UseGroupDirectoryQueryInput {
  api: RuntimeApi;
  enabled: boolean;
  pageSize?: number;
  scopeKey: string;
  sessionId: string | null;
}

function requestKey(
  sessionId: string | null,
  scopeKey: string,
  query: string,
  offset: number,
  filters: GroupSelectionFilters,
): string {
  return JSON.stringify({ sessionId, scopeKey, query, offset, filters });
}

export function useGroupDirectoryQuery({
  api,
  enabled,
  pageSize = 20,
  scopeKey,
  sessionId,
}: UseGroupDirectoryQueryInput) {
  const [inputQuery, setInputQuery] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffsetState] = useState(0);
  const [filters, setFiltersState] = useState<GroupSelectionFilters>(emptyGroupSelectionFilters);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [participantErrors, setParticipantErrors] = useState<ParticipantFilterErrors>({});
  const [groups, setGroups] = useState<RuntimeGroup[]>([]);
  const [meta, setMeta] = useState<RuntimeGroupPage["meta"] | null>(null);
  const [knownGroups, setKnownGroups] = useState<Record<string, RuntimeGroup>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadRevision, setReloadRevision] = useState(0);
  const groupsResourceRevision = useRuntimeResourceRevision(["groups"], sessionId);
  const requestRevision = useRef(0);
  const directoryRead = useLatestRequest();
  const context = `${sessionId ?? ""}:${scopeKey}`;
  const contextRef = useRef(context);
  const contextIsCurrent = contextRef.current === context;
  const normalizedInputQuery = inputQuery.trim();
  const intendedOffset = normalizedInputQuery === query ? offset : 0;
  const targetKey = enabled && contextIsCurrent
    ? requestKey(sessionId, scopeKey, normalizedInputQuery, intendedOffset, filters)
    : "";
  const committedKey = enabled && contextIsCurrent
    ? requestKey(sessionId, scopeKey, query, offset, filters)
    : "";
  const targetRef = useRef(targetKey);
  targetRef.current = targetKey;

  const reset = useCallback(() => {
    directoryRead.cancel();
    requestRevision.current += 1;
    targetRef.current = "";
    setInputQuery("");
    setQuery("");
    setOffsetState(0);
    setFiltersState(emptyGroupSelectionFilters());
    setFiltersOpen(false);
    setParticipantErrors({});
    setGroups([]);
    setMeta(null);
    setKnownGroups({});
    setLoading(false);
    setError(null);
  }, [directoryRead]);

  useEffect(() => {
    if (contextRef.current === context) return;
    contextRef.current = context;
    reset();
  }, [context, reset]);

  useEffect(() => {
    if (enabled) return;
    directoryRead.cancel();
    requestRevision.current += 1;
    targetRef.current = "";
    setLoading(false);
  }, [directoryRead, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const timeout = window.setTimeout(() => {
      setOffsetState(0);
      setQuery((current) => current === normalizedInputQuery ? current : normalizedInputQuery);
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [enabled, inputQuery, normalizedInputQuery]);

  const load = useCallback(async () => {
    if (!enabled || !sessionId || !committedKey) return;
    const revision = ++requestRevision.current;
    const signal = directoryRead.begin();
    setLoading(true);
    setError(null);
    setGroups([]);
    try {
      const page = await api.listGroups({
        sessionId,
        limit: pageSize,
        offset,
        ...(query ? { query } : {}),
        ...(filters.capabilityStatuses.length
          ? { capabilityStatus: filters.capabilityStatuses }
          : {}),
        ...(filters.capabilityFreshness.length
          ? { capabilityFreshness: filters.capabilityFreshness }
          : {}),
        ...(filters.isActive === undefined ? {} : { isActive: filters.isActive }),
        ...(filters.minParticipants === undefined
          ? {}
          : { minParticipants: filters.minParticipants }),
        ...(filters.maxParticipants === undefined
          ? {}
          : { maxParticipants: filters.maxParticipants }),
      }, { signal });
      if (revision !== requestRevision.current || committedKey !== targetRef.current) return;
      const recoveredOffset = reconciledPageOffset({
        limit: pageSize,
        offset,
        rowCount: page.data.length,
        total: page.meta.total,
      });
      if (recoveredOffset !== null) {
        if (page.meta.total === 0) setMeta({ ...page.meta });
        setOffsetState(recoveredOffset);
        return;
      }
      setGroups(page.data);
      setMeta({ ...page.meta });
      setParticipantErrors({});
      setKnownGroups((current) => {
        const next = { ...current };
        page.data.forEach((group) => { next[group.id] = group; });
        return next;
      });
    } catch (nextError) {
      if (signal.aborted) return;
      if (revision !== requestRevision.current || committedKey !== targetRef.current) return;
      if (nextError instanceof RuntimeRequestError) {
        setParticipantErrors({
          minParticipants: nextError.fieldErrors.minParticipants?.[0],
          maxParticipants: nextError.fieldErrors.maxParticipants?.[0],
        });
      }
      setError(nextError instanceof Error ? nextError.message : "Could not load groups.");
    } finally {
      directoryRead.complete(signal);
      if (revision === requestRevision.current && committedKey === targetRef.current) {
        setLoading(false);
      }
    }
  }, [api, committedKey, directoryRead, enabled, filters, offset, pageSize, query, sessionId]);

  useEffect(() => {
    if (!committedKey || committedKey !== targetKey) return;
    void load();
  }, [committedKey, groupsResourceRevision, load, reloadRevision, targetKey]);

  useEffect(() => () => {
    requestRevision.current += 1;
    targetRef.current = "";
  }, []);

  const setSearch = useCallback((value: string) => {
    directoryRead.cancel();
    requestRevision.current += 1;
    setInputQuery(value);
    setGroups([]);
    setLoading(true);
    setError(null);
  }, [directoryRead]);

  const setFilters = useCallback((next: GroupSelectionFilters) => {
    directoryRead.cancel();
    requestRevision.current += 1;
    setFiltersState(next);
    setOffsetState(0);
    setGroups([]);
    setLoading(true);
    setError(null);
    setParticipantErrors({});
    setReloadRevision((revision) => revision + 1);
  }, [directoryRead]);

  const setOffset = useCallback((next: number) => {
    directoryRead.cancel();
    requestRevision.current += 1;
    setOffsetState(next);
    setGroups([]);
    setLoading(true);
    setError(null);
  }, [directoryRead]);

  const rememberGroups = useCallback((items: RuntimeGroup[]) => {
    setKnownGroups((current) => {
      const next = { ...current };
      items.forEach((group) => { next[group.id] = group; });
      return next;
    });
  }, []);

  const hasCriteria = Boolean(query || activeGroupSelectionFilterCount(filters));
  const pageOffset = meta?.offset ?? offset;
  const total = meta?.total ?? 0;

  return useMemo(() => ({
    error,
    filters,
    filtersOpen,
    groups,
    hasCriteria,
    inputQuery,
    knownGroups,
    loading,
    meta,
    offset: pageOffset,
    pageSize: meta?.limit ?? pageSize,
    participantErrors,
    query,
    rememberGroups,
    reset,
    retry: () => setReloadRevision((revision) => revision + 1),
    setFilters,
    setFiltersOpen,
    setOffset,
    setParticipantErrors,
    setSearch,
    total,
  }), [error, filters, filtersOpen, groups, hasCriteria, inputQuery, knownGroups,
    loading, meta, pageOffset, pageSize, participantErrors, query, rememberGroups,
    reset, setFilters, setOffset, setSearch, total]);
}
