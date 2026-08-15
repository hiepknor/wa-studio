import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { useRuntimeConnection } from "@/app/RuntimeConnectionContext";
import type { RuntimeGroupList, RuntimeGroupListPage } from "@/shared/api/runtime-client";
import { Button } from "@/shared/ui/Button";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { PageHeader } from "@/shared/ui/PageHeader";
import { SearchField } from "@/shared/ui/SearchField";
import { TablePagination } from "@/shared/ui/TablePagination";
import { useToast } from "@/shared/ui/Toast";
import { GroupListEditor } from "./GroupListEditor";
import { groupListErrorMessage } from "./group-list-domain";

const PAGE_SIZE = 20;

interface GroupListsPanelProps {
  navigation: ReactNode;
}

type EditorState =
  | { kind: "closed" }
  | { kind: "create"; nonce: number }
  | { kind: "edit"; list: RuntimeGroupList };

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function listKey(sessionId: string | null, query: string, offset: number): string {
  return `${sessionId ?? ""}\u0000${query}\u0000${offset}`;
}

export function GroupListsPanel({ navigation }: GroupListsPanelProps) {
  const { connected, selectedSessionId } = useRuntimeConnection();
  const toast = useToast();
  if (!connected) throw new Error("GroupListsPanel requires a Runtime connection");
  const api = connected.api;
  const [page, setPage] = useState<RuntimeGroupListPage | null>(null);
  const [inputQuery, setInputQuery] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>({ kind: "closed" });
  const [reloadRevision, setReloadRevision] = useState(0);
  const requestRef = useRef(0);
  const sessionRef = useRef(selectedSessionId);
  const sessionIsCurrent = sessionRef.current === selectedSessionId;
  const normalizedInput = inputQuery.trim();
  const intendedOffset = normalizedInput === query ? offset : 0;
  const targetKey = sessionIsCurrent
    ? listKey(selectedSessionId, normalizedInput, intendedOffset)
    : "";
  const committedKey = sessionIsCurrent ? listKey(selectedSessionId, query, offset) : "";
  const targetRef = useRef(targetKey);
  targetRef.current = targetKey;

  const load = useCallback(async () => {
    if (!selectedSessionId || !committedKey || committedKey !== targetRef.current) return;
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const nextPage = await api.listGroupLists({
        sessionId: selectedSessionId,
        limit: PAGE_SIZE,
        offset,
        ...(query ? { query } : {}),
      });
      if (request !== requestRef.current || committedKey !== targetRef.current) return;
      if (nextPage.data.some((list) => list.sessionId !== selectedSessionId)) {
        throw new Error("Runtime returned group lists outside the active session.");
      }
      if (offset > 0 && nextPage.data.length === 0 && nextPage.meta.total <= offset) {
        const lastOffset = nextPage.meta.total === 0
          ? 0
          : Math.floor((nextPage.meta.total - 1) / PAGE_SIZE) * PAGE_SIZE;
        if (nextPage.meta.total === 0) setPage(nextPage);
        setOffset(lastOffset);
        return;
      }
      setPage({ data: [...nextPage.data], meta: { ...nextPage.meta } });
    } catch (nextError) {
      if (request === requestRef.current && committedKey === targetRef.current) {
        setError(groupListErrorMessage(nextError, "Could not load group lists."));
      }
    } finally {
      if (request === requestRef.current && committedKey === targetRef.current) setLoading(false);
    }
  }, [api, committedKey, offset, query, selectedSessionId]);

  useEffect(() => {
    if (sessionRef.current === selectedSessionId) return;
    sessionRef.current = selectedSessionId;
    requestRef.current += 1;
    setPage(null);
    setInputQuery("");
    setQuery("");
    setOffset(0);
    setLoading(false);
    setError(null);
    setEditor({ kind: "closed" });
  }, [selectedSessionId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setOffset(0);
      setQuery((current) => current === normalizedInput ? current : normalizedInput);
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [inputQuery, normalizedInput]);

  useEffect(() => {
    if (!selectedSessionId || !committedKey || committedKey !== targetKey) return;
    void load();
  }, [committedKey, load, reloadRevision, selectedSessionId, targetKey]);

  useEffect(() => () => {
    requestRef.current += 1;
    targetRef.current = "";
  }, []);

  function changeSearch(value: string) {
    requestRef.current += 1;
    setInputQuery(value);
    setLoading(true);
    setError(null);
  }

  function changeOffset(next: number) {
    requestRef.current += 1;
    setOffset(next);
    setLoading(true);
    setError(null);
  }

  function openCreate() {
    setEditor({ kind: "create", nonce: Date.now() });
  }

  function saved(list: RuntimeGroupList) {
    setEditor({ kind: "closed" });
    setReloadRevision((revision) => revision + 1);
    toast.notify({ id: `group-list-saved-${list.id}`, title: "Group list saved", tone: "success" });
  }

  function archived(listId: string) {
    setEditor({ kind: "closed" });
    setReloadRevision((revision) => revision + 1);
    toast.notify({
      description: "Existing campaign target snapshots were not changed.",
      id: `group-list-archived-${listId}`,
      title: "Group list archived",
      tone: "success",
    });
  }

  const total = page?.meta.total ?? 0;
  const pageOffset = page?.meta.offset ?? offset;
  const first = total === 0 ? 0 : pageOffset + 1;
  const last = Math.min(pageOffset + (page?.data.length ?? 0), total);

  return (
    <div aria-labelledby="groups-workspace-lists-tab" className="groups-screen group-lists-screen stack stack-lg" id="groups-workspace-lists-panel" role="tabpanel">
      <PageHeader actions={<Button disabled={!selectedSessionId} onClick={openCreate} variant="primary">New list</Button>} description="Create reusable static group selections for the active Runtime session." title="Groups" titleId="groups-title" />
      {navigation}
      {!selectedSessionId && <InlineAlert title="No active session" tone="warning">Select a Gateway session before loading group lists.</InlineAlert>}
      <div className="data-table-container group-lists-panel">
        <div className="data-table-toolbar group-lists-toolbar">
          <SearchField id="group-lists-search" label="Search group lists" loading={loading} onChange={changeSearch} placeholder="Search list name or description" value={inputQuery} variant="toolbar" />
          <span aria-live="polite" className="data-filter-result-summary">{loading ? "Updating results…" : `${first}–${last} of ${total}${query ? " matches" : " lists"}`}</span>
        </div>
        {error && <InlineAlert action={<Button onClick={() => setReloadRevision((revision) => revision + 1)} size="sm">Retry</Button>} className="data-table-error" title="Could not load group lists">{error}</InlineAlert>}
        <div aria-busy={loading || undefined} className="data-table-scroll">
          <table>
            <caption>Group lists for the active session</caption>
            <thead><tr><th scope="col">Name</th><th scope="col">Description</th><th className="data-column-number" scope="col">Groups</th><th scope="col">Updated</th><th aria-label="Actions" scope="col" /></tr></thead>
            <tbody>
              {!selectedSessionId ? <tr><td className="data-table-empty" colSpan={5}>Select a session to view group lists.</td></tr>
                : !page && loading ? <tr><td className="data-table-empty" colSpan={5}>Loading group lists…</td></tr>
                : !page && error ? <tr><td className="data-table-empty" colSpan={5}>Group lists are unavailable.</td></tr>
                : (page?.data.length ?? 0) === 0 ? <tr><td className="data-table-empty" colSpan={5}>{query ? "No group lists match this search." : "No group lists yet. Use New list to create a reusable static group selection."}</td></tr>
                : page?.data.map((list) => <tr key={list.id}><td className="data-cell-primary"><button className="group-list-name" onClick={() => setEditor({ kind: "edit", list })} type="button">{list.name}</button></td><td className="group-list-description" title={list.description ?? undefined}>{list.description || "—"}</td><td className="data-cell-number">{list.groupCount}</td><td className="data-cell-time">{formatDate(list.updatedAt)}</td><td className="data-cell-action"><Button aria-label={`Edit ${list.name}`} onClick={() => setEditor({ kind: "edit", list })} size="sm" variant="ghost">Edit</Button></td></tr>) }
            </tbody>
          </table>
        </div>
        <TablePagination limit={page?.meta.limit ?? PAGE_SIZE} loading={loading} offset={pageOffset} onOffsetChange={changeOffset} total={total} />
      </div>
      {editor.kind !== "closed" && selectedSessionId && <GroupListEditor api={api} key={editor.kind === "create" ? `create:${editor.nonce}` : editor.list.id} list={editor.kind === "edit" ? editor.list : null} onArchived={archived} onClose={() => setEditor({ kind: "closed" })} onSaved={saved} sessionId={selectedSessionId} />}
    </div>
  );
}
