import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { useAnchoredPopup } from "./anchored-popup";
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

export interface SelectMenuProps<T extends string> {
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
  const openingFocusRef = useRef<"first" | "last" | "selected">("selected");
  const [open, setOpen] = useState(false);
  const selectedOption = options.find((option) => option.value === value);

  function close({ restoreFocus = false } = {}) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function openListbox(initialFocus: "first" | "last" | "selected" = "selected") {
    if (disabled) return;
    openingFocusRef.current = initialFocus;
    setOpen(true);
  }

  const listboxLayout = useAnchoredPopup({
    estimatedChromeHeight: 12,
    estimatedOptionCount: options.length,
    onDismiss: close,
    open,
    popupRef: listboxRef,
    rootRef,
    triggerRef,
  });

  useEffect(() => {
    if (!open) return;
    const items = enabledOptions(listboxRef.current);
    const selected = items.find((item) => item.dataset.value === value);
    const initialItem = openingFocusRef.current === "last"
      ? items[items.length - 1]
      : openingFocusRef.current === "first"
        ? items[0]
        : selected ?? items[0];
    initialItem?.focus();

  }, [open, value]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    if (open) {
      close({ restoreFocus: true });
      return;
    }
    openListbox(event.key === "ArrowUp" ? "last" : event.key === "ArrowDown" ? "first" : "selected");
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
          onClick={() => open ? close({ restoreFocus: true }) : openListbox("selected")}
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
