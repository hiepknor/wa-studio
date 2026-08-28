import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { AppIcon } from "./AppIcon";
import {
  DEFAULT_FIELD_SIZE,
  type FieldSize,
  fieldSizeClassName,
} from "./field-size";
import "./search-select.css";
import "./text-field.css";

export interface SearchSelectOption<T extends string> {
  disabled?: boolean;
  group?: string;
  keywords?: string;
  label: string;
  value: T;
}

interface SearchSelectProps<T extends string> {
  containerClassName?: string;
  description?: ReactNode;
  disabled?: boolean;
  emptyMessage?: string;
  id?: string;
  label: ReactNode;
  labelHidden?: boolean;
  onChange: (value: T) => void;
  options: readonly SearchSelectOption<T>[];
  searchLabel?: string;
  searchPlaceholder?: string;
  size?: FieldSize;
  value: T;
}

const POPOVER_GAP = 6;
const POPOVER_MAX_HEIGHT = 260;

function enabledOptions(container: HTMLDivElement | null): HTMLButtonElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)'));
}

function clippingBoundary(element: HTMLElement) {
  const boundary = { bottom: window.innerHeight, top: 0 };
  let ancestor = element.parentElement;
  while (ancestor) {
    const style = window.getComputedStyle(ancestor);
    if (/auto|clip|hidden|scroll/.test(`${style.overflow} ${style.overflowY}`)) {
      const rect = ancestor.getBoundingClientRect();
      boundary.top = Math.max(boundary.top, rect.top);
      boundary.bottom = Math.min(boundary.bottom, rect.bottom);
    }
    ancestor = ancestor.parentElement;
  }
  return boundary;
}

