import { useCallback, useEffect, useRef, useState } from "react";

import type { RuntimeApi, RuntimeGroupList } from "@/shared/api/runtime-client";
import { AppIcon } from "@/shared/ui/AppIcon";
import { Button } from "@/shared/ui/Button";
import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { SearchField } from "@/shared/ui/SearchField";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import { groupListErrorMessage } from "@/features/groups/group-list-domain";

interface CampaignGroupListActionsProps {
  api: RuntimeApi;
  campaignId: string;
  disabled?: boolean;
  onApply: (list: RuntimeGroupList) => Promise<{
    message: string;
    ok: boolean;
    reloadLists?: boolean;
  }>;
  sessionId: string;
}

export function CampaignGroupListActions({
  api,
  campaignId,
  disabled = false,
  onApply,
  sessionId,
}: CampaignGroupListActionsProps) {
  const [open, setOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [inputQuery, setInputQuery] = useState("");
  const [query, setQuery] = useState("");
  const [lists, setLists] = useState<RuntimeGroupList[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRequestRef = useRef(0);
  const applyRequestRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const context = `${sessionId}:${campaignId}`;
  const contextRef = useRef(context);
  const normalizedInput = inputQuery.trim();
  const targetRef = useRef(normalizedInput);
  targetRef.current = normalizedInput;

  const close = useCallback((restoreFocus = false) => {
    listRequestRef.current += 1;
    applyRequestRef.current += 1;
    setOpen(false);
    setConfirmOpen(false);
    setApplying(false);
    setError(null);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const loadLists = useCallback(async (preserveError = false) => {
    if (!open || contextRef.current !== context) return;
    const request = ++listRequestRef.current;
    const requestContext = context;
    setLoading(true);
    if (!preserveError) setError(null);
    try {
      const page = await api.listGroupLists({
        sessionId,
        limit: 100,
        offset: 0,
        ...(query ? { query } : {}),
      });
      if (
        request !== listRequestRef.current
        || requestContext !== contextRef.current
        || query !== targetRef.current
      ) return;
      const activeLists = page.data.filter((list) => list.archivedAt === null);
      setLists(activeLists);
      setTotal(page.meta.total);
      setSelectedId((current) => activeLists.some((list) => list.id === current) ? current : "");
    } catch (nextError) {
      if (request === listRequestRef.current && requestContext === contextRef.current) {
        setError(groupListErrorMessage(nextError, "Could not load group lists."));
      }
    } finally {
      if (request === listRequestRef.current && requestContext === contextRef.current) setLoading(false);
    }
  }, [api, context, open, query, sessionId]);

  useEffect(() => {
    if (contextRef.current === context) return;
    contextRef.current = context;
    listRequestRef.current += 1;
    applyRequestRef.current += 1;
    setOpen(false);
    setConfirmOpen(false);
    setInputQuery("");
    setQuery("");
    setLists([]);
    setTotal(0);
    setSelectedId("");
    setApplying(false);
    setError(null);
  }, [context]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setQuery(normalizedInput), 300);
    return () => window.clearTimeout(timeout);
  }, [inputQuery, normalizedInput]);

  useEffect(() => {
    if (!open || contextRef.current !== context || query !== normalizedInput) return;
    void loadLists();
  }, [context, loadLists, normalizedInput, open, query]);

  useEffect(() => {
    if (!open || confirmOpen) return;
    function closeFromOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) close();
    }
    function closeFromEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close(true);
    }
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
    };
  }, [close, confirmOpen, open]);

  useEffect(() => () => {
    listRequestRef.current += 1;
    applyRequestRef.current += 1;
  }, []);

  function changeSearch(value: string) {
    listRequestRef.current += 1;
    setInputQuery(value);
    setLoading(true);
    setError(null);
  }

  function changeList(value: string) {
    applyRequestRef.current += 1;
    setSelectedId(value);
    setError(null);
  }

  async function apply() {
    const selected = lists.find((list) => list.id === selectedId);
    if (!selected) return;
    const request = ++applyRequestRef.current;
    const requestContext = contextRef.current;
    setApplying(true);
    setError(null);
    setConfirmOpen(false);
    const outcome = await onApply(selected);
    if (
      request !== applyRequestRef.current
      || requestContext !== contextRef.current
      || selected.id !== selectedId
    ) return;
    setApplying(false);
    if (!outcome.ok) {
      setError(outcome.message);
      if (outcome.reloadLists) void loadLists(true);
      return;
    }
    close(true);
  }

  const selected = lists.find((list) => list.id === selectedId) ?? null;
  const options = lists.length
    ? lists.map((list) => ({
        description: `${list.groupCount} groups · membership r${list.membershipRevision}${list.description ? ` · ${list.description}` : ""}`,
        label: list.name,
        value: list.id,
      }))
    : [{ disabled: true, label: loading ? "Loading lists…" : "No group lists", value: "" }];

  return (
    <div className="campaign-group-list-action" ref={rootRef}>
      <Button
        aria-controls="campaign-group-list-popover"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => open ? close(true) : setOpen(true)}
        ref={triggerRef}
        size="sm"
      >
        Apply group list
      </Button>
      {open && (
        <section aria-label="Apply group list" className="campaign-group-list-popover stack stack-sm" id="campaign-group-list-popover" role="dialog">
          <header>
            <div><strong>Apply group list</strong><span>Atomically replace the persisted target snapshot.</span></div>
            <button aria-label="Close group lists" onClick={() => close(true)} type="button"><AppIcon name="close" size="xs" /></button>
          </header>
          <SearchField label="Find group list" loading={loading} onChange={applying ? () => undefined : changeSearch} placeholder="Search list name or description" value={inputQuery} />
          <SelectMenu disabled={applying || loading || !lists.length} label="Group list" onChange={changeList} options={options} value={selectedId} />
          {total > 100 && <small>Showing the first 100 matches. Refine the search to find another list.</small>}
          {error && <InlineAlert title="Could not apply group list">{error}</InlineAlert>}
          <footer>
            <Button disabled={!selected || applying} loading={applying} onClick={() => setConfirmOpen(true)} size="sm" variant="primary">Apply list</Button>
          </footer>
        </section>
      )}
      <ConfirmationDialog
        body={selected?.groupCount === 0
          ? "This list is empty. Applying it will atomically clear the persisted campaign target set."
          : `Replace the persisted campaign target set with the ${selected?.groupCount ?? 0} groups from ${selected?.name ?? "this list"} at membership revision ${selected?.membershipRevision ?? "—"}?`}
        cancelLabel="Keep current targets"
        confirmLabel="Apply list"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void apply()}
        open={confirmOpen}
        title="Apply group list snapshot?"
      />
    </div>
  );
}
