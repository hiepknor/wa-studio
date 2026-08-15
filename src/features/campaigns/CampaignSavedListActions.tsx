import { useCallback, useEffect, useRef, useState } from "react";

import type {
  RuntimeApi,
  RuntimeGroupListGroup,
  RuntimeSavedGroupList,
} from "@/shared/api/runtime-client";
import { AppIcon } from "@/shared/ui/AppIcon";
import { Button } from "@/shared/ui/Button";
import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { SearchField } from "@/shared/ui/SearchField";
import { SelectMenu } from "@/shared/ui/SelectMenu";

type ApplyMode = "add" | "replace";

interface CampaignSavedListActionsProps {
  api: RuntimeApi;
  campaignId: string;
  disabled?: boolean;
  onApply: (
    groupIds: string[],
    mode: ApplyMode,
    list: RuntimeSavedGroupList,
    groups: RuntimeGroupListGroup[],
  ) => { message: string; ok: boolean };
  onNotice: (message: string) => void;
  sessionId: string;
}

export function CampaignSavedListActions({
  api,
  campaignId,
  disabled = false,
  onApply,
  onNotice,
  sessionId,
}: CampaignSavedListActionsProps) {
  const [open, setOpen] = useState(false);
  const [inputQuery, setInputQuery] = useState("");
  const [query, setQuery] = useState("");
  const [lists, setLists] = useState<RuntimeSavedGroupList[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState<ApplyMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const listRequestRef = useRef(0);
  const applyRequestRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const context = `${sessionId}:${campaignId}`;
  const contextRef = useRef(context);
  const contextIsCurrent = contextRef.current === context;
  const normalizedInput = inputQuery.trim();
  const targetRef = useRef(normalizedInput);
  targetRef.current = normalizedInput;

  const close = useCallback((restoreFocus = false) => {
    listRequestRef.current += 1;
    applyRequestRef.current += 1;
    setOpen(false);
    setApplying(null);
    setError(null);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const loadLists = useCallback(async () => {
    if (!open || !contextIsCurrent) return;
    const request = ++listRequestRef.current;
    setLoading(true);
    setError(null);
    try {
      const page = await api.listSavedGroupLists({
        sessionId,
        limit: 100,
        offset: 0,
        ...(query ? { query } : {}),
      });
      if (request !== listRequestRef.current || query !== targetRef.current) return;
      const activeLists = page.data.filter((list) => list.archivedAt === null);
      setLists(activeLists);
      setTotal(page.meta.total);
      setSelectedId((current) => activeLists.some((list) => list.id === current) ? current : "");
    } catch (nextError) {
      if (request === listRequestRef.current && query === targetRef.current) {
        setError(nextError instanceof Error ? nextError.message : "Could not load saved lists.");
      }
    } finally {
      if (request === listRequestRef.current && query === targetRef.current) setLoading(false);
    }
  }, [api, contextIsCurrent, open, query, sessionId]);

  useEffect(() => {
    const nextContext = `${sessionId}:${campaignId}`;
    if (contextRef.current === nextContext) return;
    contextRef.current = nextContext;
    listRequestRef.current += 1;
    applyRequestRef.current += 1;
    setOpen(false);
    setInputQuery("");
    setQuery("");
    setLists([]);
    setTotal(0);
    setSelectedId("");
    setApplying(null);
    setError(null);
    setReplaceOpen(false);
  }, [campaignId, sessionId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setQuery(normalizedInput), 300);
    return () => window.clearTimeout(timeout);
  }, [inputQuery, normalizedInput]);

  useEffect(() => {
    if (!open || !contextIsCurrent || query !== normalizedInput) return;
    void loadLists();
  }, [contextIsCurrent, loadLists, normalizedInput, open, query]);

  useEffect(() => {
    if (!open || replaceOpen) return;
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
  }, [close, open, replaceOpen]);

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
    setApplying(null);
    setError(null);
  }

  async function apply(mode: ApplyMode) {
    const selected = lists.find((list) => list.id === selectedId);
    if (!selected) return;
    const request = ++applyRequestRef.current;
    const requestContext = contextRef.current;
    setApplying(mode);
    setError(null);
    setReplaceOpen(false);
    try {
      const membership = await api.getGroupListMembership(selected.id);
      if (
        request !== applyRequestRef.current
        || requestContext !== contextRef.current
        || selected.id !== selectedId
      ) return;
      if (membership.list.sessionId !== sessionId) {
        setError("This group list belongs to a different Runtime session.");
        return;
      }
      if (membership.list.archivedAt !== null) {
        setError("This group list is archived and can no longer be applied.");
        return;
      }
      const outcome = onApply(
        membership.data.map((group) => group.groupId),
        mode,
        membership.list,
        membership.data,
      );
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      onNotice(outcome.message);
      close(true);
    } catch (nextError) {
      if (request === applyRequestRef.current && requestContext === contextRef.current) {
        setError(nextError instanceof Error ? nextError.message : "Could not apply the saved list.");
      }
    } finally {
      if (request === applyRequestRef.current && requestContext === contextRef.current) setApplying(null);
    }
  }

  const selected = lists.find((list) => list.id === selectedId) ?? null;
  const options = lists.length
    ? lists.map((list) => ({
        description: `${list.groupCount} groups${list.description ? ` · ${list.description}` : ""}`,
        label: list.name,
        value: list.id,
      }))
    : [{ disabled: true, label: loading ? "Loading lists…" : "No saved lists", value: "" }];

  return (
    <div className="campaign-saved-list-action" ref={rootRef}>
      <Button
        aria-controls="campaign-saved-list-popover"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => open ? close(true) : setOpen(true)}
        ref={triggerRef}
        size="sm"
      >
        Add from saved list
      </Button>
      {open && (
        <section aria-label="Add from saved list" className="campaign-saved-list-popover stack stack-sm" id="campaign-saved-list-popover" role="dialog">
          <header>
            <div><strong>Add from saved list</strong><span>Copy a fresh list snapshot into staged targets.</span></div>
            <button aria-label="Close saved lists" onClick={() => close(true)} type="button"><AppIcon name="close" size="xs" /></button>
          </header>
          <SearchField label="Find saved list" loading={loading} onChange={changeSearch} placeholder="Search list name or description" value={inputQuery} />
          <SelectMenu disabled={loading || !lists.length} label="Group list" onChange={changeList} options={options} value={selectedId} />
          {total > 100 && <small>Showing the first 100 matches. Refine the search to find another list.</small>}
          {error && <InlineAlert title="Could not apply saved list">{error}</InlineAlert>}
          <footer>
            <Button disabled={!selected || Boolean(applying)} loading={applying === "add"} onClick={() => void apply("add")} size="sm">Add to selection</Button>
            <Button disabled={!selected || Boolean(applying)} onClick={() => setReplaceOpen(true)} size="sm" variant="ghost">Replace selection</Button>
          </footer>
        </section>
      )}
      <ConfirmationDialog body={selected?.groupCount === 0 ? "This list is empty. Replace will stage an empty target set; nothing is persisted until Save target set." : `Replace the current staged selection with all ${selected?.groupCount ?? 0} groups from ${selected?.name ?? "this list"}? Nothing is persisted until Save target set.`} cancelLabel="Keep selection" confirmLabel="Replace selection" onCancel={() => setReplaceOpen(false)} onConfirm={() => void apply("replace")} open={replaceOpen} title="Replace staged target selection?" />
    </div>
  );
}
