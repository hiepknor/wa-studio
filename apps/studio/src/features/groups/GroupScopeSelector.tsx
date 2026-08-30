import {
  type KeyboardEvent,
  type UIEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import type { RuntimeGroupList } from "@/shared/api/runtime-client";
import { AppIcon } from "@/shared/ui/AppIcon";
import { Button } from "@/shared/ui/Button";
import { SearchField } from "@/shared/ui/SearchField";

interface GroupScopeSelectorProps {
  disabled?: boolean;
  directoryCount?: number | null;
  directorySelected?: boolean;
  error?: string | null;
  hasMore?: boolean;
  lists: readonly RuntimeGroupList[];
  loading?: boolean;
  onLoadMore?: () => void;
  onNewList: () => void;
  onQueryChange: (query: string) => void;
  onSelectDirectory: () => void;
  onSelectList: (list: RuntimeGroupList) => void;
  query: string;
  selectedList?: RuntimeGroupList | null;
  selectedListId?: string | null;
  valueLabel?: string;
}

function scopeOptions(container: HTMLDivElement | null): HTMLButtonElement[] {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('[role="option"]'),
  );
}

function scopeCatalogSummary(input: {
  error: string | null;
  hasMore: boolean;
  listCount: number;
  loading: boolean;
  query: string;
}): string {
  if (input.error) return "Saved lists unavailable";
  if (input.loading && input.listCount === 0) return "Loading saved lists…";
  if (input.listCount === 0 && !input.query.trim()) {
    return "Saved lists belong to the current session";
  }
  const count = `${input.listCount.toLocaleString()}${input.hasMore ? "+" : ""}`;
  const noun = input.listCount === 1 && !input.hasMore ? "list" : "lists";
  const kind = input.query.trim() ? "matching" : "saved";
  return `${count} ${kind} ${noun} · Current session only`;
}

