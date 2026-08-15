import { useCallback, useEffect, useRef, useState } from "react";

import type { RuntimeApi, RuntimeGroupList } from "@/shared/api/runtime-client";
import { AppIcon } from "@/shared/ui/AppIcon";
import { Button } from "@/shared/ui/Button";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { ModalDialog } from "@/shared/ui/ModalDialog";
import { SearchField } from "@/shared/ui/SearchField";
import { TablePagination } from "@/shared/ui/TablePagination";
import { groupListErrorMessage } from "@/features/groups/group-list-domain";

const LIST_PAGE_SIZE = 5;

function formatUpdatedAt(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

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
  const [step, setStep] = useState<"select" | "review">("select");
  const [inputQuery, setInputQuery] = useState("");
  const [query, setQuery] = useState("");
  const [lists, setLists] = useState<RuntimeGroupList[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<RuntimeGroupList | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRequestRef = useRef(0);
  const applyRequestRef = useRef(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const context = `${sessionId}:${campaignId}`;
  const contextRef = useRef(context);
  const normalizedInput = inputQuery.trim();
  const listTarget = `${context}:${query}:${offset}`;
  const targetRef = useRef(listTarget);
  targetRef.current = listTarget;

  const close = useCallback((restoreFocus = false) => {
    listRequestRef.current += 1;
    applyRequestRef.current += 1;
    setOpen(false);
    setStep("select");
    setApplying(false);
    setInputQuery("");
    setQuery("");
    setLists([]);
    setTotal(0);
    setOffset(0);
    setSelected(null);
    setError(null);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  function openDialog() {
    setStep("select");
    setOpen(true);
  }

  const loadLists = useCallback(async (preserveError = false) => {
    if (!open || contextRef.current !== context) return;
    const request = ++listRequestRef.current;
    const requestContext = context;
    const requestTarget = listTarget;
    setLoading(true);
    if (!preserveError) setError(null);
    try {
      const page = await api.listGroupLists({
        sessionId,
        limit: LIST_PAGE_SIZE,
        offset,
        ...(query ? { query } : {}),
      });
      if (
        request !== listRequestRef.current
        || requestContext !== contextRef.current
        || requestTarget !== targetRef.current
      ) return;
      const activeLists = page.data.filter((list) => list.archivedAt === null);
      if (offset > 0 && activeLists.length === 0 && page.meta.total <= offset) {
        const lastOffset = page.meta.total === 0
          ? 0
          : Math.floor((page.meta.total - 1) / LIST_PAGE_SIZE) * LIST_PAGE_SIZE;
        setOffset(lastOffset);
        return;
      }
      setLists(activeLists);
      setTotal(page.meta.total);
    } catch (nextError) {
      if (request === listRequestRef.current && requestContext === contextRef.current) {
        setError(groupListErrorMessage(nextError, "Could not load group lists."));
      }
    } finally {
      if (request === listRequestRef.current && requestContext === contextRef.current) setLoading(false);
    }
  }, [api, context, listTarget, offset, open, query, sessionId]);

  useEffect(() => {
    if (contextRef.current === context) return;
    contextRef.current = context;
    listRequestRef.current += 1;
    applyRequestRef.current += 1;
    setOpen(false);
    setStep("select");
    setInputQuery("");
    setQuery("");
    setLists([]);
    setTotal(0);
    setOffset(0);
    setSelected(null);
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

  useEffect(() => () => {
    listRequestRef.current += 1;
    applyRequestRef.current += 1;
  }, []);

  function changeSearch(value: string) {
    listRequestRef.current += 1;
    setInputQuery(value);
    setOffset(0);
    setLoading(true);
    setError(null);
  }

  function changeList(list: RuntimeGroupList) {
    applyRequestRef.current += 1;
    setSelected(list);
    setError(null);
  }

  function changeOffset(nextOffset: number) {
    listRequestRef.current += 1;
    setOffset(nextOffset);
    setLoading(true);
    setError(null);
  }

  async function apply() {
    const selectedList = selected;
    if (!selectedList) return;
    const request = ++applyRequestRef.current;
    const requestContext = contextRef.current;
    setApplying(true);
    setError(null);
    const outcome = await onApply(selectedList);
    if (
      request !== applyRequestRef.current
      || requestContext !== contextRef.current
    ) return;
    setApplying(false);
    if (!outcome.ok) {
      setStep("select");
      setError(outcome.message);
      if (outcome.reloadLists) {
        setSelected(null);
        void loadLists(true);
      }
      return;
    }
    close(true);
  }

  const selectedVisible = Boolean(selected && lists.some((list) => list.id === selected.id));
  const resultSummary = loading && !lists.length
    ? "Loading lists…"
    : total === 0
      ? "No lists"
      : `${offset + 1}–${offset + lists.length} of ${total} lists`;

  return (
    <div className="campaign-group-list-action">
      <Button
        aria-controls="campaign-group-list-dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => open ? close(true) : openDialog()}
        ref={triggerRef}
        size="sm"
      >
        Apply group list
      </Button>
      <ModalDialog
        closeDisabled={applying}
        description={step === "select"
          ? "Choose a saved list from this campaign session."
          : "Confirm the exact saved-list snapshot that will replace campaign targets."}
        eyebrow="Group list"
        footer={<>
          <div className="campaign-group-list-dialog-summary">
            <strong>{step === "review" ? "Atomic target replacement" : selected ? selected.name : "No list selected"}</strong>
            <span>{step === "review"
              ? "Campaign targets change only after confirmation."
              : selected ? "Ready to review before applying." : "Current campaign targets stay unchanged."}</span>
          </div>
          <div className="campaign-group-list-dialog-actions">
            {step === "select" ? <>
              <Button disabled={applying} onClick={() => close(true)} size="sm">Cancel</Button>
              <Button disabled={!selected || applying} onClick={() => setStep("review")} size="sm" variant="primary">Review</Button>
            </> : <>
              <Button disabled={applying} onClick={() => setStep("select")} size="sm">Back</Button>
              <Button disabled={!selected} loading={applying} onClick={() => void apply()} size="sm" variant="primary">Apply list</Button>
            </>}
          </div>
        </>}
        onClose={() => close(true)}
        open={open}
        title={step === "select" ? "Apply group list" : "Review target replacement"}
      >
        {step === "select" ? (
          <div className="campaign-group-list-dialog-form stack stack-sm" id="campaign-group-list-dialog">
            {error && <InlineAlert title="Could not apply group list">{error}</InlineAlert>}
            <div className="campaign-group-list-picker">
              <div className="campaign-group-list-picker-toolbar">
                <SearchField label="Find group list" loading={loading} onChange={applying ? () => undefined : changeSearch} placeholder="Search list name or description" value={inputQuery} variant="toolbar" />
                <span aria-live="polite">{resultSummary}</span>
              </div>
              {selected && !selectedVisible && (
                <div className="campaign-group-list-picker-retained">
                  <div><span>Selected outside current results</span><strong>{selected.name}</strong></div>
                  <Button onClick={() => setSelected(null)} size="sm" variant="ghost">Clear</Button>
                </div>
              )}
              <div aria-label="Available group lists" className="campaign-group-list-picker-results" role="radiogroup">
                {loading && !lists.length ? (
                  <div className="campaign-group-list-picker-state"><AppIcon className="ui-icon-spin" name="refresh" size="sm" /><span>Loading group lists…</span></div>
                ) : lists.length ? lists.map((list) => {
                  const checked = selected?.id === list.id;
                  return (
                    <button aria-checked={checked} className="campaign-group-list-picker-row" data-selected={checked || undefined} key={list.id} onClick={() => changeList(list)} role="radio" type="button">
                      <span className="campaign-group-list-picker-radio">{checked && <AppIcon name="check" size="xs" />}</span>
                      <span className="campaign-group-list-picker-copy"><strong>{list.name}</strong><small>{list.description || "No description"}</small></span>
                      <span className="campaign-group-list-picker-metadata"><strong>{list.groupCount.toLocaleString()} {list.groupCount === 1 ? "group" : "groups"}</strong><small>Membership r{list.membershipRevision} · Updated {formatUpdatedAt(list.updatedAt)}</small></span>
                    </button>
                  );
                }) : (
                  <div className="campaign-group-list-picker-state"><AppIcon name="groups" size="sm" /><strong>{query ? "No matching group lists" : "No group lists yet"}</strong><span>{query ? `No active lists match “${query}”.` : "Create a reusable list from the Groups workspace first."}</span></div>
                )}
              </div>
              {total > 0 && <TablePagination limit={LIST_PAGE_SIZE} loading={loading} offset={offset} onOffsetChange={changeOffset} total={total} />}
            </div>
          </div>
        ) : selected ? (
          <div className="campaign-group-list-review stack stack-md" id="campaign-group-list-dialog">
            <div className="campaign-group-list-review-list">
              <div className="campaign-group-list-review-icon"><AppIcon name="groups" size="sm" /></div>
              <div><span>Selected group list</span><strong>{selected.name}</strong>{selected.description && <p>{selected.description}</p>}</div>
            </div>
            <dl className="campaign-group-list-review-metrics">
              <div><dt>Groups</dt><dd>{selected.groupCount.toLocaleString()}</dd></div>
              <div><dt>Membership revision</dt><dd>r{selected.membershipRevision}</dd></div>
            </dl>
            <InlineAlert title={selected.groupCount === 0 ? "This list is empty" : "Replace persisted targets"} tone={selected.groupCount === 0 ? "warning" : "info"}>
              {selected.groupCount === 0
                ? "Applying this snapshot will clear the complete persisted campaign target set."
                : "Runtime will atomically replace the complete persisted target set. This does not create a live link to the group list."}
            </InlineAlert>
          </div>
        ) : null}
      </ModalDialog>
    </div>
  );
}
