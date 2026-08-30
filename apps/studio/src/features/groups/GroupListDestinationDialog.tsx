import { useEffect, useId, useRef, useState } from "react";

import type { RuntimeGroupList } from "@/shared/api/runtime-client";
import { AppIcon } from "@/shared/ui/AppIcon";
import { Button } from "@/shared/ui/Button";
import { DateTime } from "@/shared/ui/DateTime";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { ModalDialog } from "@/shared/ui/ModalDialog";
import { SearchField } from "@/shared/ui/SearchField";

interface GroupListDestinationDialogProps {
  emptyCatalog?: boolean;
  error: { body: string; title: string } | null;
  hasMore: boolean;
  lists: readonly RuntimeGroupList[];
  loading: boolean;
  onApply: (list: RuntimeGroupList) => void;
  onClose: () => void;
  onCreate: () => void;
  onLoadMore: () => void;
  onQueryChange: (query: string) => void;
  open: boolean;
  query: string;
  saving: boolean;
  selectedCount: number;
}

export function GroupListDestinationDialog({
  emptyCatalog = false,
  error,
  hasMore,
  lists,
  loading,
  onApply,
  onClose,
  onCreate,
  onLoadMore,
  onQueryChange,
  open,
  query,
  saving,
  selectedCount,
}: GroupListDestinationDialogProps) {
  const radioName = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<RuntimeGroupList | null>(null);
  const normalizedQuery = query.trim();
  const catalogUnavailable = Boolean(error) && lists.length === 0;
  const createFallback = emptyCatalog || catalogUnavailable;
  const noMatchingLists = !loading
    && !error
    && lists.length === 0
    && Boolean(normalizedQuery);

  useEffect(() => {
    if (open) setSelected(null);
  }, [open]);

  useEffect(() => {
    if (selected && !lists.some((list) => list.id === selected.id)) setSelected(null);
  }, [lists, selected]);

  return (
    <ModalDialog
      className="group-list-destination-dialog"
      closeDisabled={saving}
      description={createFallback
        ? `Create a saved list for ${selectedCount.toLocaleString()} selected ${selectedCount === 1 ? "group" : "groups"}.`
        : `Choose where to add ${selectedCount.toLocaleString()} selected ${selectedCount === 1 ? "group" : "groups"}.`}
      footer={(
        <div className="group-list-destination-actions">
          <Button disabled={saving} onClick={onClose}>Cancel</Button>
          <Button
            disabled={(!createFallback && !noMatchingLists && !selected) || saving}
            loading={saving}
            onClick={() => {
              if (createFallback) onCreate();
              else if (noMatchingLists) onQueryChange("");
              else if (selected) onApply(selected);
            }}
            variant="primary"
          >
            {createFallback
              ? "New list"
              : noMatchingLists
                ? "Clear search"
                : "Add to list"}
          </Button>
        </div>
      )}
      initialFocusRef={emptyCatalog ? undefined : searchRef}
      onClose={onClose}
      open={open}
      title={emptyCatalog
        ? "No saved lists"
        : catalogUnavailable
          ? "Saved lists unavailable"
          : "Add to existing list"}
    >
      <div className="group-list-destination-body">
        {!emptyCatalog && (
          <SearchField
            inputRef={searchRef}
            label="Search saved lists"
            loading={loading}
            onChange={onQueryChange}
            placeholder="Search list name"
            value={query}
            variant="contained"
          />
        )}
        {error && (
          <InlineAlert title={error.title} tone="warning">{error.body}</InlineAlert>
        )}
        {emptyCatalog ? (
          <div className="group-list-destination-state group-list-destination-state-empty">
            <AppIcon name="list-plus" size="sm" />
            <span>
              <strong>No saved lists</strong>
              <small>The current selection can become your first list.</small>
            </span>
          </div>
        ) : loading && lists.length === 0 ? (
          <div className="group-list-destination-state" role="status">
            <AppIcon className="ui-icon-spin" name="refresh" size="sm" />
            <span>Loading saved lists…</span>
          </div>
        ) : lists.length === 0 ? (
          <div className="group-list-destination-state">
            <AppIcon name="groups" size="sm" />
            <strong>{normalizedQuery ? "No matching lists" : "No saved lists yet"}</strong>
          </div>
        ) : (
          <div
            aria-label="Saved group lists"
            aria-busy={loading || undefined}
            className="group-list-destination-options"
            role="radiogroup"
          >
          {lists.map((list) => {
            const checked = selected?.id === list.id;
            return (
              <label
                className="group-list-destination-option"
                data-disabled={saving || undefined}
                data-selected={checked || undefined}
                key={list.id}
              >
                <input
                  aria-label={list.name}
                  checked={checked}
                  className="group-list-destination-radio"
                  disabled={saving}
                  name={radioName}
                  onChange={() => setSelected(list)}
                  type="radio"
                  value={list.id}
                />
                <span className="group-list-destination-marker">
                  {checked && <AppIcon name="check" size="xs" />}
                </span>
                <span className="group-list-destination-copy">
                  <strong>{list.name}</strong>
                  <small>{list.description || "No description"}</small>
                </span>
                <span className="group-list-destination-meta">
                  <strong>{list.groupCount.toLocaleString()} groups</strong>
                  <small>Updated <DateTime value={list.updatedAt} /></small>
                </span>
              </label>
            );
          })}
          </div>
        )}
        {!emptyCatalog && hasMore && (
          <Button
            className="group-list-destination-load-more"
            disabled={loading || saving}
            loading={loading}
            onClick={onLoadMore}
            size="sm"
            variant="ghost"
          >
            Load more lists
          </Button>
        )}
      </div>
    </ModalDialog>
  );
}