export function GroupScopeSelector({
  disabled = false,
  directoryCount = null,
  directorySelected: directorySelectedProp,
  error = null,
  hasMore = false,
  lists,
  loading = false,
  onLoadMore,
  onNewList,
  onQueryChange,
  onSelectDirectory,
  onSelectList,
  query,
  selectedList: selectedListProp = null,
  selectedListId = null,
  valueLabel,
}: GroupScopeSelectorProps) {
  const id = useId();
  const listboxId = `${id}-listbox`;
  const labelId = `${id}-label`;
  const directoryLabelId = `${id}-directory-label`;
  const savedListsLabelId = `${id}-saved-lists-label`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const loadingMoreRef = useRef(false);
  const [open, setOpen] = useState(false);
  const selectedList = selectedListProp
    ?? lists.find((list) => list.id === selectedListId)
    ?? null;

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  useEffect(() => {
    if (!loading) loadingMoreRef.current = false;
  }, [loading]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    function closeFromOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) close();
    }
    document.addEventListener("pointerdown", closeFromOutside);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeFromOutside);
    };
  }, [open]);

  function moveOption(event: KeyboardEvent, nextIndex: number) {
    const options = scopeOptions(listboxRef.current);
    if (!options.length) return;
    event.preventDefault();
    options[(nextIndex + options.length) % options.length]?.focus();
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "ArrowDown") {
      moveOption(event, 0);
    } else if (event.key === "ArrowUp") {
      moveOption(event, -1);
    }
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    if (!disabled) setOpen(true);
  }

  function handleListboxKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    const options = scopeOptions(listboxRef.current);
    const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") moveOption(event, currentIndex + 1);
    else if (event.key === "ArrowUp") {
      if (currentIndex <= 0) {
        event.preventDefault();
        searchRef.current?.focus();
      } else moveOption(event, currentIndex - 1);
    } else if (event.key === "Home") moveOption(event, 0);
    else if (event.key === "End") moveOption(event, options.length - 1);
  }

  function handleScroll(event: UIEvent<HTMLDivElement>) {
    if (!hasMore || loading || loadingMoreRef.current || !onLoadMore) return;
    const element = event.currentTarget;
    if (element.scrollHeight - element.scrollTop - element.clientHeight > 48) return;
    loadingMoreRef.current = true;
    onLoadMore();
  }

  function chooseDirectory() {
    onSelectDirectory();
    close(true);
  }

  function chooseList(list: RuntimeGroupList) {
    onSelectList(list);
    close(true);
  }

  const directorySelected = directorySelectedProp ?? selectedListId === null;
  const hasQuery = Boolean(query.trim());

  return (
    <div
      className="group-scope-selector"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
      }}
      ref={rootRef}
    >
      <span className="text-field-label text-field-label-hidden" id={labelId}>Group scope</span>
      <button
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-labelledby={labelId}
        className="group-scope-trigger"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleTriggerKeyDown}
        ref={triggerRef}
        role="combobox"
        type="button"
      >
        <AppIcon name="groups" size="sm" />
        <span>{valueLabel ?? selectedList?.name ?? "All groups"}</span>
        <AppIcon className="group-scope-trigger-chevron" name="chevron-down" size="xs" />
      </button>
      {open && (
        <div className="group-scope-pane">
          <header className="group-scope-header">
            <span>Group scope</span>
            <Button
              icon="list-plus"
              onClick={() => {
                close();
                onNewList();
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  close(true);
                }
              }}
              size="sm"
              variant="ghost"
            >
              New list
            </Button>
          </header>
          <SearchField
            id={`${id}-search`}
            inputRef={searchRef}
            label="Search saved lists"
            loading={loading}
            onChange={onQueryChange}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search lists"
            value={query}
            variant="contained"
          />
          <div
            aria-labelledby={labelId}
            className="group-scope-listbox"
            id={listboxId}
            onKeyDown={handleListboxKeyDown}
            onScroll={handleScroll}
            ref={listboxRef}
            role="listbox"
          >
            <div aria-labelledby={directoryLabelId} role="group">
              <span className="group-scope-section-label" id={directoryLabelId}>Directory</span>
              <button
                aria-selected={directorySelected}
                className="group-scope-option"
                onClick={chooseDirectory}
                role="option"
                type="button"
              >
                <span className="group-scope-option-marker">
                  {directorySelected && <AppIcon name="check" size="xs" />}
                </span>
                <span className="group-scope-option-copy">
                  <span className="group-scope-option-heading">
                    <strong>All groups</strong>
                    <span>
                      {directoryCount === null
                        ? "— groups"
                        : `${directoryCount.toLocaleString()} ${directoryCount === 1 ? "group" : "groups"}`}
                    </span>
                  </span>
                  <small>Complete synchronized directory</small>
                </span>
              </button>
            </div>
            <div aria-labelledby={savedListsLabelId} role="group">
              <span className="group-scope-section-label" id={savedListsLabelId}>Saved lists</span>
              {error ? (
                <p className="group-scope-message" role="alert">{error}</p>
              ) : lists.length === 0 && !loading ? (
                <div className="group-scope-empty-state">
                  <AppIcon name={hasQuery ? "search" : "list-plus"} size="sm" />
                  <span>
                    <strong>{hasQuery ? "No matching lists" : "No saved lists"}</strong>
                    <small>
                      {hasQuery
                        ? "Try another list name."
                        : "Create one to reuse a group selection."}
                    </small>
                  </span>
                </div>
              ) : lists.map((list) => (
                <button
                  aria-selected={list.id === selectedListId}
                  className="group-scope-option"
                  key={list.id}
                  onClick={() => chooseList(list)}
                  role="option"
                  type="button"
                >
                  <span className="group-scope-option-marker">
                    {list.id === selectedListId && <AppIcon name="check" size="xs" />}
                  </span>
                  <span className="group-scope-option-copy">
                    <span className="group-scope-option-heading">
                      <strong>{list.name}</strong>
                      <span>{list.groupCount.toLocaleString()} groups</span>
                    </span>
                    <small>{list.description || "No description"}</small>
                  </span>
                </button>
              ))}
              {loading && <p aria-live="polite" className="group-scope-message">Loading lists…</p>}
            </div>
          </div>
          <footer className="group-scope-footer">
            <AppIcon name="info" size="xs" />
            <span aria-live="polite">
              {scopeCatalogSummary({
                error,
                hasMore,
                listCount: lists.length,
                loading,
                query,
              })}
            </span>
          </footer>
        </div>
      )}
    </div>
  );
}