export function SearchSelect<T extends string>({
  containerClassName = "",
  description,
  disabled = false,
  emptyMessage = "No options match this search.",
  id,
  label,
  labelHidden = false,
  onChange,
  options,
  searchLabel = "Search options",
  searchPlaceholder = "Search",
  size = DEFAULT_FIELD_SIZE,
  value,
}: SearchSelectProps<T>) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const labelId = `${controlId}-label`;
  const descriptionId = description ? `${controlId}-description` : undefined;
  const listboxId = `${controlId}-listbox`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [popoverLayout, setPopoverLayout] = useState({
    maxHeight: POPOVER_MAX_HEIGHT,
    placement: "down" as "down" | "up",
  });
  const selectedOption = options.find((option) => option.value === value);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleOptions = useMemo(() => options.filter((option) => {
    if (!normalizedQuery) return true;
    return `${option.label} ${option.keywords ?? ""} ${option.group ?? ""}`
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  }), [normalizedQuery, options]);
  const groupedOptions = useMemo(() => {
    const groups = new Map<string, SearchSelectOption<T>[]>();
    visibleOptions.forEach((option) => {
      const group = option.group ?? "";
      groups.set(group, [...(groups.get(group) ?? []), option]);
    });
    return [...groups.entries()];
  }, [visibleOptions]);

  function close(restoreFocus = false) {
    setOpen(false);
    setQuery("");
    if (restoreFocus) triggerRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    function closeFromOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) close();
    }
    document.addEventListener("pointerdown", closeFromOutside);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) close();
  }, [disabled]);

  useLayoutEffect(() => {
    if (!open) return;
    function positionPopover() {
      const root = rootRef.current;
      const trigger = triggerRef.current;
      const popover = popoverRef.current;
      if (!root || !trigger || !popover) return;
      const triggerRect = trigger.getBoundingClientRect();
      const boundary = clippingBoundary(root);
      const naturalHeight = Math.min(
        popover.scrollHeight || visibleOptions.length * 36 + 50,
        POPOVER_MAX_HEIGHT,
      );
      const spaceAbove = Math.max(0, triggerRect.top - boundary.top - POPOVER_GAP);
      const spaceBelow = Math.max(0, boundary.bottom - triggerRect.bottom - POPOVER_GAP);
      const placement = naturalHeight <= spaceBelow
        ? "down"
        : naturalHeight <= spaceAbove || spaceAbove > spaceBelow
          ? "up"
          : "down";
      const maxHeight = Math.min(
        POPOVER_MAX_HEIGHT,
        placement === "up" ? spaceAbove : spaceBelow,
      );
      setPopoverLayout((current) => current.maxHeight === maxHeight && current.placement === placement
        ? current
        : { maxHeight, placement });
    }
    positionPopover();
    window.addEventListener("resize", positionPopover);
    window.addEventListener("scroll", positionPopover, true);
    return () => {
      window.removeEventListener("resize", positionPopover);
      window.removeEventListener("scroll", positionPopover, true);
    };
  }, [open, visibleOptions.length]);

  function moveToOption(event: KeyboardEvent, index: number) {
    const items = enabledOptions(listboxRef.current);
    if (!items.length) return;
    event.preventDefault();
    items[(index + items.length) % items.length]?.focus();
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      close(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    if (!disabled) setOpen(true);
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "ArrowDown") moveToOption(event, 0);
    else if (event.key === "ArrowUp") moveToOption(event, -1);
  }

  function handleListboxKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    const items = enabledOptions(listboxRef.current);
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") moveToOption(event, currentIndex + 1);
    else if (event.key === "ArrowUp") {
      if (currentIndex <= 0) {
        event.preventDefault();
        searchRef.current?.focus();
      } else moveToOption(event, currentIndex - 1);
    } else if (event.key === "Home") moveToOption(event, 0);
    else if (event.key === "End") moveToOption(event, items.length - 1);
  }

  return (
    <div className={`search-select text-field ${fieldSizeClassName(size)} ${containerClassName}`.trim()} ref={rootRef}>
      <span className={`text-field-label ${labelHidden ? "text-field-label-hidden" : ""}`.trim()} id={labelId}>{label}</span>
      <div className="search-select-control">
        <button
          aria-controls={listboxId}
          aria-describedby={descriptionId}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-labelledby={labelId}
          className="search-select-trigger"
          disabled={disabled}
          onClick={() => open ? close(true) : setOpen(true)}
          onKeyDown={handleTriggerKeyDown}
          ref={triggerRef}
          role="combobox"
          type="button"
        >
          <span className="search-select-value">{selectedOption?.label ?? value}</span>
          <AppIcon className="search-select-chevron" name="chevron-down" size="xs" />
        </button>
        {open && (
          <div
            className="search-select-popover"
            data-placement={popoverLayout.placement}
            ref={popoverRef}
            style={{ maxHeight: popoverLayout.maxHeight }}
          >
            <div className="search-select-search focus-owner">
              <AppIcon name="search" size="sm" />
              <input
                aria-controls={listboxId}
                aria-label={searchLabel}
                autoComplete="off"
                onChange={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder={searchPlaceholder}
                ref={searchRef}
                type="search"
                value={query}
              />
            </div>
            <div aria-labelledby={labelId} className="search-select-listbox" id={listboxId} onKeyDown={handleListboxKeyDown} ref={listboxRef} role="listbox">
              {visibleOptions.length ? groupedOptions.map(([group, groupOptions]) => (
                <div className="search-select-group" key={group || "ungrouped"} role="presentation">
                  {group && <span className="search-select-group-label">{group}</span>}
                  {groupOptions.map((option) => (
                    <button
                      aria-selected={option.value === value}
                      className="search-select-option"
                      disabled={option.disabled}
                      key={option.value}
                      onClick={() => {
                        onChange(option.value);
                        close(true);
                      }}
                      role="option"
                      type="button"
                    >
                      <span className="search-select-option-marker">{option.value === value && <AppIcon name="check" size="xs" />}</span>
                      <span>{option.label}</span>
                    </button>
                  ))}
                </div>
              )) : <p className="search-select-empty">{emptyMessage}</p>}
            </div>
          </div>
        )}
      </div>
      {description && <span className="text-field-description" id={descriptionId}>{description}</span>}
    </div>
  );
}
