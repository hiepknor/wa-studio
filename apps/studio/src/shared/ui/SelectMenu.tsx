import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { AppIcon } from "./AppIcon";
import {
  DEFAULT_FIELD_SIZE,
  type FieldSize,
  fieldSizeClassName,
} from "./field-size";
import "./select-menu.css";
import "./text-field.css";

export interface SelectMenuOption<T extends string> {
  description?: ReactNode;
  disabled?: boolean;
  label: ReactNode;
  value: T;
}

interface SelectMenuProps<T extends string> {
  "aria-describedby"?: string;
  className?: string;
  containerClassName?: string;
  description?: ReactNode;
  disabled?: boolean;
  id?: string;
  invalid?: boolean;
  label: ReactNode;
  labelHidden?: boolean;
  name?: string;
  onChange: (value: T) => void;
  options: readonly SelectMenuOption<T>[];
  size?: FieldSize;
  value: T;
}

function enabledOptions(container: HTMLDivElement | null): HTMLButtonElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLButtonElement>(
    '[role="option"]:not(:disabled)',
  ));
}

const LISTBOX_GAP = 6;
const LISTBOX_MAX_HEIGHT = 260;

interface VerticalBoundary {
  bottom: number;
  top: number;
}

function clippingBoundary(element: HTMLElement): VerticalBoundary {
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

export function SelectMenu<T extends string>({
  "aria-describedby": ariaDescribedBy,
  className = "",
  containerClassName = "",
  description,
  disabled = false,
  id,
  invalid = false,
  label,
  labelHidden = false,
  name,
  onChange,
  options,
  size = DEFAULT_FIELD_SIZE,
  value,
}: SelectMenuProps<T>) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const labelId = `${inputId}-label`;
  const descriptionId = description ? `${inputId}-description` : undefined;
  const listboxId = `${inputId}-listbox`;
  const describedBy = [ariaDescribedBy, descriptionId].filter(Boolean).join(" ") || undefined;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [listboxLayout, setListboxLayout] = useState({
    maxHeight: LISTBOX_MAX_HEIGHT,
    placement: "down" as "down" | "up",
  });
  const selectedOption = options.find((option) => option.value === value);

  function close({ restoreFocus = false } = {}) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function openListbox() {
    if (disabled) return;
    setOpen(true);
  }

  useLayoutEffect(() => {
    if (!open) return;

    function positionListbox() {
      const root = rootRef.current;
      const trigger = triggerRef.current;
      const listbox = listboxRef.current;
      if (!root || !trigger || !listbox) return;

      const triggerRect = trigger.getBoundingClientRect();
      const listboxRect = listbox.getBoundingClientRect();
      const boundary = clippingBoundary(root);
      const naturalHeight = Math.min(
        listbox.scrollHeight || listboxRect.height || options.length * 46 + 12,
        LISTBOX_MAX_HEIGHT,
      );
      const spaceAbove = Math.max(0, triggerRect.top - boundary.top - LISTBOX_GAP);
      const spaceBelow = Math.max(0, boundary.bottom - triggerRect.bottom - LISTBOX_GAP);
      const placement = naturalHeight <= spaceBelow
        ? "down"
        : naturalHeight <= spaceAbove || spaceAbove > spaceBelow
          ? "up"
          : "down";
      const maxHeight = Math.min(
        LISTBOX_MAX_HEIGHT,
        placement === "up" ? spaceAbove : spaceBelow,
      );

      setListboxLayout((current) =>
        current.placement === placement && current.maxHeight === maxHeight
          ? current
          : { maxHeight, placement });
    }

    positionListbox();
    window.addEventListener("resize", positionListbox);
    window.addEventListener("scroll", positionListbox, true);
    return () => {
      window.removeEventListener("resize", positionListbox);
      window.removeEventListener("scroll", positionListbox, true);
    };
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const items = enabledOptions(listboxRef.current);
    const selected = items.find((item) => item.dataset.value === value);
    (selected ?? items[0])?.focus();

    function closeFromOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) close();
    }

    document.addEventListener("pointerdown", closeFromOutside);
    return () => document.removeEventListener("pointerdown", closeFromOutside);
  }, [open, value]);

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    open ? close({ restoreFocus: true }) : openListbox();
  }

  function handleListboxKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = enabledOptions(listboxRef.current);
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close({ restoreFocus: true });
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (currentIndex + 1 + items.length) % items.length
            : (currentIndex - 1 + items.length) % items.length;
      items[nextIndex]?.focus();
      return;
    }
    if (event.key.length === 1 && /\S/.test(event.key)) {
      const match = items.find((item) => item.textContent?.trim().toLocaleLowerCase()
        .startsWith(event.key.toLocaleLowerCase()));
      match?.focus();
    }
  }

  return (
    <div className={`text-field ${fieldSizeClassName(size)} select-menu ${containerClassName}`.trim()} ref={rootRef}>
      <span className={`text-field-label ${labelHidden ? "text-field-label-hidden" : ""}`.trim()} id={labelId}>{label}</span>
      <div className="select-menu-control">
        <button
          aria-controls={listboxId}
          aria-describedby={describedBy}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-invalid={invalid || undefined}
          aria-labelledby={labelId}
          className={`select-menu-trigger ${className}`.trim()}
          disabled={disabled}
          onClick={() => open ? close({ restoreFocus: true }) : openListbox()}
          onKeyDown={handleTriggerKeyDown}
          ref={triggerRef}
          role="combobox"
          type="button"
        >
          <span className="select-menu-value">{selectedOption?.label ?? value}</span>
          <AppIcon className="select-menu-chevron" name="chevron-down" size="xs" />
        </button>
        {name && <input name={name} type="hidden" value={value} />}
        {open && (
          <div
            aria-labelledby={labelId}
            className="select-menu-listbox"
            data-placement={listboxLayout.placement}
            id={listboxId}
            onKeyDown={handleListboxKeyDown}
            ref={listboxRef}
            role="listbox"
            style={{ maxHeight: listboxLayout.maxHeight }}
          >
            {options.map((option) => (
              <button
                aria-selected={option.value === value}
                className="select-menu-option"
                data-value={option.value}
                disabled={option.disabled}
                key={option.value}
                onClick={() => {
                  onChange(option.value);
                  close({ restoreFocus: true });
                }}
                role="option"
                type="button"
              >
                <span className="select-menu-option-marker">
                  {option.value === value && <AppIcon name="check" size="xs" />}
                </span>
                <span className="select-menu-option-copy">
                  <span>{option.label}</span>
                  {option.description && <small>{option.description}</small>}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {description && <span className="text-field-description" id={descriptionId}>{description}</span>}
    </div>
  );
}
