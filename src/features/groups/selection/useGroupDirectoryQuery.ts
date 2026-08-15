import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  RuntimeRequestError,
  type RuntimeApi,
  type RuntimeGroup,
  type RuntimeGroupPage,
} from "@/shared/api/runtime-client";
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
  const requestRevision = useRef(0);
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
  }, []);

  useEffect(() => {
    if (contextRef.current === context) return;
    contextRef.current = context;
    reset();
  }, [context, reset]);

  useEffect(() => {
    if (enabled) return;
    requestRevision.current += 1;
    targetRef.current = "";
    setLoading(false);
  }, [enabled]);

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
      });
      if (revision !== requestRevision.current || committedKey !== targetRef.current) return;
      if (offset > 0 && page.data.length === 0 && page.meta.total <= offset) {
        const lastOffset = page.meta.total === 0
          ? 0
          : Math.floor((page.meta.total - 1) / pageSize) * pageSize;
        if (page.meta.total === 0) setMeta({ ...page.meta });
        setOffsetState(lastOffset);
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
      if (revision !== requestRevision.current || committedKey !== targetRef.current) return;
      if (nextError instanceof RuntimeRequestError) {
        setParticipantErrors({
          minParticipants: nextError.fieldErrors.minParticipants?.[0],
          maxParticipants: nextError.fieldErrors.maxParticipants?.[0],
        });
      }
      setError(nextError instanceof Error ? nextError.message : "Could not load groups.");
    } finally {
      if (revision === requestRevision.current && committedKey === targetRef.current) {
        setLoading(false);
      }
    }
  }, [api, committedKey, enabled, filters, offset, pageSize, query, sessionId]);

  useEffect(() => {
    if (!committedKey || committedKey !== targetKey) return;
    void load();
  }, [committedKey, load, reloadRevision, targetKey]);

  useEffect(() => () => {
    requestRevision.current += 1;
    targetRef.current = "";
  }, []);

  const setSearch = useCallback((value: string) => {
    requestRevision.current += 1;
    setInputQuery(value);
    setGroups([]);
    setLoading(true);
    setError(null);
  }, []);

  const setFilters = useCallback((next: GroupSelectionFilters) => {
    requestRevision.current += 1;
    setFiltersState(next);
    setOffsetState(0);
    setGroups([]);
    setLoading(true);
    setError(null);
    setParticipantErrors({});
    setReloadRevision((revision) => revision + 1);
  }, []);

  const setOffset = useCallback((next: number) => {
    requestRevision.current += 1;
    setOffsetState(next);
    setGroups([]);
    setLoading(true);
    setError(null);
  }, []);

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
